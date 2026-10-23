import { describe, expect, test } from "bun:test";
import {
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
