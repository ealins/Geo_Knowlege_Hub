export type CanonicalWriteAction = "created" | "updated";

export type CanonicalWriteCounts = {
  recordsCreated: number;
  recordsUpdated: number;
};

/** Increment persisted pipeline counters only when a canonical write is confirmed. */
export function countCanonicalWrite(
  counts: CanonicalWriteCounts,
  action: CanonicalWriteAction | null | undefined,
): CanonicalWriteCounts {
  if (action === "created") {
    return { ...counts, recordsCreated: counts.recordsCreated + 1 };
  }
  if (action === "updated") {
    return { ...counts, recordsUpdated: counts.recordsUpdated + 1 };
  }
  return counts;
}
