import { describe, expect, test } from "bun:test";
import {
  boundedHostRetryAfterSeconds,
  parseHostFetchDeferralSeconds,
  restoreAttemptsAfterUnstartedFetch,
} from "./host-fetch-deferral-policy";

describe("host fetch deferral policy", () => {
  test("recognizes the worker's exact host-backoff deferral message", () => {
    expect(parseHostFetchDeferralSeconds("Deferred by host rate-limit backoff for 13s")).toBe(13);
  });

  test("bounds pathological delays and rejects unrelated fetch failures", () => {
    expect(parseHostFetchDeferralSeconds("Deferred by host rate-limit backoff for 3600s")).toBe(1800);
    expect(parseHostFetchDeferralSeconds("HTTP 429 (rate limited)")).toBeNull();
    expect(parseHostFetchDeferralSeconds("Deferred by host rate-limit backoff for 0s")).toBeNull();
    expect(parseHostFetchDeferralSeconds(null)).toBeNull();
  });

  test("restores the lease attempt because no network request was made", () => {
    expect(restoreAttemptsAfterUnstartedFetch(1)).toBe(0);
    expect(restoreAttemptsAfterUnstartedFetch(4)).toBe(3);
    expect(restoreAttemptsAfterUnstartedFetch(-1)).toBe(0);
  });
});


describe("persisted Retry-After hint", () => {
  test("accepts positive numeric seconds and caps the value at 30 minutes", () => {
    expect(boundedHostRetryAfterSeconds(90)).toBe(90);
    expect(boundedHostRetryAfterSeconds(3600)).toBe(1800);
  });

  test("ignores missing, non-numeric, zero, and negative values", () => {
    expect(boundedHostRetryAfterSeconds(undefined)).toBe(0);
    expect(boundedHostRetryAfterSeconds("90")).toBe(0);
    expect(boundedHostRetryAfterSeconds(0)).toBe(0);
    expect(boundedHostRetryAfterSeconds(-2)).toBe(0);
  });
});
