/**
 * Decide whether a recent steady-state drain should throttle another invocation.
 *
 * Small, newly-due queues keep the configured steady-state interval. A larger
 * sub-threshold queue can catch up, and any due queue older than the age limit
 * can make bounded progress rather than remain starved behind the interval.
 */
export function shouldThrottleSteadyStateDrain(input: {
  recentWork: boolean;
  dueTasks: number;
  batchSize: number;
  oldestDueAgeMinutes?: number | null;
  maxThrottleAgeMinutes?: number;
}): boolean {
  if (!input.recentWork) return false;

  const maxThrottleAgeMinutes = Math.max(1, input.maxThrottleAgeMinutes ?? 15);
  if (
    typeof input.oldestDueAgeMinutes === "number" &&
    Number.isFinite(input.oldestDueAgeMinutes) &&
    input.oldestDueAgeMinutes >= maxThrottleAgeMinutes
  ) {
    return false;
  }

  const catchUpThreshold = Math.max(8, input.batchSize * 2);
  return input.dueTasks <= catchUpThreshold;
}


export type NormalizationQueueMode = "BACKLOG" | "STEADY_STATE";

/**
 * Keep the existing bounded parallel wave when an independent provider exists.
 * Without one, serialize tasks so a gateway failure can stop additional
 * normalization task claims in the same drain invocation.
 */
export function normalizationWavePolicy(input: {
  mode: NormalizationQueueMode;
  batch: number;
  independentFallbackConfigured: boolean;
}): { target: number; waveSize: number; concurrency: number } {
  const target = input.mode === "BACKLOG"
    ? Math.min(4, input.batch)
    : Math.min(3, input.batch);
  if (!input.independentFallbackConfigured) {
    return { target, waveSize: 1, concurrency: 1 };
  }
  return {
    target,
    waveSize: 2,
    concurrency: input.mode === "BACKLOG" ? 3 : 2,
  };
}

/** True when a completed task wave reports an actual provider gateway failure. */
export function hasProviderGatewayFailureSignal(details: readonly string[]): boolean {
  return details.some((detail) =>
    /\b(?:HTTP_502|HTTP_503|HTTP_504|HTTP_530|GATEWAY_5XX|CIRCUIT_OPEN_GATEWAY_5XX)\b|circuit open after repeated recent primary gateway/i.test(detail)
  );
}

/** Distinguish an explicit circuit-open response from a first gateway failure. */
export function hasProviderCircuitOpenSignal(details: readonly string[]): boolean {
  return details.some((detail) =>
    /CIRCUIT_OPEN_GATEWAY_5XX|circuit open after repeated recent primary gateway/i.test(detail)
  );
}

/**
 * Keep model-dependent work stopped while a confirmed provider circuit is open,
 * without preventing the caller from falling through to deterministic discovery.
 */
export function shouldRunNormalizationWave(input: {
  providerCircuitOpen: boolean;
  processed: number;
  target: number;
}): boolean {
  return !input.providerCircuitOpen && input.processed < input.target;
}

/**
 * Keep ordinary discovery bounded, but allow one slow deterministic discovery
 * task to finish during an AI-provider circuit without claiming NORMALIZE work.
 * The circuit-open timeout is below the workflow caller's HTTP deadline.
 */
export function discoveryFallbackPolicy(
  providerCircuitOpen: boolean,
  batch: number,
): { limit: number; timeoutMs: number } {
  if (providerCircuitOpen) return { limit: 1, timeoutMs: 150_000 };
  return { limit: Math.max(1, Math.floor(batch)), timeoutMs: 15_000 };
}


export type PendingVacancySnapshot = {
  id: string;
  source_id: string | null;
};

export type DueNormalizationTaskCandidate = {
  id: string;
  source_id: string | null;
  payload: unknown;
};

/**
 * Select only exact-snapshot NORMALIZE tasks whose raw record is still PENDING
 * and classified VACANCY. The vacancy canonical writer is deterministic and
 * does not require the unavailable AI provider. Callers must obtain these rows
 * from the corresponding filtered database queries and keep the task batch bounded.
 */
