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
  fetched_at?: string | null;
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


export type LegacyNormalizationPinCandidate = {
  source_id: string;
  classification: string | null;
  normalization_status: string | null;
};

/**
 * A classified legacy task with no explicit raw ID means "oldest pending
 * snapshot of this classification", except semantic-failure recovery, which
 * intentionally targets a transient FAILED snapshot. Pin only the former when
 * the backfill planner has selected that exact pending snapshot for the source.
 */
export function canPinLegacyNormalizationTaskToPendingSnapshot(
  task: OpenNormalizationTaskTarget,
  candidate: LegacyNormalizationPinCandidate,
): boolean {
  const status = task.status.toUpperCase();
  if (status !== "QUEUED" && status !== "RETRY") return false;
  if (!task.source_id || task.source_id !== candidate.source_id) return false;
  if ((candidate.normalization_status ?? "").toUpperCase() !== "PENDING") return false;

  const payload = task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
    ? task.payload
    : {};
  const rawRecordId = payload.raw_record_id;
  if (typeof rawRecordId === "string" && rawRecordId.trim()) return false;
  if (payload.reason === "semantic-failure-recovery-v7") return false;

  const taskClass = typeof payload.classification === "string"
    ? payload.classification.trim().toUpperCase()
    : "";
  const candidateClass = (candidate.classification ?? "").trim().toUpperCase();
  return taskClass.length > 0 && candidateClass.length > 0 && taskClass === candidateClass;
}


export type TransientRetrySupersessionTask = {
  status: string;
  source_id: string | null;
  payload: Record<string, unknown> | null | undefined;
  created_at: string | null;
  run_after: string | null;
  last_error: string | null;
};

export type NewerPendingSnapshotCandidate = {
  source_id: string;
  classification: string | null;
  normalization_status: string | null;
  fetched_at: string | null;
};

/**
 * Let fresh pending data take the one-task-per-source slot only when the
 * existing RETRY is an old, due, exact-target retry of an older FAILED snapshot
 * that failed because no independent AI provider was configured. The failed raw
 * snapshot remains FAILED and eligible for a later retry after the pending row
 * drains; this does not discard the older record or run tasks concurrently.
 */
/**
 * Resolve a pre-exact-snapshot RETRY task to the failed raw row it was created
 * for. Only pin when source/classification match and the failed snapshot was
 * fetched immediately before task creation; this avoids guessing across later
 * snapshots while preserving the original FAILED raw record.
 */
export function selectLegacyTransientFailureTarget(
  task: TransientRetrySupersessionTask,
  candidates: readonly NormalizationRawTarget[],
  maxSkewMs = 5 * 60 * 1000,
): NormalizationRawTarget | null {
  if (task.status.toUpperCase() !== "RETRY" || !task.source_id) return null;

  const payload = task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
    ? task.payload
    : {};
  const rawRecordId = payload.raw_record_id;
  if (typeof rawRecordId === "string" && rawRecordId.trim()) return null;
  if (payload.reason === "semantic-failure-recovery-v7") return null;

  const taskClass = typeof payload.classification === "string"
    ? payload.classification.trim().toUpperCase()
    : "";
  if (!taskClass) return null;

  const taskError = (task.last_error ?? "").toLowerCase();
  if (
    !taskError.includes("transient_extraction_failure") ||
    !taskError.includes("no independent fallback is configured")
  ) return null;

  const createdAt = Date.parse(task.created_at ?? "");
  if (!Number.isFinite(createdAt)) return null;
  const allowedSkew = Number.isFinite(maxSkewMs) ? Math.max(0, maxSkewMs) : 0;

  const matches = candidates.flatMap((candidate) => {
    if (
      candidate.source_id !== task.source_id ||
      (candidate.classification ?? "").trim().toUpperCase() !== taskClass ||
      (candidate.normalization_status ?? "").toUpperCase() !== "FAILED"
    ) return [];
    const error = candidate.normalization_error ?? "";
    if (
      !error.startsWith("TRANSIENT_EXTRACTION_FAILURE") ||
      !error.toLowerCase().includes("no independent fallback is configured")
    ) return [];
    const fetchedAt = Date.parse(candidate.fetched_at ?? "");
    const skew = createdAt - fetchedAt;
    if (!Number.isFinite(fetchedAt) || skew < 0 || skew > allowedSkew) return [];
    return [{ candidate, skew }];
  }).sort((a, b) => a.skew - b.skew);

  return matches[0]?.candidate ?? null;
}


