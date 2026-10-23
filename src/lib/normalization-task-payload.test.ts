import { describe, expect, test } from "bun:test";
import { buildNormalizationTaskPayload } from "./normalization-task-payload";

describe("buildNormalizationTaskPayload", () => {
  test("preserves the selected raw snapshot for retry-safe normalization", () => {
    expect(buildNormalizationTaskPayload({
      classification: "PROJECT",
      reason: "semantic-failure-recovery-v7",
      rawRecordId: "raw-snapshot-123",
    })).toEqual({
      classification: "PROJECT",
      reason: "semantic-failure-recovery-v7",
      raw_record_id: "raw-snapshot-123",
    });
  });

  test("omits raw_record_id only when the producer has no raw snapshot id", () => {
    expect(buildNormalizationTaskPayload({ classification: "PROJECT" })).toEqual({
      classification: "PROJECT",
    });
  });
});
