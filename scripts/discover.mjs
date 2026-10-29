// Weekly discovery of degree programmes.
//  1. Universities: OpenAlex counts recent articles per institution for the
//     domain queries; the most active education institutions are the "ranking".
//  2. For each university, find pages about programmes in the field: from its
//     sitemap (URL keywords) and a shallow crawl from the home page.
//  3. Read each programme page for an application deadline, following "apply" links.
// Output: data/programmes-discovered.json, read by radar.mjs. robots.txt is respected.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchText, robotsAllows, sitemapsOf } from "./net.mjs";
import { findDeadline } from "./deadline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(await readFile(path.join(ROOT, "config", "discover.json"), "utf8"));
const domain = JSON.parse(await readFile(path.join(ROOT, "config", "domain.json"), "utf8"));
const OUT = path.join(ROOT, "data", "programmes-discovered.json");
const prevFile = await readFile(OUT, "utf8").then(JSON.parse).catch(() => ({ items: [] }));
const nowIso = new Date().toISOString();

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WEAK = new Set(["mapping", "satellite", "Copernicus", "spatial data", "Earth system", "digital twin", "3D reconstruction", "BIM", "IFC", "UAV"]);
const STRONG = new RegExp(`(?<!\\p{L})(?:${domain.terms.filter((t) => !WEAK.has(t)).map(esc).join("|")})(?!\\p{L})`, "iu");
const URL_KEY = /(geomatic|geodes|geoinform|geospatial|remote[-_ ]?sensing|photogramm|earth[-_ ]?observ|[-_/]gis[-_/.]|lidar|cartograph|geograph|geoscien|surveying|spatial[-_ ]?(data|analysis|science))/i;
const NAV = /(graduate|master|msc|m\.s\.|programs?|programmes?|degrees?|admission|apply|academics|study|studies|department|school|college|faculty|fachbereich|studium|studiengang)/i;
const PROG = /\b(M\.?\s?Sc\.?|M\.?\s?S\.?|M\.?\s?A\.?|MEng|Master|Masters|Master['’]s|graduate certificate|graduate program(me)?|PhD|Ph\.D\.|doctoral|degree|program(me)?|major|certificate|Studiengang|Bachelor|B\.?\s?Sc\.?|undergraduate)\b/i;
const SKIP_PATH = /(\/news|\/events?\/|\/people|\/person|\/faculty\/|\/staff|\/directory|\/profile|\/publications?|\/blog|\/seminar|\/colloquium|\/calendar|\/jobs|\/careers|\/alumni|\/research-?groups?|\/labs?\/|\/projects?\/|\.pdf$|\.(jpg|png|zip)$)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s = "") => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&rsquo;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// ---------- 1. universities ----------
async function universities() {
  const since = new Date(Date.now() - cfg.since_days * 864e5).toISOString().slice(0, 10);
  const counts = new Map();
  for (const q of cfg.queries) {
    try {
      const url = `https://api.openalex.org/works?search=${encodeURIComponent(`"${q}"`)}&filter=from_publication_date:${since},type:article&group_by=authorships.institutions.id&per-page=200`;
      const data = JSON.parse(await fetchText(url));
      for (const g of data.group_by ?? []) counts.set(g.key, (counts.get(g.key) ?? 0) + g.count);
    } catch (e) { console.log("openalex query failed:", q, e.message); }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 500);
  const out = [];
  for (let i = 0; i < ranked.length; i += 50) {
    const ids = ranked.slice(i, i + 50).map(([k]) => k.split("/").pop()).join("|");
    try {
      const data = JSON.parse(await fetchText(`https://api.openalex.org/institutions?filter=openalex:${ids}&select=id,display_name,homepage_url,country_code,type&per-page=50`));
      for (const r of data.results ?? []) {
        if (r.type !== "education" || !r.homepage_url || !cfg.countries.includes(r.country_code)) continue;
        out.push({ name: r.display_name, home: r.homepage_url, country: r.country_code, score: counts.get(r.id) ?? 0 });
      }
    } catch (e) { console.log("openalex institutions failed:", e.message); }
  }
  out.sort((a, b) => b.score - a.score);
  const list = out.slice(0, cfg.top);
  for (const x of cfg.extra ?? []) if (!list.some((u) => new URL(u.home).hostname.replace(/^www\./, "") === new URL(x.home).hostname.replace(/^www\./, ""))) list.push(x);
  return list.filter((u) => !(cfg.skip_hosts ?? []).some((h) => u.home.includes(h)));
}

// ---------- 2. crawl one university ----------
const baseOf = (host) => {
  const p = host.replace(/^www\./, "").split(".");
  return /^(ac|co|edu|org|gov)$/.test(p.at(-2)) && p.length >= 3 ? p.slice(-3).join(".") : p.slice(-2).join(".");
};

async function get(url, host, state) {
  if (state.fetched >= cfg.max_pages_per_university + 15) return null;
  if (!(await robotsAllows(url))) return null;
  await sleep(350);
  state.fetched++;
  try { return await fetchText(url); } catch { return null; }
}

function links(html, from) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { out.push({ href: new URL(m[1], from).href.split("#")[0], text: clean(m[2]).slice(0, 120) }); } catch {}
  }
  return out;
}

