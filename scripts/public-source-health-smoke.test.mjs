import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectPublicPageResponse } from "./public-source-health-smoke.mjs";

describe("inspectPublicPageResponse", () => {
  test("passes a healthy jobs page when the confirmed-dead listing is absent", () => {
    const result = inspectPublicPageResponse(
      200,
      "<h1>Academic &amp; industry jobs</h1><p>Doctoral Position in Debris Flow Monitoring</p>",
      "jobs",
    );
    assert.equal(result.ok, true);
    assert.equal(result.pageDetected, true);
    assert.equal(result.confirmedDeadListingPresent, false);
  });

  test("passes a healthy Research Pulse page when the confirmed-dead listing is absent", () => {
    const result = inspectPublicPageResponse(
      200,
      "<h1>Research Pulse</h1><h2>Latest signals</h2><p>New Earth observation publication</p>",
      "pulse",
    );
    assert.equal(result.ok, true);
    assert.equal(result.pageDetected, true);
    assert.equal(result.confirmedDeadListingPresent, false);
  });

  test("fails when the confirmed-dead listing remains on either public surface", () => {
    const deadListing = "Research Assistant / Research Associate in three dimensional forest ecology (Fixed Term)";
    assert.equal(inspectPublicPageResponse(200, "<h1>Career radar</h1>" + deadListing, "jobs").ok, false);
    assert.equal(inspectPublicPageResponse(200, "<h1>Research Pulse</h1>" + deadListing, "pulse").ok, false);
  });

  test("fails closed for an error response or an unrelated page", () => {
    assert.equal(inspectPublicPageResponse(500, "<h1>Career radar</h1>", "jobs").ok, false);
    assert.equal(inspectPublicPageResponse(200, "<h1>Not found</h1>", "pulse").ok, false);
  });
});
