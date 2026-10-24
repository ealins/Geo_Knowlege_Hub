import { describe, expect, test } from "bun:test";
import { shouldBackoffSourceAfterFailure } from "./source-refresh-policy";

const now = Date.parse("2026-10-24T03:00:00.000Z");

describe("shouldBackoffSourceAfterFailure", () => {
  test("backs off repeated forbidden responses for 24 hours", () => {
    expect(shouldBackoffSourceAfterFailure({
      lastFailureAt: new Date(now - 23 * 60 * 60 * 1000).toISOString(),
      lastHttpStatus: 403,
      nowMs: now,
    })).toBe(true);
    expect(shouldBackoffSourceAfterFailure({
      lastFailureAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
      lastHttpStatus: 403,
      nowMs: now,
    })).toBe(false);
  });

  test("uses shorter cooldowns for rate limits and server errors", () => {
    expect(shouldBackoffSourceAfterFailure({
      lastFailureAt: new Date(now - 30 * 60 * 1000).toISOString(),
      lastHttpStatus: 429,
      nowMs: now,
    })).toBe(true);
    expect(shouldBackoffSourceAfterFailure({
      lastFailureAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      lastHttpStatus: 503,
      nowMs: now,
    })).toBe(false);
  });

  test("backs off missing-text/network failures for six hours", () => {
    expect(shouldBackoffSourceAfterFailure({
      lastFailureAt: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
      lastHttpStatus: null,
      nowMs: now,
    })).toBe(true);
    expect(shouldBackoffSourceAfterFailure({
      lastFailureAt: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
      lastHttpStatus: null,
      nowMs: now,
    })).toBe(false);
  });

  test("does not back off when there is no failure or a later success", () => {
    expect(shouldBackoffSourceAfterFailure({ nowMs: now })).toBe(false);
    expect(shouldBackoffSourceAfterFailure({
      lastSuccessAt: new Date(now - 30 * 60 * 1000).toISOString(),
      lastFailureAt: new Date(now - 60 * 60 * 1000).toISOString(),
      lastHttpStatus: 403,
      nowMs: now,
    })).toBe(false);
  });
});
