import { describe, expect, test } from "bun:test";
import { assertScheduleSettingsWrite, requireScheduleSettingsRead } from "./schedule-settings-errors";

describe("requireScheduleSettingsRead", () => {
  test("returns persisted settings when the query succeeds", () => {
    const row = { value: { backlog_threshold: 25 } };
    expect(requireScheduleSettingsRead(row, null)).toEqual(row);
  });

  test("preserves default-schedule behavior when no settings row exists", () => {
    expect(requireScheduleSettingsRead(null, null)).toBeNull();
  });

  test("does not silently fall back to defaults after a read failure", () => {
    expect(() => requireScheduleSettingsRead(null, { message: "timeout" }))
      .toThrow("Schedule configuration read failed: timeout");
  });
});

describe("assertScheduleSettingsWrite", () => {
  test("accepts a successful upsert", () => {
    expect(() => assertScheduleSettingsWrite(null)).not.toThrow();
  });

  test("does not report a failed upsert as saved", () => {
    expect(() => assertScheduleSettingsWrite({ message: "permission denied" }))
      .toThrow("Schedule configuration write failed: permission denied");
  });
});
