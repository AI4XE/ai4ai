import { chmod, open, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isMcpDenied } from './env-policy.js';

/**
 * Filter the project MCP definition for a spawned executor.
 *
 * Source of truth is `<workspace>/.mcp.json` (qgo-compatible). User-level MCP
 * configuration is explicitly out of scope and is never copied: the filtered
 * file is the complete configuration the carrier is allowed to see. The file
 * is written 0600 and its content is never logged, journaled or returned —
 * only the kept server names and count are exposed as evidence.
 */
export interface FilteredMcp {
  /** Absolute path of the generated configuration. */
  path: string;
  /** Names copied into the executor configuration. */
  names: string[];
  /** Number of servers present in the source file. */
  total: number;
  /** Number of servers removed. */
  removed: number;
}

export async function filterMcpConfig(options: {
  workspace: string;
  destination: string;
  extraDeny?: readonly string[];
}): Promise<FilteredMcp> {
  const source = path.join(options.workspace, '.mcp.json');
  let servers: Record<string, unknown> = {};
  let total = 0;
  try {
    const parsed = JSON.parse(await readFile(source, 'utf8')) as { mcpServers?: Record<string, unknown> };
    servers = parsed?.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers
      : {};
    total = Object.keys(servers).length;
  } catch (error) {
    // A malformed project file is an environment error, not a silent empty
    // allow-list: the caller must fix it rather than run without its servers.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(`Cannot parse project MCP configuration ${source}: ${(error as Error).message}`);
    }
  }
  const kept: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(servers)) {
    if (!isMcpDenied(name, options.extraDeny)) kept[name] = definition;
  }
  await mkdir(path.dirname(options.destination), { recursive: true, mode: 0o700 });
  const handle = await open(options.destination, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ mcpServers: kept }, null, 2) + '\n');
  } finally {
    await handle.close();
  }
  // `mode` only applies on creation; a pre-existing file must be tightened too.
  await chmod(options.destination, 0o600);
  const names = Object.keys(kept);
  return { path: options.destination, names, total, removed: total - names.length };
}
