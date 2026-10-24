/**
 * Decide whether a recent steady-state drain should throttle another invocation.
 *
 * Small queues keep the configured steady-state interval. If a larger sub-threshold
 * queue remains due, allow bounded catch-up rather than leaving multiple waves idle
 * for the full interval. The caller still applies the normal per-invocation batch,
 * concurrency, timeout, and retry/cooldown limits.
 */
export function shouldThrottleSteadyStateDrain(input: {
  recentWork: boolean;
  dueTasks: number;
  batchSize: number;
}): boolean {
  if (!input.recentWork) return false;
  const catchUpThreshold = Math.max(8, input.batchSize * 2);
  return input.dueTasks <= catchUpThreshold;
}
