// Geo Radar: fetch enabled sources, keep items that match the domain terms,
// merge with the previous feed, and drop anything not seen within RETAIN_DAYS.
// No dependencies (Node 20+). Run: node scripts/radar.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { findDeadline } from "./deadline.mjs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnabledSources } from "./source-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const RETAIN_DAYS = Number(process.env.RETAIN_DAYS ?? 45);
const MAX_FAILURES = Number(process.env.MAX_FAILURES ?? 5);
const SOURCES_FILE = process.env.SOURCES_FILE ?? path.join(ROOT, "config", "sources.json");
const UA = "GeoRadarBot/1.0 (+https://github.com/ealins/geo_knowlege_hub)";
const now = new Date();
const nowIso = now.toISOString();

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (terms) =>
  new RegExp(`(?<!\\p{L})(?:${terms.map(escapeRe).join("|")})(?!\\p{L})`, "iu");

const domain = await readJson(path.join(ROOT, "config", "domain.json"), null);
if (!domain) throw new Error("config/domain.json is missing or invalid");
const sourcesCfg = await readJson(SOURCES_FILE, { sources: [] });
const previous = await readJson(path.join(DATA_DIR, "feed.json"), { items: [] });
const statusPrev = await readJson(path.join(DATA_DIR, "status.json"), {});

const domainTerms = domain.terms.map((t) => ({ term: t, re: wordRe([t]) }));
const excludeRe = domain.exclude?.length ? wordRe(domain.exclude) : null;
const kindRes = Object.entries(domain.kinds).map(([kind, words]) => [kind, wordRe(words)]);

// ---------- text helpers ----------
const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");

const clean = (s = "") =>
  decode(decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? clean(m[1]) : "";
};

const parseDate = (s) => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

// ---------- fetching ----------
// Render a JavaScript-built page with a headless browser (only for sources
// marked "render": true, and only after robots.txt allowed the fetch).
let browserPromise = null;
async function renderPage(url) {
  const { chromium } = await import("playwright");
  browserPromise ??= chromium.launch();
  const page = await (await browserPromise).newPage({ userAgent: UA });
  try {
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    if (res && !res.ok()) throw new Error(`HTTP ${res.status()}`);
    return await page.content();
  } finally {
    await page.close();
  }
}

async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "application/rss+xml,application/atom+xml,application/json,text/html;q=0.9,*/*;q=0.5",
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Minimal robots.txt check: longest matching rule wins; our UA group or "*".
async function robotsAllows(url) {
  const u = new URL(url);
  let txt = "";
  try {
    const r = await fetch(new URL("/robots.txt", u), {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return true;
    txt = await r.text();
  } catch {
    return true;
  }
  const groups = [];
  let cur = null;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!cur || cur.rules.length) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && cur) {
      cur.rules.push({ type: key, path: val });
    }
  }
  const mine = groups.filter((g) => g.agents.includes("georadarbot"));
  const group = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const rules = group.flatMap((g) => g.rules).filter((r) => r.path);
  const p = u.pathname + u.search;
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const r of rules) {
    if (!p.startsWith(r.path)) continue;
    if (r.type === "allow") bestAllow = Math.max(bestAllow, r.path.length);
    else bestDisallow = Math.max(bestDisallow, r.path.length);
  }
  return bestDisallow < 0 || bestAllow >= bestDisallow;
}

// ---------- parsing ----------
function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  return blocks.map((b) => {
    const alt = b.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    return {
      title: tag(b, "title"),
      link: alt ? alt[1] : tag(b, "link"),
      date:
        tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date"),
      summary: (
        tag(b, "description") || tag(b, "summary") || tag(b, "content")
      ).slice(0, 400),
    };
  });
}

// OpenAlex works API (open scholarly index). Concepts go into the summary so
// the domain filter can match papers whose titles omit the field's keywords.
function parseOpenAlex(body) {
  const data = JSON.parse(body);
  return (data.results || []).map((w) => ({
    title: w.display_name || w.title || "",
    link: w.doi || w.id || "",
    date: w.publication_date || "",
    summary: [
      ...(w.keywords || []).map((k) => k.display_name),
      ...(w.concepts || []).slice(0, 8).map((c) => c.display_name),
    ].join(", ").slice(0, 400),
  }));
}

