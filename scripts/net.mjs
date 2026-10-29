// Shared polite fetching: one user agent, robots.txt respected (cached per site).
export const UA = "GeoRadarBot/1.0 (+https://github.com/ealins/geo_knowlege_hub)";
const robotsCache = new Map();

export async function fetchText(url, extraHeaders = {}) {
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
export async function robotsAllows(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    robotsCache.set(
      u.origin,
      (async () => {
        try {
          const r = await fetch(new URL("/robots.txt", u), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10_000) });
          return r.ok ? await r.text() : "";
        } catch {
          return "";
        }
      })(),
    );
  }
  const txt = await robotsCache.get(u.origin);
  if (!txt) return true;
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


// Sitemap URLs a site announces in robots.txt.
export async function sitemapsOf(origin) {
  await robotsAllows(origin + "/");
  const txt = (await robotsCache.get(origin)) || "";
  return [...txt.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
}
