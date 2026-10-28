import { describe, expect, test } from "bun:test";
import { canPinLegacyNormalizationTaskToPendingSnapshot, countUnsupportedPending, getBackfillQueueDisposition, shouldSupersedeTransientRetryForNewerPendingSnapshot, staleNormalizationTargetReason } from "./backfill-coverage";
import { assertBackfillDbSuccess } from "./backfill-db-errors";

describe("countUnsupportedPending", () => {
  test("reports pending rows outside the supported canonical classifications", () => {
    expect(countUnsupportedPending(152, 150)).toBe(2);
  });

  test("reports zero when every pending row is supported", () => {
    expect(countUnsupportedPending(150, 150)).toBe(0);
  });

  test("clamps concurrent-count drift instead of returning a negative count", () => {
    expect(countUnsupportedPending(149, 150)).toBe(0);
  });
});


describe("getBackfillQueueDisposition", () => {
  test("queues a candidate when its source has no open normalization task", () => {
    expect(getBackfillQueueDisposition("raw-1", [])).toBe("QUEUE");
  });

  test("reports an exact snapshot task when the open payload targets this raw record", () => {
    expect(getBackfillQueueDisposition("raw-1", [
      { raw_record_id: "raw-1", classification: "PROJECT" },
    ])).toBe("EXACT_SNAPSHOT_OPEN");
  });

  test("distinguishes a different snapshot on the same source from an exact queued record", () => {
    expect(getBackfillQueueDisposition("raw-1", [
      { raw_record_id: "raw-2", classification: "PROJECT" },
    ])).toBe("DEFERRED_BY_SOURCE");
  });

  test("treats legacy tasks without raw_record_id as source-level deferrals, not exact matches", () => {
    expect(getBackfillQueueDisposition("raw-1", [
      { classification: "PROJECT" },
    ])).toBe("DEFERRED_BY_SOURCE");
  });
});


describe("assertBackfillDbSuccess", () => {
  test("accepts successful database operations", () => {
    expect(() => assertBackfillDbSuccess("inspect open normalization tasks", null)).not.toThrow();
    expect(() => assertBackfillDbSuccess("insert normalization task batch 1", undefined)).not.toThrow();
  });

  test("does not treat an open-task query failure as an empty task set", () => {
    expect(() =>
      assertBackfillDbSuccess("inspect open normalization tasks", {
        message: "statement timeout",
        code: "57014",
      }),
    ).toThrow("Backfill could not inspect open normalization tasks: statement timeout");
  });

  test("surfaces failed insert batches instead of under-reporting queued tasks", () => {
    expect(() =>
      assertBackfillDbSuccess("insert normalization task batch 2", {
        message: "duplicate key value violates unique constraint",
      }),
    ).toThrow("Backfill could not insert normalization task batch 2: duplicate key value violates unique constraint");
  });

  test("surfaces structured-provider queue query failures with the operation context", () => {
    expect(() =>
      assertBackfillDbSuccess("inspect open structured-provider tasks", {
        message: "statement timeout",
        code: "57014",
      }),
    ).toThrow("Backfill could not inspect open structured-provider tasks: statement timeout");
  });

  test("uses the database error code when the message is empty", () => {
    expect(() => assertBackfillDbSuccess("inspect open normalization tasks", { code: "57014" }))
      .toThrow("Backfill could not inspect open normalization tasks: 57014");
  });
});



describe("staleNormalizationTargetReason", () => {
  const task = (status: string, payload: Record<string, unknown> = { raw_record_id: "raw-1", classification: "VACANCY" }) => ({
    status,
    source_id: "source-1",
    payload,
  });
  const raw = (normalization_status: string, classification = "VACANCY", source_id = "source-1") => ({
    id: "raw-1",
    source_id,
    classification,
    normalization_status,
    normalization_error: null,
  });

  test("retires a queued target that was already normalized", () => {
    expect(staleNormalizationTargetReason(task("QUEUED"), raw("NORMALIZED"))).toBe("raw_snapshot_normalized");
  });

  test("retires a queued target that was skipped", () => {
    expect(staleNormalizationTargetReason(task("QUEUED"), raw("SKIPPED"))).toBe("raw_snapshot_skipped");
  });

  test("retires a pending snapshot whose queued classification no longer matches", () => {
    expect(staleNormalizationTargetReason(task("RETRY"), raw("PENDING", "PROGRAMME"))).toBe("raw_snapshot_classification_mismatch");
  });

  test("retires a target missing from storage or belonging to another source", () => {
    expect(staleNormalizationTargetReason(task("QUEUED"), null)).toBe("raw_snapshot_missing");
    expect(staleNormalizationTargetReason(task("QUEUED"), raw("PENDING", "VACANCY", "source-2"))).toBe("raw_snapshot_source_mismatch");
  });

  test("preserves processing, legacy, pending-exact, and failed retry tasks", () => {
    expect(staleNormalizationTargetReason(task("PROCESSING"), raw("NORMALIZED"))).toBeNull();
    expect(staleNormalizationTargetReason(task("RETRY", { classification: "VACANCY" }), raw("PENDING"))).toBeNull();
    expect(staleNormalizationTargetReason(task("RETRY"), raw("FAILED", "PROGRAMME"))).toBeNull();
  });
});


