export type FetchFailureDisposition = {
  blocked: boolean;
  httpStatus: number;
  attempts: number;
  maxAttempts: number;
};

export function shouldDeadLetterFetchFailure(input: FetchFailureDisposition): boolean {
  const permanentlyUnavailable = input.httpStatus === 404 || input.httpStatus === 410;
  return input.blocked || permanentlyUnavailable || input.attempts >= input.maxAttempts;
}


/**
 * Mirrors the eligibility guard in lease_external_fetch_tasks. Inactive or
 * blocked sources cannot be leased; their stale open tasks must be terminalized.
 */
export function isUnleaseableFetchSource(input: {
  active: boolean | null | undefined;
  status: string | null | undefined;
}): boolean {
  return input.active === false || input.status === "BLOCKED";
}
