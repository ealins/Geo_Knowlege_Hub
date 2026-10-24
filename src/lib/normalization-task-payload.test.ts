import { describe, expect, test } from "bun:test";
import { buildNormalizationTaskPayload, shouldHydrateLegacyPendingSnapshot } from "./normalization-task-payload";

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


describe("shouldHydrateLegacyPendingSnapshot", () => {
  test("allows a legacy classified task with no raw snapshot id to be pinned", () => {
    expect(shouldHydrateLegacyPendingSnapshot({ classification: "PROGRAMME" })).toBe(true);
  });

  test("does not replace an existing exact snapshot id", () => {
    expect(shouldHydrateLegacyPendingSnapshot({
      classification: "PROGRAMME",
      raw_record_id: "raw-snapshot-123",
    })).toBe(false);
  });

  test("does not guess a snapshot when classification is missing", () => {
    expect(shouldHydrateLegacyPendingSnapshot({ reason: "legacy-task" })).toBe(false);
  });
});
