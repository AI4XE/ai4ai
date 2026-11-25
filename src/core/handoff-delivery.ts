/**
 * The single, minimal handoff delivery template (D25/D26/D29).
 *
 * Every adapter delivers the same one-message text so a successor never
 * misreads the delivery as a new instruction to hand off, and never sees an
 * explanatory verb it might act on. The marker is always the last non-empty
 * line and is the only authoritative provenance; a marker anywhere else
 * (including inside task material) confers nothing.
 *
 * - task material:  `Handoff complete. Handoff material follows:\n<task>\n[[ai4ai:<marker>]]`
 * - self restart without a task: `Handoff complete. Await the next instruction.\n[[ai4ai:<marker>]]`
 * - compact without a task: no delivery at all (the native summary is enough).
 * - fallback continuation (only when the native on-demand path is unavailable):
 *   `Handoff complete. Please continue.\n[[ai4ai:<marker>]]`
 */

export const HANDOFF_HEADER_TASK = 'Handoff complete. Handoff material follows:';
export const HANDOFF_HEADER_IDLE = 'Handoff complete. Await the next instruction.';
export const HANDOFF_HEADER_CONTINUE = 'Handoff complete. Please continue.';

export type DeliveryKind = 'task' | 'idle' | 'continue';

const HEADERS: Record<DeliveryKind, string> = {
  task: HANDOFF_HEADER_TASK,
  idle: HANDOFF_HEADER_IDLE,
  continue: HANDOFF_HEADER_CONTINUE,
};

/** Wrap a marker exactly as the delivery template does. */
export const markerLine = (marker: string): string => `[[ai4ai:${marker}]]`;

/** The exact single-message delivery text for a task. */
export function taskDelivery(task: string, marker: string): string {
  return `${HANDOFF_HEADER_TASK}\n${task ?? ''}\n${markerLine(marker)}`;
}

/** The exact single-message delivery text for a restart with no task. */
export function idleDelivery(marker: string): string {
  return `${HANDOFF_HEADER_IDLE}\n${markerLine(marker)}`;
}

/** The fallback continuation used only when native on-demand compaction is unavailable. */
export function continueDelivery(marker: string): string {
  return `${HANDOFF_HEADER_CONTINUE}\n${markerLine(marker)}`;
}

/** Build a delivery for one handoff decision. */
export function deliveryText(
  kind: DeliveryKind,
  marker: string,
  task?: string,
): string {
  return kind === 'task' ? taskDelivery(task ?? '', marker) : kind === 'idle' ? idleDelivery(marker) : continueDelivery(marker);
}

const MARKER = /^\[\[ai4ai:([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]\]$/;

/**
 * Strict delivery recognition: the first line must be one of the three exact
 * headers and the last non-empty line must be exactly the marker. Markers
 * elsewhere (including inside task text) are ignored.
 */
export function parseDelivery(text: unknown): { kind: DeliveryKind; marker: string; task: string } | undefined {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.replace(/\r\n/g, '\n');
  const lines = trimmed.split('\n');
  const first = lines[0]?.trimEnd();
  const kind = (Object.keys(HEADERS) as DeliveryKind[]).find(key => HEADERS[key] === first);
  if (!kind) return undefined;
  const nonEmpty = [...lines].reverse().find(line => line.trim() !== '');
  const match = nonEmpty ? MARKER.exec(nonEmpty.trim()) : null;
  if (!match) return undefined;
  const marker = match[1]!;
  // The body between the header and the marker is the material. For a task
  // delivery, trailing newlines are preserved exactly as the caller wrote them.
  let body = lines.slice(1);
  // Drop the marker line (the last non-empty line), keeping earlier blank lines.
  let markerIndex = -1;
  for (let index = body.length - 1; index >= 0; index--) {
    if ((body[index] ?? '').trim() !== '') { markerIndex = index; break; }
  }
  if (markerIndex >= 0) body = body.slice(0, markerIndex);
  return { kind, marker, task: body.join('\n') };
}

/** Backward-compatible recognizer used by existing hooks: is this a delivery? */
export const isDeliveryText = (text: unknown): boolean => parseDelivery(text) !== undefined;

/**
 * Legacy v0.0.7 delivery prefix. Kept only so an upgrading session can still
 * recognize an in-flight old delivery; new text never uses it.
 */
export const LEGACY_DELIVERY_PREFIX = 'AI4AI handoff delivery ';
export const isLegacyDeliveryText = (text: unknown): boolean =>
  typeof text === 'string' && (text.startsWith(LEGACY_DELIVERY_PREFIX) || text.startsWith(`The ai4ai plugin sent a message:\n${LEGACY_DELIVERY_PREFIX}`));

/**
 * D39 no-task compact continuation policy. `in-turn` harnesses continue inside
 * the same loop and must receive no message; `fallback` harnesses stall at the
 * turn boundary and get the minimal conditional continuation by default. The
 * caller may pass `continuation: "off"` to accept a stalled session. The result
 * always states the truth: a fallback is never native-equivalent.
 */
export interface NoTaskCompactDecision {
  delivery: string | null;
  continued: boolean;
  idleAfter: boolean;
  fallbackUsed: boolean;
}

export function noTaskCompactDecision(options: {
  task?: string | undefined;
  continuation?: 'auto' | 'off' | undefined;
  mode: 'in-turn' | 'fallback';
  marker: string;
}): NoTaskCompactDecision {
  const { task, continuation, mode, marker } = options;
  if (task) return { delivery: taskDelivery(task, marker), continued: true, idleAfter: false, fallbackUsed: false };
  if (mode === 'in-turn') return { delivery: null, continued: true, idleAfter: false, fallbackUsed: false };
  if (continuation === 'off') return { delivery: null, continued: false, idleAfter: true, fallbackUsed: false };
  return { delivery: continueDelivery(marker), continued: true, idleAfter: false, fallbackUsed: true };
}
