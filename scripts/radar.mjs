// Geo Radar: fetch enabled sources, keep items that match the domain terms,
// merge with the previous feed, and drop anything not seen within RETAIN_DAYS.
// No dependencies (Node 20+). Run: node scripts/radar.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { findDeadline, datesIn } from "./deadline.mjs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnabledSources } from "./source-config.mjs";
import { UA, fetchText, robotsAllows } from "./net.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const RETAIN_DAYS = Number(process.env.RETAIN_DAYS ?? 45);
const MAX_FAILURES = Number(process.env.MAX_FAILURES ?? 5);
const SOURCES_FILE = process.env.SOURCES_FILE ?? path.join(ROOT, "config", "sources.json");
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
// Adverts already opened and found off-topic, so they are not fetched again.
const checkedPrev = await readJson(path.join(DATA_DIR, "checked.json"), {});
const checkedOut = Object.fromEntries(Object.entries(checkedPrev).filter(([, d]) => Date.now() - Date.parse(d?.at ?? 0) < 30 * 864e5));

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
    .replace(/&nbsp;|\u00a0/g, " ")
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
    cited: w.cited_by_count ?? 0,
    fwci: w.fwci ?? null,
    top10: Boolean(w.citation_normalized_percentile?.is_in_top_10_percent),
    venue: w.primary_location?.source?.display_name || "",
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

