import test from "node:test";
import assert from "node:assert/strict";
import { findDeadline } from "./deadline.mjs";
const now = new Date("2026-10-29T00:00:00Z");
test("JSON-LD validThrough", () => {
  const h = '<script type="application/ld+json">{"@type":"JobPosting","validThrough":"2026-12-01T00:00:00Z"}</script>';
  assert.equal(findDeadline(h, now), "2026-12-01T00:00:00.000Z");
});
test("English deadline with year", () => {
  assert.match(findDeadline("<p>Application deadline: 15 January 2027</p>", now), /^2027-01-15/);
});
test("US style", () => {
  assert.match(findDeadline("<p>Closing date: December 5, 2026</p>", now), /^2026-12-05/);
});
test("German numeric", () => {
  assert.match(findDeadline("<p>Bewerbungsfrist: 15.01.2027</p>", now), /^2027-01-15/);
});
test("year-less takes next occurrence", () => {
  assert.match(findDeadline("<p>Deadline 15 July</p>", now), /^2027-07-15/);
});
test("no deadline", () => {
  assert.equal(findDeadline("<p>Welcome to our department</p>", now), null);
});
