import { describe, expect, test } from "bun:test";
import { shouldRecoverSemanticFailure } from "./semantic-recovery-policy";

describe("shouldRecoverSemanticFailure", () => {
  test("recovers FAILED transient provider errors as well as legacy SKIPPED errors", () => {
    expect(shouldRecoverSemanticFailure({ status: "FAILED", error: "TRANSIENT_EXTRACTION_FAILURE HTTP_502", hasOpenNormalizeTask: false })).toBe(true);
    expect(shouldRecoverSemanticFailure({ status: "SKIPPED", error: "TIMEOUT", hasOpenNormalizeTask: false })).toBe(true);
  });

  test("does not reopen a raw record while its source already has an open normalization task", () => {
    expect(shouldRecoverSemanticFailure({ status: "FAILED", error: "HTTP_502", hasOpenNormalizeTask: true })).toBe(false);
  });

  test("does not retry permanent failures or unrelated statuses", () => {
    expect(shouldRecoverSemanticFailure({ status: "FAILED", error: "HTTP_404", hasOpenNormalizeTask: false })).toBe(false);
    expect(shouldRecoverSemanticFailure({ status: "NORMALIZED", error: "HTTP_502", hasOpenNormalizeTask: false })).toBe(false);
    expect(shouldRecoverSemanticFailure({ status: "PENDING", error: "HTTP_502", hasOpenNormalizeTask: false })).toBe(false);
  });
});
