/**
 * Durable executor-target handoff request/status protocol.
 *
 * An orchestrator cannot drive another process's in-harness plugin directly.
 * It writes a durable request into the executor directory and wakes the
 * executor; the in-harness component (plugin or runner) validates it, performs
 * the transition at a safe point, and writes the status back. The orchestrator
 * reconciles the same operationId from that status.
 *
 * Files are 0600 inside the executor directory (already 0700). The request is
 * never model-visible: the wake turn carries only a control envelope that the
 * in-harness component consumes before any model input is submitted.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeAtomic } from '../adapters/executors.js';
import type { Identity } from '../contract/types.js';
import type { HandoffMode, StoredProofMechanism } from '../contract/states.js';
export { CONTROL_ENVELOPE, controlEnvelope, controlEnvelopeOperationId } from './control-envelope.js';

export const HANDOFF_REQUEST_FILE = 'handoff-request.json';
export const HANDOFF_STATUS_FILE = 'handoff-status.json';

export interface ExecutorHandoffRequest {
  format: 2;
  kind: 'handoff-request';
  operationId: string;
  mode: Exclude<HandoffMode, 'rotation'>;
  task?: string;
  marker: string;
  caller: Identity;
  requestedAt: string;
  deadlineAt: string;
}

export type ExecutorHandoffPhase =
  | 'intent' | 'scheduled' | 'applied' | 'completed' | 'failed' | 'cancelled';

export interface ExecutorHandoffStatus {
  format: 2;
  kind: 'handoff-status';
  operationId: string;
  phase: ExecutorHandoffPhase;
  mechanism?: StoredProofMechanism;
  source?: Identity;
  successor?: Identity;
  session?: string;
  generation?: string;
  continued?: boolean;
  idleAfter?: boolean;
  reason?: string;
  errorCode?: string;
  updatedAt: string;
}

const asObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function parseRequest(value: unknown): ExecutorHandoffRequest | undefined {
  if (!asObject(value) || value.format !== 2 || value.kind !== 'handoff-request') return undefined;
  if (typeof value.operationId !== 'string' || typeof value.marker !== 'string') return undefined;
  if (value.mode !== 'restart' && value.mode !== 'compact') return undefined;
  if (!asObject(value.caller) || typeof value.caller.session !== 'string') return undefined;
  return value as unknown as ExecutorHandoffRequest;
}

function parseStatus(value: unknown): ExecutorHandoffStatus | undefined {
  if (!asObject(value) || value.format !== 2 || value.kind !== 'handoff-status') return undefined;
  if (typeof value.operationId !== 'string' || typeof value.phase !== 'string') return undefined;
  return value as unknown as ExecutorHandoffStatus;
}

export async function writeHandoffRequest(directory: string, request: ExecutorHandoffRequest): Promise<string> {
  const file = path.join(directory, HANDOFF_REQUEST_FILE);
  await writeAtomic(file, request);
  return file;
}

export async function readHandoffRequest(directory: string): Promise<ExecutorHandoffRequest | undefined> {
  try { return parseRequest(JSON.parse(await readFile(path.join(directory, HANDOFF_REQUEST_FILE), 'utf8'))); }
  catch { return undefined; }
}

export async function clearHandoffRequest(directory: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(path.join(directory, HANDOFF_REQUEST_FILE), { force: true }).catch(() => undefined);
}

export async function writeHandoffStatus(directory: string, status: ExecutorHandoffStatus): Promise<void> {
  await writeAtomic(path.join(directory, HANDOFF_STATUS_FILE), status);
}

export async function readHandoffStatus(directory: string): Promise<ExecutorHandoffStatus | undefined> {
  try { return parseStatus(JSON.parse(await readFile(path.join(directory, HANDOFF_STATUS_FILE), 'utf8'))); }
  catch { return undefined; }
}

/** The executor directory a carrier was launched with, when running inside it. */
export function currentExecutorDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return typeof env.AI4AI_EXECUTOR_DIR === 'string' && env.AI4AI_EXECUTOR_DIR.length > 0 ? env.AI4AI_EXECUTOR_DIR : undefined;
}

