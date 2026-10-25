import { describe, expect, test } from "bun:test";
import { requirePipelineHealthCount } from "./pipeline-health-count";

describe("requirePipelineHealthCount", () => {
  test("returns an exact count when the query succeeds", () => {
    expect(requirePipelineHealthCount("sources", 2383, null)).toBe(2383);
  });

  test("treats a successful empty count as zero", () => {
    expect(requirePipelineHealthCount("sources", null, null)).toBe(0);
  });

  test("throws rather than disguising a database error as a zero count", () => {
    expect(() =>
      requirePipelineHealthCount("raw_records", null, { message: "connection timeout" }),
    ).toThrow('Pipeline health count query failed for "raw_records": connection timeout');
  });

  test("includes non-object query failures in the error", () => {
    expect(() => requirePipelineHealthCount("sources", null, "permission denied"))
      .toThrow('Pipeline health count query failed for "sources": permission denied');
  });
});
