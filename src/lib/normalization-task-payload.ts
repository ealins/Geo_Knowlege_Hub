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


/**
 * Legacy NORMALIZE tasks created before exact-snapshot targeting may lack a
 * raw_record_id. If they also carry a classification, the worker may pin the
 * oldest matching PENDING snapshot once, then preserve that ID across retries.
 */
export function shouldHydrateLegacyPendingSnapshot(
  payload: Record<string, unknown>,
): boolean {
  const hasRawRecordId =
    typeof payload.raw_record_id === "string" && payload.raw_record_id.trim().length > 0;
  const hasClassification =
    typeof payload.classification === "string" && payload.classification.trim().length > 0;
  return !hasRawRecordId && hasClassification;
}
