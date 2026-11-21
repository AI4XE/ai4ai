/**
 * Replica of the DSH session model-selection projection
 * (`@deepseek-ai/dsh-agent` `lib/types/model-selection.js`,
 * `modelSelectionProjectionDefinition`, stateVersion 3).
 *
 * Only two event types participate: `model/selection` records a pending choice
 * and `request/header` records the route a request actually used, retiring a
 * matching pending choice. The effective selection is `pending ?? lastUsed`.
 * Title/compaction/context events never participate, which is why a
 * `session/title-llm-request` effort (for example "off") can no longer
 * overwrite the request header's effort.
 *
 * The fold is intentionally literal: an incomplete selection (missing provider
 * or model) is ignored, an absent effort is its own value, and
 * `adapterDefaults.reasoningEffort === true` means the header's effort was the
 * adapter default and is therefore not a recorded selection.
 */
export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface DshSelectionState {
  lastUsed: DshModelSelection | null;
  pending: DshModelSelection | null;
}

export interface DshSelectionEvent {
  type?: unknown;
  data?: unknown;
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

/** A complete selection needs a provider and a model; effort is optional. */
function complete(value: unknown): DshModelSelection | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const provider = text(record.provider);
  const model = text(record.model);
  if (!provider || !model) return null;
  const reasoningEffort = text(record.reasoningEffort);
  return reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort };
}

/** Absent effort is a distinct value; provider, model and effort must all agree. */
export function sameDshSelection(left: DshModelSelection | null, right: DshModelSelection | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}

/** Selection a recorded `request/header` used, omitting an adapter-defaulted effort. */
function selectionOfHeader(data: unknown): DshModelSelection | null {
  if (!data || typeof data !== 'object') return null;
  const header = (data as Record<string, unknown>).header;
  if (!header || typeof header !== 'object') return null;
  const record = header as Record<string, unknown>;
  const config = record.config;
  if (!config || typeof config !== 'object') return null;
  const settings = config as Record<string, unknown>;
  const provider = text(settings.provider);
  const model = text(settings.model);
  if (!provider || !model) return null;
  const defaults = record.adapterDefaults && typeof record.adapterDefaults === 'object'
    ? record.adapterDefaults as Record<string, unknown>
    : undefined;
  const reasoningEffort = defaults?.reasoningEffort === true ? undefined : text(settings.reasoningEffort);
  return reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort };
}

const initialState = (): DshSelectionState => ({ lastUsed: null, pending: null });

/** One fold step, mirroring the official `apply` function. */
export function applyDshSelection(state: DshSelectionState, event: DshSelectionEvent): DshSelectionState {
  if (event.type === 'model/selection') {
    const pending = complete(event.data);
    if (!pending || sameDshSelection(state.pending, pending)) return state;
    return { ...state, pending };
  }
  if (event.type !== 'request/header') return state;
  const lastUsed = selectionOfHeader(event.data);
  if (!lastUsed) return state;
  const pending = sameDshSelection(state.pending, lastUsed) ? null : state.pending;
  if (sameDshSelection(state.lastUsed, lastUsed) && pending === state.pending) return state;
  return { lastUsed, pending };
}

/** Fold an ordered event stream (oldest first) into the projection state. */
export function foldDshSelection(events: Iterable<DshSelectionEvent>): DshSelectionState {
  let state = initialState();
  for (const event of events) state = applyDshSelection(state, event);
  return state;
}

/** The effective selection (`pending ?? lastUsed`), or null when the fold is empty. */
export function effectiveDshSelection(state: DshSelectionState): DshModelSelection | null {
  return state.pending ?? state.lastUsed;
}

/** Model id and reasoning effort from one fold, with no non-official fallback. */
export function dshSelectionValues(events: Iterable<DshSelectionEvent>): { model: string | null; reasoningEffort: string | null } {
  const selection = effectiveDshSelection(foldDshSelection(events));
  return { model: selection?.model ?? null, reasoningEffort: selection?.reasoningEffort ?? null };
}
