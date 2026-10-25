/**
 * Decide whether a recent steady-state drain should throttle another invocation.
 *
 * Small, newly-due queues keep the configured steady-state interval. A larger
 * sub-threshold queue can catch up, and any due queue older than the age limit
 * can make bounded progress rather than remain starved behind the interval.
 */
export function shouldThrottleSteadyStateDrain(input: {
  recentWork: boolean;
  dueTasks: number;
  batchSize: number;
  oldestDueAgeMinutes?: number | null;
  maxThrottleAgeMinutes?: number;
}): boolean {
  if (!input.recentWork) return false;

  const maxThrottleAgeMinutes = Math.max(1, input.maxThrottleAgeMinutes ?? 15);
  if (
    typeof input.oldestDueAgeMinutes === "number" &&
    Number.isFinite(input.oldestDueAgeMinutes) &&
    input.oldestDueAgeMinutes >= maxThrottleAgeMinutes
  ) {
    return false;
  }

  const catchUpThreshold = Math.max(8, input.batchSize * 2);
  return input.dueTasks <= catchUpThreshold;
}


export type NormalizationQueueMode = "BACKLOG" | "STEADY_STATE";

/**
 * Keep the existing bounded parallel wave when an independent provider exists.
 * Without one, serialize tasks so a gateway failure can stop additional
 * normalization task claims in the same drain invocation.
 */
export function normalizationWavePolicy(input: {
  mode: NormalizationQueueMode;
  batch: number;
  independentFallbackConfigured: boolean;
}): { target: number; waveSize: number; concurrency: number } {
  const target = input.mode === "BACKLOG"
    ? Math.min(4, input.batch)
    : Math.min(3, input.batch);
  if (!input.independentFallbackConfigured) {
    return { target, waveSize: 1, concurrency: 1 };
  }
  return {
    target,
    waveSize: 2,
    concurrency: input.mode === "BACKLOG" ? 3 : 2,
  };
}

/** True when a completed task wave reports an actual provider gateway failure. */
export function hasProviderGatewayFailureSignal(details: readonly string[]): boolean {
  return details.some((detail) =>
    /\b(?:HTTP_502|HTTP_503|HTTP_504|HTTP_530|GATEWAY_5XX|CIRCUIT_OPEN_GATEWAY_5XX)\b|circuit open after repeated recent primary gateway/i.test(detail)
  );
}

/** Distinguish an explicit circuit-open response from a first gateway failure. */
export function hasProviderCircuitOpenSignal(details: readonly string[]): boolean {
  return details.some((detail) =>
    /CIRCUIT_OPEN_GATEWAY_5XX|circuit open after repeated recent primary gateway/i.test(detail)
  );
}

/**
 * Keep model-dependent work stopped while a confirmed provider circuit is open,
 * without preventing the caller from falling through to deterministic discovery.
 */
export function shouldRunNormalizationWave(input: {
  providerCircuitOpen: boolean;
  processed: number;
  target: number;
}): boolean {
  return !input.providerCircuitOpen && input.processed < input.target;
}

/**
 * Keep ordinary discovery bounded, but allow one slow deterministic discovery
 * task to finish during an AI-provider circuit without claiming NORMALIZE work.
 * The circuit-open timeout is below the workflow caller's HTTP deadline.
 */
export function discoveryFallbackPolicy(
  providerCircuitOpen: boolean,
  batch: number,
): { limit: number; timeoutMs: number } {
  if (providerCircuitOpen) return { limit: 1, timeoutMs: 150_000 };
  return { limit: Math.max(1, Math.floor(batch)), timeoutMs: 15_000 };
}
