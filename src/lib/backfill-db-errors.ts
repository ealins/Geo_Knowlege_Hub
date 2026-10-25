export type BackfillDatabaseError = {
  message?: string | null;
  code?: string | null;
} | null | undefined;

/**
 * Fail visibly when a backfill planner cannot inspect task guards or persist a
 * batch. A failed read must never look like an empty task set, and a failed
 * insert must never be reported as a successful plan.
 */
export function assertBackfillDbSuccess(
  operation: string,
  error: BackfillDatabaseError,
): void {
  if (!error) return;
  const detail = error.message?.trim() || error.code?.trim() || "unknown database error";
  throw new Error(`Backfill could not ${operation}: ${detail}`);
}
