import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflows = [
  {
    name: "primary ingestion",
    path: "../.github/workflows/geoacademic-ingestion.yml",
    trigger: "github-actions-normalize-backlog",
  },
  {
    name: "freshness fallback",
    path: "../.github/workflows/geoacademic-freshness-fallback.yml",
    trigger: "github-actions-freshness-fallback-normalize",
  },
];

for (const workflowCase of workflows) {
  test(`${workflowCase.name} exposes the deterministic catch-up request budget`, async () => {
    const content = await readFile(new URL(workflowCase.path, import.meta.url), "utf8");
    const drainLine = content
      .split(/\r?\n/)
      .find((line) =>
        line.includes(`--data '{"action":"drain"`) &&
        line.includes(`"trigger":"${workflowCase.trigger}"`),
      );
    assert.ok(drainLine, `missing drain request for ${workflowCase.trigger}`);
    const match = drainLine.match(/"limit":(\d+)/);
    assert.ok(match, `missing numeric drain limit for ${workflowCase.trigger}`);
    assert.ok(
      Number(match[1]) >= 8,
      `drain request limit must expose the server's eight-task deterministic cap; got ${match[1]}`,
    );
  });
}
