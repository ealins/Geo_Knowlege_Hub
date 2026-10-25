import { describe, expect, test } from "bun:test";
import { countUnsupportedPending } from "./backfill-coverage";

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
