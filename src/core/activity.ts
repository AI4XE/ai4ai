/**
 * PARITY-042: read-only activity summary from normalized events + git.
 *
 * This is an observation helper, not a transcript reader: it consumes the
 * supervisor-owned `log.ndjson` through the same event-v1 normalization as
 * `ai4ai events`, plus a bounded git log/status.
 */
import { readEventTail, type ReadEventsOptions } from './events.js';
import { readTurns } from './turns.js';
import { gitActivity } from './adoption.js';
import type { HarnessId } from '../contract/states.js';

export interface ActivitySummary {
  executorId: string;
  harness: HarnessId;
  events: {
    read: number;
    counts: Record<string, number>;
    tools: { name: string; count: number }[];
    files: string[];
    errors: number;
    lastText: string | null;
    nextCursor: number;
    reset: boolean;
  };
  turns: { total: number; lastOutcome: string | null; lastAt: string | null };
  git: { commits: string[]; dirtyFiles: number; error?: string };
}

const FILE_PATTERN = /(?:^|[\s"'`(])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`),:])/g;

export async function activitySummary(options: {
  home: string;
  workspace: string;
  executorId: string;
  harness: HarnessId;
  events?: ReadEventsOptions;
  gitLimit?: number;
}): Promise<ActivitySummary> {
  const tail = await readEventTail(options.home, options.executorId, options.harness, { tail: 200, ...(options.events ?? {}) });
  const counts: Record<string, number> = {};
  const tools = new Map<string, number>();
  const files = new Set<string>();
  let errors = 0;
  let lastText: string | null = null;
  for (const event of tail.events ?? []) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    if (event.kind === 'error') errors += 1;
    if (event.kind === 'tool' && event.tool) tools.set(event.tool, (tools.get(event.tool) ?? 0) + 1);
    if (event.text) {
      lastText = event.text;
      for (const match of event.text.matchAll(FILE_PATTERN)) {
        if (files.size >= 50) break;
        files.add(match[1]!);
      }
    }
  }
  const turns = await readTurns(options.home, options.executorId, 500);
  const last = turns.at(-1);
  const git = await gitActivity(options.workspace, options.gitLimit ?? 5);
  return {
    executorId: options.executorId,
    harness: options.harness,
    events: {
      read: tail.events?.length ?? 0,
      counts,
      tools: [...tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 20),
      files: [...files],
      errors,
      lastText: lastText ? lastText.slice(0, 4096) : null,
      nextCursor: tail.nextCursor,
      reset: tail.reset === true,
    },
    turns: { total: turns.length, lastOutcome: last?.outcome ?? null, lastAt: last?.endedAt ?? last?.startedAt ?? null },
    git,
  };
}
