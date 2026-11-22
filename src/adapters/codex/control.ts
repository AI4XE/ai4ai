import { connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Minimal client for the local Codex app-server daemon.
 *
 * The daemon control socket speaks WebSocket-framed JSON-RPC and lives under
 * `$CODEX_HOME/app-server-control`. ai4ai keeps this transport dependency-free:
 * the handshake and text frames are small enough to implement directly.
 */

export interface CodexThread {
  id: string;
  cwd?: string;
  updatedAt?: number;
  status?: { type?: string };
  historyMode?: string;
  model?: string;
}

export type ThreadResolution =
  | { ok: true; thread: CodexThread; loaded: CodexThread[] }
  | { ok: false; code: 'codex-thread-missing' | 'codex-thread-ambiguous' | 'codex-thread-mismatch'; reason: string; loaded: CodexThread[] };

/** A thread that the app-server currently has loaded (idle or active). */
export const isLoadedThread = (thread: CodexThread): boolean =>
  typeof thread.status?.type === 'string' && thread.status.type !== 'notLoaded';

/**
 * Read every page of `thread/list`. A machine with many threads (180 locally)
 * returns them paginated; checking only the first page silently mis-resolves
 * the TUI's thread and can make a false same-SID proof.
 */
export async function listAllThreads(
  daemon: CodexDaemon,
  options: { cwd?: string; limit?: number; maxPages?: number } = {},
): Promise<CodexThread[]> {
  const limit = options.limit ?? 100;
  const maxPages = options.maxPages ?? 200;
  const seen = new Map<string, CodexThread>();
  let cursor: string | null | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, unknown> = { limit };
    if (options.cwd) params.cwd = options.cwd;
    if (cursor) params.cursor = cursor;
    const listing = await daemon.call('thread/list', params, 30000) as { data?: CodexThread[]; nextCursor?: string | null };
    for (const thread of listing?.data ?? []) if (typeof thread?.id === 'string') seen.set(thread.id, thread);
    cursor = listing?.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return [...seen.values()];
}

/**
 * Resolve the native thread a TUI handoff may target.
 *
 * Order: an explicit `AI4AI_CODEX_THREAD`, otherwise exactly one loaded thread
 * for this workspace across every page. Zero or several loaded threads are a
 * structured failure; guessing by cwd/updatedAt would target a thread the user
 * is not looking at and make the same-SID proof vacuous.
 */
export async function resolveTuiThread(
  daemon: CodexDaemon,
  workspace: string,
  explicit?: string,
): Promise<ThreadResolution> {
  const absolute = path.resolve(workspace);
  const all = await listAllThreads(daemon, explicit ? {} : { cwd: absolute });
  const rows = all.filter(thread => typeof thread.cwd === 'string' && path.resolve(thread.cwd) === absolute);
  const loaded = rows.filter(isLoadedThread);
  if (explicit) {
    const found = all.find(thread => thread.id === explicit);
    if (!found) return { ok: false, code: 'codex-thread-missing', reason: `AI4AI_CODEX_THREAD ${explicit} is not present on the app-server`, loaded };
    if (typeof found.cwd === 'string' && path.resolve(found.cwd) !== absolute) {
      return { ok: false, code: 'codex-thread-mismatch', reason: `AI4AI_CODEX_THREAD ${explicit} belongs to another workspace`, loaded };
    }
    return { ok: true, thread: found, loaded };
  }
  if (loaded.length === 1) return { ok: true, thread: loaded[0]!, loaded };
  if (loaded.length === 0) {
    return { ok: false, code: 'codex-thread-missing', reason: 'No loaded Codex thread matches this workspace; set AI4AI_CODEX_THREAD explicitly', loaded };
  }
  return {
    ok: false, code: 'codex-thread-ambiguous',
    reason: `${loaded.length} loaded Codex threads match this workspace (${loaded.map(t => t.id).join(', ')}); set AI4AI_CODEX_THREAD to choose one`,
    loaded,
  };
}

/** Metadata-only thread status, cheap enough to poll without scanning pages. */
export async function threadStatus(daemon: CodexDaemon, threadId: string): Promise<CodexThread | undefined> {
  try {
    const read = await daemon.call('thread/read', { threadId, includeTurns: false }, 15000) as { thread?: CodexThread };
    return read?.thread;
  } catch {
    return undefined;
  }
}

interface Pending { resolve: (value: any) => void; reject: (error: Error) => void }

export class CodexDaemon {
  private socket: Socket;
  private buffer = Buffer.alloc(0);
  private handshake = false;
  private ready: Promise<void>;
  private handshakeDone: Promise<void>;
  private handshakeResolve!: () => void;
  private handshakeReject!: (error: Error) => void;
  private id = 0;
  private pending = new Map<number, Pending>();
  private listeners: ((message: any) => void)[] = [];
  private fragments: Buffer[] = [];

  private constructor(socket: Socket) {
    this.socket = socket;
    this.handshakeDone = new Promise((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
    });
    this.ready = new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
        resolve();
      });
    });
    socket.on('data', chunk => this.onData(chunk));
    socket.once('timeout', () => {
      const error = new Error('Codex daemon connection timed out');
      this.handshakeReject(error);
      this.pending.forEach(entry => entry.reject(error));
      this.pending.clear();
    });
  }

  static async connect(socketPath: string, timeoutMs = 10000): Promise<CodexDaemon> {
    const socket = connect(socketPath);
    socket.setTimeout(timeoutMs);
    const daemon = new CodexDaemon(socket);
    await daemon.ready;
    await daemon.handshakeDone;
    return daemon;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshake) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buffer.subarray(0, end).toString();
      this.buffer = this.buffer.subarray(end + 4);
      this.handshake = /101/.test(head);
      if (!this.handshake) {
        const error = new Error('Codex daemon rejected the WebSocket handshake');
        this.handshakeReject(error);
        this.pending.forEach(entry => entry.reject(error));
        this.pending.clear();
        return;
      }
      this.handshakeResolve();
    }
    this.parse();
  }

  private parse(): void {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2)); offset = 10;
      }
      let mask: Buffer | undefined;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4); offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index % 4]!;
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.frame(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) this.fragments.push(payload);
      else this.fragments = [payload];
      if (!fin) continue;
      const text = Buffer.concat(this.fragments).toString();
      this.fragments = [];
      let message: any;
      try { message = JSON.parse(text); } catch { continue; }
      this.dispatch(message);
    }
  }

  private dispatch(message: any): void {
    if (typeof message.id === 'number' && message.method) {
      this.send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(String(message.error.message ?? JSON.stringify(message.error))));
      else entry.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') for (const listener of this.listeners) listener(message);
  }

  private frame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index++) masked[index] = masked[index]! ^ mask[index % 4]!;
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private send(message: any): void {
    this.frame(0x1, Buffer.from(JSON.stringify(message)));
  }

  call(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex daemon did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  onMessage(listener: (message: any) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(entry => entry !== listener); };
  }

  close(): void {
    for (const entry of this.pending.values()) entry.reject(new Error('Codex daemon connection closed'));
    this.pending.clear();
    this.listeners = [];
    try { this.socket.destroy(); } catch { /* already gone */ }
  }
}

