const HOUR_MS = 60 * 60 * 1000;

export type SourceRefreshFailureInput = {
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastHttpStatus?: number | null;
  nowMs?: number;
};

/**
 * Back off a source after a failed fetch so permanently blocked or broken
 * sources are not re-enqueued on every refresh tick. A later success clears
 * the failure cooldown; this policy only changes scheduling, not source state.
 */
export function shouldBackoffSourceAfterFailure(
  input: SourceRefreshFailureInput,
): boolean {
  if (!input.lastFailureAt) return false;

  const failedAt = Date.parse(input.lastFailureAt);
  if (!Number.isFinite(failedAt)) return false;

  const succeededAt = input.lastSuccessAt ? Date.parse(input.lastSuccessAt) : Number.NaN;
  if (Number.isFinite(succeededAt) && succeededAt >= failedAt) return false;

  const status = input.lastHttpStatus ?? null;
  const cooldownMs =
    status === 401 || status === 403 || status === 404 || status === 410
      ? 24 * HOUR_MS
      : status === 429
        ? HOUR_MS
        : status !== null && status >= 500
          ? 2 * HOUR_MS
          : 6 * HOUR_MS;

  return (input.nowMs ?? Date.now()) - failedAt < cooldownMs;
}


export type BlockedSourceReprobeInput = {
  status: string | null | undefined;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastHttpStatus?: number | null;
  nowMs?: number;
};

/**
 * A 403 normally blocks a source from leasing. Re-probe only a source that
 * previously fetched successfully and whose later 403 is at least 24 hours
 * old. Never-successful sources, 404/410 sources, and robots-blocked sources
 * without an HTTP status remain blocked. This lets temporary access failures
 * recover without turning the blocked registry into an aggressive retry loop.
 */
export function shouldReprobeBlocked403Source(
  input: BlockedSourceReprobeInput,
): boolean {
  if (input.status !== "BLOCKED" || input.lastHttpStatus !== 403) return false;
  if (!input.lastSuccessAt || !input.lastFailureAt) return false;

  const succeededAt = Date.parse(input.lastSuccessAt);
  const failedAt = Date.parse(input.lastFailureAt);
  if (!Number.isFinite(succeededAt) || !Number.isFinite(failedAt)) return false;
  if (succeededAt >= failedAt) return false;

  return (input.nowMs ?? Date.now()) - failedAt >= 24 * HOUR_MS;
}


export type SourceRefreshSkipReason =
  | "not_due"
  | "blocked"
  | "blocked_reprobe_limit"
  | "open_fetch_task"
  | "failure_cooldown"
  | "reprobe_state_changed";

/**
 * Explain why a due-source refresh candidate was not enqueued.
 * This is diagnostic only: it does not change the source eligibility policy.
 */
export function getSourceRefreshSkipReason(input: {
  isDue: boolean;
  status: string | null | undefined;
  blockedReprobe: boolean;
  blockedReprobeLimitReached: boolean;
  hasOpenFetchTask: boolean;
  failureBackoff: boolean;
}): Exclude<SourceRefreshSkipReason, "reprobe_state_changed"> | null {
  if (!input.isDue) return "not_due";
  if (input.status === "BLOCKED" && !input.blockedReprobe) return "blocked";
  if (input.blockedReprobe && input.blockedReprobeLimitReached) return "blocked_reprobe_limit";
  if (input.hasOpenFetchTask) return "open_fetch_task";
  if (!input.blockedReprobe && input.failureBackoff) return "failure_cooldown";
  return null;
}
