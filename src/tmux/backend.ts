import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export interface TmuxPane { paneId: string; pid: number; command: string; session: string; active: boolean; path: string }
export interface TmuxProfile { harness: 'codex' | 'claude-code' | 'opencode'; commandPattern: RegExp; idlePattern: RegExp; busyPattern: RegExp; newChatKeys: string[] }
export interface TmuxResult {
  status: 'applied' | 'unsupported' | 'failed' | 'unknown';
  strategy: 'tmux';
  experimental: true;
  reason: string;
  paneId?: string;
}

export const PROFILES: Record<TmuxProfile['harness'], TmuxProfile> = {
  codex: {
    harness: 'codex', commandPattern: /^(codex|node|codex-cli)$/i,
    idlePattern: /(?:^|\n)\s*(?:›|>|codex>)\s*$/i,
    busyPattern: /(?:esc to interrupt|working|thinking|⏳|running)/i,
    newChatKeys: ['/new', 'Enter'],
  },
  'claude-code': {
    harness: 'claude-code', commandPattern: /^(claude|node)$/i,
    idlePattern: /(?:^|\n)\s*(?:>|❯)\s*$/i,
    busyPattern: /(?:esc to interrupt|Working|Thinking)/i,
    newChatKeys: ['/clear', 'Enter'],
  },
  opencode: {
    harness: 'opencode', commandPattern: /^(opencode|node)$/i,
    idlePattern: /(?:^|\n)\s*(?:>|›)\s*$/i,
    busyPattern: /(?:esc to interrupt|working)/i,
    newChatKeys: ['/new', 'Enter'],
  },
};

function run(command: string, args: string[], timeoutMs = 10000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error) }); return;
    }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-65536); });
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-16384); });
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const socketArgs = (): string[] => {
  const socket = process.env.AI4AI_TMUX_SOCKET || process.env.TMUX_SOCKET;
  return socket ? ['-S', socket] : [];
};

const equalPath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** tmux is unavailable on native Windows by design. */
export async function tmuxAvailable(): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const result = await run(process.env.AI4AI_TMUX_BIN || 'tmux', [...socketArgs(), '-V']);
  return result.code === 0;
}

export async function listPanes(): Promise<TmuxPane[]> {
  const result = await run(process.env.AI4AI_TMUX_BIN || 'tmux', [...socketArgs(), 'list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}|#{pane_current_command}|#{session_name}|#{window_active}|#{pane_current_path}']);
  if (result.code !== 0) return [];
  return result.stdout.split('\n').filter(Boolean).map(line => {
    const [paneId, pid, command, session, active, panePath] = line.split('|');
    return { paneId: paneId!, pid: Number(pid), command: command!, session: session!, active: active === '1', path: panePath ?? '' };
  }).filter(pane => pane.paneId?.startsWith('%') && Number.isSafeInteger(pane.pid));
}

async function parentPid(pid: number): Promise<number | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    const ppid = Number(fields[1]);
    return Number.isSafeInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch { return undefined; }
}

/** Walk the process ancestry to find the owning tmux pane. */
export async function paneForProcess(pid: number): Promise<TmuxPane | undefined> {
  const panes = await listPanes();
  if (!panes.length) return undefined;
  const byPid = new Map(panes.map(pane => [pane.pid, pane]));
  let current: number | undefined = pid;
  for (let depth = 0; depth < 64 && current; depth++) {
    const pane = byPid.get(current);
    if (pane) return pane;
    current = await parentPid(current);
  }
  return undefined;
}

/** Fallback attribution when the harness runs behind a managed daemon: match the pane's harness command and workspace. */
export async function paneForWorkspace(harness: TmuxProfile['harness'], workspace: string): Promise<TmuxPane | undefined> {
  const profile = PROFILES[harness];
  const panes = (await listPanes()).filter(pane => profile.commandPattern.test(pane.command) && equalPath(pathNormalize(pane.path), pathNormalize(workspace)));
  return panes.length === 1 ? panes[0] : undefined;
}

