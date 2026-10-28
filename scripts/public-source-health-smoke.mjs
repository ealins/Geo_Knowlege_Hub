export const CONFIRMED_DEAD_LISTING_PATTERN =
  /Research Assistant\s*\/\s*Research Associate in three dimensional forest ecology \(Fixed Term\)/i;

const JOBS_PAGE_MARKER = /Academic\s*(?:&amp;|&|&#38;)\s*industry jobs|Career radar/i;
const PULSE_PAGE_MARKER = /Research Pulse|Latest signals/i;

/** Pure response check so the production smoke gate has deterministic unit coverage. */
export function inspectPublicPageResponse(status, html, pageKind) {
  const body = typeof html === "string" ? html : "";
  const marker = pageKind === "pulse" ? PULSE_PAGE_MARKER : JOBS_PAGE_MARKER;
  const pageDetected = marker.test(body);
  const confirmedDeadListingPresent = CONFIRMED_DEAD_LISTING_PATTERN.test(body);
  return {
    ok: status >= 200 && status < 300 && pageDetected && !confirmedDeadListingPresent,
    pageDetected,
    confirmedDeadListingPresent,
    status,
    pageKind,
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runProductionSmoke() {
  const pages = [
    { name: "jobs catalogue", kind: "jobs", url: new URL("https://geoacademic.app/jobs?sector=academic") },
    { name: "homepage Research Pulse", kind: "pulse", url: new URL("https://geoacademic.app/") },
  ];

  for (const page of pages) {
    let lastFailure = "No response received";
    let passed = false;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        const url = new URL(page.url);
        url.searchParams.set(
          "freshness_probe",
          (process.env.GITHUB_SHA || String(Date.now())) + "-" + page.kind + "-" + attempt,
        );
        const response = await fetch(url, {
          headers: {
            "Cache-Control": "no-cache, no-store, max-age=0",
            Pragma: "no-cache",
          },
          signal: AbortSignal.timeout(20_000),
        });
        const html = await response.text();
        const check = inspectPublicPageResponse(response.status, html, page.kind);
        if (check.ok) {
          console.log("Public source-health smoke passed for " + page.name + " (HTTP " + response.status + ").");
          passed = true;
          break;
        }
        lastFailure = check.confirmedDeadListingPresent
          ? "The confirmed-dead Cambridge forest-ecology listing is still present in public HTML."
          : "Expected " + page.name + " not verified (HTTP " + response.status + ", page marker: " + check.pageDetected + ").";
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }

      if (attempt < 8) await delay(5_000);
    }

    if (!passed) {
      console.error("::error::Public source-health smoke failed for " + page.name + " after 8 attempts: " + lastFailure);
      process.exitCode = 1;
      return;
    }
  }
}

// CI imports this module for unit tests. The network smoke runs only in the
// post-deployment step that explicitly sets this opt-in variable.
if (process.env.GEOACADEMIC_PUBLIC_SOURCE_HEALTH_SMOKE === "1") {
  await runProductionSmoke();
}
