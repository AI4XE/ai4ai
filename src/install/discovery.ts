import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { NativeCommand } from './dsh-installer.js';

async function exists(file: string, executable = false): Promise<boolean> {
  try { await access(file, executable && process.platform !== 'win32' ? constants.X_OK : constants.R_OK); return (await stat(file)).isFile(); } catch { return false; }
}
export function dshHome(explicit?: string, environment: NodeJS.ProcessEnv = process.env, userHome = os.homedir()): string {
  // Match the native resolver: blank environment values are unset; nonblank
  // values retain their spaces, and native tilde expansion precedes resolve.
  let value = explicit ?? (environment.DSH_HOME?.trim() ? environment.DSH_HOME : undefined) ?? path.join(userHome, '.dsh');
  if (value === '~') value = userHome;
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(userHome, value.slice(2));
  return path.resolve(value);
}
export async function discoverDsh(environment: NodeJS.ProcessEnv = process.env): Promise<NativeCommand> {
  const names = process.platform === 'win32' ? ['dsh.exe', 'dsh.cmd', 'dsh'] : ['dsh'];
  for (const raw of (environment.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const directory = raw.replace(/^"(.*)"$/, '$1');
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      if (!(await exists(candidate, true))) continue;
      if (candidate.endsWith('.cmd')) {
        const entries = [
          path.join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
          ...(path.basename(directory).toLowerCase() === '.bin' ? [path.resolve(directory, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')] : []),
        ];
        for (const entry of entries) if (await exists(entry)) {
          const siblingNode = path.join(directory, 'node.exe');
          return { file: await exists(siblingNode, true) ? siblingNode : process.execPath, prefixArgs: [entry] };
        }
        continue;
      }
      return { file: await realpath(candidate) };
    }
  }
  throw new Error('No executable native dsh command was discovered on PATH; install the harness normally first');
}
