import { describe, expect, test } from "bun:test";
import { filterPublicOpportunityIdsByServerHealth, filterPublicPulseRowsByServerHealth } from "./public-source-health-client";

describe("filterPublicOpportunityIdsByServerHealth", () => {
  test("removes only IDs returned as confirmed dead by the server", async () => {
    const result = await filterPublicOpportunityIdsByServerHealth(
      ["live-1", "dead-1", "unknown-1"],
      async (ids) => {
        expect(ids).toEqual(["live-1", "dead-1", "unknown-1"]);
        return { suppressed_opportunity_ids: ["dead-1"] };
      },
    );

    expect(result).toEqual(["live-1", "unknown-1"]);
  });

  test("returns an empty list without making a server call when there are no IDs", async () => {
    let called = false;
    const result = await filterPublicOpportunityIdsByServerHealth([], async () => {
      called = true;
      return { suppressed_opportunity_ids: [] };
    });

    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  test("fails open to the evidence-filtered IDs when the server lookup fails", async () => {
    const ids = ["live-1", "possibly-dead-1"];
    const result = await filterPublicOpportunityIdsByServerHealth(ids, async () => {
      throw new Error("server unavailable");
    });

    expect(result).toEqual(ids);
  });

  test("fails open when the server response is malformed", async () => {
    const ids = ["live-1", "possibly-dead-1"];
    const result = await filterPublicOpportunityIdsByServerHealth(ids, async () => ({
      suppressed_opportunity_ids: ["dead-1", 42],
    }));

    expect(result).toEqual(ids);
  });

  test("filters stale cached opportunity IDs from homepage pulse rows with a fresh health lookup", async () => {
    const rows = [
      { id: "pulse-dead", entity_type: "opportunity", entity_id: "dead-1" },
      { id: "pulse-live", entity_type: "opportunity", entity_id: "live-1" },
      { id: "pulse-paper", entity_type: "publication", entity_id: null },
    ];
    const result = await filterPublicPulseRowsByServerHealth(
      rows,
      new Set(["dead-1", "live-1"]),
      async (ids) => {
        expect(ids).toEqual(["dead-1", "live-1"]);
        return { suppressed_opportunity_ids: ["dead-1"] };
      },
    );

    expect(result.map((row) => row.id)).toEqual(["pulse-live", "pulse-paper"]);
  });

  test("hides opportunity pulse rows not present in the public jobs ID set", async () => {
    const rows = [
      { id: "pulse-private", entity_type: "opportunity", entity_id: "private-1" },
      { id: "pulse-paper", entity_type: "publication", entity_id: null },
    ];
    let called = false;
    const result = await filterPublicPulseRowsByServerHealth(rows, new Set(), async () => {
      called = true;
      return { suppressed_opportunity_ids: [] };
    });

    expect(result.map((row) => row.id)).toEqual(["pulse-paper"]);
    expect(called).toBe(false);
  });

});
