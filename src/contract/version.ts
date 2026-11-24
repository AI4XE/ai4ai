/** The single product version source used by native client `initialize` strings. */
export const PRODUCT_VERSION = '0.0.8';

/** Features a caller may require explicitly. Unknown names fail closed. */
export const FEATURES = [
  'handoff', 'spawn', 'status', 'message', 'cancel', 'stop', 'finish', 'list',
  'surface-preserve', 'surface-cross', 'spawn-isolation', 'spawn-policy',
  'spawn-persistence', 'spawn-surface', 'spawn-permission-mode', 'spawn-env-exclude', 'spawn-mcp-deny',
  'message-revival', 'events', 'watch',
  'model-override', 'reasoning-effort-override',
] as const;

export type Feature = typeof FEATURES[number];
