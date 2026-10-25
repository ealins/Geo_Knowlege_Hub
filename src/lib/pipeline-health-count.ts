/**
 * Keep pipeline health counts honest: an empty successful query is zero, but
 * a failed database query must not be presented as a real zero count.
 */
export function requirePipelineHealthCount(
  table: string,
  count: number | null,
  error: unknown,
): number {
  if (error) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "query failed")
        : String(error);
    throw new Error(`Pipeline health count query failed for "${table}": ${message}`);
  }
  return count ?? 0;
}
