import { describe, expect, test } from "bun:test";
import {
  shouldRecoverSemanticFailure,
  shouldRetryInstitutionlessVacancy,
} from "./semantic-recovery-policy";

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


describe("shouldRetryInstitutionlessVacancy", () => {
  test("retries only failed vacancy records blocked by a missing institution", () => {
    expect(shouldRetryInstitutionlessVacancy({
      classification: "VACANCY",
      status: "FAILED",
      error: "missing institution",
    })).toBe(true);
  });

  test("does not retry other classifications, statuses, or failure reasons", () => {
    expect(shouldRetryInstitutionlessVacancy({
      classification: "PROJECT",
      status: "FAILED",
      error: "missing institution",
    })).toBe(false);
    expect(shouldRetryInstitutionlessVacancy({
      classification: "VACANCY",
      status: "SKIPPED",
      error: "missing institution",
    })).toBe(false);
    expect(shouldRetryInstitutionlessVacancy({
      classification: "VACANCY",
      status: "FAILED",
      error: "HTTP_502",
    })).toBe(false);
  });
});