const pathNormalize = (value: string): string => value.replace(/[\\/]+$/, '');

export async function capture(paneId: string): Promise<string> {
  const result = await run(process.env.AI4AI_TMUX_BIN || 'tmux', [...socketArgs(), 'capture-pane', '-p', '-t', paneId, '-S', '-40']);
  return result.code === 0 ? result.stdout : '';
}

export async function sendKeys(paneId: string, keys: string[]): Promise<boolean> {
  const result = await run(process.env.AI4AI_TMUX_BIN || 'tmux', [...socketArgs(), 'send-keys', '-t', paneId, ...keys]);
  return result.code === 0;
}

/**
 * Deliver arbitrary text without key-name interpretation. `send-keys` treats
 * arguments such as "Enter" or "C-m" as key names, so material that happens to
 * contain them would be corrupted. A buffer plus bracketed paste is the same
 * path a human paste uses: embedded newlines stay in the composer instead of
 * submitting the turn early.
 */
export async function pasteText(paneId: string, text: string): Promise<boolean> {
  const bin = process.env.AI4AI_TMUX_BIN || 'tmux';
  const buffer = await run(bin, [...socketArgs(), 'set-buffer', '--', text]);
  if (buffer.code !== 0) return false;
  const paste = await run(bin, [...socketArgs(), 'paste-buffer', '-p', '-d', '-t', paneId]);
  return paste.code === 0;
}

/**
 * Experimental same-window handoff by key injection.
 *
 * Safety is enforced by preconditions, not prompts: the pane must run the
 * expected harness, must be idle, and a single attempt is made. Any doubt
 * returns a structured refusal and never retries.
 */
export async function tmuxHandoff(input: {
  harness: TmuxProfile['harness'];
  paneId?: string;
  pid?: number;
  task?: string;
}): Promise<TmuxResult> {
  if (!(await tmuxAvailable())) return { status: 'unsupported', strategy: 'tmux', experimental: true, reason: 'tmux is not available on this platform' };
  const profile = PROFILES[input.harness];
  const pane = input.paneId
    ? (await listPanes()).find(candidate => candidate.paneId === input.paneId)
    : input.pid ? await paneForProcess(input.pid) : undefined;
  if (!pane) return { status: 'unknown', strategy: 'tmux', experimental: true, reason: 'No tmux pane could be attributed to this session' };
  if (!profile.commandPattern.test(pane.command)) {
    return { status: 'unsupported', strategy: 'tmux', experimental: true, paneId: pane.paneId, reason: `Pane command ${pane.command} does not match the ${input.harness} profile` };
  }
  const screen = await capture(pane.paneId);
  if (!screen) return { status: 'unknown', strategy: 'tmux', experimental: true, paneId: pane.paneId, reason: 'Pane content could not be captured' };
  if (profile.busyPattern.test(screen.slice(-2000))) {
    return { status: 'failed', strategy: 'tmux', experimental: true, paneId: pane.paneId, reason: 'Pane is busy; a single attempt is not made while the harness is running' };
  }
  if (!profile.idlePattern.test(screen.slice(-2000))) {
    return { status: 'failed', strategy: 'tmux', experimental: true, paneId: pane.paneId, reason: 'Pane is not at an idle prompt' };
  }
  if (!(await sendKeys(pane.paneId, profile.newChatKeys))) {
    return { status: 'unknown', strategy: 'tmux', experimental: true, paneId: pane.paneId, reason: 'Key injection returned no confirmation' };
  }
  if (input.task) {
    // Deliver the task material as a separate, visible turn rather than
    // smuggling it into the command line.
    await new Promise(resolve => setTimeout(resolve, 750));
    await sendKeys(pane.paneId, [input.task, 'Enter']);
  }
  return { status: 'applied', strategy: 'tmux', experimental: true, paneId: pane.paneId, reason: 'Keys injected once; the harness owns the resulting native effect' };
}

export { equalPath };
