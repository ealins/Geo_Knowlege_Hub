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