export function selectDeterministicVacancyTaskIds(
  pendingVacancies: readonly PendingVacancySnapshot[],
  dueTasks: readonly DueNormalizationTaskCandidate[],
  limit = 1,
  excludedSourceIds: readonly string[] = [],
): string[] {
  const maxTasks = Math.max(0, Math.floor(limit));
  if (maxTasks === 0) return [];

  const sourceByRawId = new Map<string, string>();
  for (const raw of pendingVacancies) {
    if (raw.id && raw.source_id) sourceByRawId.set(raw.id, raw.source_id);
  }

  const selectedIds: string[] = [];
  const selectedSources = new Set<string>(excludedSourceIds.filter(Boolean));
  for (const task of dueTasks) {
    if (!task.id || !task.source_id || selectedSources.has(task.source_id)) continue;
    const payload =
      task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
        ? (task.payload as Record<string, unknown>)
        : {};
    const rawRecordId = payload.raw_record_id;
    if (typeof rawRecordId !== "string" || !rawRecordId.trim()) continue;
    if (sourceByRawId.get(rawRecordId) !== task.source_id) continue;

    selectedIds.push(task.id);
    selectedSources.add(task.source_id);
    if (selectedIds.length >= maxTasks) break;
  }
  return selectedIds;
}


/**
 * Prefer exact pending vacancy snapshots that pass the canonical posting gate.
 * If none can be normalized, still select one exact pending snapshot so the
 * deterministic normalizer can mark false-positive classifications SKIPPED.
 * This keeps invalid rows from starving valid work while allowing the backlog
 * of rejected snapshots to drain safely during a provider outage.
 */
export function selectPreferredDeterministicVacancyTaskIds(
  pendingVacancies: readonly PendingVacancySnapshot[],
  eligibleRawRecordIds: ReadonlySet<string>,
  dueTasks: readonly DueNormalizationTaskCandidate[],
  limit = 1,
  excludedSourceIds: readonly string[] = [],
): string[] {
  const preferredSnapshots = pendingVacancies.filter((raw) =>
    eligibleRawRecordIds.has(raw.id),
  );
  const preferred = selectDeterministicVacancyTaskIds(preferredSnapshots, dueTasks, limit, excludedSourceIds);
  if (preferred.length > 0) return preferred;

  // A deterministic rejection is still useful progress: normalizeSource marks
  // the exact snapshot SKIPPED without calling the unavailable AI provider.
  return selectDeterministicVacancyTaskIds(pendingVacancies, dueTasks, limit, excludedSourceIds);
}


export type PendingDeterministicCleanupSnapshot = {
  id: string;
  source_id: string | null;
  classification: string | null;
};

/**
 * Select exact pending RESEARCH_NEWS tasks explicitly enqueued for deterministic
 * cleanup. The non-vacancy normalizer has no writer for this class and returns
 * SKIPPED without an LLM request. Legacy tasks and source-mismatched snapshots
 * must never be selected.
 */
export function selectDeterministicResearchNewsTaskIds(
  pendingSnapshots: readonly PendingDeterministicCleanupSnapshot[],
  dueTasks: readonly DueNormalizationTaskCandidate[],
  limit = 1,
): string[] {
  const maxTasks = Math.max(0, Math.floor(limit));
  if (maxTasks === 0) return [];

  const sourceByRawId = new Map<string, string>();
  for (const raw of pendingSnapshots) {
    if (
      raw.id &&
      raw.source_id &&
      raw.classification?.toUpperCase() === "RESEARCH_NEWS"
    ) {
      sourceByRawId.set(raw.id, raw.source_id);
    }
  }

  const selectedIds: string[] = [];
  const selectedSources = new Set<string>();
  for (const task of dueTasks) {
    if (!task.id || !task.source_id || selectedSources.has(task.source_id)) continue;
    const payload =
      task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
        ? (task.payload as Record<string, unknown>)
        : {};
    if (payload.deterministic_cleanup !== true) continue;
    if (String(payload.classification ?? "").toUpperCase() !== "RESEARCH_NEWS") continue;
    const rawRecordId = payload.raw_record_id;
    if (typeof rawRecordId !== "string" || !rawRecordId.trim()) continue;
    if (sourceByRawId.get(rawRecordId) !== task.source_id) continue;

    selectedIds.push(task.id);
    selectedSources.add(task.source_id);
    if (selectedIds.length >= maxTasks) break;
  }
  return selectedIds;
}
