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
