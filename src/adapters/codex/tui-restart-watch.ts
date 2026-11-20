#!/usr/bin/env node
/**
 * Detached watcher for a Codex TUI restart handoff.
 *
 * The handoff tool call runs inside the source turn, so it cannot wait for that
 * turn to end. This watcher waits for the tmux pane to become idle, then sends
 * the harness-native `/new` command and the caller material as the next visible
 * turn. The TUI process and pane are never replaced.
 *
 * The source turn can still be writing after the tool returns and the footer
 * shows transient idle-looking frames, so the gate requires a sustained Ready
 * state and re-checks it immediately before the keys are sent. `/new` being
 * rejected mid-turn is retried only after the pane is genuinely idle again.
 * Delivery is proven from a rollout created after the reset that contains the
 * material as a *user* message; the source rollout already contains the
 * material as a tool argument and must never count as delivery.
 *
 * It then records the successor thread (the newest rollout for the workspace)
 * in a durable journal file and completes the pending operation record.
 */
import { readFile, readdir, stat, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture, pasteText, sendKeys, PROFILES } from '../../tmux/backend.js';
import { Ai4aiStore } from '../../core/store.js';
import { result } from '../../contract/validate.js';
import type { Identity, Request, Result } from '../../contract/types.js';

interface Payload {
  home: string;
  identity: Identity;
  request: Request;
  operationId: string;
  marker: string;
  paneId: string;
  startedAt: string;
  timeoutMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Status footer only: the transcript may itself contain words like "working". */
const footer = (screen: string): string => screen.split(/\r?\n/).slice(-16).join('\n');
const running = (text: string): boolean => /esc to interrupt|\bWorking \(|\bThinking \(|\bCompacting\b/.test(text);
const rejected = (text: string): boolean => /\/new is disabled while a task is in progress/i.test(text);
const promptVisible = (screen: string): boolean => /Ask Codex to do anything/i.test(screen) || /(?:^|\n)\s*›\s*$/m.test(screen.slice(-3000));
const footerish = (line: string): boolean => /Ask Codex to do anything|Context \d+% used|\bReady\b|for shortcuts|esc to interrupt|\bWorking \(|\bThinking \(/i.test(line);
const transcript = (screen: string): string[] => screen.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 8 && !footerish(line));
/** The fresh-conversation worktree dialog blocks every other interaction. */
const worktreeDialog = (screen: string): boolean => /Where should the new conversation run/i.test(screen);
/** `/new` is selected by the first Enter and submitted by the second in 0.169. */
const composerNew = (screen: string): boolean => /(?:^|\n)\s*›\s*\/new\s*$/m.test(screen);

/** A sustained idle frame: no running footer, no /new rejection, Ready or prompt. */
const idleFrame = (screen: string): boolean => {
  const foot = footer(screen);
  return !running(foot) && !rejected(screen.slice(-2000)) && (/Ready/i.test(foot) || promptVisible(screen));
};

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('payload path missing');
  const payload = JSON.parse(await readFile(file, 'utf8')) as Payload;
  const { identity, request, operationId, marker, paneId } = payload;
  const profile = PROFILES.codex;
  const started = Date.parse(payload.startedAt);
  const journalDir = path.join(payload.home, '.ai4ai', 'codex', 'tui-restart');
  const journal = path.join(journalDir, `${operationId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const writeJournal = async (value: Record<string, unknown>): Promise<void> => {
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    const temporary = `${journal}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
    await rename(temporary, journal);
  };

  const deadline = Date.now() + payload.timeoutMs;
  const fail = async (phase: 'failed' | 'unknown', reason: string, successor: Identity | null = null): Promise<void> => {
    await writeJournal({ format: 1, operationId, marker, phase, mechanism: 'restart', reason, successor });
    await complete(payload, result({ operation: 'handoff', operationId }, phase, reason, {
      durable: true, state: phase,
      ...(phase === 'failed' ? { unavailable: ['handoff.restart'], error: { code: 'handoff-timeout', message: reason } } : {}),
    }));
  };

  /** Wait for a sustained idle pane; the returned sample is the last good frame. */
  const waitIdle = async (until: number, samples = 6): Promise<string | undefined> => {
    let stable = 0;
    while (Date.now() < until) {
      const screen = await capture(paneId);
      // A dialog or a half-submitted /new blocks the prompt forever; clear it
      // instead of waiting for an idle frame that cannot occur.
      if (screen && worktreeDialog(screen)) {
        await sendKeys(paneId, ['Enter']);
        stable = 0;
        await sleep(1200);
        continue;
      }
      if (screen && composerNew(screen) && !running(footer(screen))) {
        await sendKeys(paneId, ['Enter']);
        stable = 0;
        await sleep(900);
        continue;
      }
      stable = screen && idleFrame(screen) ? stable + 1 : 0;
      if (stable >= samples) {
        // Settle: the agent may still be writing its closing message after the
        // footer first looks Ready. Re-check once more after a pause.
        await sleep(2000);
        const again = await capture(paneId);
        if (again && !worktreeDialog(again) && !composerNew(again) && idleFrame(again)) return again;
        stable = 0;
      }
      await sleep(750);
    }
    return undefined;
  };

  const beforeIdle = await waitIdle(deadline);
  if (!beforeIdle) return fail('failed', 'The TUI pane did not become idle before the timeout');
  // Snapshot the rollouts that already exist: the source rollout contains the
  // material as a tool argument and must not satisfy delivery.
  const snapshot = await rolloutSnapshot(started);

  const beforeLines = transcript(beforeIdle).slice(-24);
  /** True when the pane switched to a fresh conversation: the old transcript is gone. */
  const paneCleared = (screen: string): boolean => {
    const retained = beforeLines.filter(line => screen.includes(line)).length;
    const ratio = beforeLines.length ? retained / beforeLines.length : 1;
    return /Context 0% used/i.test(screen.slice(-1500)) || ratio < 0.3;
  };

  let sentNew = false;
  let applied = false;
  for (let attempt = 0; attempt < 4 && !applied; attempt++) {
    if (attempt > 0) {
      const idle = await waitIdle(Math.min(deadline, Date.now() + 120_000), 4);
      if (!idle) break;
    }
    sentNew = await sendKeys(paneId, profile.newChatKeys);
    if (!sentNew) break;
    // Codex selects the `/new` entry on the first Enter; the command runs on
    // the second one. Without it the composer just holds the literal text.
    await sleep(500);
    await sendKeys(paneId, ['Enter']);
    const until = Math.min(deadline, Date.now() + 120_000);
    while (Date.now() < until) {
      const now = await capture(paneId);
      if (!now) { await sleep(700); continue; }
      if (rejected(now.slice(-2500))) break; // retried after the pane is idle again
      if (worktreeDialog(now)) {
        await sendKeys(paneId, ['Enter']);
        await sleep(1200);
        continue;
      }
      if (composerNew(now) && !running(footer(now))) {
        await sendKeys(paneId, ['Enter']);
        await sleep(900);
        continue;
      }
      if (running(footer(now))) { await sleep(700); continue; }
      if (promptVisible(now) && paneCleared(now)) { applied = true; break; }
      await sleep(700);
    }
  }
  if (!sentNew) return fail('failed', 'The native /new command could not be delivered');
  if (!applied) return fail('failed', 'The native /new reset could not be confirmed; the material was not typed into the old conversation');

  const task = request.task ?? '';
  if (!task) return fail('failed', 'The handoff material is empty');
  // A fresh conversation may take a moment to finish redrawing; wait for its
  // idle prompt before pasting so the keys are not swallowed.
  if (!(await waitIdle(Math.min(deadline, Date.now() + 60_000), 2))) {
    return fail('unknown', 'The new Codex conversation did not reach an idle prompt');
  }

  let pasted = await pasteText(paneId, task);
  if (!pasted) {
    // Bracketed paste is unavailable in some tmux builds; the literal key path
    // is the compatibility fallback.
    pasted = await sendKeys(paneId, ['-l', '--', task]);
    await sleep(800);
  }
  await sleep(600);
  let submitted = false;
  for (let attempt = 0; attempt < 6 && !submitted; attempt++) {
    await sendKeys(paneId, ['C-m']);
    await sleep(1500);
    const now = await capture(paneId);
    // A running turn, or a composer that no longer holds the material, means
    // the submit was accepted.
    if (running(footer(now))) submitted = true;
    else if (!now.includes(task.slice(0, Math.min(40, task.length)))) submitted = true;
  }

  // The durable native proof is a rollout created after the reset that holds
  // the material as a user message. Poll it: the successor turn starts
  // asynchronously after the submit.
  let delivered = false;
  const deliverUntil = Math.min(deadline, Date.now() + 120_000);
  while (Date.now() < deliverUntil && !delivered) {
    delivered = await rolloutHasMaterial(snapshot, started, task);
    if (!delivered) await sleep(2000);
  }
  const successor = await discoverThread(identity.workspace, snapshot, started);
  const visible = delivered && !/Where should the new conversation run/i.test(await capture(paneId));
  const phase = visible ? 'completed' : 'unknown';
  await writeJournal({
    format: 1, operationId, marker, phase, mechanism: 'restart',
    nativeEvidence: 'codex-tui:/new', successor,
    reason: visible
      ? 'Native /new reset the context in place; the material is visible as a user turn in the successor rollout'
      : 'The /new reset was applied in the pane, but delivery could not be confirmed from a successor rollout',
  });
  await complete(payload, result({ operation: 'handoff', operationId }, visible ? 'completed' : 'unknown',
    visible
      ? 'Codex /new reset the context in the same TUI; the task material was delivered as the next user turn'
      : 'Codex /new was applied but the material delivery was not confirmed',
    {
      durable: true,
      state: visible ? 'completed' : 'unknown',
      handoff: { phase: visible ? 'completed' : 'pending' },
      sessionId: successor?.session ?? identity.session,
      proof: {
        source: identity,
        successor: successor ?? { ...identity, generation: marker },
        mechanism: 'new-session',
        nativeEvidence: 'codex-tui:/new',
      },
    }));
}

/** Complete the pending operation record with the successor identity. */
async function complete(payload: Payload, outcome: Result): Promise<void> {
  try {
    const store = await Ai4aiStore.open(payload.home);
    await store.completePending(payload.identity, payload.operationId, outcome);
  } catch { /* the journal file remains the durable evidence */ }
}

/** Rollout files that existed before the reset, keyed by absolute path. */
async function rolloutSnapshot(started: number): Promise<Set<string>> {
  const files = await rolloutFiles(started);
  return new Set(files.map(entry => entry.file));
}

async function rolloutFiles(started: number): Promise<{ file: string; mtime: number }[]> {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  if (!existsSync(root)) return [];
  const files: { file: string; mtime: number }[] = [];
  for (let offset = 0; offset < 2; offset++) {
    const date = new Date(started - offset * 86_400_000);
    const directory = path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(directory, entry.name);
      const info = await stat(file).catch(() => undefined);
      if (info && info.mtimeMs >= started - 2000) files.push({ file, mtime: info.mtimeMs });
    }
  }
  return files;
}

/** True when a rollout created after the reset holds the material as a user message. */
async function rolloutHasMaterial(snapshot: Set<string>, started: number, task: string): Promise<boolean> {
  const needle = task.slice(0, Math.min(40, task.length));
  if (!needle) return false;
  for (const entry of await rolloutFiles(started)) {
    if (snapshot.has(entry.file)) continue;
    const text = await readFile(entry.file, 'utf8').catch(() => '');
    if (!text.includes(needle)) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes(needle)) continue;
      try {
        const row = JSON.parse(line) as Record<string, any>;
        const item = row?.payload ?? row;
        const role = item?.role;
        const content = item?.content;
        const parts = Array.isArray(content) ? content : [];
        const isUser = role === 'user'
          || (row?.type === 'event_msg' && typeof item?.message === 'string' && row?.payload?.type === 'user_message')
          || parts.some((part: any) => part?.type === 'input_text' || part?.type === 'text');
        if (isUser && !/tool_call|function_call/.test(String(row?.type ?? ''))) return true;
      } catch { /* not a JSON row */ }
    }
  }
  return false;
}

