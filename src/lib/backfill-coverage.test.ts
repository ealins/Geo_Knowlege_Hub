import { describe, expect, test } from "bun:test";
import { countUnsupportedPending, getBackfillQueueDisposition } from "./backfill-coverage";
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
    ).toThrow("Raw-record backfill could not inspect open normalization tasks: statement timeout");
  });

  test("surfaces failed insert batches instead of under-reporting queued tasks", () => {
    expect(() =>
      assertBackfillDbSuccess("insert normalization task batch 2", {
        message: "duplicate key value violates unique constraint",
      }),
    ).toThrow("Raw-record backfill could not insert normalization task batch 2: duplicate key value violates unique constraint");
  });

  test("uses the database error code when the message is empty", () => {
    expect(() => assertBackfillDbSuccess("inspect open normalization tasks", { code: "57014" }))
      .toThrow("Raw-record backfill could not inspect open normalization tasks: 57014");
  });
});
