import { describe, expect, test } from "bun:test";
import { assertBackfillDbSuccess } from "./backfill-db-errors";

describe("assertBackfillDbSuccess", () => {
  test("accepts a successful query or insert", () => {
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

  test("surfaces a failed insert batch instead of under-reporting queued tasks", () => {
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
