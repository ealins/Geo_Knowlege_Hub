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
 * Kept as a small compatibility predicate for callers/tests that only need to
 * know whether the generic legacy pending-snapshot path applies.
 */
export function shouldHydrateLegacyPendingSnapshot(
  payload: Record<string, unknown>,
): boolean {
  return legacyNormalizationSnapshotTarget(payload) === "PENDING_OLDEST";
}