/** Newest rollout for this workspace created after the handoff, excluding pre-existing files. */
async function discoverThread(workspace: string, snapshot: Set<string>, started: number): Promise<Identity | null> {
  const candidates = (await rolloutFiles(started)).filter(entry => !snapshot.has(entry.file));
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates) {
    try {
      const head = (await readFile(candidate.file, 'utf8')).split(/\r?\n/).slice(0, 5).map(line => {
        try { return JSON.parse(line) as Record<string, any>; } catch { return undefined; }
      }).filter(Boolean) as Record<string, any>[];
      const meta = head.find(row => row.type === 'session_meta')?.payload as Record<string, any> | undefined;
      const id = typeof meta?.session_id === 'string' ? meta.session_id : typeof meta?.id === 'string' ? meta.id : undefined;
      if (!id) continue;
      if (typeof meta?.cwd === 'string' && meta.cwd.replace(/[\\/]+$/, '') !== workspace.replace(/[\\/]+$/, '')) continue;
      return { harness: 'codex', workspace, surface: 'tui', session: id, generation: id, agent: 'main' };
    } catch { /* try the next candidate */ }
  }
  return null;
}

main().catch(async error => {
  try {
    const file = process.argv[2];
    if (file) {
      const payload = JSON.parse(await readFile(file, 'utf8')) as Payload;
      const journalDir = path.join(payload.home, '.ai4ai', 'codex', 'tui-restart');
      await mkdir(journalDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(journalDir, `${payload.operationId}.json`), JSON.stringify({
        format: 1, operationId: payload.operationId, phase: 'failed', mechanism: 'restart', reason: String(error?.message ?? error),
      }, null, 2) + '\n');
    }
  } catch { /* best effort */ }
  process.exit(1);
});
