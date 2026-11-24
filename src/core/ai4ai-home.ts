/**
 * ai4ai store-home resolution for in-harness integrations (v0.0.8 D-plan §6).
 *
 * `AI4AI_HOME` (default `<workspace>/.ai4ai` for a project install) is the sole
 * ai4ai ledger store. `DSH_HOME` belongs to the DSH runtime and must not be used
 * as the ledger just because the plugin runs inside it. For backward
 * compatibility an existing install that only has a `DSH_HOME` ledger keeps
 * working: the plugin falls back to it and reports a notice instead of moving or
 * deleting anything.
 */

export type StoreHomeSource = 'AI4AI_HOME' | 'DSH_HOME' | 'workspace';

export interface StoreHomeResolution {
  home: string;
  source: StoreHomeSource;
  /** True when AI4AI_HOME was unset and a legacy/default location is used. */
  fallback: boolean;
}

export const AI4AI_HOME_FALLBACK_NOTICE = {
  code: 'ai4ai-home-fallback',
  impact: 'none' as const,
  action_required: false as const,
  message: 'AI4AI_HOME is unset; using the legacy DSH_HOME store. Set AI4AI_HOME (default <workspace>/.ai4ai) to make the ledger store explicit.',
};

export function resolveAi4aiStoreHome(options: { env?: NodeJS.ProcessEnv; workspace?: string } = {}): StoreHomeResolution {
  const env = options.env ?? process.env;
  const explicit = typeof env.AI4AI_HOME === 'string' ? env.AI4AI_HOME.trim() : '';
  if (explicit) return { home: explicit, source: 'AI4AI_HOME', fallback: false };
  const dsh = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (dsh) return { home: dsh, source: 'DSH_HOME', fallback: true };
  return { home: options.workspace?.trim() || process.cwd(), source: 'workspace', fallback: true };
}
