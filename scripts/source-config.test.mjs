import test from "node:test";
import assert from "node:assert/strict";
import { getEnabledSources } from "./source-config.mjs";

const valid = (overrides = {}) => ({
  id: "arxiv-cv",
  name: "arXiv Computer Vision",
  url: "https://rss.arxiv.org/rss/cs.CV",
  type: "rss",
  kind: "paper",
  enabled: true,
  ...overrides,
});

test("returns enabled sources and ignores disabled placeholders", () => {
  const enabled = getEnabledSources({
    sources: [
      valid(),
      valid({ id: "placeholder", enabled: false, url: "https://example.org/feed.xml" }),
    ],
  });
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].id, "arxiv-cv");
});

test("fails closed when no sources are enabled", () => {
  assert.throws(
    () => getEnabledSources({ sources: [valid({ enabled: false })] }),
    /No enabled sources configured/,
  );
});

test("rejects malformed or insecure enabled source URLs", () => {
  assert.throws(() => getEnabledSources({ sources: [valid({ url: "http://example.org/feed.xml" })] }), /must use HTTPS/);
  assert.throws(() => getEnabledSources({ sources: [valid({ url: "not a url" })] }), /invalid URL/);
});

test("rejects duplicate enabled ids and unsupported types", () => {
  assert.throws(() => getEnabledSources({ sources: [valid(), valid()] }), /Duplicate enabled source id/);
  assert.throws(() => getEnabledSources({ sources: [valid({ type: "json" })] }), /unsupported type/);
});
