export const CONFIRMED_DEAD_LISTING_PATTERN =
  /Research Assistant\s*\/\s*Research Associate in three dimensional forest ecology \(Fixed Term\)/i;

const JOBS_PAGE_MARKER = /Academic\s*(?:&amp;|&|&#38;)\s*industry jobs|Career radar/i;
const PULSE_PAGE_MARKER = /Research Pulse|Latest signals/i;

function visibleText(html) {
  return (typeof html === "string" ? html : "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function extractPositionCount(text, pageKind) {
  const pattern = pageKind === "pulse" ? /\bPositions\s+(\d+)\b/i : /\bBoth tracks\s+(\d+)\b/i;
  const match = text.match(pattern);
  return match ? Number(match[1]) : null;
}

/** Pure response check so the production smoke gate has deterministic unit coverage. */
export function inspectPublicPageResponse(status, html, pageKind) {
  const text = visibleText(html);
  const marker = pageKind === "pulse" ? PULSE_PAGE_MARKER : JOBS_PAGE_MARKER;
  const pageDetected = marker.test(text);
  const confirmedDeadListingPresent = CONFIRMED_DEAD_LISTING_PATTERN.test(text);
  const positionCount = extractPositionCount(text, pageKind);
  return {
    ok:
      status >= 200 &&
      status < 300 &&
      pageDetected &&
      !confirmedDeadListingPresent &&
      positionCount !== null,
    pageDetected,
    confirmedDeadListingPresent,
    positionCount,
    status,
    pageKind,
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchVerifiedPage(page) {
  let lastFailure = "No response received";
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
        console.log(
          "Public source-health smoke passed for " + page.name +
          " (HTTP " + response.status + ", positions " + check.positionCount + ").",
        );
        return check;
      }
      lastFailure = check.confirmedDeadListingPresent
        ? "The confirmed-dead Cambridge forest-ecology listing is still visible."
        : "Expected " + page.name + " not verified (HTTP " + response.status +
          ", page marker: " + check.pageDetected + ", position count: " + check.positionCount + ").";
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    if (attempt < 8) await delay(5_000);
  }
  throw new Error(lastFailure);
}

async function runProductionSmoke() {
  const pages = [
    { name: "jobs catalogue", kind: "jobs", url: "https://geoacademic.app/jobs?sector=academic" },
    { name: "homepage Research Pulse", kind: "pulse", url: "https://geoacademic.app/" },
  ];
  const results = {};
  for (const page of pages) {
    try {
      results[page.kind] = await fetchVerifiedPage(page);
    } catch (error) {
      console.error(
        "::error::Public source-health smoke failed for " + page.name + " after 8 attempts: " +
        (error instanceof Error ? error.message : String(error)),
      );
      process.exitCode = 1;
      return;
    }
  }

  if (results.jobs.positionCount !== results.pulse.positionCount) {
    console.error(
      "::error::Public freshness mismatch: jobs catalogue shows " + results.jobs.positionCount +
      " positions but homepage shows " + results.pulse.positionCount + ".",
    );
    process.exitCode = 1;
    return;
  }
  console.log("Public source-health smoke passed on both pages; position counts agree at " + results.jobs.positionCount + ".");
}

// CI imports this module for unit tests. The network smoke runs only in the
// post-deployment step that explicitly sets this opt-in variable.
if (process.env.GEOACADEMIC_PUBLIC_SOURCE_HEALTH_SMOKE === "1") {
  await runProductionSmoke();
}
