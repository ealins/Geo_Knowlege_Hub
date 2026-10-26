export type NormalizationDatabaseError = {
  message?: string | null;
  code?: string | null;
} | null | undefined;

/**
 * Normalization must distinguish a missing raw snapshot from a failed database
 * operation. A failed status write must also prevent the task from being
 * reported as completed successfully.
 */
export function assertNormalizationDbSuccess(
  operation: string,
  error: NormalizationDatabaseError,
): void {
  if (!error) return;
  const detail = error.message?.trim() || error.code?.trim() || "unknown database error";
  throw new Error(`Normalization could not ${operation}: ${detail}`);
}
