declare module '@opencode/plugin' {
  /** Supplied by the OpenCode runtime; only the shape used here is declared. */
  export const Plugin: { define<T>(value: T): T };
}
