// Visual + sanity check of the built site with Playwright.
// Usage: node scripts/check-ui.mjs   (serves ./site with ./data, writes screenshots to ./shots)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); }
catch { ({ chromium } = await import("playwright")); }

const root = path.resolve(".");
const MIME = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const file = u.startsWith("/data/") ? path.join(root, u) : path.join(root, "site", u === "/" ? "index.html" : u);
  fs.readFile(file, (e, buf) => e ? (res.writeHead(404), res.end()) : (res.writeHead(200, { "content-type": MIME[path.extname(file)] || "text/plain" }), res.end(buf)));
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

fs.mkdirSync("shots", { recursive: true });
const browser = await chromium.launch();
const problems = [];
for (const [name, width, height, scheme] of [["desktop", 1280, 1000, "light"], ["desktop-dark", 1280, 1000, "dark"], ["mobile", 390, 900, "light"]]) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
  page.on("console", m => m.type() === "error" && problems.push(`${name}: console error: ${m.text()}`));
  page.on("pageerror", e => problems.push(`${name}: ${e.message}`));
  await page.goto(base);
  await page.waitForSelector(".row, .empty", { timeout: 8000 });
  await page.waitForTimeout(1600);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push(`${name}: horizontal overflow`);
  const rows = await page.locator(".row").count();
  if (!rows) problems.push(`${name}: no rows rendered`);
  await page.screenshot({ path: `shots/${name}.png`, fullPage: false });
  await page.close();
}
await browser.close(); server.close();
console.log(problems.length ? "Problems:\n" + problems.join("\n") : "UI check passed. Screenshots in ./shots");
process.exit(problems.length ? 1 : 0);
