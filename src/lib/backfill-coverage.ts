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


export type OpenNormalizationTaskTarget = {
  status: string;
  source_id: string | null;
  payload: Record<string, unknown> | null | undefined;
};

export type NormalizationRawTarget = {
  id: string;
  source_id: string | null;
  classification: string | null;
  normalization_status: string | null;
  normalization_error: string | null;
};

/**
 * Return a retirement reason only for a queued/retry task whose explicit target
 * can no longer be normalized as selected. PROCESSING tasks, legacy tasks
 * without raw_record_id, and FAILED snapshots remain protected from retargeting.
 */
export function staleNormalizationTargetReason(
  task: OpenNormalizationTaskTarget,
  target: NormalizationRawTarget | null | undefined,
): string | null {
  const status = task.status.toUpperCase();
  if (status !== "QUEUED" && status !== "RETRY") return null;

  const payload = task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
    ? task.payload
    : {};
  const rawRecordId = payload.raw_record_id;
  if (typeof rawRecordId !== "string" || !rawRecordId.trim()) return null;
  if (!target) return "raw_snapshot_missing";
  if (!task.source_id || target.source_id !== task.source_id) {
    return "raw_snapshot_source_mismatch";
  }

  const rawStatus = (target.normalization_status ?? "").toUpperCase();
  if (rawStatus === "NORMALIZED" || rawStatus === "SKIPPED") {
    return `raw_snapshot_${rawStatus.toLowerCase()}`;
  }

  if (rawStatus === "PENDING") {
    const taskClass = typeof payload.classification === "string" ? payload.classification.trim().toUpperCase() : "";
    const rawClass = (target.classification ?? "").trim().toUpperCase();
    if (taskClass && rawClass && taskClass !== rawClass) {
      return "raw_snapshot_classification_mismatch";
    }
  }

  return null;
}
