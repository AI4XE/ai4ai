import type { Register, CoreEngineInterface, SessionMessage } from 'claude-code';
import { TOOL_DESCRIPTION, TOOL_NAME, normalizeToolRequest } from '../../contract/tool.js';

/**
 * The Claude hooks module is evaluated in a sandbox that allows relative
 * imports and `claude-code` only. `install/binding.ts` imports `node:path`, so
 * it must not be imported here; `resolveBinding` below is an import-free
 * equivalent that reads candidates through the host `$.fs` API and lets the
 * worker re-validate whatever it selects.
 */

interface Binding { harness: string; workspace: string; surface: 'tui' | 'headless'; session: string; generation: string; agent: string }
interface HandoffRecord { operationId: string; marker: string; phase: string; mechanism?: 'restart' | 'compact'; request: { task?: string; mode?: 'restart' | 'compact' }; source: Binding }
interface Runtime {
  binding?: Binding;
  instance: string;
  node: string;
  /** Workspace-local binding selected for this session (never a foreign project's). */
  bindingPath?: string;
  active?: HandoffRecord;
  busy: boolean;
  pumping: boolean;
  /** True while the plugin itself is running the native /clear reset. */
  restarting: boolean;
  turnId: string;
  expectedWindow: string;
  appliedHere: boolean;
  delivery?: { text: string; operationId: string; marker: string; invalid: boolean; adopted: boolean };
  admissionTurn?: string;
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
const projection = (rows: readonly SessionMessage[]): string => JSON.stringify(rows.map((message: SessionMessage) => ({
  role: message.role, text: message.text, toolUses: message.toolUses, toolResults: message.toolResults ?? [],
})));

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
  return rpcWith($, node, { ...payload, ...(marker ? { marker } : {}) }, bindingPath);
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
  // The journal is keyed by the record's source session. After a restart the
  // in-memory binding points at the successor, so transitions must use the
  // source identity or the record would not be found.
  const from = caller ?? (current.active.source as unknown as Binding) ?? current.binding;
  const out = await rpc($, current.node, {
    caller: from, action: 'transition', operationId: current.active.operationId,
    marker: current.active.marker, phase, reason, ...extra,
  }, current.bindingPath);
  if (out.record) current.active = out.record;
  return out;
}
async function bindNative($: CoreEngineInterface, s: Runtime): Promise<void> {
  const hello = await rpcWith($, s.node, { action: 'binding', workspace: await $.session.cwd() }, s.bindingPath);
  s.instance = hello.instance;
  const session = await $.session.id();
  const surface = await currentSurface($);
  const provisional: Binding = { harness: 'claude-code', workspace: hello.workspace, surface, session, generation: 'original', agent: 'main' };
  const inspected = await rpcWith($, s.node, { caller: provisional, action: 'inspect' }, s.bindingPath).catch(() => undefined);
  s.binding = { ...provisional, generation: inspected?.generation ?? 'original' };
  if (inspected?.record) {
    s.active = inspected.record as HandoffRecord;
    await rpcWith($, s.node, { caller: s.binding, action: 'recover' }, s.bindingPath).catch(() => undefined);
  }
}

function deliveryText(s: Runtime, text: string): boolean {
  const suffix = "\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.";
  return !!s.delivery && (text === s.delivery.text || text === `The ai4ai plugin sent a message:\n${s.delivery.text}${suffix}`);
}

function isDeliveryText(text: string): boolean {
  return text.startsWith('AI4AI handoff delivery ') || text.startsWith('The ai4ai plugin sent a message:\nAI4AI handoff delivery ');
}

function admitted(s: Runtime): boolean {
  return !!s.delivery && !s.delivery.invalid && (s.delivery.adopted
    || (s.active?.phase === 'applied' && s.active.operationId === s.delivery.operationId && s.binding?.generation === s.delivery.marker));
}


