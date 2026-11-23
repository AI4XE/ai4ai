/** Features a caller may require explicitly. Unknown names fail closed. */
export const FEATURES = [
  'handoff', 'spawn', 'status', 'message', 'cancel', 'stop', 'finish', 'list',
  'surface-preserve', 'surface-cross', 'spawn-isolation', 'spawn-policy',
  'spawn-persistence', 'spawn-surface', 'spawn-permission-mode', 'spawn-env-exclude', 'spawn-mcp-deny',
  'message-revival', 'events', 'watch',
  'model-override', 'reasoning-effort-override',
] as const;

export type Feature = typeof FEATURES[number];
