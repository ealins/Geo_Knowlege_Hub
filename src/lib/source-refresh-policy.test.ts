import { describe, expect, test } from "bun:test";
import { getSourceRefreshSkipReason, shouldBackoffSourceAfterFailure, shouldReprobeBlocked403Source } from "./source-refresh-policy";

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


describe("shouldReprobeBlocked403Source", () => {
  test("re-probes only previously successful sources after the 24-hour 403 cooldown", () => {
    expect(shouldReprobeBlocked403Source({
      status: "BLOCKED",
      lastHttpStatus: 403,
      lastSuccessAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      lastFailureAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
      nowMs: now,
    })).toBe(true);
    expect(shouldReprobeBlocked403Source({
      status: "BLOCKED",
      lastHttpStatus: 403,
      lastSuccessAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      lastFailureAt: new Date(now - 23 * 60 * 60 * 1000).toISOString(),
      nowMs: now,
    })).toBe(false);
  });

  test("never re-probes never-successful, removed, or robots-blocked sources", () => {
    const oldFailure = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    expect(shouldReprobeBlocked403Source({
      status: "BLOCKED", lastHttpStatus: 403, lastFailureAt: oldFailure, nowMs: now,
    })).toBe(false);
    expect(shouldReprobeBlocked403Source({
      status: "BLOCKED", lastHttpStatus: 404,
      lastSuccessAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      lastFailureAt: oldFailure, nowMs: now,
    })).toBe(false);
    expect(shouldReprobeBlocked403Source({
      status: "BLOCKED", lastHttpStatus: null,
      lastSuccessAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      lastFailureAt: oldFailure, nowMs: now,
    })).toBe(false);
  });

  test("does not re-probe when a success is newer than the failure or source is no longer blocked", () => {
    expect(shouldReprobeBlocked403Source({
      status: "FETCHED", lastHttpStatus: 403,
      lastSuccessAt: new Date(now - 60 * 60 * 1000).toISOString(),
      lastFailureAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
      nowMs: now,
    })).toBe(false);
    expect(shouldReprobeBlocked403Source({
      status: "BLOCKED", lastHttpStatus: 403,
      lastSuccessAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      lastFailureAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
      nowMs: now,
    })).toBe(false);
  });
});


describe("getSourceRefreshSkipReason", () => {
  const allowed = {
    isDue: true,
    status: "FETCHED",
    blockedReprobe: false,
    blockedReprobeLimitReached: false,
    hasOpenFetchTask: false,
    failureBackoff: false,
  };

  test("reports not-due before other exclusion conditions", () => {
    expect(getSourceRefreshSkipReason({
      ...allowed,
      isDue: false,
      status: "BLOCKED",
      hasOpenFetchTask: true,
    })).toBe("not_due");
  });

  test("keeps blocked sources excluded unless the bounded 403 re-probe policy allows them", () => {
    expect(getSourceRefreshSkipReason({
      ...allowed,
      status: "BLOCKED",
    })).toBe("blocked");
    expect(getSourceRefreshSkipReason({
      ...allowed,
      status: "BLOCKED",
      blockedReprobe: true,
    })).toBeNull();
  });

  test("reports the per-tick re-probe cap without relaxing it", () => {
    expect(getSourceRefreshSkipReason({
      ...allowed,
      status: "BLOCKED",
      blockedReprobe: true,
      blockedReprobeLimitReached: true,
    })).toBe("blocked_reprobe_limit");
  });

  test("reports an existing open fetch task before cooldown", () => {
    expect(getSourceRefreshSkipReason({
      ...allowed,
      hasOpenFetchTask: true,
      failureBackoff: true,
    })).toBe("open_fetch_task");
  });

  test("reports cooldown and allows eligible due sources", () => {
    expect(getSourceRefreshSkipReason({
      ...allowed,
      failureBackoff: true,
    })).toBe("failure_cooldown");
    expect(getSourceRefreshSkipReason(allowed)).toBeNull();
  });
});
