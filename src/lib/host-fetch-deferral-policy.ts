export function parseHostFetchDeferralSeconds(error: unknown): number | null {
  if (typeof error !== "string") return null;
  const match = error.trim().match(/^Deferred by host rate-limit backoff for (\d+)s$/i);
  if (!match) return null;

  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds < 1) return null;
  return Math.min(seconds, 30 * 60);
}

/** Undo the queue lease's attempt increment when no HTTP request was made. */
export function restoreAttemptsAfterUnstartedFetch(attempts: number): number {
  if (!Number.isFinite(attempts)) return 0;
  return Math.max(0, Math.floor(attempts) - 1);
}


/** Clamp origin-provided HTTP 429 retry hints before persisting them. */
export function boundedHostRetryAfterSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(30 * 60, Math.floor(value));
}
