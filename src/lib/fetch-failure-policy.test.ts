import { describe, expect, test } from "bun:test";
import { isUnleaseableFetchSource, shouldDeadLetterFetchFailure } from "./fetch-failure-policy";

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


describe("isUnleaseableFetchSource", () => {
  test("rejects inactive sources regardless of status", () => {
    expect(isUnleaseableFetchSource({ active: false, status: "PENDING" })).toBe(true);
    expect(isUnleaseableFetchSource({ active: false, status: "FAILED" })).toBe(true);
  });

  test("rejects blocked sources even when active is true", () => {
    expect(isUnleaseableFetchSource({ active: true, status: "BLOCKED" })).toBe(true);
  });

  test("preserves eligible sources and null active values allowed by the lease RPC", () => {
    expect(isUnleaseableFetchSource({ active: true, status: "FAILED" })).toBe(false);
    expect(isUnleaseableFetchSource({ active: true, status: "FETCHED" })).toBe(false);
    expect(isUnleaseableFetchSource({ active: null, status: "PENDING" })).toBe(false);
  });
});
