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


export type BackfillQueueDisposition =
  | "QUEUE"
  | "EXACT_SNAPSHOT_OPEN"
  | "DEFERRED_BY_SOURCE";

/**
 * Distinguish an open task for the selected raw snapshot from a different
 * task that merely occupies the same source's one-task slot. This is
 * diagnostic only; it never authorizes concurrent normalization for a source.
 */
export function getBackfillQueueDisposition(
  rawRecordId: string,
  openTaskPayloads: readonly (Record<string, unknown> | null | undefined)[],
): BackfillQueueDisposition {
  if (openTaskPayloads.length === 0) return "QUEUE";
  const exactSnapshotOpen = openTaskPayloads.some(
    (payload) =>
      typeof payload?.raw_record_id === "string" &&
      payload.raw_record_id.trim() === rawRecordId,
  );
  return exactSnapshotOpen ? "EXACT_SNAPSHOT_OPEN" : "DEFERRED_BY_SOURCE";
}
