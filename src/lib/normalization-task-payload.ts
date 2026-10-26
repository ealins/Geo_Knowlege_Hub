/**
 * Build queue metadata for normalization while retaining the exact raw snapshot
 * selected by the producer. The queue retry path preserves payload unchanged.
 */
export type NormalizationTaskPayloadInput = {
  classification?: string | null;
  reason?: string;
  rawRecordId?: string | null;
};

export function buildNormalizationTaskPayload(
  input: NormalizationTaskPayloadInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.classification !== undefined) payload.classification = input.classification;
  if (input.reason !== undefined) payload.reason = input.reason;
  if (input.rawRecordId) payload.raw_record_id = input.rawRecordId;
  return payload;
}


export type LegacyNormalizationSnapshotTarget =
  | "PENDING_OLDEST"
  | "FAILED_TRANSIENT_LATEST";

/**
 * Legacy tasks without raw_record_id must retain the intent of their producer:
 * semantic-failure-recovery-v7 selected a transient FAILED snapshot, while older
 * generic backfill tasks are allowed to claim the oldest matching PENDING one.
 */
export function legacyNormalizationSnapshotTarget(
  payload: Record<string, unknown>,
): LegacyNormalizationSnapshotTarget | null {
  const hasRawRecordId =
    typeof payload.raw_record_id === "string" && payload.raw_record_id.trim().length > 0;
  const hasClassification =
    typeof payload.classification === "string" && payload.classification.trim().length > 0;
  if (hasRawRecordId || !hasClassification) return null;
  return payload.reason === "semantic-failure-recovery-v7"
    ? "FAILED_TRANSIENT_LATEST"
    : "PENDING_OLDEST";
}

/**
 * A classified legacy task has an explicit snapshot-selection intent. If no
 * row matches that intent, do not let normalizeSource fall back to the newest
 * raw page for the source; leave raw rows untouched so backfill can re-evaluate.
 */
export function shouldSkipLegacySnapshotFallback(
  payload: Record<string, unknown>,
  matchedRawRecordId: string | null | undefined,
): boolean {
  const hasMatchedId =
    typeof matchedRawRecordId === "string" && matchedRawRecordId.trim().length > 0;
  return legacyNormalizationSnapshotTarget(payload) !== null && !hasMatchedId;
}

/**
 * Kept as a small compatibility predicate for callers/tests that only need to
 * know whether the generic legacy pending-snapshot path applies.
 */
export function shouldHydrateLegacyPendingSnapshot(
  payload: Record<string, unknown>,
): boolean {
  return legacyNormalizationSnapshotTarget(payload) === "PENDING_OLDEST";
}
