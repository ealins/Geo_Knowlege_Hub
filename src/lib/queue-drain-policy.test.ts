import { describe, expect, test } from "bun:test";
import { discoveryFallbackPolicy, hasProviderCircuitOpenSignal, hasProviderGatewayFailureSignal, normalizationWavePolicy, selectDeterministicVacancyTaskIds, selectPreferredDeterministicVacancyTaskIds, selectDeterministicResearchNewsTaskIds, shouldRunDeterministicNormalizationFallback, shouldRunNormalizationWave, shouldThrottleSteadyStateDrain } from "./queue-drain-policy";

describe("shouldThrottleSteadyStateDrain", () => {
  test("keeps the interval for a small, recently due queue after recent work", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 7,
      batchSize: 4,
      oldestDueAgeMinutes: 5,
    })).toBe(true);
  });

  test("allows bounded catch-up when a small queue has aged beyond the limit", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 7,
      batchSize: 4,
      oldestDueAgeMinutes: 15,
    })).toBe(false);
  });

  test("keeps the interval if due-task age is unknown after a telemetry read error", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 7,
      batchSize: 4,
      oldestDueAgeMinutes: null,
    })).toBe(true);
  });

  test("allows bounded catch-up when due work exceeds two steady-state waves", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 23,
      batchSize: 4,
      oldestDueAgeMinutes: 2,
    })).toBe(false);
  });

  test("does not throttle when there was no recent work", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: false,
      dueTasks: 4,
      batchSize: 4,
      oldestDueAgeMinutes: 2,
    })).toBe(false);
  });

  test("scales the catch-up threshold with larger steady-state batches", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 10,
      batchSize: 6,
      oldestDueAgeMinutes: 2,
    })).toBe(true);
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 13,
      batchSize: 6,
      oldestDueAgeMinutes: 2,
    })).toBe(false);
  });
});


describe("normalizationWavePolicy", () => {
  test("serializes normalization when no independent provider is configured", () => {
    expect(normalizationWavePolicy({
      mode: "BACKLOG",
      batch: 4,
      independentFallbackConfigured: false,
    })).toEqual({ target: 4, waveSize: 1, concurrency: 1 });
  });

  test("preserves bounded parallel waves when an independent provider is configured", () => {
    expect(normalizationWavePolicy({
      mode: "BACKLOG",
      batch: 4,
      independentFallbackConfigured: true,
    })).toEqual({ target: 4, waveSize: 2, concurrency: 3 });
    expect(normalizationWavePolicy({
      mode: "STEADY_STATE",
      batch: 3,
      independentFallbackConfigured: true,
    })).toEqual({ target: 3, waveSize: 2, concurrency: 2 });
  });
});

describe("provider gateway failure signals", () => {
  test("detects a gateway deferral so the drain can stop before claiming another task", () => {
    expect(hasProviderGatewayFailureSignal([
      "DEFERRED NORMALIZE: TRANSIENT_EXTRACTION_FAILURE GATEWAY_5XX: HTTP_502",
    ])).toBe(true);
  });

  test("detects HTTP 504 so the drain stops before claiming another normalization task", () => {
    expect(hasProviderGatewayFailureSignal([
      "DEFERRED NORMALIZE: TRANSIENT_EXTRACTION_FAILURE HTTP_504: gateway timeout",
    ])).toBe(true);
  });

  test("detects an explicit circuit-open response", () => {
    expect(hasProviderCircuitOpenSignal([
      "DEFERRED NORMALIZE: circuit open after repeated recent primary gateway HTTP 502/503/530 failures",
    ])).toBe(true);
  });

  test("does not classify ordinary extraction validation failures as gateway outages", () => {
    expect(hasProviderGatewayFailureSignal(["FAILED NORMALIZE: missing title"])).toBe(false);
    expect(hasProviderCircuitOpenSignal(["FAILED NORMALIZE: missing title"])).toBe(false);
  });
});

describe("shouldRunNormalizationWave", () => {
  test("does not claim normalization work while the provider circuit is open", () => {
    expect(shouldRunNormalizationWave({
      providerCircuitOpen: true,
      processed: 0,
      target: 4,
    })).toBe(false);
  });

  test("continues bounded normalization waves when the circuit is closed", () => {
    expect(shouldRunNormalizationWave({
      providerCircuitOpen: false,
      processed: 0,
      target: 4,
    })).toBe(true);
    expect(shouldRunNormalizationWave({
      providerCircuitOpen: false,
      processed: 4,
      target: 4,
    })).toBe(false);
  });
});

