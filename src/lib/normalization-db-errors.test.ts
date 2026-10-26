import { describe, expect, test } from "bun:test";
import { assertNormalizationDbSuccess } from "./normalization-db-errors";

describe("assertNormalizationDbSuccess", () => {
  test("accepts successful snapshot reads and status writes", () => {
    expect(() => assertNormalizationDbSuccess("read raw snapshot for normalization", null)).not.toThrow();
    expect(() => assertNormalizationDbSuccess("persist raw snapshot status SKIPPED", undefined)).not.toThrow();
  });

  test("does not treat a failed snapshot read as a missing raw record", () => {
    expect(() =>
      assertNormalizationDbSuccess("read raw snapshot for normalization", {
        message: "statement timeout",
        code: "57014",
      }),
    ).toThrow("Normalization could not read raw snapshot for normalization: statement timeout");
  });

  test("does not allow a terminal result when persisting status failed", () => {
    expect(() =>
      assertNormalizationDbSuccess("persist raw snapshot status NORMALIZED", {
        message: "connection reset",
      }),
    ).toThrow("Normalization could not persist raw snapshot status NORMALIZED: connection reset");
  });

  test("uses the database error code when the message is empty", () => {
    expect(() => assertNormalizationDbSuccess("read raw snapshot", { code: "57014" }))
      .toThrow("Normalization could not read raw snapshot: 57014");
  });
});
