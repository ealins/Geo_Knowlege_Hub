import { describe, expect, test } from "bun:test";
import { shouldTryNextExtractionModel, isTransientExtractionError, shouldUseOpenRouterFallback, shouldUseOpenAIFallback, shouldRetryPrimaryProvider, getNormalizationProviderDeferralMinutes, shouldOpenOmniRouteCircuit, isLocalGatewayCircuitOpen, recordLocalGatewayFailure, OMNIROUTE_CIRCUIT_WINDOW_MS, getOmniRouteCircuitWindowStart } from "./transient-errors";

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

  test("keeps bounded retries for non-gateway transient errors without a fallback", () => {
    expect(shouldRetryPrimaryProvider({ errorCode: "HTTP_429", attempt: 1, retryLimit: 2 })).toBe(true);
    expect(shouldRetryPrimaryProvider({ errorCode: "HTTP_500", attempt: 1, retryLimit: 2 })).toBe(true);
    expect(shouldRetryPrimaryProvider({ errorCode: "HTTP_429", attempt: 2, retryLimit: 2 })).toBe(false);
    expect(shouldRetryPrimaryProvider({ errorCode: "HTTP_403", attempt: 1, retryLimit: 2 })).toBe(false);
  });

  test("fails fast on gateway 502/503/504 responses without an independent fallback", () => {
    for (const errorCode of ["HTTP_502", "HTTP_503", "HTTP_504", "GATEWAY_5XX"]) {
      expect(shouldRetryPrimaryProvider({
        errorCode,
        attempt: 1,
        retryLimit: 3,
        independentFallbackConfigured: false,
      })).toBe(false);
    }
  });
  test("fails over immediately on primary 5xx when an independent fallback is configured", () => {
    for (const errorCode of ["HTTP_500", "HTTP_502", "HTTP_503", "HTTP_504", "HTTP_599"]) {
      expect(shouldRetryPrimaryProvider({
        errorCode,
        attempt: 1,
        retryLimit: 2,
        independentFallbackConfigured: true,
      })).toBe(false);
    }
  });


});


describe("getNormalizationProviderDeferralMinutes", () => {
  test("defers the confirmed HTTP 530 outage when no independent fallback is configured", () => {
    expect(getNormalizationProviderDeferralMinutes(
      "TRANSIENT_EXTRACTION_FAILURE HTTP_530: error code: 1033; no independent fallback is configured (set OPENAI_API_KEY or OPENROUTER_API_KEY with OPENROUTER_MODEL)",
    )).toBe(30);
  });

  test("does not defer HTTP 530 when the independent fallback diagnostic is absent", () => {
    expect(getNormalizationProviderDeferralMinutes(
      "TRANSIENT_EXTRACTION_FAILURE HTTP_530: fallback returned HTTP_502",
    )).toBe(null);
  });

  test("defers a circuit-open gateway outage when no independent fallback is configured", () => {
    expect(getNormalizationProviderDeferralMinutes(
      "TRANSIENT_EXTRACTION_FAILURE GATEWAY_5XX: circuit open after repeated gateway failures; no independent fallback is configured",
    )).toBe(30);
  });

  test("defers first-attempt gateway 502/503/504 failures when no fallback is configured", () => {
    for (const code of ["HTTP_502", "HTTP_503", "HTTP_504"]) {
      expect(getNormalizationProviderDeferralMinutes(
        "TRANSIENT_EXTRACTION_FAILURE " + code + ": upstream gateway unavailable; no independent fallback is configured",
      )).toBe(30);
    }
  });

  test("leaves unrelated transient provider errors on the existing bounded retry policy", () => {
    expect(getNormalizationProviderDeferralMinutes(
      "TRANSIENT_EXTRACTION_FAILURE HTTP_502: upstream temporarily unavailable",
    )).toBe(null);
    expect(getNormalizationProviderDeferralMinutes("missing title")).toBe(null);
  });
});

describe("OMNIROUTE_CIRCUIT_WINDOW_MS", () => {
  test("uses the shared 30-minute cutoff for provider preflight", () => {
    const now = Date.parse("2026-10-25T22:00:00.000Z");
    expect(getOmniRouteCircuitWindowStart(now)).toBe("2026-10-25T21:30:00.000Z");
  });

  test("matches the 30-minute normalization deferral window", () => {
    const deferralMinutes = getNormalizationProviderDeferralMinutes(
      "TRANSIENT_EXTRACTION_FAILURE GATEWAY_5XX: circuit open; no independent fallback is configured",
    );
    expect(deferralMinutes).toBe(30);
    expect(OMNIROUTE_CIRCUIT_WINDOW_MS).toBe((deferralMinutes ?? 0) * 60_000);
  });
});


