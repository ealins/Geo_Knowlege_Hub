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

import { eventRange } from "./deadline.mjs";
test("event range same month", () => {
  const r = eventRange("Held on 11-15 Jan 2027 in Tainan", now);
  assert.match(r.start, /^2027-01-11/); assert.match(r.end, /^2027-01-15/);
});
test("event range across months", () => {
  const r = eventRange("28 Jun - 3 Jul 2027", now);
  assert.match(r.start, /^2027-06-28/); assert.match(r.end, /^2027-07-03/);
});
test("event range US style and past ranges ignored", () => {
  assert.match(eventRange("June 3-5, 2027", now).start, /^2027-06-03/);
  assert.equal(eventRange("12-14 March 2019", now), null);
});
test("event range German", () => {
  assert.match(eventRange("15.-17.09.2027", now).start, /^2027-09-15/);
});
