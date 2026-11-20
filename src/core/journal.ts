/**
 * Journal revision helpers shared by the native adapters.
 *
 * Journals are append-only revision logs: the latest row for an operation id
 * wins. Selecting the "active" operation by scanning the rows backwards would
 * resurrect a superseded non-terminal revision (e.g. `applied`) that sits under
 * a later terminal revision (`completed` or `unknown`).
 */
export function activeRecord<T extends { operationId: string; phase: string }>(
  records: readonly T[],
  terminal: (record: T) => boolean,
): T | undefined {
  const latest = new Map<string, T>();
  for (const record of records) latest.set(record.operationId, record);
  let active: T | undefined;
  for (const record of records) {
    if (latest.get(record.operationId) === record && !terminal(record)) active = record;
  }
  return active;
}
