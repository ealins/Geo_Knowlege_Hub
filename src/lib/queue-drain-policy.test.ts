import { describe, expect, test } from "bun:test";
import { shouldThrottleSteadyStateDrain } from "./queue-drain-policy";

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
