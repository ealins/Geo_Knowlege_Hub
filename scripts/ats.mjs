import { writeFile, mkdir } from "node:fs/promises";
const UA = "GeoRadarBot/1.0 (+https://geoacademic.app)";
const MARK = { personio: /personio\.(de|com)/i, smartrecruiters: /smartrecruiters\.com/i, workday: /myworkdayjobs\.com|workday/i, softgarden: /softgarden\.(io|de)/i, successfactors: /successfactors|sapsf/i, umantis: /umantis|haufe-?(talent|umantis)|\/jobs\/stellen/i, interamt: /interamt\.de/i, join: /join\.com/i, greenhouse: /greenhouse\.io/i, lever: /lever\.co/i, recruitee: /recruitee\.com/i, teamtailor: /teamtailor/i, cornerstone: /csod\.com/i, jobPosting: /"JobPosting"/, rss: /application\/(rss|atom)\+xml/i, jobs_json: /\/(api|wp-json)\/[^"']*job/i, varbi: /varbi\.com/i, emply: /emply\.(net|com)/i, ibm_kenexa: /kenexa|brassring/i, cvmaker: /cvmaker|jobylon|reachmee|hr-manager/i };
const urls = JSON.parse(process.env.URLS);
const out = [];
for (const url of urls) {
  const row = { url };
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(25000), redirect: "follow" });
    row.status = r.status; row.final = r.url;
    const b = await r.text(); row.bytes = b.length;
    row.markers = Object.entries(MARK).filter(([, re]) => re.test(b)).map(([k]) => k);
    row.hosts = [...new Set([...b.matchAll(/https?:\/\/([a-z0-9.-]+)\//gi)].map((m) => m[1]).filter((h) => /job|career|recruit|personal|stellen|vacanc|apply|hr/i.test(h)))].slice(0, 6);
  } catch (e) { row.error = e.message; }
  out.push(row); console.log(JSON.stringify(row));
}
await mkdir("diagout", { recursive: true });
await writeFile("diagout/ats.json", JSON.stringify(out, null, 1));
