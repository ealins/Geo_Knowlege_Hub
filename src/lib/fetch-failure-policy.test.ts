import { describe, expect, test } from "bun:test";
import { shouldDeadLetterFetchFailure } from "./fetch-failure-policy";

describe("shouldDeadLetterFetchFailure", () => {
  test("terminalizes blocked HTTP 403 fetches immediately", () => {
    expect(shouldDeadLetterFetchFailure({
      blocked: true,
      httpStatus: 403,
      attempts: 1,
      maxAttempts: 5,
    })).toBe(true);
  });

  test("terminalizes robots.txt blocks without consuming retries forever", () => {
    expect(shouldDeadLetterFetchFailure({
      blocked: true,
      httpStatus: 0,
      attempts: 1,
      maxAttempts: 5,
    })).toBe(true);
  });

  test("keeps transient rate limits retryable before the attempt limit", () => {
    expect(shouldDeadLetterFetchFailure({
      blocked: false,
      httpStatus: 429,
      attempts: 2,
      maxAttempts: 5,
    })).toBe(false);
  });

  test("terminalizes retired and exhausted sources", () => {
    expect(shouldDeadLetterFetchFailure({
      blocked: false,
      httpStatus: 404,
      attempts: 1,
      maxAttempts: 5,
    })).toBe(true);
    expect(shouldDeadLetterFetchFailure({
      blocked: false,
      httpStatus: 502,
      attempts: 5,
      maxAttempts: 5,
    })).toBe(true);
  });
});
