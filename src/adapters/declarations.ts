import type { CapabilityDeclaration } from '../contract/types.js';
import type { Availability, HandoffMode, HarnessId, Os } from '../contract/states.js';

export interface DeclarationInput {
  harness: HarnessId;
  os: Os;
  /** How the harness is driven: tui | headless | web. */
  interface: 'tui' | 'headless' | 'web';
  handoff?: {
    availability?: Availability;
    modes?: HandoffMode[];
    modelOverride?: Availability;
    reasoningEffortOverride?: Availability;
    crossSurface?: Availability;
    tmuxFallback?: 'off' | 'experimental';
  };
  spawn?: { availability?: Availability; maxConcurrent?: number; isolation?: Availability };
  status?: { availability?: Availability; model?: Availability; reasoningEffort?: Availability; context?: Availability; percentSource?: 'native' | 'derived' | null };
  experimental?: string[];
  reason: string;
  evidence?: string;
}

/**
 * Build one capability declaration with honest defaults. Anything not claimed as
 * supported is `not-tested` or `unsupported`; nothing defaults to supported.
 */
export function declaration(input: DeclarationInput): CapabilityDeclaration {
  const handoff = input.handoff ?? {};
  const spawn = input.spawn ?? {};
  const status = input.status ?? {};
  const availability = handoff.availability ?? 'not-tested';
  return {
    harness: input.harness,
    os: input.os,
    interface: input.interface,
    operations: {
      capabilities: 'supported',
      handoff: availability,
      spawn: spawn.availability ?? 'not-tested',
      status: status.availability ?? 'not-tested',
      message: spawn.availability ?? 'not-tested',
      cancel: spawn.availability ?? 'not-tested',
      stop: spawn.availability ?? 'not-tested',
      list: 'supported',
    },
    handoff: {
      availability,
      modes: handoff.modes ?? ['compact', 'restart'],
      modelOverride: handoff.modelOverride ?? 'unsupported',
      reasoningEffortOverride: handoff.reasoningEffortOverride ?? 'unsupported',
      crossSurface: handoff.crossSurface ?? 'unsupported',
      tmuxFallback: handoff.tmuxFallback ?? 'off',
    },
    spawn: {
      availability: spawn.availability ?? 'not-tested',
      lifecycle: 'detached',
      maxConcurrent: spawn.maxConcurrent ?? 2,
      isolation: spawn.isolation ?? 'unsupported',
    },
    status: {
      availability: status.availability ?? 'not-tested',
      model: status.model ?? 'not-tested',
      reasoningEffort: status.reasoningEffort ?? 'unsupported',
      context: status.context ?? 'not-tested',
      percentSource: status.percentSource ?? null,
    },
    experimental: input.experimental ?? [],
    reason: input.reason,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
}
