/**
 * Recovery only retries transient semantic failures, and never while another
 * normalization task for the same source is open. This prevents changing a raw
 * row to PENDING when enqueue deduplication will refuse to create its task.
 */
export function shouldRecoverSemanticFailure(input: {
  status: string | null | undefined;
  error: string | null | undefined;
  hasOpenNormalizeTask: boolean;
}): boolean {
  if (input.hasOpenNormalizeTask) return false;
  if (input.status !== "SKIPPED" && input.status !== "FAILED") return false;
  return /(?:NVIDIA_SECRET_NOT_CONFIGURED|AI_PROVIDER_NOT_CONFIGURED|HTTP_(?:429|5\d\d)|TIMEOUT|NETWORK_ERROR|UNPARSEABLE_RESPONSE|OUTPUT_TRUNCATED|EMPTY_COMPLETION)/i.test(input.error ?? "");
}
