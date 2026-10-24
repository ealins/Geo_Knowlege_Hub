import { describe, expect, test } from "bun:test";
import { isTransientExtractionError, shouldUseOpenRouterFallback, shouldUseOpenAIFallback, shouldRetryPrimaryProvider } from "./transient-errors";

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


describe("shouldUseOpenRouterFallback", () => {
  test("uses an independent configured route for transient OmniRoute failures", () => {
    for (const code of ["HTTP_429", "HTTP_502", "HTTP_530", "TIMEOUT", "NETWORK_ERROR"]) {
      expect(shouldUseOpenRouterFallback({
        primaryErrorCode: code,
        apiKey: "configured",
        model: "provider/model",
      })).toBe(true);
    }
  });

  test("does not fan out for permanent failures or incomplete fallback configuration", () => {
    expect(shouldUseOpenRouterFallback({
      primaryErrorCode: "HTTP_403",
      apiKey: "configured",
      model: "provider/model",
    })).toBe(false);
    expect(shouldUseOpenRouterFallback({
      primaryErrorCode: "HTTP_502",
      apiKey: "",
      model: "provider/model",
    })).toBe(false);
    expect(shouldUseOpenRouterFallback({
      primaryErrorCode: "HTTP_502",
      apiKey: "configured",
      model: "",
    })).toBe(false);
  });
});


describe("shouldUseOpenAIFallback", () => {
  test("uses the configured OpenAI key after transient primary failures", () => {
    for (const code of ["HTTP_429", "HTTP_502", "HTTP_530", "TIMEOUT", "NETWORK_ERROR"]) {
      expect(shouldUseOpenAIFallback({ primaryErrorCode: code, apiKey: "configured" })).toBe(true);
    }
  });

  test("does not call OpenAI for permanent errors or without a key", () => {
    expect(shouldUseOpenAIFallback({ primaryErrorCode: "HTTP_403", apiKey: "configured" })).toBe(false);
    expect(shouldUseOpenAIFallback({ primaryErrorCode: "HTTP_502", apiKey: "" })).toBe(false);
  });
});


describe("shouldRetryPrimaryProvider", () => {
  test("does not repeat the primary route for HTTP 530", () => {
    expect(shouldRetryPrimaryProvider({ errorCode: "HTTP_530", attempt: 1, retryLimit: 2 })).toBe(false);
  });

  test("retries other transient errors only while attempts remain", () => {
    expect(shouldRetryPrimaryProvider({ errorCode: "HTTP_502", attempt: 1, retryLimit: 2 })).toBe(true);
    expect(shouldRetryPrimaryProvider({ errorCode: "HTTP_502", attempt: 2, retryLimit: 2 })).toBe(false);
    expect(shouldRetryPrimaryProvider({ errorCode: "HTTP_403", attempt: 1, retryLimit: 2 })).toBe(false);
  });
});
