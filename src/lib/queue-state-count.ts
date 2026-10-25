/**
 * Keep queue-state decisions based on successful counts only. A failed query
 * must not masquerade as an empty queue and switch the scheduler to steady state.
 */
export function requireQueueStateCount(
  label: "due" | "pending",
  count: number | null,
  error: unknown,
): number {
  if (error) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "query failed")
        : String(error);
    throw new Error(`Queue-state ${label} count query failed: ${message}`);
  }
  return count ?? 0;
}
