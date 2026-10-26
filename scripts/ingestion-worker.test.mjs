import assert from "node:assert/strict";
import test from "node:test";

import { parseRetryAfterMs, shouldQueueMaintenance } from "./ingestion-worker.mjs";

test("burst mode refreshes the queue when no fetch lease is available", () => {
  assert.equal(
    shouldQueueMaintenance({
      burstMode: true,
      lastMaintenanceAtMs: 0,
      nowMs: 10_000,
      maintenanceIntervalMs: 60_000,
      fetchLeaseCount: 0,
    }),
    true,
  );
});

test("steady mode still refills the queue when no fetch tasks are due", () => {
  assert.equal(
    shouldQueueMaintenance({
      burstMode: false,
      lastMaintenanceAtMs: 0,
      nowMs: 10_000,
      maintenanceIntervalMs: 60_000,
      fetchLeaseCount: 0,
    }),
    true,
  );
});

test("burst mode does not repeat maintenance immediately after a refill", () => {
  assert.equal(
    shouldQueueMaintenance({
      burstMode: true,
      lastMaintenanceAtMs: 10_000,
      nowMs: 20_000,
      maintenanceIntervalMs: 60_000,
      fetchLeaseCount: 0,
    }),
    false,
  );
});

test("burst mode prioritizes existing fetch leases over maintenance", () => {
  assert.equal(
    shouldQueueMaintenance({
      burstMode: true,
      lastMaintenanceAtMs: 0,
      nowMs: 20_000,
      maintenanceIntervalMs: 60_000,
      fetchLeaseCount: 1,
    }),
    false,
  );
});


test("Retry-After seconds extend host backoff within the existing 30-minute cap", () => {
  assert.equal(parseRetryAfterMs("90", 1_000), 90_000);
  assert.equal(parseRetryAfterMs("3600", 1_000), 30 * 60_000);
});

test("Retry-After HTTP dates are parsed relative to the supplied clock", () => {
  assert.equal(
    parseRetryAfterMs("Mon, 26 Oct 2026 08:36:00 GMT", Date.parse("Mon, 26 Oct 2026 08:34:00 GMT")),
    120_000,
  );
});

test("invalid or expired Retry-After headers do not add delay", () => {
  assert.equal(parseRetryAfterMs("not-a-date", 1_000), null);
  assert.equal(parseRetryAfterMs("Mon, 26 Oct 2026 08:33:00 GMT", Date.parse("Mon, 26 Oct 2026 08:34:00 GMT")), null);
  assert.equal(parseRetryAfterMs(null, 1_000), null);
});
