export const CONFIRMED_DEAD_LISTING_PATTERN =
  /Research Assistant\\s*\\/\\s*Research Associate in three dimensional forest ecology \\(Fixed Term\\)/i;

const JOBS_PAGE_MARKER = /Academic\\s*(?:&amp;|&|&#38;)\\s*industry jobs|Career radar/i;

/** Pure response check so the production smoke gate has deterministic unit coverage. */
export function inspectPublicJobsResponse(status, html) {
  const body = typeof html === "string" ? html : "";
  const pageDetected = JOBS_PAGE_MARKER.test(body);
  const confirmedDeadListingPresent = CONFIRMED_DEAD_LISTING_PATTERN.test(body);
  return {
    ok: status >= 200 && status < 300 && pageDetected && !confirmedDeadListingPresent,
    pageDetected,
    confirmedDeadListingPresent,
    status,
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runProductionSmoke() {
  const url = new URL("https://geoacademic.app/jobs");
  url.searchParams.set("sector", "academic");
  // Unique query parameter plus no-cache headers avoids treating a cached HTML
  // response as evidence that the latest deployment reached the public surface.
  url.searchParams.set("freshness_probe", process.env.GITHUB_SHA || String(Date.now()));

  let lastFailure = "No response received";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "Cache-Control": "no-cache, no-store, max-age=0",
          Pragma: "no-cache",
        },
        signal: AbortSignal.timeout(20_000),
      });
      const html = await response.text();
      const check = inspectPublicJobsResponse(response.status, html);
      if (check.ok) {
        console.log(
          `Public source-health smoke passed (HTTP ${response.status}); confirmed-dead Cambridge listing is absent.`,
        );
        return;
      }
      lastFailure = check.confirmedDeadListingPresent
        ? "The confirmed-dead Cambridge forest-ecology listing is still present in public HTML."
        : `Expected jobs page not verified (HTTP ${response.status}, page marker: ${check.pageDetected}).`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    if (attempt < 8) await delay(5_000);
  }

  console.error(`::error::Public source-health smoke failed after 8 attempts: ${lastFailure}`);
  process.exitCode = 1;
}

// CI imports this module for unit tests. The network smoke runs only in the
// post-deployment step that explicitly sets this opt-in variable.
if (process.env.GEOACADEMIC_PUBLIC_SOURCE_HEALTH_SMOKE === "1") {
  await runProductionSmoke();
}
