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