// German Federal Employment Agency job search API (public, documented on bund.dev).
function parseArbeitsagentur(body) {
  const data = JSON.parse(body);
  return (data.stellenangebote || []).map((j) => ({
    title: `${j.titel || j.beruf || ""}${j.arbeitgeber ? " – " + j.arbeitgeber : ""}`,
    link: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(j.refnr)}`,
    date: j.aktuelleVeroeffentlichungsdatum || j.modifikationsTimestamp || "",
    summary: [j.beruf, j.titel].filter(Boolean).join(", "),
    location: j.arbeitsort?.ort || "",
  }));
}

// schema.org JSON-LD embedded in pages: JobPosting, Event, Course, etc.
// Gives clean titles, dates, deadlines and locations instead of link text.
const LD_TYPES = new Set(["JobPosting", "Event", "EducationEvent", "Course", "EducationalOccupationalProgram", "ScholarlyArticle", "NewsArticle"]);
function parseJsonLd(html, source) {
  const out = [];
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node["@graph"]) visit(node["@graph"]);
    if (node.itemListElement) visit(node.itemListElement.map((e) => e.item || e));
    const types = [].concat(node["@type"] || []);
    if (!types.some((t) => LD_TYPES.has(t))) return;
    const title = clean(String(node.title || node.name || node.headline || ""));
    let link = node.url || node["@id"] || "";
    try { link = new URL(link, source.url).href; } catch { link = ""; }
    const loc = node.jobLocation || node.location;
    const place = [].concat(loc || [])[0];
    out.push({
      title,
      link,
      date: node.datePosted || node.startDate || node.datePublished || "",
      summary: clean(String(node.description || "")).slice(0, 400),
      deadline: node.validThrough || node.applicationDeadline || node.endDate || "",
      location: clean(String(place?.address?.addressLocality || place?.name || place?.address?.addressCountry || "")),
    });
  };
  for (const b of blocks) {
    try { visit(JSON.parse(b.replace(/^<script[^>]*>|<\/script>$/gi, ""))); } catch { /* malformed block */ }
  }
  return out.filter((r) => r.title && r.link);
}

function parseHtml(html, source) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const include = source.include ? new RegExp(source.include, "i") : null;
  let m;
  while ((m = re.exec(html))) {
    const text = clean(m[2]);
    if (text.length < 12 || text.length > 300) continue;
    let href;
    try {
      href = new URL(m[1], source.url).href;
    } catch {
      continue;
    }
    if (include && !include.test(`${href} ${text}`)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ title: text, link: href, date: "", summary: "" });
  }
  return out;
}

// ---------- filtering ----------
function classify(raw, source) {
  const text = `${raw.title} ${raw.summary}`;
  const matched = domainTerms.filter((d) => d.re.test(text)).map((d) => d.term);
  if (!matched.length || !raw.link) return null;
  if (raw.deadline && Date.parse(raw.deadline) < now.getTime()) return null; // already closed
  if (excludeRe && excludeRe.test(text)) return null;
  // Job pages also carry navigation and department links: require a position
  // word and a title of at least four words before accepting a listing.
  // Sources marked "trusted" list only items of their kind (e.g. an event calendar).
  if (source.type === "html" && !source.trusted && ["job", "event", "course"].includes(source.kind)) {
    const re = kindRes.find(([k]) => k === source.kind)?.[1];
    if ((re && !re.test(text)) || raw.title.trim().split(/\s+/).length < (source.kind === "course" ? 2 : 4) || raw.title.includes("@")) return null;
  }
  let kind = source.kind && source.kind !== "auto" ? source.kind : "news";
  if (!source.kind || source.kind === "auto") {
    const hit = kindRes.find(([, re]) => re.test(text));
    if (hit) kind = hit[0];
  }
  return {
    id: createHash("sha1").update(raw.link).digest("hex").slice(0, 16),
    title: raw.title,
    url: raw.link,
    kind,
    source: source.id,
    source_name: source.name,
    published: parseDate(raw.date),
    summary: (raw.summary || "").slice(0, 300),
    deadline: parseDate(raw.deadline),
    location: raw.location || null,
    matched,
  };
}

// ---------- per source ----------
async function runSource(src, statusOut) {
  const prev = statusPrev[src.id] ?? { consecutive_failures: 0 };
  if ((prev.consecutive_failures ?? 0) >= MAX_FAILURES) {
    statusOut[src.id] = {
      ...prev,
      state: "paused",
      note: `paused after ${MAX_FAILURES} failures; set consecutive_failures to 0 to retry`,
    };
    return [];
  }
  try {
    if (!(await robotsAllows(src.url.replace(/\{since:\d+\}/g, "")))) throw new Error("disallowed by robots.txt");
    // {since:N} in a URL becomes the date N days ago (YYYY-MM-DD), keeping API queries to recent work.
    const url = src.url.replace(/\{since:(\d+)\}/g, (_, d) => new Date(now.getTime() - Number(d) * 864e5).toISOString().slice(0, 10));
    const body = src.render ? await renderPage(url) : await fetchText(url, src.headers);
    const raw =
      src.type === "rss" ? parseFeed(body)
      : src.type === "openalex" ? parseOpenAlex(body)
      : src.type === "arbeitsagentur" ? parseArbeitsagentur(body)
      : [...parseJsonLd(body, src), ...parseHtml(body, src)];
    const kept = raw.map((r) => classify(r, src)).filter(Boolean);
    statusOut[src.id] = {
      state: "ok",
      last_checked: nowIso,
      last_success: nowIso,
      items_found: raw.length,
      items_matched: kept.length,
      consecutive_failures: 0,
      last_error: null,
    };
    return kept;
  } catch (err) {
    statusOut[src.id] = {
      ...prev,
      state: "error",
      last_checked: nowIso,
      consecutive_failures: (prev.consecutive_failures ?? 0) + 1,
      last_error: String(err?.message ?? err).slice(0, 200),
    };
    return [];
  }
}

// ---------- main ----------
const enabled = getEnabledSources(sourcesCfg);
const statusOut = {};
const batches = await Promise.all(enabled.map((s) => runSource(s, statusOut)));
const fresh = batches.flat();

// Merge: keep first_seen for known items, refresh last_seen for items seen now.
// Each kind has its own retention window (config/domain.json retain_days):
// an item expires once it has gone unseen for longer than its window.
const retainMs = (kind) => (domain.retain_days?.[kind] ?? RETAIN_DAYS) * 864e5;
const isLive = (it) => now.getTime() - Date.parse(it.last_seen) <= retainMs(it.kind);
const prevById = new Map((previous.items ?? []).map((i) => [i.id, i]));
const merged = new Map();
for (const it of fresh) {
  if (merged.has(it.id)) continue;
  const p = prevById.get(it.id);
  merged.set(it.id, { ...it, first_seen: p?.first_seen ?? nowIso, last_seen: nowIso });
}
// Listing pages (html) show only what is currently open: if such a source was
// read successfully and an item is no longer on it, the item is gone. Feeds
// and APIs roll over quickly, so their items keep the per-kind window instead.
const htmlOk = new Set(enabled.filter((s) => s.type === "html" && statusOut[s.id]?.state === "ok").map((s) => s.id));
for (const it of previous.items ?? []) {
  if (merged.has(it.id) || htmlOk.has(it.source)) continue;
  merged.set(it.id, it);
}
// Open status: positions, programmes and events rarely state a deadline in the
// listing, so read each item's own page (robots.txt respected) for one. Results
// are cached on the item and rechecked every few days; at most 80 pages per run.
const ENRICH_KINDS = new Set(["job", "course", "event"]);
const RECHECK_MS = 3 * 864e5;
const todo = [...merged.values()].filter(
  (i) => ENRICH_KINDS.has(i.kind) && !i.deadline && !i.apply_closed && (!i.deadline_checked || now.getTime() - Date.parse(i.deadline_checked) > RECHECK_MS),
).slice(0, 80);
for (let n = 0; n < todo.length; n += 8) {
  await Promise.all(
    todo.slice(n, n + 8).map(async (it) => {
      it.deadline_checked = nowIso;
      try {
        if (!(await robotsAllows(it.url))) return;
        const found = findDeadline(await fetchText(it.url), now);
        if (!found) return;
        if (Date.parse(found) >= now.getTime()) it.deadline = found;
        else if (it.kind === "course") it.apply_closed = true; // programme stays; its intake has passed
        else it.deadline = found; // position or event already over: dropped below
      } catch {}
    }),
  );
}

const items = [...merged.values()]
  .filter(isLive)
  .filter((i) => !i.deadline || Date.parse(i.deadline) >= now.getTime())
  .sort((a, b) => b.first_seen.localeCompare(a.first_seen));

await mkdir(DATA_DIR, { recursive: true });
await writeFile(
  path.join(DATA_DIR, "feed.json"),
  JSON.stringify({ generated_at: nowIso, retain_days: RETAIN_DAYS, count: items.length, items }, null, 2) + "\n",
);
await writeFile(
  path.join(DATA_DIR, "status.json"),
  JSON.stringify(Object.fromEntries(Object.entries({ ...statusPrev, ...statusOut }).filter(([id]) => enabled.some((e) => e.id === id))), null, 2) + "\n",
);

console.log(
  `sources enabled: ${enabled.length}, matched this run: ${fresh.length}, items kept: ${items.length}`,
);
if (browserPromise) await (await browserPromise).close();
