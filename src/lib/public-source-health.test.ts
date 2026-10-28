import { describe, expect, test } from "bun:test";
import {
  isConfirmedDeadOpportunitySource,
  isOpportunityOnlyBackedByDeadSources,
  type PublicSourceHealth,
} from "./public-source-health";

const checkedAt = "2026-10-01T00:00:00.000Z";
const failureAt = "2026-10-08T00:00:00.000Z";

function source(overrides: Partial<PublicSourceHealth> = {}): PublicSourceHealth {
  return {
    id: "source-1",
    active: false,
    status: "FAILED",
    last_http_status: 404,
    last_success_at: "2026-09-01T00:00:00.000Z",
    last_failure_at: failureAt,
    ...overrides,
  };
}

describe("isConfirmedDeadOpportunitySource", () => {
  test("confirms an inactive 404 after the opportunity and evidence checks", () => {
    expect(isConfirmedDeadOpportunitySource(source(), checkedAt, checkedAt)).toBe(true);
  });

  test("accepts 410 when there was no successful fetch", () => {
    expect(isConfirmedDeadOpportunitySource(
      source({ last_http_status: 410, last_success_at: null }),
      checkedAt,
      checkedAt,
    )).toBe(true);
  });

  test("does not suppress an active source", () => {
    expect(isConfirmedDeadOpportunitySource(source({ active: true }), checkedAt, checkedAt)).toBe(false);
  });

  test("does not suppress transient or non-terminal HTTP failures", () => {
    for (const status of [403, 429, 500, 502, 503]) {
      expect(isConfirmedDeadOpportunitySource(source({ last_http_status: status }), checkedAt, checkedAt)).toBe(false);
    }
  });

  test("does not suppress a source that succeeded after the failure", () => {
    expect(isConfirmedDeadOpportunitySource(
      source({ last_success_at: "2026-10-09T00:00:00.000Z" }),
      checkedAt,
      checkedAt,
    )).toBe(false);
  });

  test("does not suppress when the failure predates either recorded check", () => {
    expect(isConfirmedDeadOpportunitySource(source(), "2026-10-09T00:00:00.000Z", checkedAt)).toBe(false);
    expect(isConfirmedDeadOpportunitySource(source(), checkedAt, "2026-10-09T00:00:00.000Z")).toBe(false);
  });

  test("fails open when source metadata is missing or invalid", () => {
    expect(isConfirmedDeadOpportunitySource(undefined, checkedAt, checkedAt)).toBe(false);
    expect(isConfirmedDeadOpportunitySource(source({ last_failure_at: "not-a-date" }), checkedAt, checkedAt)).toBe(false);
  });
});

describe("isOpportunityOnlyBackedByDeadSources", () => {
  const dead = source();
  const healthy = source({
    id: "source-2",
    active: true,
    status: "ACTIVE",
    last_http_status: 200,
    last_success_at: "2026-10-09T00:00:00.000Z",
  });

  test("hides only when every known source link is confirmed dead", () => {
    expect(isOpportunityOnlyBackedByDeadSources(
      [{ source_id: dead.id, last_checked_at: checkedAt }],
      new Map([[dead.id, dead]]),
      checkedAt,
    )).toBe(true);
  });

  test("preserves an opportunity with any healthy or unknown source link", () => {
    expect(isOpportunityOnlyBackedByDeadSources(
      [
        { source_id: dead.id, last_checked_at: checkedAt },
        { source_id: healthy.id, last_checked_at: checkedAt },
      ],
      new Map([[dead.id, dead], [healthy.id, healthy]]),
      checkedAt,
    )).toBe(false);

    expect(isOpportunityOnlyBackedByDeadSources(
      [{ source_id: "missing-source", last_checked_at: checkedAt }],
      new Map(),
      checkedAt,
    )).toBe(false);

    expect(isOpportunityOnlyBackedByDeadSources(
      [{ source_id: null, last_checked_at: checkedAt }],
      new Map(),
      checkedAt,
    )).toBe(false);
  });

  test("preserves an opportunity without source links", () => {
    expect(isOpportunityOnlyBackedByDeadSources([], new Map(), checkedAt)).toBe(false);
  });
});
