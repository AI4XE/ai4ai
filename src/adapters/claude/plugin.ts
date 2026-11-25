import type { Register, CoreEngineInterface } from 'claude-code';
import { TOOL_DESCRIPTION, TOOL_NAME, normalizeToolCall } from '../../contract/tool.js';
import { RetainedInput, mergeRetained } from '../../core/retained-input.js';
import { parseDelivery, isDeliveryText as isCanonicalDelivery, taskDelivery, idleDelivery, noTaskCompactDecision } from '../../core/handoff-delivery.js';
import { controlEnvelopeOperationId } from '../../core/control-envelope.js';

/**
 * The Claude hooks module is evaluated in a sandbox that allows relative
 * imports and `claude-code` only. `install/binding.ts` imports `node:path`, so
 * it must not be imported here; `resolveBinding` below is an import-free
 * equivalent that reads candidates through the host `$.fs` API and lets the
 * worker re-validate whatever it selects.
 */

interface Binding { harness: string; workspace: string; surface: 'tui' | 'headless'; session: string; generation: string; agent: string }
interface HandoffRecord { operationId: string; marker: string; phase: string; mechanism?: 'restart' | 'compact'; request: { task?: string; mode?: 'restart' | 'compact'; continuation?: 'auto' | 'off' }; source: Binding }
interface Runtime {
  binding?: Binding;
  instance: string;
  node: string;
  /** Workspace-local binding selected for this session (never a foreign project's). */
  bindingPath?: string;
  active?: HandoffRecord;
  busy: boolean;
  pumping: boolean;
  /** Journal write started by the compact hook; the pump awaits it before delivery. */
  replacement?: Promise<unknown> | undefined;
  turnId: string;
  appliedHere: boolean;
  delivery?: { text: string; operationId: string; marker: string; invalid: boolean; adopted: boolean };
  /** Native turn that admitted the delivery; its completion replays retained input. */
  admissionTurn?: string;
  /** True while the native summarizer is running for a compact handoff. */
  compacting?: boolean;
  /** True when the no-task compact fallback continuation was injected. */
  fallback?: boolean;
  /** Rotation seed: the initial D29 text is a normal task, never a delivery. */
  seed?: boolean;
  /** Turn that only carries the invisible executor-target handoff envelope. */
  controlTurn?: string;
  /** Real user input retained while the handoff window is open. */
  retained: RetainedInput;
}

const tool = 'mcp__ai4ai__session';
const dbg = ($: any, message: string): void => { try { $.ui.log('ai4ai debug: ' + message, { to: 'debug' }); } catch { /* debug only */ } };

interface BindingFile {
  product?: unknown; format?: unknown; home?: unknown; workspace?: unknown;
  ownerToken?: unknown; node?: unknown; scope?: unknown;
}
interface NativeBinding { home: string; workspace: string; ownerToken: string; node?: string }

// Import-free path helpers for the hooks sandbox (see the import comment).
const trimTrailing = (value: string): string => value.replace(/[\\/]+$/, '');
const absolutePath = (value: unknown): value is string => typeof value === 'string'
  && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'));