/** Schedule the native context replacement and deliver the task; callable from a hook. */
async function pump($: CoreEngineInterface, s: Runtime): Promise<void> {
  if (s.busy || s.pumping || s.active?.phase !== 'scheduled') return;
  s.pumping = true;
  try {
    try { s.expectedWindow = projection(await $.session.messages()); } catch { s.expectedWindow = ''; }
    if (s.active?.phase !== 'scheduled') return;
    const mode = s.active.mechanism ?? s.active.request.mode ?? 'restart';
    if (mode === 'restart') {
      // Native in-place reset: the built-in /clear starts a new session with
      // empty context in the same process (the host pipe stays intact).
      const before = await $.session.id();
      const source = s.binding;
      if (!source) return;
      s.restarting = true;
      try {
        await $.command.run({ command: 'clear' });
        let after = before;
        for (let i = 0; i < 80 && after === before; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          after = await $.session.id();
        }
        if (after === before) {
          await transition($, s, 'unknown', 'Native /clear did not produce a new session id; no task redelivery');
          return;
        }
        let display = '';
        try { display = JSON.stringify(await $.session.messages()); } catch { display = ''; }
        const clearSeen = display.includes('/clear') || display.includes('local_command');
        if (!clearSeen) dbg($, 'restart: /clear entry was not exposed by the plugin transcript view; the session id change is the native evidence');
        const successor = { ...source, session: after, generation: s.active.marker };
        await transition($, s, 'applied',
          clearSeen
            ? 'Native /clear reset the context in place; successor delivery pending'
            : 'Native /clear changed the session id in place; successor delivery pending',
          { successor, mechanism: 'restart' }, source);
        s.binding = successor;
        s.appliedHere = true;
      } finally {
        s.restarting = false;
      }
    } else {
      await $.command.run({ command: 'compact', args: s.active.marker });
      let api = '';
      try { api = JSON.stringify(await $.session.messages({ as: 'api' })); } catch { api = ''; }
      if (!s.appliedHere || (s.active.phase as string) !== 'applied' || (api !== '' && !api.includes(s.active.marker))) {
        await transition($, s, 'unknown', 'Native replacement could not be proved; no task redelivery');
        return;
      }
      if (s.binding) s.binding = { ...s.binding, generation: s.active.marker };
    }
    const delivery = {
      text: `AI4AI handoff delivery ${s.active.marker}. Adopt the caller-supplied task in this fresh context. Carry out this task now:\n${s.active.request.task ?? ''}\nNative system/security instructions remain authoritative. Query ai4ai status if you need context or model details.`,
      operationId: s.active.operationId, marker: s.active.marker, invalid: false, adopted: false,
    };
    s.delivery = delivery;
    await $.prompt.submit({ text: delivery.text });
  } catch (error: any) {
    dbg($, 'pump failed: ' + String(error?.message ?? error));
    try { await transition($, s, 'unknown', 'Native scheduling outcome unknown; no replay'); } catch { /* intent remains unreplayed */ }
  } finally {
    s.pumping = false;
  }
}

