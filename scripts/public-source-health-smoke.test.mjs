import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectPublicJobsResponse } from "./public-source-health-smoke.mjs";

describe("inspectPublicJobsResponse", () => {
  test("passes a healthy jobs page when the confirmed-dead listing is absent", () => {
    const result = inspectPublicJobsResponse(
      200,
      "<h1>Academic &amp; industry jobs</h1><p>Doctoral Position in Debris Flow Monitoring</p>",
    );
    assert.equal(result.ok, true);
    assert.equal(result.pageDetected, true);
    assert.equal(result.confirmedDeadListingPresent, false);
  });

  test("fails when the known confirmed-dead listing remains in public HTML", () => {
    const result = inspectPublicJobsResponse(
      200,
      "<h1>Academic &amp; industry jobs</h1><p>Research Assistant / Research Associate in three dimensional forest ecology (Fixed Term)</p>",
    );
    assert.equal(result.ok, false);
    assert.equal(result.confirmedDeadListingPresent, true);
  });

  test("fails closed for an error response or an unrelated page", () => {
    assert.equal(inspectPublicJobsResponse(500, "<h1>Career radar</h1>").ok, false);
    assert.equal(inspectPublicJobsResponse(200, "<h1>Not found</h1>").ok, false);
  });
});
