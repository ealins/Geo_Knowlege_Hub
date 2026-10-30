// Daily Adzuna job search (one run per UTC day, hard-capped calls).
// Needs ADZUNA_APP_ID and ADZUNA_APP_KEY. Writes data/adzuna.json for the radar.
import { readFile, writeFile } from "node:fs/promises";

const cfg = JSON.parse(await readFile("config/adzuna.json", "utf8"));
const OUT = "data/adzuna.json";
const prev = JSON.parse(await readFile(OUT, "utf8").catch(() => '{"items":[]}'));
const today = new Date().toISOString().slice(0, 10);
const { ADZUNA_APP_ID: id, ADZUNA_APP_KEY: key } = process.env;

if (!id || !key) { console.log("No Adzuna keys set; skipping."); process.exit(0); }
if ((prev.fetched_at || "").startsWith(today) && !process.argv.includes("--force")) { console.log("Already fetched today; skipping to save calls."); process.exit(0); }

const cap = Math.min(cfg.calls_per_day ?? 20, 24);
const items = new Map();
let calls = 0, failed = 0;
for (const [country, what] of cfg.queries.slice(0, cap)) {
  const u = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
  u.search = new URLSearchParams({ app_id: id, app_key: key, results_per_page: "50", what_phrase: what, max_days_old: String(cfg.max_days_old ?? 30), "content-type": "application/json" });
  calls++;
  try {
    const r = await fetch(u, { headers: { accept: "application/json" } });
    if (!r.ok) { failed++; console.log(`${country} "${what}": HTTP ${r.status}`); if (r.status === 429 || r.status === 401) break; continue; }
    const j = await r.json();
    for (const x of j.results || []) {
      if (!x.redirect_url || items.has(x.id)) continue;
      items.set(x.id, {
        title: (x.title || "").replace(/<[^>]+>/g, ""),
        url: x.redirect_url,
        org: x.company?.display_name || "",
        location: [x.location?.display_name, country.toUpperCase()].filter(Boolean).join(", "),
        posted: x.created || "",
        summary: (x.description || "").replace(/<[^>]+>/g, "").slice(0, 400),
        query: `${country}:${what}`,
      });
    }
    console.log(`${country} "${what}": ${j.results?.length ?? 0} (total ${j.count ?? "?"})`);
  } catch (e) { failed++; console.log(`${country} "${what}": ${e.message}`); }
  await new Promise((s) => setTimeout(s, 3000)); // stay far below the per-minute limit
}
if (!items.size && failed) { console.log("All calls failed; keeping previous file."); process.exit(0); }
await writeFile(OUT, JSON.stringify({ fetched_at: new Date().toISOString(), calls, items: [...items.values()] }, null, 2) + "\n");
console.log(`calls ${calls}, items ${items.size}`);