/** Native Claude Code mods: in-place handoff without a summarizer, daemon or history fork. */
export const register: Register = on => {
  const s: Runtime = { instance: '', node: '', busy: false, pumping: false, restarting: false, turnId: '', expectedWindow: '', appliedHere: false };
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
      // A native /clear restart re-enters session.start for the successor
      // session; bindNative would look up a journal that belongs to the source
      // session. Keep the in-memory restart binding instead.
      if (!s.restarting && (!s.binding || await $.session.id() !== s.binding.session)) await serial(() => bindNative($, s));
    } catch { /* Tool calls fail closed until a later successful bind. */ }
    $.clock.every(250, () => { void pump($, s); });
    return next(e);
  });


  on('turn.start', async ($: any, e: any, next: any) => {
    if (!e.agentId) await serial(async () => {
      if (!s.binding || await $.session.id() !== s.binding.session) await bindNative($, s);
      s.busy = true;
      s.turnId = e.turnId;
      if (isDeliveryText(e.text)) {
        s.admissionTurn = e.turnId;
        if (!deliveryText(s, e.text) || !admitted(s)) { await $.turn.abort({ turnId: e.turnId }); return; }
        // Adoption is real: the successor turn is executing in the replaced context.
        if (s.delivery && !s.delivery.adopted) {
          s.delivery.adopted = true;
          s.binding = { ...s.binding!, generation: s.delivery.marker };
          await transition($, s, 'completed', 'Successor adopted the replaced context; handoff complete');
        }
      } else if (s.active && !['completed', 'cancelled', 'failed', 'unknown'].includes(s.active.phase)) {
        await transition($, s, 'cancelled', 'A different native turn started before successor admission; delivery was not executed');
      }
    });
    return next(e);
  });

  on('turn.complete', async ($: any, e: any, next: any) => {
    const out = await next(e);
    let pumpNow = false;
    if (!e.agentId) await serial(async () => {
      dbg($, `turn.complete reason=${String(e.reason)} aborted=${String(e.isAborted)} phase=${String(s.active?.phase)}`);
      if (s.active?.phase === 'pending') {
        if (e.isAborted || e.reason !== 'answer') await transition($, s, 'cancelled', 'Source turn stopped, refused or failed; handoff cancelled');
        else {
          await transition($, s, 'scheduled', 'Source turn completed; native safe point scheduled');
          pumpNow = true;
        }
      }
      s.busy = false;
    });
    // The native compact triggers our session.compact hook; never hold the
    // serial queue while it runs or the two wait on each other.
    if (pumpNow) await pump($, s);
    return out;
  });

  on('session.compact', async ($: any, e: any, next: any) => {
    if (e.agentId || !e.instructions?.startsWith('ai4ai-context-')) return next(e);
    return (async () => {
      if (!s.binding || !s.active || s.active.phase !== 'scheduled' || e.instructions !== s.active.marker || s.busy || (s.expectedWindow !== '' && projection(e.messages) !== s.expectedWindow)) {
        await transition($, s, 'unknown', 'Native compaction input changed or intent is not owned');
        return { skip: 'AI4AI did not authorize this replacement; original native context retained' };
      }
      await transition($, s, 'applied', 'Native compact hook supplied a fresh task window; successor adoption pending');
      s.appliedHere = true;
      return {
        messages: [{
          role: 'user' as const,
          text: `AI4AI native context binding: ${s.active.marker}\nFresh execution context. Await the separately submitted AI4AI task. Do not infer a task from the context marker. Native security and system instructions remain authoritative.`,
          toolUses: [],
        }],
      };
    })().catch(() => ({ skip: 'AI4AI native gate failed closed; no replacement authorized' }));
  });

  on('prompt.submit', async ($: any, e: any, next: any) => {
    const own = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name;
    const ownCompact = e.command?.name === 'compact' && e.command.args === s.active?.marker && s.pumping;
    if (own && e.text.startsWith('AI4AI handoff delivery ')) {
      const allow = await serial(async () => e.text === s.delivery?.text && admitted(s) && await $.session.id() === s.binding?.session);
      if (!allow) return { drop: 'Superseded or uncertain AI4AI delivery; task not admitted' };
    } else if (!ownCompact && !s.restarting && !s.pumping) await serial(async () => { if (s.active && s.active.phase === 'pending') await transition($, s, 'cancelled', 'Later user input retained; handoff not replayed'); });
    return next(e);
  });

  on('session.end', async ($: any, e: any, next: any) => {
    // The /clear restart ends the source session on purpose; the successor
    // session owns the handoff now, so the source must not mark it unknown.
    await serial(async () => {
      if (s.restarting || (s.active?.mechanism === 'restart' && s.delivery)) return;
      if (s.active && !['completed', 'cancelled', 'failed', 'unknown'].includes(s.active.phase)) await transition($, s, 'unknown', 'Native session ended; unfinished handoff is not resumed automatically');
    });
    return next(e);
  });

  on('tool.call', { tool }, async ($: any, e: any) => {
    if (e.agentId) return { deny: 'AI4AI requires the native main session' };
    return serial(async () => {
      const request: any = normalizeToolRequest(e) as any;
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
      const out = await rpc($, s.node, { caller: s.binding, instance: s.instance, action: 'request', request, ...usage }, s.bindingPath);
      if (out.record) s.active = out.record;
      dbg($, `tool result state=${String(out.result?.status)} record=${String(out.record?.phase)}`);
      return { result: JSON.stringify(out.result) };
    }).catch((error: any) => ({ result: JSON.stringify({ operation: e.operation, operationId: e.operationId, status: 'unknown', reason: 'AI4AI native handler failed: ' + String(error?.message ?? error).slice(0, 600), durable: false, modelVerification: 'unknown', verification: { model: 'unknown', context: 'reported' }, context: { window: null, used: null, percent: null, percentSource: null }, unavailable: [], notices: [] }) }));
  });
};
