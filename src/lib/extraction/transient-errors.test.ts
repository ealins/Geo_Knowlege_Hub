import { describe, expect, test } from "bun:test";
import { isTransientExtractionError } from "./transient-errors";

describe("isTransientExtractionError", () => {
  test("retries common transient provider failures", () => {
    for (const code of ["TIMEOUT", "NETWORK_ERROR", "HTTP_429", "HTTP_500", "HTTP_502", "HTTP_599"]) {
      expect(isTransientExtractionError(code)).toBe(true);
    }
  });

  test("does not retry non-transient extraction outcomes", () => {
    for (const code of ["HTTP_400", "HTTP_404", "HTTP_403", "NO_RESULT", "", undefined, null]) {
      expect(isTransientExtractionError(code)).toBe(false);
    }
  });
});
