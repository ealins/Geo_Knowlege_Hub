import { describe, expect, test } from "bun:test";
import { shouldRunProgrammeDiscovery } from "./ingestion-worker.mjs";

const hour = 60 * 60_000;
const retry = 10 * 60_000;

describe("persistent worker programme discovery cadence", () => {
  test("runs on first persistent-worker start", () => {
    expect(shouldRunProgrammeDiscovery({
      burstMode: false,
      lastSuccessAtMs: 0,
      lastAttemptAtMs: 0,
      nowMs: 1_000,
      intervalMs: hour,
      retryIntervalMs: retry,
    })).toBe(true);
  });

  test("does not run inside a bounded burst", () => {
    expect(shouldRunProgrammeDiscovery({
      burstMode: true,
      lastSuccessAtMs: 0,
      lastAttemptAtMs: 0,
      nowMs: 1_000,
      intervalMs: hour,
      retryIntervalMs: retry,
    })).toBe(false);
  });

  test("waits for the hourly interval after a successful sweep", () => {
    const last = 1_000;
    const args = {
      burstMode: false,
      lastSuccessAtMs: last,
      lastAttemptAtMs: last,
      intervalMs: hour,
      retryIntervalMs: retry,
    };
    expect(shouldRunProgrammeDiscovery({ ...args, nowMs: last + hour - 1 })).toBe(false);
    expect(shouldRunProgrammeDiscovery({ ...args, nowMs: last + hour })).toBe(true);
  });

  test("throttles failed attempts and retries after the retry interval", () => {
    const attempt = 10_000;
    const args = {
      burstMode: false,
      lastSuccessAtMs: 0,
      lastAttemptAtMs: attempt,
      intervalMs: hour,
      retryIntervalMs: retry,
    };
    expect(shouldRunProgrammeDiscovery({ ...args, nowMs: attempt + retry - 1 })).toBe(false);
    expect(shouldRunProgrammeDiscovery({ ...args, nowMs: attempt + retry })).toBe(true);
  });
});