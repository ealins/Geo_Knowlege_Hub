/**
 * Counts pending raw records whose classifications are not supported by the
 * canonical backfill pipeline. This is diagnostic only: unsupported rows remain
 * untouched and are not silently reclassified or discarded.
 */
export function countUnsupportedPending(totalPending: number, supportedPending: number): number {
  const total = Number.isFinite(totalPending) ? Math.max(0, Math.trunc(totalPending)) : 0;
  const supported = Number.isFinite(supportedPending) ? Math.max(0, Math.trunc(supportedPending)) : 0;
  // Separate count queries can observe a concurrent status update; clamp rather
  // than emitting a negative diagnostic while the next run reconciles the counts.
  return Math.max(0, total - supported);
}
