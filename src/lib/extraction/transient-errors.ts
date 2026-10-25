/** Keep preflight circuit checks aligned with the normalization retry deferral. */
export const OMNIROUTE_CIRCUIT_WINDOW_MS = 30 * 60_000;

/** Provider outages are retryable; business-rule and schema rejections are not. */
export function isTransientExtractionError(errorCode: string | null | undefined): boolean {
  if (!errorCode) return false;
  return errorCode === "TIMEOUT" ||
    errorCode === "NETWORK_ERROR" ||
    errorCode === "HTTP_429" ||
    errorCode === "GATEWAY_5XX" ||
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
  independentFallbackConfigured?: boolean;
}): boolean {
  if (input.errorCode === "HTTP_530" || input.errorCode === "GATEWAY_5XX") return false;

  // Do not repeat the same primary route after a confirmed gateway 502/503/504
  // when no independent provider is configured. The queue will defer the task
  // for the existing 30-minute circuit window instead of burning retries.
  if (
    !input.independentFallbackConfigured &&
    /^(?:HTTP_(?:502|503|504)|GATEWAY_5XX)$/.test(input.errorCode ?? "")
  ) {
    return false;
  }

  // With a separate provider configured, fail over on the first primary 5xx.
  if (input.independentFallbackConfigured && /^HTTP_5\d{2}$/.test(input.errorCode ?? "")) {
    return false;
  }

  return input.attempt < input.retryLimit && isTransientExtractionError(input.errorCode);
}


/**
 * Defer repeated normalization failures for a confirmed provider gateway
 * outage when no independent fallback is configured. The queue's
 * retryAfterMinutes path preserves attempts and exact-snapshot payloads.
 */
export function getNormalizationProviderDeferralMinutes(
  reason: string | null | undefined,
): number | null {
  if (!reason?.startsWith("TRANSIENT_EXTRACTION_FAILURE")) return null;
  if (!/\b(?:HTTP_502|HTTP_503|HTTP_504|HTTP_530|GATEWAY_5XX)\b/.test(reason)) return null;
  if (!/no independent fallback is configured/i.test(reason)) return null;
  return 30;
}

/**
 * Avoid repeated requests to a provider during a confirmed gateway outage when
 * no independent route is configured. Count only actual 502/503/530 responses;
 * circuit-open telemetry has no HTTP status and cannot extend the window.
 */
export function shouldOpenOmniRouteCircuit(input: {
  recentGatewayFailures: number;
  independentFallbackConfigured: boolean;
  threshold?: number;
}): boolean {
  if (input.independentFallbackConfigured) return false;
  const threshold = Math.max(1, Math.floor(input.threshold ?? 3));
  return Number.isFinite(input.recentGatewayFailures) &&
    input.recentGatewayFailures >= threshold;
}

