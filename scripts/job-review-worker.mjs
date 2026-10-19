/**
 * Bounded GeoAcademic vacancy-review worker for GitHub Actions.
 *
 * The worker receives page snapshots through a secret-authenticated lease. It
 * never receives Supabase credentials and cannot write canonical rows itself.
 * Model output is validated again by the web application before persistence.
 */

const BASE_URL = (process.env.GEOACADEMIC_BASE_URL || "https://geoacademic.app").replace(/\/$/, "");
const HOOK_SECRET = process.env.INGESTION_HOOK_SECRET || "";
const OMNIROUTE_URL = (process.env.OMNIROUTE_URL || "https://omniroute.geoacademic.app/v1").replace(
  /\/$/,
  "",
);
const OMNIROUTE_API_KEY = process.env.OMNIROUTE_API_KEY || "";
const OMNIROUTE_MODEL = process.env.OMNIROUTE_MODEL || "auto";
const OMNIROUTE_CODING_MODEL = process.env.OMNIROUTE_CODING_MODEL || "auto/coding:free";
const RUNTIME_MS = clamp(process.env.REVIEW_RUNTIME_MS, 30_000, 4 * 60_000, 210_000);
const LEASE_LIMIT = clamp(process.env.REVIEW_LEASE_LIMIT, 1, 10, 4);
const CONCURRENCY = clamp(process.env.REVIEW_CONCURRENCY, 1, 8, 8);
const HOOK_TIMEOUT_MS = 90_000;

const SYSTEM_PROMPT = `You extract job facts for GeoAcademic, which covers photogrammetry, remote sensing, geodesy, geoinformatics, GIS, GeoAI, Earth observation, LiDAR, SAR, point clouds and spatial data science.

Absolute rules:
1. Use only the supplied page. Never infer or invent facts.
2. Use null for unstated fields.
3. Every evidence item must be a verbatim continuous snippet from PAGE TEXT.
4. Return one JSON object only. No prose and no markdown.
5. Reject career hubs, vacancy lists, marketing pages, employee stories and product pages.
6. geospatial_relevance is true only when the role itself genuinely concerns the listed geospatial fields. Generic software/AI roles are false.

Return exactly:
{"is_single_real_position":boolean,"rejection_reason":string|null,"title":string|null,"opportunity_type":"phd"|"doctoral_researcher"|"research_assistant"|"postdoc"|"other"|null,"sector":"academic"|"industry"|null,"department":string|null,"supervisor_name":string|null,"city":string|null,"country":string|null,"funding_type":string|null,"salary_text":string|null,"contract_type":string|null,"start_date":string|null,"application_deadline":string|null,"application_url":string|null,"requirements":string|null,"summary":string|null,"geospatial_relevance":boolean,"topics":string[],"confidence":number,"evidence":string[]}

Dates are YYYY-MM-DD or null. confidence is 0..1.`;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function parseJsonObject(value) {
  const text = String(value || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI response has no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

function detectCodingContent(pageText) {
  const codingIndicators = [
    "code",
    "function",
    "class",
    "import ",
    "export ",
    "def ",
    "interface",
    "type ",
    "npm ",
    "yarn ",
    "pnpm ",
    "package.json",
    "tsconfig",
    "docker",
    "dockerfile",
    "api docs",
    "sdk reference",
  ];
  const lowerText = pageText.toLowerCase();
  const matches = codingIndicators.filter((ind) => lowerText.includes(ind));
  return matches.length >= 3;
}

async function fetchHook(action) {
  if (!HOOK_SECRET) throw new Error("INGESTION_HOOK_SECRET is not configured");
  const response = await fetch(`${BASE_URL}/api/hooks/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ingestion-secret": HOOK_SECRET,
    },
  });
  const body = await response.text();
  if (response.ok) {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (response.status === 401) {
    throw new Error(
      `Hook ${action} HTTP 401: INGESTION_HOOK_SECRET does not match the production hook secret`,
    );
  }
  throw new Error(
    `Hook ${action} HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`,
  );
}

async function extractWithAI(lease) {
  const pageText = String(lease.text_content || "").slice(0, 8_000);
  if (pageText.length < 120) throw new Error("Page text too short for review");
  if (!OMNIROUTE_API_KEY) throw new Error("OMNIROUTE_API_KEY is not configured");

  // Use coding model for code-heavy pages to get better results
  const useCodingModel = detectCodingContent(pageText);
  const model = useCodingModel ? OMNIROUTE_CODING_MODEL : OMNIROUTE_MODEL;

  const userContent = `SOURCE URL: ${lease.url || ""}
PAGE TITLE: ${lease.title || ""}
PAGE TEXT:
${pageText}`;

  const response = await fetch(`${OMNIROUTE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${OMNIROUTE_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OmniRoute ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  return parseJsonObject(content);
}

export async function runLease(lease) {
  const result = await extractWithAI(lease);
  return {
    id: lease.id,
    status: "REVIEWED",
    result,
    reviewed_at: new Date().toISOString(),
  };
}

async function acquire() {
  if (active < CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
  active += 1;
}

function release() {
  active = Math.max(0, active - 1);
  const next = waiting.shift();
  if (next) next();
}

let active = 0;
let waiting = [];

let leases = [];
let currentLeaseIndex = 0;

function processLeases() {
  if (leases.length === 0) {
    console.log("No leases to process");
    return;
  }

  acquire().then(async () => {
    try {
      const lease = leases[currentLeaseIndex];
      console.log(`Processing lease ${lease.id}...`);

      const result = await runLease(lease);
      console.log(`Lease ${lease.id} completed:`, JSON.stringify(result).slice(0, 200));

      // Return result to hook
      await fetchHook("result").catch((e) => console.error("Failed to return result:", e));
    } catch (error) {
      console.error(`Lease error:`, error);
    } finally {
      release();
      currentLeaseIndex = (currentLeaseIndex + 1) % leases.length;
      if (currentLeaseIndex === 0) {
        console.log("Cycle complete, shutting down");
      } else {
        setTimeout(processLeases, 100);
      }
    }
  });
}

async function main() {
  console.log("Starting job-review-worker...");
  console.log("OmniRoute URL:", OMNIROUTE_URL);
  console.log("OmniRoute Model:", OMNIROUTE_MODEL);
  console.log("OmniRoute Coding Model:", OMNIROUTE_CODING_MODEL);

  // Acquire leases
  const result = await fetchHook("acquire");
  leases = result.leases || [];
  console.log(`Acquired ${leases.length} leases`);

  if (leases.length === 0) {
    console.log("No leases available, exiting");
    return;
  }

  // Process leases
  const deadline = Date.now() + RUNTIME_MS;
  const interval = setInterval(() => {
    if (Date.now() > deadline) {
      console.log("Runtime limit reached, shutting down");
      clearInterval(interval);
      processLeases();
    }
  }, 1000);

  processLeases();

  console.log("Worker started, deadline:", new Date(deadline).toISOString());
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});