/** Provider outages are retryable; business-rule and schema rejections are not. */
export function isTransientExtractionError(errorCode: string | null | undefined): boolean {
  if (!errorCode) return false;
  return errorCode === "TIMEOUT" ||
    errorCode === "NETWORK_ERROR" ||
    errorCode === "HTTP_429" ||
    /^HTTP_5\d{2}$/.test(errorCode);
}


/**
 * Use a separately configured OpenRouter route only when the primary gateway
 * failed transiently. Permanent source/schema failures must not fan out.
 */
export function shouldUseOpenRouterFallback(input: {
  primaryErrorCode: string | null | undefined;
  apiKey: string | null | undefined;
  model: string | null | undefined;
}): boolean {
  return Boolean(
    input.apiKey?.trim() &&
    input.model?.trim() &&
    isTransientExtractionError(input.primaryErrorCode),
  );
}


/** Use OpenAI only for transient primary-provider failures. */
export function shouldUseOpenAIFallback(input: {
  primaryErrorCode: string | null | undefined;
  apiKey: string | null | undefined;
}): boolean {
  return Boolean(input.apiKey?.trim() && isTransientExtractionError(input.primaryErrorCode));
}


/**
 * Avoid spending another retry on HTTP 530 from the primary gateway.
 * In the observed outage, the response was Cloudflare error 1033; repeating
 * the same route only delays independent-provider fallback.
 */
export function shouldRetryPrimaryProvider(input: {
  errorCode: string | null | undefined;
  attempt: number;
  retryLimit: number;
}): boolean {
  if (input.errorCode === "HTTP_530") return false;
  return input.attempt < input.retryLimit && isTransientExtractionError(input.errorCode);
}


/**
 * Defer repeated normalization failures only for the observed provider-wide
 * HTTP 530 case where no independent fallback is configured. The queue's
 * retryAfterMinutes path preserves attempts and exact-snapshot payloads.
 */
export function getNormalizationProviderDeferralMinutes(
  reason: string | null | undefined,
): number | null {
  if (!reason?.startsWith("TRANSIENT_EXTRACTION_FAILURE")) return null;
  if (!/\bHTTP_530\b/.test(reason)) return null;
  if (!/no independent fallback is configured/i.test(reason)) return null;
  return 30;
}

/**
 * Avoid repeated requests to a provider during a confirmed outage when no
 * independent route is configured. Only real HTTP_530 rows count toward the
 * threshold; circuit-open telemetry uses a different error code so it cannot
 * keep the circuit open indefinitely.
 */
export function shouldOpenOmniRouteCircuit(input: {
  recentHttp530Failures: number;
  independentFallbackConfigured: boolean;
  threshold?: number;
}): boolean {
  if (input.independentFallbackConfigured) return false;
  const threshold = Math.max(1, Math.floor(input.threshold ?? 3));
  return Number.isFinite(input.recentHttp530Failures) &&
    input.recentHttp530Failures >= threshold;
}

