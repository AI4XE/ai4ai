/**
 * OpenCode served-session readiness.
 *
 * `opencode serve` starts listening before the in-harness plugin is registered.
 * A turn submitted in that window is executed by the host with no plugin
 * hooks, so an executor-target wake envelope would reach the model instead of
 * the plugin (observed on a cold plugin cache: the first wake turn leaked the
 * control envelope; later turns on the same server consumed it normally).
 *
 * The carrier therefore waits for the ai4ai plugin to report `active` before
 * it submits any turn, and refuses to submit a control envelope when the
 * plugin never activates.
 */
export interface PluginReadinessOptions {
  /** Server base URL, e.g. `http://127.0.0.1:4096`. */
  url: string;
  /** The per-executor server password (Basic auth user is `opencode`). */
  password: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PluginReadiness {
  ready: boolean;
  waitedMs: number;
  detail: string;
}

interface PluginRow {
  id?: unknown;
  state?: { status?: unknown };
}

/** Poll the server plugin registry until the ai4ai plugin is active. */export async function waitForAi4aiPlugin(options: PluginReadinessOptions): Promise<PluginReadiness> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 500;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const now = options.now ?? (() => Date.now());
  const started = now();
  const authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`;
  let detail = 'the ai4ai plugin was not reported';

  while (now() - started < timeoutMs) {
    try {
      const response = await doFetch(`${options.url}/api/plugin`, { headers: { authorization } });
      if (response.ok) {
        const body = await response.json() as { data?: unknown };
        const rows = Array.isArray(body?.data) ? body.data as PluginRow[] : [];
        const plugin = rows.find(row => row?.id === 'ai4ai');
        if (!plugin) {
          detail = 'the ai4ai plugin is not listed yet';
        } else {
          const status = typeof plugin.state?.status === 'string' ? plugin.state.status : 'unknown';
          if (status === 'active') return { ready: true, waitedMs: now() - started, detail: 'the ai4ai plugin is active' };
          detail = `the ai4ai plugin state is ${status}`;
        }
      } else {
        detail = `the plugin probe returned HTTP ${response.status}`;
      }
    } catch (error) {
      detail = `the plugin probe failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    await sleep(intervalMs);
  }
  return { ready: false, waitedMs: now() - started, detail };
}

/**
 * The 2.x CLI refuses a turn until the server answers its V2 health probe; the
 * server's TCP port becomes connectable before that endpoint is ready (observed:
 * `UnexpectedStatus: 503` one second after `opencode serve` listened). Wait for
 * a 2xx from `/global/health` before spawning `opencode run`.
 */
export interface ServerHealthOptions {
  url: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function waitForServerHealth(options: ServerHealthOptions): Promise<PluginReadiness> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const now = options.now ?? (() => Date.now());
  const started = now();
  let detail = 'the server health probe did not run';
  while (now() - started < timeoutMs) {
    try {
      const response = await doFetch(`${options.url}/global/health`);
      if (response.ok) return { ready: true, waitedMs: now() - started, detail: 'the server answered its V2 health probe' };
      detail = `the V2 health probe returned HTTP ${response.status}`;
    } catch (error) {
      detail = `the V2 health probe failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    await sleep(intervalMs);
  }
  return { ready: false, waitedMs: now() - started, detail };
}
