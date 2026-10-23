/** Provider outages are retryable; business-rule and schema rejections are not. */
export function isTransientExtractionError(errorCode: string | null | undefined): boolean {
  if (!errorCode) return false;
  return errorCode === "TIMEOUT" ||
    errorCode === "NETWORK_ERROR" ||
    errorCode === "HTTP_429" ||
    /^HTTP_5\d{2}$/.test(errorCode);
}
