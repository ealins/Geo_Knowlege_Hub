/**
 * GeoAcademic external fetch worker.
 *
 * Railway performs robots checks, downloads, HTML cleanup and link extraction.
 * The web app only leases tasks and persists compact validated snapshots, keeping
 * expensive and long-running network work outside the web application.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

const BASE_URL = (
  process.env.GEOACADEMIC_BASE_URL || "https://geoacademic.app"
).replace(/\/$/, "");
const HOOK_SECRET = process.env.INGESTION_HOOK_SECRET || "";
const CONCURRENCY = clamp(process.env.INGESTION_FETCH_CONCURRENCY, 1, 8, 6);
const LEASE_LIMIT = clamp(process.env.INGESTION_LEASE_LIMIT, 1, 20, 12);
const ACTIVE_DELAY_MS = clamp(
  process.env.INGESTION_ACTIVE_DELAY_MS,
  250,
  60_000,
  2_000,
);
const IDLE_DELAY_MS = clamp(
  process.env.INGESTION_IDLE_DELAY_MS,
  5_000,
  10 * 60_000,
  45_000,
);
const ERROR_DELAY_MS = clamp(
  process.env.INGESTION_ERROR_DELAY_MS,
  5_000,
  10 * 60_000,
  30_000,
);
const FETCH_TIMEOUT_MS = clamp(
  process.env.INGESTION_FETCH_TIMEOUT_MS,
  5_000,
  60_000,
  20_000,
);
const PER_HOST_DELAY_MS = clamp(
  process.env.INGESTION_PER_HOST_DELAY_MS,
  250,
  30_000,
  1_500,
);
const MAX_RESPONSE_BYTES = clamp(
  process.env.INGESTION_MAX_RESPONSE_BYTES,
  250_000,
  10_000_000,
  3_000_000,
);
const MAINTENANCE_INTERVAL_MS = clamp(
  process.env.INGESTION_MAINTENANCE_INTERVAL_MS,
  5 * 60_000,
  24 * 60 * 60_000,
  10 * 60_000,
);
const RESEED_INTERVAL_MS = clamp(
  process.env.INGESTION_RESEED_INTERVAL_MS,
  60 * 60_000,
  7 * 24 * 60 * 60_000,
  6 * 60 * 60_000,
);
const RUNTIME_MS = clamp(process.env.INGESTION_RUNTIME_MS, 0, 4 * 60_000, 0);
const BURST_MODE =
  (process.env.INGESTION_BURST_MODE || "").toLowerCase() === "true";
const WORKER_TRIGGER =
  process.env.INGESTION_WORKER_TRIGGER || "external-fetch-worker";
const USER_AGENT =
  "GeoAcademicRadarBot/1.0 (+https://geoacademic.app; academic source indexing)";

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.floor(parsed)))
    : fallback;
}

export function shouldQueueMaintenance({
  burstMode,
  lastMaintenanceAtMs,
  nowMs,
  maintenanceIntervalMs,
  fetchLeaseCount,
}) {
  // In a bounded burst, existing leases must be fetched before any
  // housekeeping work. If no fetch work is available, perform an initial
  // refill, then throttle further refills to the configured interval.
  if (burstMode && fetchLeaseCount > 0) return false;
  if (lastMaintenanceAtMs === 0) return true;
  return nowMs - lastMaintenanceAtMs >= maintenanceIntervalMs;
}

let stopping = false;
let fatalError = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callHook(action, payload = {}, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}/api/public/hooks/ingest-batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${HOOK_SECRET}`,
      },
      body: JSON.stringify({
        action,
        trigger: WORKER_TRIGGER,
        ...payload,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let result = {};
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      result = { raw: text.slice(0, 500) };
    }
    if (
      !response.ok &&
      !(action === "complete-fetch" && response.status === 409)
    ) {
      throw new Error(
        `Hook ${action} HTTP ${response.status}: ${JSON.stringify(result).slice(0, 500)}`,
      );
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:"))
    return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized)
    );
  }
  return true;
}

const dnsCache = new Map();

async function assertPublicUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol))
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  if (url.username || url.password)
    throw new Error("Credential-bearing URLs are not allowed");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new Error("Local network URL is not allowed");
  }
  let addresses = dnsCache.get(host);
  if (!addresses || addresses.expiresAt <= Date.now()) {
    const resolved = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true, verbatim: true });
    addresses = {
      values: resolved.map((entry) => entry.address),
      expiresAt: Date.now() + 10 * 60_000,
    };
    dnsCache.set(host, addresses);
  }
  if (!addresses.values.length || addresses.values.some(isPrivateAddress)) {
    throw new Error("Private or unresolvable network target is not allowed");
  }
  return url;
}

async function fetchWithTimeout(url, init = {}) {
  let current = (await assertPublicUrl(url)).toString();
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain,application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9",
        ...(init.headers || {}),
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    current = (
      await assertPublicUrl(new URL(location, current).toString())
    ).toString();
  }
  throw new Error("Too many redirects");
}

const robotsCache = new Map();

async function robotsAllows(url) {
  const parsed = new URL(url);
  const cached = robotsCache.get(parsed.origin);
  if (cached && cached.expiresAt > Date.now()) {
    return !cached.disallow.some((path) => parsed.pathname.startsWith(path));
  }
  let disallow = [];
  try {
    const response = await fetchWithTimeout(`${parsed.origin}/robots.txt`, {
      headers: { accept: "text/plain" },
    });
    if (response.ok) {
      const text = await response.text();
      let applies = false;
      for (const raw of text.split("\n")) {
        const line = (raw.split("#")[0] || "").trim();
        const [keyRaw, ...rest] = line.split(":");
        const key = (keyRaw || "").trim().toLowerCase();
        const value = rest.join(":").trim();
        if (key === "user-agent") {
          applies =
            value === "*" || value.toLowerCase().includes("geoacademic");
        } else if (key === "disallow" && applies && value) {
          disallow.push(value);
        }
      }
    }
  } catch {
    disallow = [];
  }
  robotsCache.set(parsed.origin, {
    disallow,
    expiresAt: Date.now() + 60 * 60_000,
  });
  return !disallow.some((path) => parsed.pathname.startsWith(path));
}

const hostNextStart = new Map();

async function respectHostDelay(url) {
  const host = new URL(url).host;
  const startAt = Math.max(Date.now(), hostNextStart.get(host) || 0);
  hostNextStart.set(host, startAt + PER_HOST_DELAY_MS);
  const waitMs = Math.max(0, startAt - Date.now());
  if (waitMs) await sleep(waitMs);
}

async function readTextLimited(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} byte limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} byte limit`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&auml;/gi, "ä")
    .replace(/&ouml;/gi, "ö")
    .replace(/&uuml;/gi, "ü")
    .replace(/&szlig;/gi, "ß");
}

function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
    || /<(?:rss:title|atom:title|title)\b[^>]*>([\s\S]*?)<\/(?:rss:title|atom:title|title)>/i.exec(html);
  return match?.[1]
    ? decodeEntities(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 300)
    : null;
}

function extractText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);
}

function extractLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const add = (href, label) => {
    if (!href || /^(?:mailto:|tel:|javascript:)/i.test(href.trim())) return;
    try {
      const url = new URL(decodeEntities(href.trim()), baseUrl);
      url.hash = "";
      if (!/^https?:$/.test(url.protocol) || seen.has(url.toString())) return;
      seen.add(url.toString());
      links.push({
        url: url.toString(),
        label: decodeEntities(label || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200),
      });
    } catch {
      // Ignore malformed links.
    }
  };
  const anchors = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchors.exec(html)) !== null && links.length < 200) add(match[1], match[2]);

  // RSS/Atom entries become individual discovered source links, not one feed-sized pulse.
  const entries = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let entry;
  while ((entry = entries.exec(html)) !== null && links.length < 200) {
    const block = entry[1] || "";
    const label = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1] || "";
    const href = /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i.exec(block)?.[1]
      || /<link\b[^>]*>([\s\S]*?)<\/link>/i.exec(block)?.[1];
    add(href, label);
  }
  return links;
}

function compactValue(value, depth = 0) {
  if (depth > 4) return undefined;
  if (value === null || ["string", "number", "boolean"].includes(typeof value))
    return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 12)
      .map((item) => compactValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  const output = {};
  for (const [key, nested] of Object.entries(value).slice(0, 40)) {
    const compacted = compactValue(nested, depth + 1);
    if (compacted !== undefined) output[key] = compacted;
  }
  return output;
}

function flattenStructured(value, output) {
  if (output.length >= 30) return;
  if (Array.isArray(value)) {
    for (const item of value) flattenStructured(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value["@graph"])) {
    for (const item of value["@graph"]) flattenStructured(item, output);
  }
  if (value["@type"] || value["@id"] || value.name || value.headline) {
    const compacted = compactValue(value);
    if (compacted && !Array.isArray(compacted)) output.push(compacted);
  }
}

function structuredTypes(node) {
  const value = node["@type"];
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
}

function extractStructured(html, pageUrl) {
  const jsonld = [];
  const expression =
    /<script\b[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let chars = 0;
  while (
    (match = expression.exec(html)) !== null &&
    jsonld.length < 30 &&
    chars < 24_000
  ) {
    const raw = decodeEntities((match[1] || "").trim());
    if (!raw) continue;
    chars += raw.length;
    try {
      flattenStructured(JSON.parse(raw), jsonld);
    } catch {
      // Ignore invalid publisher JSON-LD.
    }
  }
  const meta = { page_url: pageUrl };
  const wanted = new Set([
    "og:title",
    "og:type",
    "og:url",
    "article:published_time",
    "profile:first_name",
    "profile:last_name",
  ]);
  const metaExpression =
    /<meta\b[^>]*(?:property|name)=["']([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>|<meta\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']([^"']+)["'][^>]*>/gi;
  while ((match = metaExpression.exec(html)) !== null) {
    const key = (match[1] || match[4] || "").toLowerCase();
    const value = decodeEntities(match[2] || match[3] || "").trim();
    if (wanted.has(key) && value) meta[key] = value.slice(0, 1_000);
  }
  const types = [...new Set(jsonld.flatMap(structuredTypes))];
  return jsonld.length || Object.keys(meta).length > 1
    ? { jsonld, meta, types }
    : null;
}

async function fetchLease(lease) {
  const startedAt = Date.now();
  let completion;
  try {
    await respectHostDelay(lease.url);
    if (!(await robotsAllows(lease.url))) {
      completion = {
        success: false,
        blocked: true,
        error: "Disallowed by robots.txt",
      };
    } else {
      const response = await fetchWithTimeout(lease.url);
      if (!response.ok) {
        completion = {
          success: false,
          http_status: response.status,
          blocked: response.status === 403,
          error: `HTTP ${response.status}`,
        };
      } else {
        const contentType = (
          response.headers.get("content-type") || ""
        ).toLowerCase();
        if (
          contentType &&
          !/(?:text\/html|application\/xhtml\+xml|text\/plain|application\/(?:rss\+xml|atom\+xml|xml)|text\/xml)/.test(
            contentType,
          )
        ) {
          throw new Error(
            `Unsupported content type: ${contentType.slice(0, 120)}`,
          );
        }
        const html = await readTextLimited(response);
        const finalUrl = response.url || lease.url;
        const text = extractText(html);
        if (!text) throw new Error("Fetched page contains no usable text");
        completion = {
          success: true,
          http_status: response.status,
          final_url: finalUrl,
          page_title: extractTitle(html),
          text_content: text,
          links: extractLinks(html, finalUrl),
          structured: extractStructured(html, finalUrl),
        };
      }
    }
  } catch (error) {
    completion = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  completion.response_time_ms = Date.now() - startedAt;
  const result = await callHook(
    "complete-fetch",
    {
      completion: {
        task_id: lease.task_id,
        source_id: lease.source_id,
        lease_started_at: lease.lease_started_at,
        attempt: lease.attempt,
        ...completion,
      },
    },
    90_000,
  );
  return { lease, completion, result };
}

async function mapConcurrent(items, concurrency, callback) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        output[index] = await callback(items[index]);
      }
    }),
  );
  return output;
}

async function runMaintenance() {
  // Keep the source-fetch control plane small and bounded. Public insight
  // projection can perform hundreds of database operations and belongs in a
  // separate non-critical job; allowing it here previously aborted the whole
  // worker after the 120-second hook timeout.
  const [refreshResult, discoveryResult] = await Promise.allSettled([
    callHook("refresh-due", { limit: 80 }, 30_000),
    callHook("enqueue-discovery", { limit: 8 }, 30_000),
  ]);

  if (refreshResult.status === "rejected") {
    console.error(
      `${new Date().toISOString()} MAINTENANCE_FAILED action=refresh-due`,
      refreshResult.reason,
    );
  }
  if (discoveryResult.status === "rejected") {
    console.error(
      `${new Date().toISOString()} MAINTENANCE_FAILED action=enqueue-discovery`,
      discoveryResult.reason,
    );
  }

  const refresh =
    refreshResult.status === "fulfilled" ? refreshResult.value : {};
  const discovery =
    discoveryResult.status === "fulfilled" ? discoveryResult.value : {};
  console.log(
    `${new Date().toISOString()} MAINTENANCE refresh_queued=${refresh.queued ?? 0} discovery_queued=${discovery.queued ?? 0} refresh_ok=${refreshResult.status === "fulfilled"} discovery_ok=${discoveryResult.status === "fulfilled"}`,
  );
}

const shouldRunDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (shouldRunDirectly) {
  if (!HOOK_SECRET) {
    console.error("Missing INGESTION_HOOK_SECRET in environment.");
    process.exit(1);
  }

  console.log(
    `GeoAcademic external fetch worker -> ${BASE_URL} concurrency=${CONCURRENCY} lease=${LEASE_LIMIT}${RUNTIME_MS ? ` runtime=${Math.round(RUNTIME_MS / 1000)}s` : " continuous"}`,
  );

  let lastMaintenanceAt = 0;
  let lastReseedAt = 0;
  const stopAt = RUNTIME_MS ? Date.now() + RUNTIME_MS : Number.POSITIVE_INFINITY;
  while (!stopping && Date.now() < stopAt) {
    try {
      if (!BURST_MODE && Date.now() - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) {
        await runMaintenance();
        lastMaintenanceAt = Date.now();
      }
      if (!BURST_MODE && Date.now() - lastReseedAt >= RESEED_INTERVAL_MS) {
        const reseed = await callHook("reseed-high-value", { limit: 100 });
        lastReseedAt = Date.now();
        console.log(
          `${new Date().toISOString()} RESEED queued=${reseed.queued ?? 0}`,
        );
      }

      const leased = await callHook(
        "lease-fetch",
        { limit: LEASE_LIMIT },
        20_000,
      );
      let leases = Array.isArray(leased.leases) ? leased.leases : [];
      const maintenanceNow = shouldQueueMaintenance({
        burstMode: BURST_MODE,
        lastMaintenanceAtMs: lastMaintenanceAt,
        nowMs: Date.now(),
        maintenanceIntervalMs: MAINTENANCE_INTERVAL_MS,
        fetchLeaseCount: leases.length,
      });
      if (maintenanceNow) {
        await runMaintenance();
        lastMaintenanceAt = Date.now();

        // A bounded GitHub Actions burst used to exit immediately after this
        // refill because its first lease was empty. Lease once more so the same
        // run can fetch the newly queued sources instead of waiting 15 minutes
        // for the next scheduled execution.
        if (leases.length === 0) {
          const refilled = await callHook(
            "lease-fetch",
            { limit: LEASE_LIMIT },
            20_000,
          );
          leases = Array.isArray(refilled.leases) ? refilled.leases : [];
          console.log(
            `${new Date().toISOString()} REFILL leased=${leases.length}`,
          );
        }
      }
      if (leases.length === 0) {
        console.log(`${new Date().toISOString()} IDLE no fetch tasks due`);
        if (RUNTIME_MS) break;
        await sleep(IDLE_DELAY_MS);
        continue;
      }

      const results = await mapConcurrent(leases, CONCURRENCY, async (lease) => {
        try {
          return await fetchLease(lease);
        } catch (error) {
          console.error(
            `${new Date().toISOString()} COMPLETE_FAILED task=${lease.task_id}:`,
            error instanceof Error ? error.message : String(error),
          );
          return null;
        }
      });
      const completed = results.filter(
        (result) => result?.result?.status === "COMPLETE",
      ).length;
      const retries = results.filter(
        (result) => result?.result?.status === "RETRY",
      ).length;
      const retryDetails = results
        .filter((result) => result?.result?.status === "RETRY")
        .slice(0, 5)
        .map((result) => ({
          task_id: result?.lease?.task_id,
          url: result?.lease?.url,
          error: result?.completion?.error ?? "unknown",
        }));
      if (retryDetails.length) {
        console.warn(
          `${new Date().toISOString()} FETCH_RETRY_DETAILS ${JSON.stringify(retryDetails)}`,
        );
      }
      const staleResults = results.filter(
        (result) => result?.result?.status === "STALE",
      );
      const stale = staleResults.length;
      if (staleResults.length) {
        console.error(
          `${new Date().toISOString()} FETCH_STALE_DETAILS ${JSON.stringify(
            staleResults.map((result) => ({
              task_id: result?.lease?.task_id,
              stale_reason: result?.result?.stale_reason ?? "unknown",
            })),
          )}`,
        );
      }
      console.log(
        `${new Date().toISOString()} FETCH leased=${leases.length} complete=${completed} retry=${retries} stale=${stale}`,
      );
      if (BURST_MODE && stale > 0) {
        fatalError = new Error(`Burst fetch produced ${stale} stale lease result(s)`);
        break;
      }
      if (Date.now() + ACTIVE_DELAY_MS < stopAt) await sleep(ACTIVE_DELAY_MS);
    } catch (error) {
      console.error(
        `${new Date().toISOString()} worker error:`,
        error instanceof Error ? error.message : String(error),
      );
      if (RUNTIME_MS) {
        fatalError = error instanceof Error ? error : new Error(String(error));
        break;
      }
      await sleep(ERROR_DELAY_MS);
    }
  }

  if (fatalError) {
    console.error(
      `Worker failed: ${fatalError instanceof Error ? fatalError.message : String(fatalError)}`,
    );
    process.exitCode = 1;
  } else {
    console.log("Worker stopped.");
  }
}
