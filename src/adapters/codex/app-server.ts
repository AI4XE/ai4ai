import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RpcError { code: number; message: string; data?: unknown }
export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

/**
 * Minimal Codex app-server JSON-RPC client.
 *
 * The app-server protocol is upstream-experimental; this client only uses the
 * documented initialize/thread/turn methods and always labels results
 * `experimental` in capability declarations.
 */
export class CodexAppServer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private handlers: NotificationHandler[] = [];
  private closed = false;
  private exitError?: Error;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => this.onLine(line));
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-4000); });
    child.once('exit', (code, signal) => {
      this.closed = true;
      const detail = stderr.trim().split(/\r?\n/).slice(-6).join(' | ');
      this.exitError = new Error(`codex app-server exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`);
      for (const { reject } of this.pending.values()) reject(this.exitError);
      this.pending.clear();
    });
  }

  static start(options: { command?: string; args?: string[]; cwd: string; env?: NodeJS.ProcessEnv }): CodexAppServer {
    const child = spawn(options.command ?? 'codex', options.args ?? ['app-server'], {
      cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    }) as ChildProcessWithoutNullStreams;
    return new CodexAppServer(child);
  }

  onNotification(handler: NotificationHandler): void { this.handlers.push(handler); }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const id = message.id;
    if (typeof id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) pending.reject(new Error(`app-server error: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') {
      const params = (message.params ?? {}) as Record<string, unknown>;
      for (const handler of this.handlers) handler(message.method, params);
    }
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    if (this.closed) return Promise.reject(this.exitError ?? new Error('codex app-server is closed'));
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(body);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize(clientName = 'ai4ai', version = '0.0.4'): Promise<unknown> {
    const result = await this.request('initialize', { clientInfo: { name: clientName, version } });
    this.notify('initialized');
    return result;
  }

  close(): void {
    if (this.closed) return;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    try { this.child.kill('SIGTERM'); } catch { /* already closed */ }
  }
}
