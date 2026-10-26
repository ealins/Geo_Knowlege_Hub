import { describe, expect, test } from "bun:test";
import { countCanonicalWrite } from "./canonical-write-metrics";

describe("countCanonicalWrite", () => {
  test("increments created records only for confirmed creates", () => {
    expect(countCanonicalWrite({ recordsCreated: 2, recordsUpdated: 3 }, "created")).toEqual({
      recordsCreated: 3,
      recordsUpdated: 3,
    });
  });

  test("increments updated records only for confirmed updates", () => {
    expect(countCanonicalWrite({ recordsCreated: 2, recordsUpdated: 3 }, "updated")).toEqual({
      recordsCreated: 2,
      recordsUpdated: 4,
    });
  });

  test("does not count a normalization without a confirmed entity write", () => {
    const counts = { recordsCreated: 2, recordsUpdated: 3 };
    expect(countCanonicalWrite(counts, undefined)).toBe(counts);
  });
});
