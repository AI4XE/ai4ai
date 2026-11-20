/**
 * Installation binding resolution.
 *
 * A binding names the integration home (the project's `.ai4ai` directory for
 * project scope, `~/.ai4ai` for user scope). Native plugins can be served from
 * a shared per-version cache, so the binding must never be taken from the
 * plugin's own directory alone: the workspace-local binding always wins, and a
 * plugin-root binding is only accepted when its workspace contains the caller.
 */
import path from 'node:path';

export interface InstallationBinding {
  product: 'ai4ai';
  format: 2;
  home: string;
  workspace: string;
  ownerToken: string;
  version?: string;
  node?: string;
  scope?: 'project' | 'user';
}

/** Parse and validate a binding; throws when the record is foreign/malformed. */
export function parseBinding(raw: string): InstallationBinding {
  const value = JSON.parse(raw) as Partial<InstallationBinding>;
  if (value.product !== 'ai4ai' || value.format !== 2
    || typeof value.home !== 'string' || !path.isAbsolute(value.home)
    || typeof value.workspace !== 'string' || !path.isAbsolute(value.workspace)
    || typeof value.ownerToken !== 'string' || value.ownerToken.length === 0) {
    throw new Error('Invalid installation binding');
  }
  return value as InstallationBinding;
}

/** True when `candidate` is `root` or lives inside it. */
export function containsWorkspace(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Workspace-local binding paths, nearest first (the session may start in a subdirectory). */
export function localBindingCandidates(workspace: string, maxDepth = 16): string[] {
  const output: string[] = [];
  let current = path.resolve(workspace);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    output.push(path.join(current, '.ai4ai', 'binding.json'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return output;
}

/**
 * Resolve the binding for a workspace.
 *
 * 1. The nearest workspace-local `.ai4ai/binding.json` whose recorded workspace
 *    contains the caller wins. This is what makes two projects sharing one
 *    plugin cache resolve their own installation.
 * 2. Otherwise the plugin-root binding is accepted only when it belongs to the
 *    caller's workspace tree. A foreign project's binding is never adopted.
 */
export async function resolveBindingFile(options: {
  workspace: string;
  pluginRoot: string;
  read: (file: string) => Promise<string | undefined>;
}): Promise<{ binding: InstallationBinding; path: string } | undefined> {
  for (const candidate of localBindingCandidates(options.workspace)) {
    const raw = await options.read(candidate).catch(() => undefined);
    if (!raw) continue;
    let binding: InstallationBinding;
    try { binding = parseBinding(raw); } catch { continue; }
    if (containsWorkspace(binding.workspace, options.workspace)) return { binding, path: candidate };
  }
  const fallback = path.join(options.pluginRoot, 'binding.json');
  const raw = await options.read(fallback).catch(() => undefined);
  if (!raw) return undefined;
  try {
    const binding = parseBinding(raw);
    if (containsWorkspace(binding.workspace, options.workspace)) return { binding, path: fallback };
  } catch { /* malformed plugin-root binding: fail closed */ }
  return undefined;
}
