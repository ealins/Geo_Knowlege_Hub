import { describe, expect, test } from "bun:test";
import { buildNormalizationTaskPayload, legacyNormalizationSnapshotTarget, shouldHydrateLegacyPendingSnapshot, shouldSkipLegacySnapshotFallback } from "./normalization-task-payload";

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


describe("shouldSkipLegacySnapshotFallback", () => {
  test("does not fall through to the newest page when a generic legacy target is missing", () => {
    expect(shouldSkipLegacySnapshotFallback({ classification: "PROGRAMME" }, null)).toBe(true);
  });

  test("does not fall through when a semantic-recovery snapshot is missing", () => {
    expect(shouldSkipLegacySnapshotFallback({
      classification: "COURSE",
      reason: "semantic-failure-recovery-v7",
    }, undefined)).toBe(true);
  });

  test("allows pinning when the expected legacy snapshot exists", () => {
    expect(shouldSkipLegacySnapshotFallback({ classification: "PROGRAMME" }, "raw-123")).toBe(false);
  });

  test("preserves legacy latest-page compatibility when no classification intent exists", () => {
    expect(shouldSkipLegacySnapshotFallback({ reason: "legacy-task" }, null)).toBe(false);
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

  test("pins semantic-failure-recovery-v7 tasks to the transient failed snapshot, not an older pending one", () => {
    expect(legacyNormalizationSnapshotTarget({
      classification: "PROGRAMME",
      reason: "semantic-failure-recovery-v7",
    })).toBe("FAILED_TRANSIENT_LATEST");
  });

  test("keeps generic legacy tasks on the oldest pending snapshot path", () => {
    expect(legacyNormalizationSnapshotTarget({
      classification: "PROGRAMME",
    })).toBe("PENDING_OLDEST");
  });

  test("does not select a legacy target when an exact raw id is already present", () => {
    expect(legacyNormalizationSnapshotTarget({
      classification: "PROGRAMME",
      raw_record_id: "raw-snapshot-123",
      reason: "semantic-failure-recovery-v7",
    })).toBe(null);
  });
});
