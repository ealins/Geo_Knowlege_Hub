import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectPublicPageResponse } from "./public-source-health-smoke.mjs";

describe("inspectPublicPageResponse", () => {
  test("passes a healthy jobs page and extracts its total count", () => {
    const result = inspectPublicPageResponse(
      200,
      "<h1>Academic &amp; industry jobs</h1><p>Academic track 41 Industry track 0 Both tracks 41</p><p>Doctoral Position in Debris Flow Monitoring</p>",
      "jobs",
    );
    assert.equal(result.ok, true);
    assert.equal(result.pageDetected, true);
    assert.equal(result.confirmedDeadListingPresent, false);
    assert.equal(result.positionCount, 41);
  });

  test("passes a healthy Research Pulse page and extracts its position count", () => {
    const result = inspectPublicPageResponse(
      200,
      "<h1>Research Pulse</h1><h2>Latest signals</h2><p>Positions 41</p><p>New Earth observation publication</p>",
      "pulse",
    );
    assert.equal(result.ok, true);
    assert.equal(result.pageDetected, true);
    assert.equal(result.confirmedDeadListingPresent, false);
    assert.equal(result.positionCount, 41);
  });

  test("fails when the confirmed-dead listing remains on either public surface", () => {
    const deadListing = "Research Assistant / Research Associate in three dimensional forest ecology (Fixed Term)";
    assert.equal(inspectPublicPageResponse(200, "<h1>Career radar</h1><p>Both tracks 41</p>" + deadListing, "jobs").ok, false);
    assert.equal(inspectPublicPageResponse(200, "<h1>Research Pulse</h1><p>Positions 41</p>" + deadListing, "pulse").ok, false);
  });

  test("fails closed for an error response, unrelated page, or missing count", () => {
    assert.equal(inspectPublicPageResponse(500, "<h1>Career radar</h1><p>Both tracks 41</p>", "jobs").ok, false);
    assert.equal(inspectPublicPageResponse(200, "<h1>Not found</h1><p>Positions 41</p>", "pulse").ok, false);
    assert.equal(inspectPublicPageResponse(200, "<h1>Research Pulse</h1>", "pulse").ok, false);
  });
});
