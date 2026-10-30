// Assemble the static site into dist/ (index.html + data/). Node 20+, no deps.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await cp(path.join(ROOT, "site", "index.html"), path.join(DIST, "index.html"));
await cp(path.join(ROOT, "site", "fonts"), path.join(DIST, "fonts"), { recursive: true });
await cp(path.join(ROOT, "data"), path.join(DIST, "data"), { recursive: true });
await writeFile(path.join(DIST, ".nojekyll"), "");
console.log(`built ${DIST}`);
