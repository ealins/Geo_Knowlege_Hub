import { describe, expect, test } from "bun:test";
import { shouldThrottleSteadyStateDrain } from "./queue-drain-policy";

describe("shouldThrottleSteadyStateDrain", () => {
  test("keeps the interval for a small queue after recent work", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 8,
      batchSize: 4,
    })).toBe(true);
  });

  test("allows bounded catch-up when due work exceeds two steady-state waves", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 23,
      batchSize: 4,
    })).toBe(false);
  });

  test("does not throttle when there was no recent work", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: false,
      dueTasks: 4,
      batchSize: 4,
    })).toBe(false);
  });

  test("scales the catch-up threshold with larger steady-state batches", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 10,
      batchSize: 6,
    })).toBe(true);
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 13,
      batchSize: 6,
    })).toBe(false);
  });
});
