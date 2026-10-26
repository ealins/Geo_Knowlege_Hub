/** Keep preflight circuit checks aligned with the normalization retry deferral. */
export const OMNIROUTE_CIRCUIT_WINDOW_MS = 30 * 60_000;

/** Return the database preflight cutoff using the same window as queue deferral. */
export function getOmniRouteCircuitWindowStart(nowMs = Date.now()): string {
  return new Date(nowMs - OMNIROUTE_CIRCUIT_WINDOW_MS).toISOString();
}

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
 * no independent route is configured. Count actual 502/503/504/530 responses;
 * circuit-open telemetry has no HTTP status and cannot extend the window.
 */
export function shouldOpenOmniRouteCircuit(input: {
  recentGatewayFailures: number;
  /** Recent HTTP 530/Cloudflare 1033 responses are route failures; one is sufficient. */
  recentHttp530Failures?: number;
  independentFallbackConfigured: boolean;
  threshold?: number;
}): boolean {
  if (input.independentFallbackConfigured) return false;

  // HTTP 530/1033 is a route/tunnel failure. Unlike transient 502/503/504
  // responses, it opens the cross-isolate circuit immediately.
  const recentHttp530Failures = input.recentHttp530Failures ?? 0;
  if (Number.isFinite(recentHttp530Failures) && recentHttp530Failures > 0) {
    return true;
  }

  const threshold = Math.max(1, Math.floor(input.threshold ?? 3));
  return Number.isFinite(input.recentGatewayFailures) &&
    input.recentGatewayFailures >= threshold;
}



/**
 * Process-local half of the OmniRoute circuit breaker. The database preflight
 * protects across isolates, but concurrent calls can all pass that preflight
 * before the first failed response is recorded. This state stops later calls
 * in the same warm isolate; it never replaces the cross-isolate DB circuit.
 */
export type LocalGatewayCircuitState = {
  failureTimes: number[];
  openUntil: number;
};

export function recordLocalGatewayFailure(
  state: LocalGatewayCircuitState,
  errorCode: string | null | undefined,
  nowMs = Date.now(),
  threshold = 3,
): LocalGatewayCircuitState {
  const failureTimes = state.failureTimes.filter(
    (at) => Number.isFinite(at) && at <= nowMs && nowMs - at < OMNIROUTE_CIRCUIT_WINDOW_MS,
  );
  if (!/^(?:HTTP_(?:502|503|504|530)|GATEWAY_5XX)$/.test(errorCode ?? "")) {
    return { ...state, failureTimes };
  }

  failureTimes.push(nowMs);
  const safeThreshold = Number.isFinite(threshold) ? Math.max(1, Math.floor(threshold)) : 3;
  // Cloudflare 530/1033 is a route/tunnel failure, so stop this isolate's
  // queued calls immediately. Other gateway failures retain the 3-failure rule.
  const shouldOpen = errorCode === "HTTP_530" || failureTimes.length >= safeThreshold;
  return {
    failureTimes,
    openUntil: shouldOpen
      ? Math.max(state.openUntil, nowMs + OMNIROUTE_CIRCUIT_WINDOW_MS)
      : state.openUntil,
  };
}

export function isLocalGatewayCircuitOpen(
  state: LocalGatewayCircuitState,
  nowMs = Date.now(),
): boolean {
  return state.openUntil > nowMs;
}
