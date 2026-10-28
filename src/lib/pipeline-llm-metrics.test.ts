import { describe, expect, test } from "bun:test";
import { summarizeNvidiaCallMetrics } from "./pipeline-llm-metrics";

describe("summarizeNvidiaCallMetrics", () => {
  test("counts only NVIDIA calls, not primary or other fallback providers", () => {
    expect(
      summarizeNvidiaCallMetrics([
        { provider: "OmniRoute", cached: false },
        { provider: "OpenAI", cached: true },
        { provider: "NVIDIA", cached: false },
        { provider: "nvidia", cached: true },
      ]),
    ).toEqual({ nvidia_calls: 2, nvidia_cached: 1 });
  });

  test("returns zero for empty or non-NVIDIA telemetry", () => {
    expect(summarizeNvidiaCallMetrics([])).toEqual({
      nvidia_calls: 0,
      nvidia_cached: 0,
    });
    expect(
      summarizeNvidiaCallMetrics([
        { provider: "OmniRoute", cached: true },
        { provider: "OpenRouter", cached: false },
      ]),
    ).toEqual({ nvidia_calls: 0, nvidia_cached: 0 });
  });

  test("does not count null or missing provider names as NVIDIA", () => {
    expect(
      summarizeNvidiaCallMetrics([
        { provider: null, cached: true },
        { cached: true },
      ]),
    ).toEqual({ nvidia_calls: 0, nvidia_cached: 0 });
  });
});
