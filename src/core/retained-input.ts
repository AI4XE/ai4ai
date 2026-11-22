/**
 * Real user input that arrives while a handoff replaces the context.
 *
 * A handoff is atomic once accepted: such input must neither cancel the
 * handoff nor be lost. Plugins retain the text in arrival order and replay it
 * in the fresh context. This module is deliberately pure (no host imports)
 * because the Claude hooks sandbox loads it through a relative import.
 */
export class RetainedInput {
  private readonly queues = new Map<string, string[]>();

  /** Keep one input for `scope`; empty or non-text input is ignored. */
  retain(scope: string, text: unknown): boolean {
    if (typeof text !== 'string' || text.trim() === '') return false;
    const queue = this.queues.get(scope);
    if (queue) queue.push(text);
    else this.queues.set(scope, [text]);
    return true;
  }

  /** Remove and return the inputs in arrival order (at-most-once replay). */
  take(scope: string): string[] {
    const queue = this.queues.get(scope) ?? [];
    this.queues.delete(scope);
    return queue;
  }

  /**
   * Read without consuming. Used where delivery must succeed before the queue
   * is cleared, so a failed native delivery does not silently drop the input.
   */
  peek(scope: string): string[] {
    return [...(this.queues.get(scope) ?? [])];
  }

  clear(scope: string): void {
    this.queues.delete(scope);
  }

  count(scope: string): number {
    return this.queues.get(scope)?.length ?? 0;
  }
}

/** Compose retained inputs into one instruction block that keeps their order. */
export function mergeRetained(entries: readonly string[]): string {
  if (entries.length === 0) return '';
  const body = entries.length === 1
    ? entries[0]!
    : entries.map((text, index) => `${index + 1}. ${text}`).join('\n');
  return `Later user input (preserve and act on it):\n${body}`;
}
