import { describe, expect, test } from "bun:test";
import { countUnsupportedPending, getBackfillQueueDisposition, staleNormalizationTargetReason } from "./backfill-coverage";
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