export function shouldSupersedeTransientRetryForNewerPendingSnapshot(
  task: TransientRetrySupersessionTask,
  target: NormalizationRawTarget | null | undefined,
  candidate: NewerPendingSnapshotCandidate,
  nowMs = Date.now(),
): boolean {
  if (task.status.toUpperCase() !== "RETRY") return false;
  if (!task.source_id || task.source_id !== candidate.source_id) return false;
  if ((candidate.normalization_status ?? "").toUpperCase() !== "PENDING") return false;
  if (!target || target.source_id !== task.source_id) return false;
  if ((target.normalization_status ?? "").toUpperCase() !== "FAILED") return false;

  const payload = task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
    ? task.payload
    : {};
  const rawRecordId = payload.raw_record_id;
  const hasExplicitTarget =
    typeof rawRecordId === "string" && rawRecordId.trim() === target.id;
  // Legacy v7 recovery tasks deliberately target the latest FAILED transient
  // snapshot. The caller must resolve that exact row before using this path.
  const isLegacySemanticFailureRetry =
    (typeof rawRecordId !== "string" || !rawRecordId.trim()) &&
    payload.reason === "semantic-failure-recovery-v7";
  if (!hasExplicitTarget && !isLegacySemanticFailureRetry) return false;

  const taskClass = typeof payload.classification === "string"
    ? payload.classification.trim().toUpperCase()
    : "";
  const targetClass = (target.classification ?? "").trim().toUpperCase();
  const candidateClass = (candidate.classification ?? "").trim().toUpperCase();
  if (!taskClass || !targetClass || taskClass !== targetClass || targetClass !== candidateClass) {
    return false;
  }

  const outageMarker = "no independent fallback is configured";
  const rawError = target.normalization_error ?? "";
  const taskError = task.last_error ?? "";
  if (
    !rawError.startsWith("TRANSIENT_EXTRACTION_FAILURE") ||
    !rawError.toLowerCase().includes(outageMarker) ||
    !taskError.toLowerCase().includes(outageMarker)
  ) {
    return false;
  }

  const taskCreatedAt = Date.parse(task.created_at ?? "");
  const runAfter = Date.parse(task.run_after ?? "");
  const failedFetchedAt = Date.parse(target.fetched_at ?? "");
  const pendingFetchedAt = Date.parse(candidate.fetched_at ?? "");
  const minAgeMs = 24 * 60 * 60 * 1000;
  if (!Number.isFinite(taskCreatedAt) || taskCreatedAt > nowMs - minAgeMs) return false;
  if (!Number.isFinite(runAfter) || runAfter > nowMs) return false;
  if (!Number.isFinite(failedFetchedAt) || !Number.isFinite(pendingFetchedAt)) return false;
  return pendingFetchedAt > failedFetchedAt;
}

/**
 * Select the oldest pending snapshot that can safely replace a legacy v7
 * provider-outage retry. This avoids an older, different-class pending row
 * hiding a newer same-class row that can safely take the source's task slot.
 */
export function selectNewerPendingSnapshotForTransientRetry<
  T extends NewerPendingSnapshotCandidate & { id: string },
>(
  candidates: readonly T[],
  task: TransientRetrySupersessionTask,
  target: NormalizationRawTarget | null | undefined,
  nowMs = Date.now(),
): T | null {
  return candidates.find((candidate) =>
    shouldSupersedeTransientRetryForNewerPendingSnapshot(task, target, candidate, nowMs)
  ) ?? null;
}
