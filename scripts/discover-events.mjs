// Event discovery. Starts from directories the field maintains (ISPRS member
// societies, related calendars), visits each organisation's site, finds pages
// about events (conferences, workshops, symposia, schools), and keeps those that
// are still ahead, with their dates and call deadline when stated.
// Output: data/events-discovered.json, read by radar.mjs. robots.txt respected.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchText, robotsAllows } from "./net.mjs";
import { findDeadline, eventRange } from "./deadline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(await readFile(path.join(ROOT, "config", "discover-events.json"), "utf8"));
const domain = JSON.parse(await readFile(path.join(ROOT, "config", "domain.json"), "utf8"));
const OUT = path.join(ROOT, "data", "events-discovered.json");
const prev = await readFile(OUT, "utf8").then(JSON.parse).catch(() => ({ items: [] }));
const now = new Date();
const nowIso = now.toISOString();

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOPIC = new RegExp(`(?<!\\p{L})(?:${domain.terms.map(esc).join("|")})(?!\\p{L})`, "iu");
// The link text itself must name a kind of event (several languages).
const EVENT_WORD = /(conference|workshop|symposi|congress|congres|kongres|summit|summer school|winter school|forum|assembly|annual meeting|colloquium|webinar|tagung|konferenz|jahrestagung|kolloquium|konferens|konferanse|konferencija|conferenza|conferencia|colloque|simpozij|simpoz|geomatikkdag|geodesi.*dag|dagene|geomatics day|geo ?week|working week)/i;
const NEWSY = /(published|publication|issue|newsletter|press|award|prize|nominee|genomineerd|bekend|hands over|signs|decision|odluka|nyhet|news|obituary|showcases?|held at|recap|report on|photos|gallery|highlights|about our|view our|fragenforum|appointed|elected|membership|job|vacanc|tender|call for (members|nominations)|brojevi|списание|публикуван)/i;
const YEAR = /\b(2026|2027|2028)\b/;
const GENERIC = /^(events?|calendar|conferences?|workshops?|upcoming events|past events|all events|news|home|read more|more|details|register|registration|call for papers|submit|programme|program)$/i;
const NAV = /(event|calendar|conference|symposium|congress|workshop|meeting|tagung|veranstaltung|agenda|termine|kalender|news|aktuelles)/i;
const SKIP_PATH = /\.(pdf|jpe?g|png|zip|docx?|xlsx?)$|\/(login|wp-admin|feed)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decodeEnt = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&rsquo;/g, "'").replace(/&amp;/g, "&");
const clean = (s = "") => decodeEnt(s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const hostOf = (u) => new URL(u).hostname.replace(/^www\./, "");
const skipHost = (h) => cfg.skip_hosts.some((s) => h === s || h.endsWith("." + s));

async function pageLinks(url, html) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']\s*([^"'#\s]+)[^>]*>([\s\S]*?)<\/a>/gi)) {
    try { out.push({ href: new URL(m[1], url).href, text: clean(m[2]).slice(0, 200), index: m.index, len: m[0].length }); } catch {}
  }
  return out;
}

// ---------- 1. organisations ----------
async function seedHosts() {
  const hosts = new Map(); // host -> { url, onTopic }
  const add = (url, onTopic) => {
    try {
      const h = hostOf(url);
      if (skipHost(h) || !/^https?:/.test(url) || SKIP_PATH.test(url)) return;
      if (!hosts.has(h)) hosts.set(h, { url, onTopic });
    } catch {}
  };
  for (const [list, onTopic] of [[cfg.societies, true], [cfg.hubs, false]]) {
    for (const seed of list) {
      try {
        if (!(await robotsAllows(seed))) continue;
        const html = await fetchText(seed);
        for (const l of await pageLinks(seed, html)) if (hostOf(l.href) !== hostOf(seed)) add(l.href, onTopic);
      } catch (e) { console.log("seed failed:", seed, e.message); }
    }
  }
  for (const u of cfg.extra_hosts) add(u, true);
  return [...hosts.entries()].slice(0, cfg.max_hosts).map(([host, v]) => ({ host, ...v }));
}