/** Resolve CODEX_HOME without touching the user's Codex configuration. */
export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(homedir(), '.codex');
}

/**
 * Resolve a control socket path to its real file. The daemon exposes its
 * socket through a symlink under `$CODEX_HOME`; some filesystems (for example
 * a 9p-mounted home pointing into a local tmpfs) cannot connect through that
 * symlink, so always connect to the resolved target.
 */
function realSocket(socketPath: string): string {
  try { return realpathSync(socketPath); } catch { return socketPath; }
}

/** Ask the CLI for the managed daemon socket; fall back to the documented path. */
export async function daemonSocket(codexBin = process.env.AI4AI_CODEX_BIN || 'codex'): Promise<string | undefined> {
  const fallback = path.join(codexHome(), 'app-server-control', 'app-server-control.sock');
  if (existsSync(fallback)) return realSocket(fallback);
  return new Promise(resolve => {
    const child = spawn(codexBin, ['app-server', 'daemon', 'version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    let stdout = '';
    child.stdout?.on('data', data => { stdout = (stdout + String(data)).slice(-65536); });
    child.once('error', () => resolve(undefined));
    child.once('close', () => {
      try {
        const first = stdout.trim().split('\n')[0]!;
        const value = JSON.parse(first) as { status?: string; socketPath?: string };
        if (value.status === 'running' && typeof value.socketPath === 'string') resolve(realSocket(value.socketPath));
        else resolve(undefined);
      } catch { resolve(undefined); }
    });
  });
}

/** List every thread on the daemon (all pages). */
export async function listThreads(): Promise<CodexThread[]> {
  const socket = await daemonSocket();
  if (!socket) return [];
  const daemon = await CodexDaemon.connect(socket);
  try {
    await daemon.call('initialize', { clientInfo: { name: 'ai4ai', version: '0.0.6' } });
    return await listAllThreads(daemon);
  } finally { daemon.close(); }
}
