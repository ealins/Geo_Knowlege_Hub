import { writeFile, mkdir } from "node:fs/promises";
const UA = "GeoRadarBot/1.0 (+https://geoacademic.app)";
const urls = JSON.parse(process.env.URLS);
await mkdir("diagout", { recursive: true });
let n = 0;
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(25000), redirect: "follow" });
    const b = await r.text();
    await writeFile(`diagout/dump-${process.env.GITHUB_RUN_ID}-${n++}.html`, `<!-- ${u} ${r.status} -->\n` + b.slice(0, 250000));
  } catch (e) { await writeFile(`diagout/dump-${process.env.GITHUB_RUN_ID}-${n++}.html`, `<!-- ${u} ERROR ${e.message} -->`); }
}