describe("discoveryFallbackPolicy", () => {
  test("runs one bounded discovery task with a longer budget during provider circuit", () => {
    expect(discoveryFallbackPolicy(true, 8)).toEqual({
      limit: 1,
      timeoutMs: 150_000,
    });
  });

  test("preserves the ordinary discovery batch and timeout when the circuit is closed", () => {
    expect(discoveryFallbackPolicy(false, 4)).toEqual({
      limit: 4,
      timeoutMs: 15_000,
    });
  });
});


describe("selectDeterministicVacancyTaskIds", () => {
  test("selects only an exact pending vacancy snapshot for the same source", () => {
    expect(selectDeterministicVacancyTaskIds(
      [
        { id: "raw-vacancy", source_id: "source-a" },
        { id: "raw-other", source_id: "source-b" },
      ],
      [
        { id: "task-exact", source_id: "source-a", payload: { raw_record_id: "raw-vacancy" } },
        { id: "task-wrong-source", source_id: "source-a", payload: { raw_record_id: "raw-other" } },
        { id: "task-legacy", source_id: "source-a", payload: { classification: "VACANCY" } },
      ],
      1,
    )).toEqual(["task-exact"]);
  });

  test("does not select more than one task per source or exceed the limit", () => {
    expect(selectDeterministicVacancyTaskIds(
      [
        { id: "raw-a", source_id: "source-a" },
        { id: "raw-b", source_id: "source-a" },
        { id: "raw-c", source_id: "source-c" },
      ],
      [
        { id: "task-a1", source_id: "source-a", payload: { raw_record_id: "raw-a" } },
        { id: "task-a2", source_id: "source-a", payload: { raw_record_id: "raw-b" } },
        { id: "task-c1", source_id: "source-c", payload: { raw_record_id: "raw-c" } },
      ],
      2,
    )).toEqual(["task-a1", "task-c1"]);
  });

  test("returns no candidates when exact snapshot IDs are missing or stale", () => {
    expect(selectDeterministicVacancyTaskIds(
      [{ id: "raw-vacancy", source_id: "source-a" }],
      [
        { id: "task-legacy", source_id: "source-a", payload: { classification: "VACANCY" } },
        { id: "task-stale", source_id: "source-a", payload: { raw_record_id: "raw-deleted" } },
      ],
      1,
    )).toEqual([]);
  });
});


describe("selectPreferredDeterministicVacancyTaskIds", () => {
  test("prioritizes a gate-passing snapshot over an older rejected snapshot", () => {
    expect(selectPreferredDeterministicVacancyTaskIds(
      [
        { id: "raw-rejected", source_id: "source-a" },
        { id: "raw-eligible", source_id: "source-b" },
      ],
      new Set(["raw-eligible"]),
      [
        { id: "task-rejected", source_id: "source-a", payload: { raw_record_id: "raw-rejected" } },
        { id: "task-eligible", source_id: "source-b", payload: { raw_record_id: "raw-eligible" } },
      ],
      1,
    )).toEqual(["task-eligible"]);
  });

  test("drains one exact rejected snapshot when no gate-passing snapshot is available", () => {
    expect(selectPreferredDeterministicVacancyTaskIds(
      [{ id: "raw-rejected", source_id: "source-a" }],
      new Set(),
      [{ id: "task-rejected", source_id: "source-a", payload: { raw_record_id: "raw-rejected" } }],
      1,
    )).toEqual(["task-rejected"]);
  });

  test("drains up to three rejected snapshots from distinct sources during provider outage", () => {
    expect(selectPreferredDeterministicVacancyTaskIds(
      [
        { id: "raw-a", source_id: "source-a" },
        { id: "raw-b", source_id: "source-b" },
        { id: "raw-c", source_id: "source-c" },
        { id: "raw-d", source_id: "source-d" },
      ],
      new Set(),
      [
        { id: "task-a", source_id: "source-a", payload: { raw_record_id: "raw-a" } },
        { id: "task-b", source_id: "source-b", payload: { raw_record_id: "raw-b" } },
        { id: "task-c", source_id: "source-c", payload: { raw_record_id: "raw-c" } },
        { id: "task-d", source_id: "source-d", payload: { raw_record_id: "raw-d" } },
      ],
      3,
    )).toEqual(["task-a", "task-b", "task-c"]);
  });

  test("never falls back to a legacy task without an exact raw_record_id", () => {
    expect(selectPreferredDeterministicVacancyTaskIds(
      [{ id: "raw-rejected", source_id: "source-a" }],
      new Set(),
      [{ id: "task-legacy", source_id: "source-a", payload: { classification: "VACANCY" } }],
      1,
    )).toEqual([]);
  });
});


