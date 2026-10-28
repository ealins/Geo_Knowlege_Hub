import assert from "node:assert/strict";
import test from "node:test";

import {
  extractStructuredFallbackText,
  isEthzJobDetailRedirectToListing,
  isTransientWorkerError,
  parseRetryAfterMs,
  shouldRetryTransientWorkerError,
  shouldQueueMaintenance,
  shouldRunReseed,
} from "./ingestion-worker.mjs";

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

test("recovers meaningful JobPosting JSON-LD when visible page text is empty", () => {
  const text = extractStructuredFallbackText({
    jsonld: [{
      "@type": "JobPosting",
      title: "Remote Sensing Scientist",
      description: "Lead satellite image analysis, geospatial modelling, and validation of Earth observation products for a multidisciplinary research team.",
    }],
  });
  assert.match(text, /Remote Sensing Scientist/);
  assert.match(text, /satellite image analysis/);
});

test("does not treat short or non-content JSON-LD metadata as usable text", () => {
  assert.equal(extractStructuredFallbackText({
    jsonld: [{ "@type": "WebSite", name: "GeoAcademic", description: "Home" }],
  }), "");
  assert.equal(extractStructuredFallbackText({
    jsonld: [{ "@type": "JobPosting", title: "Researcher", description: "Join our team." }],
  }), "");
});


test("rejects an ETHZ job detail that redirects to the generic site index", () => {
  assert.equal(
    isEthzJobDetailRedirectToListing(
      "https://jobs.ethz.ch/job/view/JOPG_ethz_xGjw10x7EZ9dklNfEB",
      "https://jobs.ethz.ch/site/index",
    ),
    true,
  );
});

test("does not reject an ETHZ detail page that remains on its requested path", () => {
  assert.equal(
    isEthzJobDetailRedirectToListing(
      "https://jobs.ethz.ch/job/view/JOPG_ethz_xGjw10x7EZ9dklNfEB",
      "https://jobs.ethz.ch/job/view/JOPG_ethz_xGjw10x7EZ9dklNfEB",
    ),
    false,
  );
});

test("keeps the redirect guard narrow to ETHZ detail-to-index redirects", () => {
  assert.equal(
    isEthzJobDetailRedirectToListing(
      "https://jobs.ethz.ch/site/index",
      "https://jobs.ethz.ch/site/index",
    ),
    false,
  );
  assert.equal(
    isEthzJobDetailRedirectToListing(
      "https://jobs.example.edu/job/view/JOPG_ethz_xGjw10x7EZ9dklNfEB",
      "https://jobs.example.edu/site/index",
    ),
    false,
  );
});

test("a failed reseed hook is throttled briefly without delaying the fetch loop", () => {
  const input = {
    lastSuccessAtMs: 0,
    lastAttemptAtMs: 50_000,
    nowMs: 80_000,
    intervalMs: 6 * 60 * 60_000,
    retryIntervalMs: 10 * 60_000,
  };
  assert.equal(shouldRunReseed(input), false);
  assert.equal(shouldRunReseed({ ...input, nowMs: 50_000 + 10 * 60_000 }), true);
});

test("successful reseeding follows the long refresh interval", () => {
  assert.equal(shouldRunReseed({
    lastSuccessAtMs: 10_000,
    lastAttemptAtMs: 10_000,
    nowMs: 60_000,
    intervalMs: 6 * 60 * 60_000,
    retryIntervalMs: 10 * 60_000,
  }), false);
  assert.equal(shouldRunReseed({
    lastSuccessAtMs: 10_000,
    lastAttemptAtMs: 10_000,
    nowMs: 10_000 + 6 * 60 * 60_000,
    intervalMs: 6 * 60 * 60_000,
    retryIntervalMs: 10 * 60_000,
  }), true);
});

test("recognizes transient network and upstream failures for bounded retry", () => {
  assert.equal(isTransientWorkerError(new Error("fetch failed")), true);
  assert.equal(isTransientWorkerError(new Error("Hook lease-fetch HTTP 503: upstream unavailable")), true);
  assert.equal(isTransientWorkerError(new Error("UND_ERR_CONNECT_TIMEOUT")), true);
});

test("does not retry authentication or contract failures as transient", () => {
  assert.equal(isTransientWorkerError(new Error("Hook lease-fetch HTTP 401: unauthorized")), false);
  assert.equal(isTransientWorkerError(new Error("Missing INGESTION_HOOK_SECRET")), false);
});

test("retries transient loop errors only while retry budget and runtime remain", () => {
  const error = new Error("fetch failed");
  assert.equal(shouldRetryTransientWorkerError({
    error, consecutiveErrors: 0, remainingMs: 60_000, retryDelayMs: 30_000,
  }), true);
  assert.equal(shouldRetryTransientWorkerError({
    error, consecutiveErrors: 2, remainingMs: 60_000, retryDelayMs: 30_000,
  }), false);
  assert.equal(shouldRetryTransientWorkerError({
    error, consecutiveErrors: 0, remainingMs: 30_000, retryDelayMs: 30_000,
  }), false);
  assert.equal(shouldRetryTransientWorkerError({
    error: new Error("Hook lease-fetch HTTP 401: unauthorized"),
    consecutiveErrors: 0, remainingMs: 60_000, retryDelayMs: 30_000,
  }), false);
});
