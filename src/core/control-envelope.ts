/**
 * The invisible executor-target control envelope. Pure string logic with no
 * Node imports so the Claude hooks sandbox can load it.
 */
export const CONTROL_ENVELOPE = '[[ai4ai-control:handoff:';

export const controlEnvelope = (operationId: string): string => `${CONTROL_ENVELOPE}${operationId}]]`;

/** Recognize the invisible wake envelope and extract the operation id. */
export function controlEnvelopeOperationId(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith(CONTROL_ENVELOPE) || !trimmed.endsWith(']]')) return undefined;
  const id = trimmed.slice(CONTROL_ENVELOPE.length, -2);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : undefined;
}