// ---------- 2. one organisation ----------
async function crawl(org) {
  const state = { fetched: 0, err: null };
  const found = new Map();
  const get = async (url) => {
    if (state.fetched >= cfg.max_pages_per_host) return null;
    if (!(await robotsAllows(url))) { state.err ??= "robots.txt"; return null; }
    await sleep(350);
    state.fetched++;
    try { return await fetchText(url); } catch (e) { state.err ??= e.message; return null; }
  };
  const record = async (title, url, range, ctx, deadlineHtml) => {
    title = title.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!title || GENERIC.test(title) || title.split(/\s+/).length < 3) return;
    const company = org.host.endsWith(".com");
    if ((!org.onTopic || company) && !TOPIC.test(`${title} ${ctx}`)) return;
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, "") + range.start.slice(0, 7);
    if (found.has(key) || found.size >= cfg.max_events_per_host) return;
    let deadline = deadlineHtml ? findDeadline(deadlineHtml, now) : null;
    if (deadline && (Date.parse(deadline) > Date.parse(range.start) || Date.parse(deadline) < now.getTime())) deadline = null;
    found.set(key, { title, url, starts: range.start, ends: range.end, deadline, host: org.host, discovered_at: nowIso });
  };

  const queue = [{ url: org.url, depth: 0 }];
  const seen = new Set([org.url]);
  while (queue.length && state.fetched < cfg.max_pages_per_host) {
    const { url, depth } = queue.shift();
    const html = await get(url);
    if (!html) continue;

    // The page itself is an event (a conference site): title + year + dates.
    const title = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const text = clean(html).slice(0, 6000);
    const self = eventRange(text, now);
    if (self && YEAR.test(title) && EVENT_WORD.test(title)) await record(title, url, self, text.slice(0, 600), html);

    const links = await pageLinks(url, html);
    for (const l of links) {
      const sameSite = hostOf(l.href) === org.host || hostOf(l.href).endsWith("." + org.host);
      const looksEvent = l.text.length >= 10 && l.text.length <= 140 && EVENT_WORD.test(l.text) && !NEWSY.test(l.text) && !GENERIC.test(l.text);
      if (looksEvent && !SKIP_PATH.test(l.href)) {
        // dates next to the link ...
        const ctx = clean(html.slice(Math.max(0, l.index - 250), l.index + l.len + 450));
        let range = null;
        let detail = null;
        if (!found.has("seen:" + l.href) && state.fetched < cfg.max_pages_per_host) {
          // the event's own page is the authority for its dates
          found.set("seen:" + l.href, null);
          detail = await get(l.href);
          if (detail) range = eventRange(clean(detail).slice(0, 1500), now);
        }
        if (!range) {
          // fall back to dates beside the link, but a single date within days of today is a post date
          const near = eventRange(ctx, now);
          if (near && (near.start !== near.end || Date.parse(near.start) > now.getTime() + 7 * 864e5)) range = near;
        }
        if (range && Date.parse(range.start) >= now.getTime() - 864e5) await record(l.text, l.href, range, ctx, detail);
      }
      if (depth < 2 && sameSite && NAV.test(l.text + " " + l.href) && !seen.has(l.href) && !SKIP_PATH.test(l.href)) {
        seen.add(l.href);
        queue.push({ url: l.href, depth: depth + 1 });
      }
    }
  }
  for (const k of [...found.keys()]) if (k.startsWith("seen:")) found.delete(k);
  return { items: [...found.values()], fetched: state.fetched, err: state.err };
}

// ---------- main ----------
const orgs = await seedHosts();
console.log(`organisations: ${orgs.length}`);
const results = [];
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < orgs.length) {
    const org = orgs[next++];
    try {
      const r = await crawl(org);
      console.log(`${org.host}${org.onTopic ? "" : " (hub)"}: pages ${r.fetched}, events ${r.items.length}${r.items.length || !r.err ? "" : " [" + r.err + "]"}`);
      // A site that could not be read keeps its earlier events instead of vanishing.
      results.push(...(r.fetched === 0 ? prev.items.filter((i) => i.host === org.host && Date.parse(i.ends) + 864e5 >= now.getTime()) : r.items));
    } catch (e) {
      console.log(`${org.host}: failed ${e.message}`);
      results.push(...prev.items.filter((i) => i.host === org.host));
    }
  }
}));

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated_at: nowIso, organisations: orgs.length, count: results.length, items: results }, null, 1) + "\n");
console.log(`events: ${results.length}, with call deadline: ${results.filter((i) => i.deadline).length}`);
