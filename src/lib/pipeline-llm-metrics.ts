export type ProviderCallMetric = {
  provider?: string | null;
  cached?: boolean | null;
};

/**
 * The legacy pipeline_runs columns are displayed as NVIDIA-specific metrics.
 * Count only calls actually attributed to NVIDIA, not every LLM attempt in a
 * normalization run.
 */
export function summarizeNvidiaCallMetrics(calls: readonly ProviderCallMetric[]): {
  nvidia_calls: number;
  nvidia_cached: number;
} {
  const nvidiaCalls = calls.filter(
    (call) => (call.provider ?? "").trim().toLowerCase() === "nvidia",
  );

  return {
    nvidia_calls: nvidiaCalls.length,
    nvidia_cached: nvidiaCalls.filter((call) => call.cached === true).length,
  };
}