const normalizedPath = (value: string): string => {
  const trimmed = trimTrailing(value).replace(/\\/g, '/');
  // Windows paths compare case-insensitively; POSIX paths do not.
  return /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('//') ? trimmed.toLowerCase() : trimmed;
};
const containsWorkspace = (root: string, candidate: string): boolean => {
  const owner = normalizedPath(root);
  const target = normalizedPath(candidate);
  return target === owner || target.startsWith(owner.endsWith('/') ? owner : `${owner}/`);
};
const parentPath = (value: string): string => {
  const trimmed = trimTrailing(value);
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return trimmed;
  if (index === 0) return '/';
  if (index === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.slice(0, index);
};
const joinPath = (directory: string, name: string): string => {
  const trimmed = trimTrailing(directory);
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return `${trimmed}${separator}${name}`;
};

/** Read one binding candidate through the host API; malformed/foreign records are skipped. */
async function readBinding($: any, file: string): Promise<NativeBinding | undefined> {
  let raw: unknown;
  try { raw = await $.fs.read(file); } catch { return undefined; }
  if (typeof raw !== 'string') return undefined;
  let value: BindingFile;
  try { value = JSON.parse(raw) as BindingFile; } catch { return undefined; }
  if (!value || value.product !== 'ai4ai' || value.format !== 2 || !absolutePath(value.home) || !absolutePath(value.workspace)
    || typeof value.ownerToken !== 'string' || value.ownerToken.length === 0) return undefined;
  return {
    home: value.home, workspace: value.workspace, ownerToken: value.ownerToken,
    ...(typeof value.node === 'string' && absolutePath(value.node) ? { node: value.node } : {}),
  };
}

/**
 * Import-free binding resolution: the nearest workspace-local binding whose
 * recorded workspace contains the caller wins; the plugin-root binding is a
 * compatible fallback. The worker validates ownership again when used.
 */
async function resolveBinding($: any): Promise<{ binding: NativeBinding; path: string } | undefined> {
  const workspace = await $.session.cwd();
  if (typeof workspace !== 'string' || !absolutePath(workspace)) return undefined;
  const candidates: string[] = [];
  let current = workspace;
  for (let depth = 0; depth < 16; depth += 1) {
    candidates.push(joinPath(current, '.ai4ai/binding.json'));
    const parent = parentPath(current);
    if (parent === current) break;
    current = parent;
  }
  candidates.push(joinPath($.plugin.root, 'binding.json'));
  for (const file of candidates) {
    const binding = await readBinding($, file);
    if (binding && containsWorkspace(binding.workspace, workspace)) return { binding, path: file };
  }
  return undefined;
}
/** The handoff window: accepted but not yet completed. */
const HANDOFF_WINDOW = ['pending', 'scheduled', 'applied'];
const TERMINAL = ['cancelled', 'failed', 'unknown'];
const RETAINED_SCOPE = 'handoff';
const inHandoffWindow = (s: Runtime): boolean => !!s.active && HANDOFF_WINDOW.includes(String(s.active.phase));

async function rpc($: CoreEngineInterface, node: string, payload: object, bindingPath?: string): Promise<any> {
  let marker: string | undefined;
  try {
    const api = await $.session.messages({ as: 'api' });
    const first = api.find((message: any) => message.role === 'user')?.content;
    const text = typeof first === 'string' ? first : first?.[0]?.type === 'text' ? first[0].text : undefined;
    // Only the first native binding block is evidence. Task text quoting a marker
    // later in history never confers generation authority.
    marker = typeof text === 'string'
      ? /^AI4AI native context binding: (ai4ai-context-[a-f0-9-]{36})\nFresh execution context\..*$/s.exec(text)?.[1]
      : undefined;
  } catch { /* the transcript is unavailable in some lifecycle phases */ }
  // The transcript marker is generation authority for calls that have none of
  // their own (binding/inspect/request). A transition already carries the
  // target record's marker; overriding it with the current window's marker
  // would reject every handoff after the first one.
  const authority = marker && (payload as { marker?: unknown }).marker === undefined ? { marker } : {};
  return rpcWith($, node, { ...payload, ...authority }, bindingPath);
}

async function rpcWith($: CoreEngineInterface, node: string, payload: Record<string, unknown>, bindingPath?: string): Promise<any> {
  const out = await $.process.run([node, `${$.plugin.root}/dist/adapters/claude/worker.js`], {
    stdin: JSON.stringify({ ...payload, ...(bindingPath ? { bindingPath } : {}) }), timeoutMs: 20000,
  });
  if (out.exitCode !== 0 || out.isStdoutTruncated) throw new Error(`AI4AI journal unavailable: ${String((out as any).stderr ?? '').slice(-600)}`);
  return JSON.parse(out.stdout);
}

async function currentSurface($: CoreEngineInterface): Promise<'tui' | 'headless'> {
  try { return (await $.session.surfaces()).length === 0 ? 'headless' : 'tui'; } catch { return 'headless'; }
}

async function transition($: CoreEngineInterface, current: Runtime, phase: string, reason: string, extra: Record<string, unknown> = {}, caller?: Binding): Promise<any> {
  if (!current.binding || !current.active) return undefined;
  // The journal is keyed by the record's source session. The in-place
  // replacement keeps that session, but transitions still use the record's
  // source identity so a later generation cannot be mistaken for it.
  const from = caller ?? (current.active.source as unknown as Binding) ?? current.binding;
  const out = await rpc($, current.node, {
    caller: from, action: 'transition', operationId: current.active.operationId,
    marker: current.active.marker, phase, reason, ...extra,
  }, current.bindingPath);
  if (out.record) {
    current.active = out.record;
    // A cancelled, failed or uncertain handoff terminates the window; retained
    // input belongs to the abandoned transition and is never replayed later.
    if (TERMINAL.includes(String(out.record.phase))) current.retained.clear(RETAINED_SCOPE);
  }
  return out;
}
/**
 * Persist the per-session handoff binding. It is the primary generation
 * authority: compact deliveries carry no transcript marker, and a crafted task
 * body can never mint a generation by quoting a marker.
 */
async function writeBinding($: CoreEngineInterface, s: Runtime, record: HandoffRecord): Promise<void> {
  if (!s.binding) return;
  try {
    await rpcWith($, s.node, {
      caller: s.binding, action: 'bind',
      session: record.source.session, generation: record.marker, marker: record.marker,
      operationId: record.operationId, mechanism: record.mechanism,
    }, s.bindingPath);
  } catch { /* the journal record remains; binding is an optimization for compact */ }
}

async function bindNative($: CoreEngineInterface, s: Runtime): Promise<void> {  const hello = await rpcWith($, s.node, { action: 'binding', workspace: await $.session.cwd() }, s.bindingPath);
  s.instance = hello.instance;
  const session = await $.session.id();
  const surface = await currentSurface($);
  const provisional: Binding = { harness: 'claude-code', workspace: hello.workspace, surface, session, generation: 'original', agent: 'main' };
  const inspected = await rpcWith($, s.node, { caller: provisional, action: 'inspect' }, s.bindingPath).catch(() => undefined);
  s.binding = { ...provisional, generation: inspected?.generation ?? 'original' };
  // The executor record (not the prompt text) decides whether this session is
  // a rotation seed whose first D29 text is a normal task.
  if (inspected?.handoffSeed === true) s.seed = true;
  if (inspected?.record) {
    s.active = inspected.record as HandoffRecord;
    await rpcWith($, s.node, { caller: s.binding, action: 'recover' }, s.bindingPath).catch(() => undefined);
  }
}

function deliveryText(s: Runtime, text: string): boolean {
  if (!s.delivery) return false;
  return text === s.delivery.text || unwrapHostDelivery(text) === s.delivery.text;
}

/** Bounded control-token extraction across host event shapes (never stringifies the whole event). */
const CONTROL_TOKEN = /\[\[ai4ai-control:handoff:([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]\]/;
function controlOperationOf(value: unknown): string | undefined {
  if (typeof value === 'string') return CONTROL_TOKEN.exec(value)?.[1];
  if (Array.isArray(value)) { for (const item of value) { const hit = controlOperationOf(item); if (hit) return hit; } return undefined; }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return controlOperationOf(record.text) ?? controlOperationOf(record.content) ?? controlOperationOf(record.message);
  }
  return undefined;
}

const HOST_WRAPPER_PREFIX = 'The ai4ai plugin sent a message:\n';
const HOST_WRAPPER_SUFFIX = "\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.";

/** Strip the host's plugin-submit wrapper so the canonical D29 text is parsed. */
function unwrapHostDelivery(text: string): string {
  if (!text.startsWith(HOST_WRAPPER_PREFIX)) return text;
  let body = text.slice(HOST_WRAPPER_PREFIX.length);
  if (body.endsWith(HOST_WRAPPER_SUFFIX)) body = body.slice(0, -HOST_WRAPPER_SUFFIX.length);
  return body;
}

function isDeliveryText(text: string): boolean {
  return isCanonicalDelivery(unwrapHostDelivery(text)) || text.startsWith('AI4AI handoff delivery ') || text.startsWith('The ai4ai plugin sent a message:\nAI4AI handoff delivery ');
}

function admitted(s: Runtime): boolean {
  return !!s.delivery && !s.delivery.invalid && (s.delivery.adopted
    || (s.active?.phase === 'applied' && s.active.operationId === s.delivery.operationId && s.binding?.generation === s.delivery.marker));
}

/**
 * Replay input retained during the handoff. The queue is drained before the
 * submit so one message is never delivered twice; a submit failure is logged
 * and not retried, because the host may already have accepted it.
 */
async function replayRetained($: CoreEngineInterface, s: Runtime): Promise<void> {
  const entries = s.retained.take(RETAINED_SCOPE);
  if (entries.length === 0) return;
  const text = `AI4AI retained user input from during the handoff. Act on it now.\n${mergeRetained(entries)}`;
  try {
    await $.prompt.submit({ text });
  } catch (error: any) {
    dbg($, 'retained input replay failed: ' + String(error?.message ?? error));
  }
}


/** Schedule the native context replacement and deliver the task; callable from a hook. */
async function pump($: CoreEngineInterface, s: Runtime): Promise<void> {
  if (s.busy || s.pumping || s.active?.phase !== 'scheduled') return;
  s.pumping = true;
  try {
    if (s.active?.phase !== 'scheduled') return;
    const mode = s.active.mechanism ?? s.active.request.mode ?? 'restart';
    if (mode === 'compact') {
      // Native-first compact (D31/D34): let the harness's own summarizer run in
      // place. The session.compact hook returns the native summary untouched
      // (it only intercepts when a marker instruction is supplied), so the
      // successor sees the summary and, when a task is supplied, that task as
      // the next input. With no task nothing is delivered and the native
      // continuation carries the original work.
      try {
        s.compacting = true;
        await $.command.run({ command: 'compact' });
      } finally {
        s.compacting = false;
      }
      const applied = await transition($, s, 'applied', 'Native compaction completed in place; successor adoption pending', { proofMechanism: 'native-compaction' });
      if (!applied?.record || applied.record.phase !== 'applied') return;
      if (s.binding) s.binding = { ...s.binding, generation: s.active!.marker };
      await writeBinding($, s, s.active!);
      const decision = noTaskCompactDecision({
        task: s.active?.request.task,
        continuation: s.active?.request.continuation,
        mode: 'fallback',
        marker: s.active?.marker ?? '',
      });
      if (decision.delivery === null) {
        await transition($, s, 'completed',
          decision.fallbackUsed ? 'No-task compact completed' : 'No-task compact completed; continuation disabled by the caller (the session may be idle)',
          { continued: decision.continued, idleAfter: decision.idleAfter, fallbackUsed: decision.fallbackUsed });
      } else {
        s.fallback = decision.fallbackUsed;
        s.delivery = { text: decision.delivery, operationId: s.active!.operationId, marker: s.active!.marker, invalid: false, adopted: false };
        await $.prompt.submit({ text: decision.delivery });
      }
      return;
    }
    if (mode !== 'restart') {
      // The native pump implements the zero-summary restart only. A compact
      // request must be refused by the worker before it reaches this point.
      await transition($, s, 'unknown', 'The native pump implements restart only; no replacement attempted');
      return;
    }
    const before = await $.session.id();
    const source = s.binding;
    if (!source) return;
    s.appliedHere = false;
    s.replacement = undefined;
    // `compact` runs the session.compact hook, which supplies a replacement
    // message window and prevents the core compaction (and its summarizer)
    // from running. The hook must finish inside the host's 10s budget, so it
    // returns the window immediately and journals the transition separately.
    await $.command.run({ command: 'compact', args: s.active.marker });
    if (s.replacement) await s.replacement;
    // Explicit same-SID assertion: the replacement must not change the native
    // session. A changed id is a defect, never a successful handoff.
    const after = await $.session.id();
    if (after !== before) {
      await transition($, s, 'unknown', 'The native replacement changed the session id; the handoff was refused and the task was not delivered');
      return;
    }
    if (!s.appliedHere || (s.active?.phase as string) !== 'applied') {
      await transition($, s, 'unknown', 'Native replacement could not be proved; no task redelivery');
      return;
    }
    let api = '';
    try { api = JSON.stringify(await $.session.messages({ as: 'api' })); } catch { api = ''; }
    if (api !== '' && !api.includes(s.active.marker)) {
      await transition($, s, 'unknown', 'The replacement window does not contain the AI4AI binding; no task redelivery');
      return;
    }
    if (s.binding) s.binding = { ...s.binding, generation: s.active.marker };
    await writeBinding($, s, s.active);
    // A restart with no task uses the canonical status message so the successor
    // awaits the next instruction; a task restart delivers the task verbatim.
    const text = s.active.request.task
      ? taskDelivery(s.active.request.task, s.active.marker)
      : idleDelivery(s.active.marker);
    const delivery = {
      text, operationId: s.active.operationId, marker: s.active.marker, invalid: false, adopted: false,
    };
    s.delivery = delivery;
    await $.prompt.submit({ text: delivery.text });
  } catch (error: any) {
    dbg($, 'pump failed: ' + String(error?.message ?? error));
    const disabled = /DISABLE_COMPACT/i.test(String(error?.message ?? error));
    try {
      await transition($, s, 'failed', disabled
        ? 'Compaction is switched off in this session (DISABLE_COMPACT); the in-place restart is unsupported'
        : 'Native scheduling outcome unknown; no replay');
    } catch { /* intent remains unreplayed */ }
  } finally {
    s.pumping = false;
  }
}

/** Native Claude Code mods: in-place handoff without a summarizer, daemon or history fork. */
export const register: Register = on => {
  const s: Runtime = { instance: '', node: '', busy: false, pumping: false, turnId: '', appliedHere: false, retained: new RetainedInput() };
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const pending = tail.then(fn); tail = pending.catch(() => undefined); return pending; };

  on('session.start', async ($: any, e: any, next: any) => {
    // A plugin cache can be shared by several workspaces. The workspace-local
    // binding always wins; the plugin-root copy is only a compatible fallback.
    try {
      const resolved = await resolveBinding($);
      if (resolved) {
        s.bindingPath = resolved.path;
        s.node = resolved.binding.node || process.execPath;
      }
    } catch { /* leave unbound; the tool fails closed with a structured result */ }
    // Register the tool before binding: a binding failure must leave a tool
    // that fails closed with a structured result, not an invisible capability.
    await $.tool.register({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      isDeferred: false,
      inputSchema: JSON.parse(await $.fs.read(`${$.plugin.root}/request-schema.json`)),
    });
    try {
      // The in-place replacement keeps the same session, so an existing
      // binding remains authoritative across a handoff.
      if (!s.binding || await $.session.id() !== s.binding.session) await serial(() => bindNative($, s));
    } catch { /* Tool calls fail closed until a later successful bind. */ }
    $.clock.every(250, () => { void pump($, s); });
    return next(e);
  });


  on('turn.start', async ($: any, e: any, next: any) => {
    if (!e.agentId) await serial(async () => {
      s.busy = true;
      s.turnId = e.turnId;
      // Temporary diagnostic: capture the host turn.start shape once per turn.
      try {
        const bounded = (value: unknown): unknown => {
          try { return JSON.parse(JSON.stringify(value, (key, item) => typeof item === 'string' ? item.slice(0, 300) : item)); }
          catch { return String(value).slice(0, 300); }
        };
        if (s.node) await rpcWith($, s.node, {
          action: 'debug',
          debug: { keys: Object.keys(e ?? {}), text: bounded(e.text), message: bounded(e.message), content: bounded(e.content), raw: bounded(e) },
        }, s.bindingPath);
      } catch { /* diagnostic only */ }
      // Invisible executor-target handoff envelope: consume the durable
      // request, schedule the transition and abort before the model sees it.
      // Detection runs before binding so a binding hiccup can never leak the
      // envelope into the model turn.
      const controlOperation = controlEnvelopeOperationId(e.text)
        ?? controlEnvelopeOperationId(e.message?.content)
        ?? controlEnvelopeOperationId((e.message?.content ?? [])[0]?.text)
        ?? (typeof e.text === 'string' && e.text.includes('[[ai4ai-control:handoff:')
          ? controlEnvelopeOperationId(e.text.slice(e.text.indexOf('[[ai4ai-control:handoff:'))) : undefined);
      if (controlOperation) {
        s.controlTurn = e.turnId;
        try {
          if (!s.binding) await bindNative($, s);
          const out = await rpc($, s.node, { action: 'intake', caller: s.binding }, s.bindingPath);
          if (out?.record) {
            s.active = out.record;
            await transition($, s, 'scheduled', 'External executor-target handoff accepted; applying at this safe point');
          }
        } catch (error: any) {
          dbg($, 'handoff intake failed: ' + String(error?.message ?? error));
        }
        await $.turn.abort({ turnId: e.turnId });
        return;
      }
      if (!s.binding || await $.session.id() !== s.binding.session) await bindNative($, s);
      if (isDeliveryText(e.text) && !(s.seed && !s.delivery)) {
        s.admissionTurn = e.turnId;
        if (!deliveryText(s, e.text) || !admitted(s)) { await $.turn.abort({ turnId: e.turnId }); return; }
        // Adoption is real: the successor turn is executing in the replaced context.
        if (s.delivery && !s.delivery.adopted) {
          s.delivery.adopted = true;
          s.binding = { ...s.binding!, generation: s.delivery.marker };
          await transition($, s, 'completed', s.fallback
            ? 'Successor adopted the replaced context with the minimal continuation fallback; handoff complete'
            : 'Successor adopted the replaced context; handoff complete',
            { continued: true, idleAfter: false, fallbackUsed: s.fallback === true });
        }
      }
    });
    return next(e);
  });

  on('turn.complete', async ($: any, e: any, next: any) => {
    const out = await next(e);
    let pumpNow = false;
    let replayNow = false;
    if (!e.agentId) await serial(async () => {
      dbg($, `turn.complete reason=${String(e.reason)} aborted=${String(e.isAborted)} phase=${String(s.active?.phase)}`);
      // The control turn carries no model work: its completion is the safe
      // point that applies the queued external handoff.
      if (s.controlTurn !== undefined && s.controlTurn === e.turnId) {
        delete s.controlTurn;
        s.busy = false;
        if (s.active?.phase === 'scheduled') pumpNow = true;
        return;
      }
      if (s.active?.phase === 'pending') {
        if (e.isAborted || e.reason !== 'answer') await transition($, s, 'cancelled', 'Source turn stopped, refused or failed; handoff cancelled');
        else {
          await transition($, s, 'scheduled', 'Source turn completed; native safe point scheduled');
          pumpNow = true;
        }
      }
      if (s.admissionTurn !== undefined && s.admissionTurn === e.turnId) {
        // Adoption is complete. An aborted successor turn is an explicit stop:
        // its retained input is discarded instead of silently driving a new turn.
        delete s.admissionTurn;
        if (e.isAborted || e.reason !== 'answer') s.retained.clear(RETAINED_SCOPE);
        else replayNow = s.retained.count(RETAINED_SCOPE) > 0;
      }
      s.busy = false;
    });
    // The native compact triggers our session.compact hook; never hold the
    // serial queue while it runs or the two wait on each other.
    if (pumpNow) await pump($, s);
    // The replay starts a new native turn; the host resolves the submit when
    // that turn starts, so the hook must not wait on it.
    else if (replayNow) void replayRetained($, s);
    return out;
  });

  // The host skips a hook that throws or exceeds its budget and then runs the
  // core compaction, which would summarize the context and break the
  // zero-token guarantee. This handler therefore never performs slow work: it
  // validates in memory, returns the replacement window immediately and starts
  // the journal write in the background. The mods loader requires the hook to
  // be an inline function at the `on(...)` call site, so the fail-closed
  // try/catch lives here rather than in an attached `.catch`.
  on('session.compact', async ($: any, e: any, next: any) => {
    if (e.agentId || !e.instructions?.startsWith('ai4ai-context-')) return next(e);
    try {
      const refuse = (detail: string): { skip: string } => {
        void transition($, s, 'unknown', `Native compaction input changed or intent is not owned: ${detail}`).catch(() => undefined);
        return { skip: `AI4AI did not authorize this replacement; original native context retained (${detail})` };
      };
      if (!s.binding) return refuse('no native binding');
      if (!s.active) return refuse('no active handoff record');
      // Fault-injection seam used only by the release gate: a caller that
      // deliberately uses this operation id exercises the fail-closed catch.
      // It is inert for every other operation id.
      if (s.active.operationId === 'ai4ai-hook-fault-throw') throw new Error('injected session.compact hook fault');
      if (s.active.phase !== 'scheduled') return refuse(`handoff phase is ${String(s.active.phase)}`);
      if (e.instructions !== s.active.marker) return refuse('marker does not match the owned intent');
      if (s.busy) return refuse('the plugin is busy with another native turn');
      s.appliedHere = true;
      s.replacement = transition($, s, 'applied', 'Native compact hook supplied a fresh task window; successor adoption pending');
      return {
        messages: [{
          role: 'user' as const,
          text: `AI4AI native context binding: ${s.active.marker}\nFresh execution context. Await the separately submitted AI4AI task. Do not infer a task from the context marker. Native security and system instructions remain authoritative.`,
          toolUses: [],
        }],
      };
    } catch (error: any) {
      s.appliedHere = false;
      const detail = String(error?.message ?? error).slice(0, 300);
      dbg($, 'session.compact gate failed closed: ' + detail);
      return { skip: 'AI4AI native gate failed closed; no replacement authorized (' + detail + ')' };
    }
  });

  on('prompt.submit', async ($: any, e: any, next: any) => {
    const origin = e.origin ?? {};
    const own = origin.kind === 'plugin' && origin.name === $.plugin.name;
    const isDelivery = own && isDeliveryText(String(e.text ?? ''));
    const ownCompact = e.command?.name === 'compact' && e.command.args === s.active?.marker && s.pumping;
    try {
      if (isDelivery) {
        // Delivery admission must prove the replacement actually happened in
        // this session; anything uncertain drops the task instead of injecting
        // it into a stale context.
        const allow = await serial(async () => e.text === s.delivery?.text && admitted(s) && await $.session.id() === s.binding?.session);
        if (!allow) return { drop: 'Superseded or uncertain AI4AI delivery; task not admitted' };
      } else if (!own && !ownCompact) {
        // A handoff is atomic once accepted: real user input never cancels it.
        // Hold the prompt back and deliver it in the fresh context instead.
        const retained = await serial(async () => {
          if (!inHandoffWindow(s)) return false;
          return s.retained.retain(RETAINED_SCOPE, e.text);
        });
        if (retained) return { drop: 'AI4AI handoff is in progress; the input was retained and will be delivered in the fresh context' };
      }
    } catch {
      // Never fail open on the one path that injects handoff material.
      if (isDelivery) return { drop: 'AI4AI delivery admission failed closed; task not admitted' };
    }
    return next(e);
  });

  on('session.end', async ($: any, e: any, next: any) => {
    // The in-place replacement keeps this session; an unfinished handoff at
    // session end is genuinely uncertain and never replayed.
    await serial(async () => {
      if (s.active && !['completed', 'cancelled', 'failed', 'unknown'].includes(s.active.phase)) await transition($, s, 'unknown', 'Native session ended; unfinished handoff is not resumed automatically');
    });
    return next(e);
  });

  on('tool.call', { tool }, async ($: any, e: any) => {
    if (e.agentId) return { deny: 'AI4AI requires the native main session' };
    return serial(async () => {
      // The hooks sandbox has no `process` global; the executor-context guard
      // is enforced by the worker, which owns AI4AI_EXECUTOR_ID. Only the
      // in-harness default is decided here.
      const norm = normalizeToolCall(e);
      if (!norm.ok) {
        return { result: JSON.stringify({
          operation: 'handoff', operationId: norm.operationId, status: 'failed', reason: norm.failure.message,
          durable: false, modelVerification: 'unknown', verification: { model: 'unknown', context: 'reported' },
          notices: [], unavailable: [],
          error: { code: norm.failure.code, message: norm.failure.message, correctedCall: norm.failure.correctedCall },
        }) };
      }
      const request: any = norm.request;
      for (const key of ['tool', 'tool_use_id', 'agentId', 'requestMeta']) delete request[key];
      const usage = await (async () => {
        if (request.operation !== 'status') return {};
        try {
          const raw = await $.session.usage() as any;
          const context = raw?.context ?? raw;
          let model: any;
          try { model = await $.session.model(); } catch { model = undefined; }
          return {
            usage: {
              window: context?.window ?? null,
              used: context?.tokens ?? context?.used ?? null,
              percent: context?.percent ?? null,
              model: typeof model === 'string' ? model : model?.id ?? null,
            },
          };
        } catch { return {}; }
      })();
      if (!s.binding) throw new Error('AI4AI native binding is unavailable');
      const out = await rpc($, s.node, { caller: s.binding, instance: s.instance, action: 'request', request, targetDefaulted: norm.notices.length > 0, ...usage }, s.bindingPath);
      if (out.record) {
        s.active = out.record;
        // An explicit cancel/stop or a failed request ends the window; retained
        // input is discarded with the abandoned transition.
        if (TERMINAL.includes(String(out.record.phase))) s.retained.clear(RETAINED_SCOPE);
      }
      dbg($, `tool result state=${String(out.result?.status)} record=${String(out.record?.phase)}`);
      if (norm.notices.length === 0) return { result: JSON.stringify(out.result) };
      const merged = { ...(out.result ?? {}), notices: [...((out.result && out.result.notices) ?? []), ...norm.notices] };
      return { result: JSON.stringify(merged) };
    }).catch((error: any) => ({ result: JSON.stringify({ operation: e.operation, operationId: e.operationId, status: 'unknown', reason: 'AI4AI native handler failed: ' + String(error?.message ?? error).slice(0, 600), durable: false, modelVerification: 'unknown', verification: { model: 'unknown', context: 'reported' }, context: { window: null, used: null, percent: null, percentSource: null }, unavailable: [], notices: [] }) }));
  });
};
