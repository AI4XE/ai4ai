/** Features a caller may require explicitly. Unknown names fail closed. */
export const FEATURES = [
  'handoff', 'spawn', 'status', 'message', 'cancel', 'stop', 'list',
  'surface-preserve', 'surface-cross', 'spawn-isolation', 'spawn-policy',
  'model-override', 'reasoning-effort-override', 'tmux-fallback',
] as const;

export type Feature = typeof FEATURES[number];
