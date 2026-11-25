#!/usr/bin/env node
/**
 * OpenCode served-session carrier.
 *
 * `opencode run --standalone` starts a throwaway process that does not load the
 * project plugin. To support the same in-harness handoff as the TUI, a
 * persistent executor is backed by one per-executor `opencode serve` process;
 * every turn attaches to that server, and the plugin is loaded inside it.
 *
 * The server is detached (it must outlive a turn) and recorded as
 * `opencode-server.json` (0600). The supervisor/sweep stops it at the end of
 * the executor's life. `--port 0` is unreliable on 1.19.6, so an explicit free
 * port is selected and verified.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { controlEnvelopeOperationId } from '../../core/control-envelope.js';
import { waitForAi4aiPlugin, waitForServerHealth } from './readiness.js';

const args = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const session = valueOf('--session');
const model = valueOf('--model');
const directory = process.env.AI4AI_OPENCODE_CWD || process.env.PWD || process.cwd();
const executorDirectory = process.env.AI4AI_EXECUTOR_DIR;
const binary = process.env.AI4AI_OPENCODE_BIN || 'opencode';
const surface = 'headless';

const message = await new Promise<string>((resolve, reject) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; });
  process.stdin.on('end', () => resolve(text));
  process.stdin.on('error', reject);
});

const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
const major = Number(/(\d+)\.\d+\.\d+/.exec(String(version.stdout ?? ''))?.[1] ?? 2);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

const alive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

interface ServerRecord { pid: number; url: string; password: string; startedAt: string }
const serverFile = executorDirectory ? path.join(executorDirectory, 'opencode-server.json') : undefined;

async function readServer(): Promise<ServerRecord | undefined> {
  if (!serverFile) return undefined;
  try {
    const value = JSON.parse(await readFile(serverFile, 'utf8')) as ServerRecord;
    if (!alive(value.pid)) return undefined;
    if (!(await canConnect(Number(new URL(value.url).port)))) return undefined;
    return value;
  } catch { return undefined; }
}

async function startServer(): Promise<ServerRecord> {
  const password = randomUUID();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const log = executorDirectory ? createWriteStream(path.join(executorDirectory, 'opencode-server.log'), { flags: 'a' }) : undefined;
  const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: directory,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, AI4AI_OPENCODE_SURFACE: surface },
    windowsHide: true,
  });
  child.stdout?.on('data', data => log?.write(data));
  child.stderr?.on('data', data => log?.write(data));
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await canConnect(port)) break;
    if (child.exitCode !== null) throw new Error(`opencode serve exited with ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!(await canConnect(port))) throw new Error('opencode serve did not listen within the timeout');
  const record: ServerRecord = { pid: child.pid ?? 0, url, password, startedAt: new Date().toISOString() };
  if (serverFile) {
    const temporary = `${serverFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, serverFile);
  }
  return record;
}

let server = await readServer();
if (!server) server = await startServer();

// The 2.x CLI waits for the server's V2 health endpoint before accepting a
// turn; `startServer` only waits for the TCP port, so a cold server can still
// answer 503 to `opencode run`. Wait for health on every 2.x turn (a warm
// server answers immediately).
if (major >= 2) {
  const health = await waitForServerHealth({ url: server.url });
  if (executorDirectory) {
    await writeFile(path.join(executorDirectory, 'server-health.json'), JSON.stringify({
      at: new Date().toISOString(), ...health,
    }, null, 2) + '\n').catch(() => undefined);
  }
  if (!health.ready) {
    process.stderr.write(`opencode carrier aborted: ${health.detail}\n`);
    process.exit(1);
  }
}

// The server answers on its port before the in-harness plugin is registered.
// A control envelope submitted in that window is executed as ordinary model
// input, so the durable request would never be consumed. Only a wake envelope
// needs the wait: ordinary turns stay fast when no plugin is installed, and a
// 1.x server never loads project plugins.
const envelopeOperationId = controlEnvelopeOperationId(message);
if (envelopeOperationId) {
  const readiness = major >= 2
    ? await waitForAi4aiPlugin({ url: server.url, password: server.password })
    : { ready: false, waitedMs: 0, detail: `OpenCode ${major}.x does not load project plugins in a served session` };
  if (executorDirectory) {
    await writeFile(path.join(executorDirectory, 'plugin-readiness.json'), JSON.stringify({
      at: new Date().toISOString(), ...readiness,
    }, null, 2) + '\n').catch(() => undefined);
  }
  if (!readiness.ready) {
    process.stderr.write(`opencode carrier refused the control envelope: ${readiness.detail}\n`);
    if (executorDirectory) {
      await writeFile(path.join(executorDirectory, 'intake-error.json'), JSON.stringify({
        at: new Date().toISOString(),
        message: `The control envelope was not submitted: ${readiness.detail}`,
      }, null, 2) + '\n').catch(() => undefined);
    }
    process.exit(1);
  }
}

const runArgs = ['run', '--format', 'json', '--auto'];
// 1.x attaches with --attach and takes --password; 2.x uses --server and does
// not accept --password (auth is not part of that CLI).
if (major >= 2) runArgs.push('--server', server.url);
else runArgs.push('--attach', server.url, '--password', server.password);
if (session) runArgs.push('--session', session);
if (model) runArgs.push('--model', model);
runArgs.push(message);

const child = spawn(binary, runArgs, {
  cwd: directory,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: server.password, AI4AI_OPENCODE_SURFACE: surface },
  windowsHide: true,
});
child.on('error', error => {
  process.stderr.write(`opencode attach carrier failed: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
