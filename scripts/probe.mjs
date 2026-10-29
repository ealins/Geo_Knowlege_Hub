// Diagnostic only (probe branch): tests candidate sources from the GitHub runner.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { findDeadline } from "./deadline.mjs";
const UA = "GeoRadarBot/1.0 (+https://geoacademic.app)";
const domain = JSON.parse(await readFile("config/domain.json", "utf8"));
const terms = domain.terms.map((t) => new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i"));
const list = JSON.parse(await readFile("scripts/probe-list.json", "utf8"));

async function robots(url) {
  try {
    const u = new URL(url);
    const r = await fetch(new URL("/robots.txt", u), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return "no-robots";
    const t = await r.text();
    const lines = t.split(/\r?\n/).map((l) => l.split("#")[0].trim());
    let on = false, dis = [];
    for (const l of lines) {
      const [k, ...v] = l.split(":"); const val = v.join(":").trim();
      if (/^user-agent$/i.test(k)) on = val === "*" || /georadarbot/i.test(val);
      else if (on && /^disallow$/i.test(k) && val) dis.push(val);
    }
    const p = u.pathname + u.search;
    return dis.some((d) => p.startsWith(d)) ? "DISALLOWED" : "allowed";
  } catch { return "robots-error"; }
}

const out = [];
for (const c of list) {
  const row = { url: c.url, note: c.note };
  try {
    row.robots = await robots(c.url);
    const res = await fetch(c.url, { headers: { "user-agent": UA, accept: "text/html,application/json,application/rss+xml,*/*;q=0.5", ...(c.headers || {}) }, signal: AbortSignal.timeout(25000), redirect: "follow" });
    row.status = res.status; row.type = res.headers.get("content-type")?.slice(0, 40);
    const body = await res.text(); row.bytes = body.length;
    row.jsonld = (body.match(/ld\+json/gi) || []).length;
    row.jobPosting = (body.match(/"JobPosting"/g) || []).length;
    row.event = (body.match(/"Event"/g) || []).length;
    row.rssItems = (body.match(/<(item|entry)[\s>]/g) || []).length;
    row.termHits = terms.filter((re) => re.test(body)).length;
    row.deadline = findDeadline(body)?.slice(0, 10) || null;
    row.sample = body.replace(/\s+/g, " ").slice(0, c.sample || 160);
  } catch (e) { row.error = String(e.message || e).slice(0, 80); }
  out.push(row);
  console.log(JSON.stringify(row));
}
await mkdir("diagout", { recursive: true });
await writeFile(`diagout/probe-${process.env.GITHUB_RUN_ID || "local"}.json`, JSON.stringify(out, null, 1));
