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
