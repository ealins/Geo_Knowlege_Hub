import { describe, expect, test } from "bun:test";
import { discoveryFallbackPolicy, hasProviderCircuitOpenSignal, hasProviderGatewayFailureSignal, normalizationWavePolicy, shouldRunNormalizationWave, shouldThrottleSteadyStateDrain } from "./queue-drain-policy";

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