async function sitemapUrls(origin) {
  const found = [];
  const queue = [...new Set([...(await sitemapsOf(origin)), origin + "/sitemap.xml"])].slice(0, 4);
  let fetched = 0;
  while (queue.length && fetched < 12) {
    const sm = queue.shift();
    try {
      if (!(await robotsAllows(sm))) continue;
      fetched++;
      const xml = await fetchText(sm);
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      if (/<sitemapindex/i.test(xml)) queue.push(...locs.filter((l) => !/\.gz$/.test(l)).slice(0, 8));
      else found.push(...locs.filter((l) => URL_KEY.test(l) && !SKIP_PATH.test(l)));
    } catch {}
  }
  return found;
}

function programmeOf(html, url) {
  const h1 = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  const ogt = clean(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] ?? "");
  const ttl = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const desc = clean(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1] ?? "");
  const title = (h1.length >= 8 && h1.length <= 140 ? h1 : ogt || ttl).replace(/\s*[|–—-]\s*[^|–—-]{0,60}$/, (m) => (/univers|college|school|institute|hochschule/i.test(m) ? "" : m));
  const head = `${h1} ${ogt} ${ttl}`;
  if (!STRONG.test(`${head} ${desc}`) || !PROG.test(`${head} ${url}`) || SKIP_PATH.test(url) || title.length < 8) return null;
  return { title: title.slice(0, 140), summary: desc.slice(0, 220) };
}

async function crawl(u) {
  const state = { fetched: 0 };
  const origin = new URL(u.home).origin;
  const host = new URL(u.home).hostname;
  const base = baseOf(host);
  const sameSite = (href) => { try { const h = new URL(href).hostname; return h === host || baseOf(h) === base; } catch { return false; } };

  const seen = new Set();
  const queue = [];
  const push = (href, depth, prio) => { if (!seen.has(href) && sameSite(href) && !SKIP_PATH.test(href)) { seen.add(href); queue.push({ href, depth, prio }); } };
  for (const s of (await sitemapUrls(origin)).slice(0, 60)) push(s, 2, 0);
  push(u.home, 0, 1);

  const found = new Map();
  while (queue.length && state.fetched < cfg.max_pages_per_university) {
    queue.sort((a, b) => a.prio - b.prio || a.depth - b.depth);
    const { href, depth } = queue.shift();
    const html = await get(href, host, state);
    if (!html) continue;
    const prog = programmeOf(html, href);
    if (prog) {
      let deadline = findDeadline(html);
      if (!deadline) {
        for (const l of links(html, href).filter((l) => /(apply|application|admission|deadline|bewerb)/i.test(l.text) && sameSite(l.href)).slice(0, 3)) {
          const sub = await get(l.href, host, state);
          deadline = sub ? findDeadline(sub) : null;
          if (deadline) break;
        }
      }
      const key = prog.title.toLowerCase();
      if (!found.has(key)) found.set(key, { url: href, ...prog, university: u.name, country: u.country, deadline: deadline ?? null, discovered_at: nowIso });
    }
    if (depth < 3) {
      for (const l of links(html, href)) {
        if (URL_KEY.test(l.href + " " + l.text)) push(l.href, depth + 1, 0);
        else if (depth < 2 && NAV.test(l.text) && l.text.length < 40) push(l.href, depth + 1, 2);
      }
    }
  }
  const items = [...found.values()].sort((a, b) => Number(Boolean(b.deadline)) - Number(Boolean(a.deadline))).slice(0, cfg.max_programmes_per_university);
  return { items, fetched: state.fetched };
}

// ---------- main ----------
const list = await universities();
console.log(`universities: ${list.length}`);
const results = [];
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < list.length) {
    const u = list[next++];
    try {
      const r = await crawl(u);
      console.log(`${u.name} (${u.country}): pages ${r.fetched}, programmes ${r.items.length}, with deadline ${r.items.filter((i) => i.deadline).length}`);
      // A site that could not be read keeps last week's entries instead of vanishing.
      results.push(...(r.fetched === 0 ? prevFile.items.filter((i) => i.university === u.name) : r.items));
    } catch (e) {
      console.log(`${u.name}: failed ${e.message}`);
      results.push(...prevFile.items.filter((i) => i.university === u.name));
    }
  }
}));

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated_at: nowIso, universities: list.length, count: results.length, items: results }, null, 1) + "\n");
console.log(`programmes: ${results.length}, with deadline: ${results.filter((i) => i.deadline).length}`);