// ISPRS calendar (one page per year): a table of dates, event names, website and
// place for every ISPRS, co-sponsored and related event, all within the field.
const MON3 = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseDateRange(s) {
  const utc = (y, m, d) => new Date(Date.UTC(+y, MON3[m.toLowerCase().slice(0, 3)], +d)).toISOString();
  let m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\w*\s*[-–]\s*(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/);
  if (m) return { start: utc(m[5], m[2], m[1]), end: utc(m[5], m[4], m[3]) };
  m = s.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/);
  if (m) return { start: utc(m[4], m[3], m[1]), end: utc(m[4], m[3], m[2]) };
  m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/);
  if (m) return { start: utc(m[3], m[2], m[1]), end: utc(m[3], m[2], m[1]) };
  return null;
}
function parseIsprsCalendar(html, source) {
  const out = [];
  for (const row of html.split(/<tr class=['"]/).slice(1)) {
    const cells = row.split(/<td\b/i).slice(1);
    if (cells.length < 3) continue;
    const when = parseDateRange(clean(cells[0]));
    const nameCell = cells[1];
    const title = nameCell.replace(/^[^>]*>/, "").replace(/<img[^>]*>/gi, "").split(/<br\s*\/?>/i).map(clean).find(Boolean) || "";
    const site = nameCell.match(/href=['"]\s*(https?:[^'"\s]+)/i)?.[1];
    if (!when || !title || !site) continue;
    const sub = clean((nameCell.match(/<p>([\s\S]*?)<\/p>/i) || [])[1] || "");
    const place = clean(cells[2].replace(/^[^>]*>/, " "));
    out.push({ title: sub && !title.includes(sub) ? `${title}: ${sub}`.slice(0, 160) : title, link: site, date: when.start, starts: when.start, ends: when.end, summary: sub, deadline: "", location: place });
  }
  return out;
}

// jobs.ac.uk search results: each result shows employer, location and closing
// date ("24 Nov"). The search term is added to the summary so the domain filter
// accepts what the site already matched on its full text.
function parseJobsAc(html, source) {
  const out = [];
  for (const block of html.split(/<div class="j-search-result__result/).slice(1)) {
    const a = block.match(/<a href="(\/job\/[^"]+)">\s*([^<]+?)\s*<\/a>/);
    if (!a) continue;
    const employer = pick(block, /j-search-result__employer">\s*<b>([^<]+)</);
    const location = pick(block, /<div>Location:\s*([^<]+)</);
    const closes = block.match(/date--blue\s*">([^<]+)</)?.[1]?.trim() || "";
    out.push({
      title: clean(a[2]),
      link: new URL(a[1], "https://www.jobs.ac.uk").href,
      date: "",
      summary: `${clean(employer)}. ${source.tag || ""}`,
      deadline: datesIn(closes, now)[0] || "",
      location: clean(location),
    });
  }
  return out;
}
const pick = (s, re) => s.match(re)?.[1] ?? "";

// Keyword search on a job board is loose, and an advert may mention "GIS" only in
// a list of desirable skills. Open each new advert once and keep it only if the
// field shows in its title or in the opening of the description. Verdicts are
// cached in checked.json (30 days), so each advert is fetched once.
const VERIFY_V = 2;
const WEAK = new Set(["mapping", "satellite", "Copernicus", "spatial data", "Earth system", "digital twin", "3D reconstruction", "BIM", "IFC", "UAV"]);
const strongTerms = domainTerms.filter((d) => !WEAK.has(d.term));
const hasStrong = (s) => strongTerms.filter((d) => d.re.test(s));
let verifyBudget = 120;
async function verifyAdverts(raws) {
  const keep = [];
  const todo = [];
  for (const r of raws) {
    const c = checkedOut[r.link];
    if (hasStrong(r.title).length) keep.push(r);
    else if (c?.v === VERIFY_V) { if (c.ok) keep.push({ ...r, summary: `${r.summary} ${c.terms}` }); }
    else if (verifyBudget-- > 0) todo.push(r);
  }
  for (let n = 0; n < todo.length; n += 6) {
    await Promise.all(todo.slice(n, n + 6).map(async (r) => {
      try {
        if (!(await robotsAllows(r.link))) return;
        const text = clean((await fetchText(r.link)).replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, " "));
        const at = Math.max(0, text.indexOf(r.title));
        const terms = hasStrong(text.slice(at, at + 1500)).map((d) => d.term);
        checkedOut[r.link] = { v: VERIFY_V, ok: terms.length > 0, terms: terms.join(", "), at: nowIso };
        if (terms.length) keep.push({ ...r, summary: `${r.summary} ${terms.join(", ")}` });
      } catch { /* try again next run */ }
    }));
  }
  return keep;
}

// A single page that is itself the item (e.g. one degree programme). Title and
// description come from the page; the closing date is read from its text.
function parsePage(html, source, url) {
  const title = clean(pick(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || pick(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const desc = clean(pick(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || pick(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i));
  return [{ title: source.title || title, link: url, date: "", summary: `${desc} ${source.tag || ""}`.trim(), deadline: findDeadline(html, now) || "", location: source.location || "" }];
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
// Paper impact: top venue, citations so far, field-weighted citation impact and
// OpenAlex's top-10% flag. Only papers scoring at least paper_min_impact are kept.
const venueRes = (domain.top_venues ?? []).map((v) => new RegExp(v, "i"));
const minImpact = domain.paper_min_impact ?? 25;
function paperImpact(raw) {
  const topVenue = venueRes.some((re) => re.test(raw.venue || ""));
  const score = (topVenue ? 40 : 0) + Math.min((raw.cited || 0) * 4, 40) + Math.min((raw.fwci || 0) * 8, 30) + (raw.top10 ? 20 : 0);
  return { score: Math.round(score), topVenue };
}

function classify(raw, source) {
  const text = `${raw.title} ${raw.summary}`;
  const matched = domainTerms.filter((d) => d.re.test(text)).map((d) => d.term);
  // on_topic sources (ISPRS, AGILE, ...) are about the field as a whole, so their
  // events need no keyword in the title; the source's own tag is used instead.
  if ((!matched.length && !source.on_topic) || !raw.link) return null;
  if (!matched.length) matched.push(source.tag || source.name);
  // A programme page keeps its place after its intake closes; anything else is over.
  let closed = false;
  if (raw.ends && Date.parse(raw.ends) + 864e5 < now.getTime()) return null; // event is over
  if (raw.deadline && Date.parse(raw.deadline) < now.getTime()) {
    if (raw.starts) raw = { ...raw, deadline: "" }; // call closed, event still ahead
    else if (source.kind !== "course") return null;
    else { raw = { ...raw, deadline: "" }; closed = true; }
  }
  if (excludeRe && excludeRe.test(text)) return null;
  // Job pages also carry navigation and department links: require a position
  // word and a title of at least four words before accepting a listing.
  // Sources marked "trusted" list only items of their kind (e.g. an event calendar).
  if (source.type === "html" && !source.trusted && ["job", "event", "course"].includes(source.kind)) {
    const re = kindRes.find(([k]) => k === source.kind)?.[1];
    if ((re && !re.test(text)) || raw.title.trim().split(/\s+/).length < (source.kind === "course" ? 2 : source.on_topic ? 3 : 4) || raw.title.includes("@")) return null;
  }
  // A posting with no closing date counts as open for 45 days after it was posted.
  if (raw.open_posting && (!raw.date || now.getTime() - Date.parse(raw.date) > 45 * 864e5)) return null;
  let kind = source.kind && source.kind !== "auto" ? source.kind : "news";
  if (!source.kind || source.kind === "auto") {
    const hit = kindRes.find(([, re]) => re.test(text));
    if (hit) kind = hit[0];
  }
  let paper = {};
  if (kind === "paper") {
    const { score, topVenue } = paperImpact(raw);
    if (score < minImpact) return null;
    paper = { impact: score, top_venue: topVenue, cited_by: raw.cited ?? 0, fwci: raw.fwci != null ? Math.round(raw.fwci * 10) / 10 : null, venue: raw.venue || null };
  }
  return {
    ...paper,
    ...(closed ? { apply_closed: true } : {}),
    ...(raw.open_posting ? { open_posting: true } : {}),
    id: createHash("sha1").update(raw.link).digest("hex").slice(0, 16),
    title: raw.title,
    url: raw.link,
    kind,
    source: source.id,
    source_name: source.name,
    published: parseDate(raw.date),
    summary: (raw.summary || "").slice(0, 300),
    deadline: parseDate(raw.deadline),
    ...(raw.starts ? { starts: parseDate(raw.starts), ends: parseDate(raw.ends || raw.starts) } : {}),
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
    if (src.type === "discovered") {
      // Programmes found by scripts/discover.mjs (weekly); read from the committed file.
      const file = await readJson(path.join(DATA_DIR, "programmes-discovered.json"), { items: [] });
      const raw = file.items.map((p) => ({ title: p.title, link: p.url, date: "", summary: `${p.summary || ""} ${p.university}`, deadline: p.deadline || "", location: `${p.university}, ${p.country}` }));
      const kept = raw.map((r) => classify(r, src)).filter(Boolean);
      statusOut[src.id] = { state: "ok", last_checked: nowIso, last_success: nowIso, items_found: raw.length, items_matched: kept.length, consecutive_failures: 0, last_error: null };
      return kept;
    }
    if (src.type === "curated") {
      // Items collected by the scheduled Claude task (Indeed, Exa, web search), read from data/curated.json.
      const file = await readJson(path.join(DATA_DIR, "curated.json"), { items: [] });
      const raw = (file.items ?? []).map((c) => ({
        title: c.title, link: c.url, date: c.posted || "", summary: [c.org, c.summary].filter(Boolean).join(". "),
        deadline: c.deadline || "", starts: c.starts || "", ends: c.ends || c.starts || "", location: c.location || c.org || "",
        kind: c.kind, open_posting: c.kind === "job" && !c.deadline,
      }));
      const kept = raw.map((r) => classify(r, { ...src, kind: r.kind })).filter(Boolean);
      statusOut[src.id] = { state: "ok", last_checked: nowIso, last_success: nowIso, items_found: raw.length, items_matched: kept.length, consecutive_failures: 0, last_error: null };
      return kept;
    }
    if (src.type === "discovered-events") {
      // Events found by scripts/discover-events.mjs, read from the committed file.
      const file = await readJson(path.join(DATA_DIR, "events-discovered.json"), { items: [] });
      const raw = file.items.map((e) => ({ title: e.title, link: e.url, date: e.starts, starts: e.starts, ends: e.ends, summary: e.host, deadline: e.deadline || "", location: e.host }));
      const kept = raw.map((r) => classify(r, src)).filter(Boolean);
      statusOut[src.id] = { state: "ok", last_checked: nowIso, last_success: nowIso, items_found: raw.length, items_matched: kept.length, consecutive_failures: 0, last_error: null };
      return kept;
    }
    if (!(await robotsAllows(src.url.replace(/\{since:\d+\}/g, "")))) throw new Error("disallowed by robots.txt");
    // {since:N} in a URL becomes the date N days ago (YYYY-MM-DD), keeping API queries to recent work.
    const url = src.url.replace(/\{since:(\d+)\}/g, (_, d) => new Date(now.getTime() - Number(d) * 864e5).toISOString().slice(0, 10));
    const body = src.render ? await renderPage(url) : await fetchText(url, src.headers);
    const raw =
      src.type === "rss" ? parseFeed(body)
      : src.type === "openalex" ? parseOpenAlex(body)
      : src.type === "arbeitsagentur" ? parseArbeitsagentur(body)
      : src.type === "isprs-calendar" ? parseIsprsCalendar(body, src)
      : src.type === "jobsacuk" ? await verifyAdverts(parseJobsAc(body, src))
      : src.type === "page" ? parsePage(body, src, url)
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
// A pool of 10: opening every site at once overloads the runner and makes
// healthy sources fail with "fetch failed".
const batches = [];
let nextSource = 0;
await Promise.all(Array.from({ length: 10 }, async () => {
  while (nextSource < enabled.length) batches.push(await runSource(enabled[nextSource++], statusOut));
}));
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
const htmlOk = new Set(enabled.filter((s) => ["html", "jobsacuk", "page", "discovered", "discovered-events", "curated"].includes(s.type) && statusOut[s.id]?.state === "ok").map((s) => s.id));
const enabledIds = new Set(enabled.map((s) => s.id));
for (const it of previous.items ?? []) {
  if (merged.has(it.id) || htmlOk.has(it.source) || !enabledIds.has(it.source)) continue;
  merged.set(it.id, it);
}
// Open status: positions, programmes and events rarely state a deadline in the
// listing, so read each item's own page (robots.txt respected) for one. Results
// are cached on the item and rechecked every few days; at most 80 pages per run.
const ENRICH_KINDS = new Set(["job", "course", "event"]);
const RECHECK_MS = 3 * 864e5;
const todo = [...merged.values()].filter(
  (i) => ENRICH_KINDS.has(i.kind) && !i.deadline && !i.apply_closed && !i.open_posting && (!i.deadline_checked || now.getTime() - Date.parse(i.deadline_checked) > RECHECK_MS),
).slice(0, 80);
for (let n = 0; n < todo.length; n += 8) {
  await Promise.all(
    todo.slice(n, n + 8).map(async (it) => {
      it.deadline_checked = nowIso;
      try {
        if (!(await robotsAllows(it.url))) return;
        const found = findDeadline(await fetchText(it.url), now);
        if (!found) return;
        if (it.kind === "event" && it.starts && Date.parse(found) > Date.parse(it.starts)) return; // not a call deadline
        if (Date.parse(found) >= now.getTime()) it.deadline = found;
        else if (it.kind === "course") it.apply_closed = true; // programme stays; its intake has passed
        else if (it.kind === "event" && it.starts) it.call_closed = true; // call closed, event still ahead
        else it.deadline = found; // position or event already over: dropped below
      } catch {}
    }),
  );
}

const items = [...merged.values()]
  .map((i) => (i.kind === "event" && i.starts && i.deadline && Date.parse(i.deadline) > Date.parse(i.starts) ? { ...i, deadline: null } : i))
  .filter(isLive)
  .filter((i) => i.kind !== "paper" || (i.impact ?? 0) >= minImpact)
  .filter((i) => !(i.kind === "event" && i.ends && Date.parse(i.ends) + 864e5 < now.getTime()))
  .filter((i) => !i.deadline || Date.parse(i.deadline) >= now.getTime() || (i.kind === "event" && i.ends))
  .sort((a, b) => b.first_seen.localeCompare(a.first_seen));

// The same position or event often arrives from several sources (a university
// page and a job board). Keep one: the entry with a closing date, else the first.
const normTitle = (s) => s.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 70);
const bestByKey = new Map();
for (const it of items) {
  if (!["job", "event", "course"].includes(it.kind)) continue;
  const key = `${it.kind}|${normTitle(it.title)}`;
  const cur = bestByKey.get(key);
  if (!cur || (!cur.deadline && it.deadline)) bestByKey.set(key, it);
}
const dedupedItems = items.filter((it) => !["job", "event", "course"].includes(it.kind) || bestByKey.get(`${it.kind}|${normTitle(it.title)}`) === it);
items.length = 0;
items.push(...dedupedItems);

await mkdir(DATA_DIR, { recursive: true });
await writeFile(
  path.join(DATA_DIR, "feed.json"),
  JSON.stringify({ generated_at: nowIso, retain_days: RETAIN_DAYS, count: items.length, items }, null, 2) + "\n",
);
await writeFile(path.join(DATA_DIR, "checked.json"), JSON.stringify(checkedOut, null, 1) + "\n");
await writeFile(
  path.join(DATA_DIR, "status.json"),
  JSON.stringify(Object.fromEntries(Object.entries({ ...statusPrev, ...statusOut }).filter(([id]) => enabled.some((e) => e.id === id))), null, 2) + "\n",
);

console.log(
  `sources enabled: ${enabled.length}, matched this run: ${fresh.length}, items kept: ${items.length}`,
);
if (browserPromise) await (await browserPromise).close();