describe("canPinLegacyNormalizationTaskToPendingSnapshot", () => {
  const task = (status: string, payload: Record<string, unknown> = { classification: "PROGRAMME" }) => ({
    status,
    source_id: "source-1",
    payload,
  });
  const candidate = (normalization_status = "PENDING", classification = "PROGRAMME", source_id = "source-1") => ({
    normalization_status,
    classification,
    source_id,
  });

  test("pins a generic legacy task to its matching oldest pending snapshot", () => {
    expect(canPinLegacyNormalizationTaskToPendingSnapshot(task("RETRY"), candidate())).toBe(true);
  });

  test("does not pin semantic-failure recovery to a pending snapshot", () => {
    expect(canPinLegacyNormalizationTaskToPendingSnapshot(
      task("RETRY", { classification: "PROGRAMME", reason: "semantic-failure-recovery-v7" }),
      candidate(),
    )).toBe(false);
  });

  test("preserves exact-target, processing, failed, and mismatched tasks", () => {
    expect(canPinLegacyNormalizationTaskToPendingSnapshot(task("PROCESSING"), candidate())).toBe(false);
    expect(canPinLegacyNormalizationTaskToPendingSnapshot(task("RETRY", { classification: "PROGRAMME", raw_record_id: "raw-1" }), candidate())).toBe(false);
    expect(canPinLegacyNormalizationTaskToPendingSnapshot(task("RETRY"), candidate("FAILED"))).toBe(false);
    expect(canPinLegacyNormalizationTaskToPendingSnapshot(task("RETRY"), candidate("PENDING", "COURSE"))).toBe(false);
    expect(canPinLegacyNormalizationTaskToPendingSnapshot(task("RETRY"), candidate("PENDING", "PROGRAMME", "source-2"))).toBe(false);
  });
});


describe("shouldSupersedeTransientRetryForNewerPendingSnapshot", () => {
  const now = Date.parse("2026-10-28T07:00:00.000Z");
  const outage = "TRANSIENT_EXTRACTION_FAILURE HTTP_502; no independent fallback is configured";
  const task = (overrides: Record<string, unknown> = {}) => ({
    status: "RETRY",
    source_id: "source-1",
    payload: { raw_record_id: "raw-old", classification: "PROJECT", reason: "semantic-failure-recovery-v8" },
    created_at: "2026-10-24T05:00:00.000Z",
    run_after: "2026-10-28T06:00:00.000Z",
    last_error: outage,
    ...overrides,
  });
  const target = (overrides: Record<string, unknown> = {}) => ({
    id: "raw-old",
    source_id: "source-1",
    classification: "PROJECT",
    normalization_status: "FAILED",
    normalization_error: outage,
    fetched_at: "2026-10-13T00:00:00.000Z",
    ...overrides,
  });
  const candidate = (overrides: Record<string, unknown> = {}) => ({
    source_id: "source-1",
    classification: "PROJECT",
    normalization_status: "PENDING",
    fetched_at: "2026-10-26T00:00:00.000Z",
    ...overrides,
  });

  test("lets a newer same-class pending snapshot take the slot from an old due outage retry", () => {
    expect(shouldSupersedeTransientRetryForNewerPendingSnapshot(task(), target(), candidate(), now)).toBe(true);
  });

  test("preserves the failed retry when its snapshot is newer than the pending row", () => {
    expect(shouldSupersedeTransientRetryForNewerPendingSnapshot(
      task(), target({ fetched_at: "2026-10-27T00:00:00.000Z" }), candidate(), now,
    )).toBe(false);
  });

  test("preserves retries for another classification or a different source", () => {
    expect(shouldSupersedeTransientRetryForNewerPendingSnapshot(
      task(), target(), candidate({ classification: "EVENT" }), now,
    )).toBe(false);
    expect(shouldSupersedeTransientRetryForNewerPendingSnapshot(
      task(), target(), candidate({ source_id: "source-2" }), now,
    )).toBe(false);
  });

  test("does not supersede recent, not-yet-due, non-retry, or non-provider failures", () => {
    expect(shouldSupersedeTransientRetryForNewerPendingSnapshot(
      task({ created_at: "2026-10-27T12:00:00.000Z" }), target(), candidate(), now,
    )).toBe(false);
    expect(shouldSupersedeTransientRetryForNewerPendingSnapshot(
      task({ run_after: "2026-10-28T08:00:00.000Z" }), target(), candidate(), now,
    )).toBe(false);
    expect(shouldSupersedeTransientRetryForNewerPendingSnapshot(
      task({ status: "PROCESSING" }), target(), candidate(), now,
    )).toBe(false);
    expect(shouldSupersedeTransientRetryForNewerPendingSnapshot(
      task({ last_error: "transient error without provider marker" }), target(), candidate(), now,
    )).toBe(false);
  });
});