describe("selectDeterministicResearchNewsTaskIds", () => {
  test("selects only exact pending RESEARCH_NEWS snapshots marked for cleanup", () => {
    const pending = [
      { id: "news-1", source_id: "source-1", classification: "RESEARCH_NEWS" },
      { id: "news-2", source_id: "source-2", classification: "RESEARCH_NEWS" },
    ];
    const tasks = [
      {
        id: "task-1",
        source_id: "source-1",
        payload: {
          raw_record_id: "news-1",
          classification: "RESEARCH_NEWS",
          deterministic_cleanup: true,
        },
      },
      {
        id: "task-2",
        source_id: "source-2",
        payload: {
          raw_record_id: "news-2",
          classification: "RESEARCH_NEWS",
          deterministic_cleanup: true,
        },
      },
    ];
    expect(selectDeterministicResearchNewsTaskIds(pending, tasks, 1)).toEqual(["task-1"]);
    expect(selectDeterministicResearchNewsTaskIds(pending, tasks, 2)).toEqual(["task-1", "task-2"]);
  });

  test("rejects legacy tasks, wrong-source IDs, other classifications and unmarked tasks", () => {
    const pending = [
      { id: "news-1", source_id: "source-1", classification: "RESEARCH_NEWS" },
    ];
    const tasks = [
      { id: "legacy", source_id: "source-1", payload: { classification: "RESEARCH_NEWS" } },
      {
        id: "wrong-source",
        source_id: "source-2",
        payload: {
          raw_record_id: "news-1",
          classification: "RESEARCH_NEWS",
          deterministic_cleanup: true,
        },
      },
      {
        id: "not-marked",
        source_id: "source-1",
        payload: { raw_record_id: "news-1", classification: "RESEARCH_NEWS" },
      },
      {
        id: "wrong-class",
        source_id: "source-1",
        payload: {
          raw_record_id: "news-1",
          classification: "VACANCY",
          deterministic_cleanup: true,
        },
      },
    ];
    expect(selectDeterministicResearchNewsTaskIds(pending, tasks, 5)).toEqual([]);
  });

  test("does not select a vacancy task from a source already selected for cleanup", () => {
    const pending = [
      { id: "vac-1", source_id: "source-1" },
      { id: "vac-2", source_id: "source-2" },
    ];
    const tasks = [
      { id: "task-1", source_id: "source-1", payload: { raw_record_id: "vac-1" } },
      { id: "task-2", source_id: "source-2", payload: { raw_record_id: "vac-2" } },
    ];
    expect(selectDeterministicVacancyTaskIds(pending, tasks, 2, ["source-1"])).toEqual(["task-2"]);
  });
});


describe("shouldRunDeterministicNormalizationFallback", () => {
  test("runs deterministic cleanup when the circuit was already open", () => {
    expect(shouldRunDeterministicNormalizationFallback({
      providerCircuitOpen: true,
      providerGatewayFailure: false,
      independentFallbackConfigured: false,
    })).toBe(true);
  });

  test("runs bounded cleanup after the first gateway failure in this invocation", () => {
    expect(shouldRunDeterministicNormalizationFallback({
      providerCircuitOpen: false,
      providerGatewayFailure: true,
      independentFallbackConfigured: false,
    })).toBe(true);
  });

  test("does not run outage fallback when an independent provider is configured", () => {
    expect(shouldRunDeterministicNormalizationFallback({
      providerCircuitOpen: true,
      providerGatewayFailure: true,
      independentFallbackConfigured: true,
    })).toBe(false);
  });

  test("does not run outage fallback when the provider is healthy", () => {
    expect(shouldRunDeterministicNormalizationFallback({
      providerCircuitOpen: false,
      providerGatewayFailure: false,
      independentFallbackConfigured: false,
    })).toBe(false);
  });
});