describe("shouldOpenOmniRouteCircuit", () => {
  test("opens immediately after one recent HTTP 530/Cloudflare 1033 when no fallback is configured", () => {
    expect(shouldOpenOmniRouteCircuit({
      recentGatewayFailures: 1,
      recentHttp530Failures: 1,
      independentFallbackConfigured: false,
    })).toBe(true);
  });

  test("opens after two ordinary gateway 502/503/504 failures in the shared window", () => {
    expect(shouldOpenOmniRouteCircuit({
      recentGatewayFailures: 1,
      recentHttp530Failures: 0,
      independentFallbackConfigured: false,
    })).toBe(false);
    expect(shouldOpenOmniRouteCircuit({
      recentGatewayFailures: 2,
      recentHttp530Failures: 0,
      independentFallbackConfigured: false,
    })).toBe(true);
  });

  test("never blocks a configured independent fallback route, even after HTTP 530", () => {
    expect(shouldOpenOmniRouteCircuit({
      recentGatewayFailures: 1,
      recentHttp530Failures: 1,
      independentFallbackConfigured: true,
    })).toBe(false);
  });
});



describe("process-local OmniRoute circuit", () => {
  const closed = () => ({ failureTimes: [] as number[], openUntil: 0 });

  test("opens immediately on HTTP 530 so later queued calls can be short-circuited", () => {
    const state = recordLocalGatewayFailure(closed(), "HTTP_530", 1_000);
    expect(isLocalGatewayCircuitOpen(state, 1_001)).toBe(true);
    expect(state.openUntil).toBe(1_000 + OMNIROUTE_CIRCUIT_WINDOW_MS);
  });

  test("opens after two recent 502/503/504 failures", () => {
    const first = recordLocalGatewayFailure(closed(), "HTTP_502", 1_000);
    expect(isLocalGatewayCircuitOpen(first, 1_001)).toBe(false);
    const second = recordLocalGatewayFailure(first, "HTTP_503", 2_000);
    expect(isLocalGatewayCircuitOpen(second, 2_001)).toBe(true);
  });

  test("does not count rate limits or failures outside the 30-minute window", () => {
    const old = recordLocalGatewayFailure(closed(), "HTTP_502", 1_000);
    const rateLimit = recordLocalGatewayFailure(old, "HTTP_429", 1_500);
    expect(rateLimit.failureTimes).toHaveLength(1); // preserve the prior 502 while ignoring the 429
    const recent = recordLocalGatewayFailure(old, "HTTP_503", 1_000 + OMNIROUTE_CIRCUIT_WINDOW_MS);
    expect(recent.failureTimes).toHaveLength(1);
    expect(isLocalGatewayCircuitOpen(recent, 1_000 + OMNIROUTE_CIRCUIT_WINDOW_MS + 1)).toBe(false);
  });

  test("circuit expires after its bounded window", () => {
    const state = recordLocalGatewayFailure(closed(), "HTTP_530", 10_000);
    expect(isLocalGatewayCircuitOpen(state, 10_000 + OMNIROUTE_CIRCUIT_WINDOW_MS - 1)).toBe(true);
    expect(isLocalGatewayCircuitOpen(state, 10_000 + OMNIROUTE_CIRCUIT_WINDOW_MS)).toBe(false);
  });
});


describe("shouldTryNextExtractionModel", () => {
  test("stops the model ladder after gateway failures", () => {
    for (const code of ["HTTP_502", "HTTP_503", "HTTP_504", "HTTP_530", "GATEWAY_5XX"]) {
      expect(shouldTryNextExtractionModel(code)).toBe(false);
    }
  });

  test("preserves model escalation for non-gateway outcomes", () => {
    for (const code of ["TIMEOUT", "OUTPUT_TRUNCATED", "HTTP_429", "HTTP_500", "SCHEMA_FAILURE", null]) {
      expect(shouldTryNextExtractionModel(code)).toBe(true);
    }
  });
});
