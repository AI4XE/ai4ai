/**
 * Supervisor wire protocol.
 *
 * Protocol 3 adds the first-class `idle` lifecycle, the per-executor turn
 * ledger and the `finish` control. A supervisor from an older release cannot
 * report those semantics, so it is refused instead of being silently driven
 * with protocol-3 expectations.
 */
export const SUPERVISOR_PROTOCOL = 3;
export const MIN_SUPERVISOR_PROTOCOL = 3;
