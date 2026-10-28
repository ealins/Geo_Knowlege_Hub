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


/**
 * Report whether normalization has an independent extraction provider available.
 * Keep this gate aligned with the fallback chain in nvidia.server.ts: NVIDIA is
 * independent of OmniRoute and must prevent the primary-gateway circuit from
 * pausing model work when NVIDIA_API_KEY is configured.
 */
export function isIndependentProviderConfigured(input: {
  openAIKey?: string | null;
  openRouterKey?: string | null;
  openRouterModel?: string | null;
  nvidiaKey?: string | null;
}): boolean {
  return Boolean(
    input.openAIKey?.trim() ||
      (input.openRouterKey?.trim() && input.openRouterModel?.trim()) ||
      input.nvidiaKey?.trim(),
  );
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
  providerCircuitOpen?: boolean;
}): { target: number; waveSize: number; concurrency: number } {
  // Only widen the target when the circuit is already open before this drain.
  // Normal model-dependent work remains at four per backlog invocation; the
  // larger target is consumed solely by the separately gated deterministic path.
  const deterministicCatchUp =
    input.mode === "BACKLOG" &&
    input.providerCircuitOpen === true &&
    !input.independentFallbackConfigured;
  const target = input.mode === "BACKLOG"
    ? Math.min(deterministicCatchUp ? 8 : 4, input.batch)
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

/**
 * Permit bounded deterministic snapshot cleanup when the provider circuit was
 * already open at preflight or the first model request confirms a gateway outage.
 * Never use this fallback when an independent provider is configured.
 */
export function shouldRunDeterministicNormalizationFallback(input: {
  providerCircuitOpen: boolean;
  providerGatewayFailure: boolean;
  independentFallbackConfigured: boolean;
}): boolean {
  return !input.independentFallbackConfigured &&
    (input.providerCircuitOpen || input.providerGatewayFailure);
}

/**
 * Reserve bounded deterministic cleanup capacity when a provider failure
 * consumed the last normalization slot. The failed model-dependent task is
 * deferred for retry, so it must not prevent one exact-snapshot, no-model
 * cleanup task from running in the same invocation.
 */
export function deterministicNormalizationFallbackLimit(input: {
  target: number;
  processed: number;
  providerGatewayFailure: boolean;
  providerCircuitOpen?: boolean;
}): number {
  const target = Number.isFinite(input.target) ? Math.max(0, Math.floor(input.target)) : 0;
  const processed = Number.isFinite(input.processed) ? Math.max(0, Math.floor(input.processed)) : 0;
  const deferredFailureCredit = input.providerGatewayFailure ? 1 : 0;
  // When the circuit was already open at preflight, allow up to eight
  // strictly gated deterministic tasks. If a model request fails during this
  // invocation, keep the fallback cap at three so ordinary failure handling
  // stays conservative and does not expand the same tick after a new outage.
  const fallbackCap = input.providerGatewayFailure
    ? 3
    : input.providerCircuitOpen
      ? 8
      : 4;
  return Math.min(fallbackCap, Math.max(0, target - processed + deferredFailureCredit));
}


export type PendingDeterministicMediaSnapshot = {
  id: string;
  source_id: string | null;
  classification: string | null;
  final_url: string | null;
};

/**
 * Recognize only a proven legacy false-positive class: ESA multimedia video/image
 * pages that were stored as COURSE before the classifier's media-path guard.
 * Keep the host, path, and classification checks strict to avoid skipping real courses.
 */
export function deterministicMediaSnapshotReason(input: {
  classification: string | null | undefined;
  finalUrl: string | null | undefined;
}): string | null {
  if (input.classification?.toUpperCase() !== "COURSE" || !input.finalUrl) return null;
  try {
    const url = new URL(input.finalUrl);
    const host = url.hostname.toLowerCase();
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (
      (host === "esa.int" || host.endsWith(".esa.int")) &&
      /^\/esa_multimedia\/(?:videos|images)\//i.test(path)
    ) {
      return "ESA multimedia item is not a course";
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Select bounded cleanup tasks only when a queued NORMALIZE task points to the
 * exact pending ESA media snapshot from the same source. The caller's query must
 * already restrict snapshots to normalization_status=PENDING and tasks to due,
 * open NORMALIZE work.
 */
export function selectDeterministicMediaTaskIds(
  pendingSnapshots: readonly PendingDeterministicMediaSnapshot[],
  dueTasks: readonly DueNormalizationTaskCandidate[],
  limit = 1,
  excludedSourceIds: readonly string[] = [],
): string[] {
  const maxTasks = Math.max(0, Math.floor(limit));
  if (maxTasks === 0) return [];

  const sourceByRawId = new Map<string, string>();
  for (const raw of pendingSnapshots) {
    if (
      raw.id &&
      raw.source_id &&
      deterministicMediaSnapshotReason({
        classification: raw.classification,
        finalUrl: raw.final_url,
      })
    ) {
      sourceByRawId.set(raw.id, raw.source_id);
    }
  }

  const selectedIds: string[] = [];
  const selectedSources = new Set<string>(excludedSourceIds.filter(Boolean));
  for (const task of dueTasks) {
    if (!task.id || !task.source_id || selectedSources.has(task.source_id)) continue;
    const payload =
      task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
        ? (task.payload as Record<string, unknown>)
        : {};
    if (String(payload.classification ?? "").toUpperCase() !== "COURSE") continue;
    const rawRecordId = payload.raw_record_id;
    if (typeof rawRecordId !== "string" || !rawRecordId.trim()) continue;
    if (sourceByRawId.get(rawRecordId) !== task.source_id) continue;

    selectedIds.push(task.id);
    selectedSources.add(task.source_id);
    if (selectedIds.length >= maxTasks) break;
  }
  return selectedIds;
}


export type PendingDeterministicProgrammeSnapshot = {
  id: string;
  source_id: string | null;
  classification: string | null;
  final_url: string | null;
  page_title: string | null;
};

/**
 * Recognize only known institutional navigation/resource pages that were
 * misclassified as PROGRAMME opportunities. Both the exact page-title family
 * and a structural URL path must match; a real programme title or an unrelated
 * page under the same institution is never selected for deterministic cleanup.
 */
export function deterministicProgrammeSnapshotReason(input: {
  classification: string | null | undefined;
  finalUrl: string | null | undefined;
  pageTitle: string | null | undefined;
}): string | null {
  if (input.classification?.toUpperCase() !== "PROGRAMME" || !input.finalUrl || !input.pageTitle) {
    return null;
  }

  let path: string;
  try {
    path = new URL(input.finalUrl).pathname.toLowerCase();
  } catch {
    return null;
  }

  const structuralPath =
    /^\/internal-resources(?:\/|$)/i.test(path) ||
    /^\/(?:about\/(?:core-values|annual-reports|make-gift|equity-inclusion|department-chairs-letter|contact-us)|people\/faculty|education\/for-current-students|research\/postdoctoral-training\/postdoc-resources|about-us\/find-us|student-resources\/contact-student-services-advisors)(?:\/|$)/i.test(path);
  if (!structuralPath) return null;

  const title = input.pageTitle
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const navigationTitle =
    /^(?:department policies|postdoc resources|for current students|our core values|faculty \+ senior researchers|faculty resources|annual reports|make a gift|equity\s*&\s*inclusion|department chair['’]?s letter|contact us|visit\s*&\s*contact us|labs\s*-\s*environment,\s*health\s*\+\s*safety|contact student services advisors)(?:\s*(?:\||[-–—])\s*.+)?$/i;
  if (!navigationTitle.test(title)) return null;

  return "institutional navigation/resource page is not a programme opportunity";
}

/**
 * Select exact pending PROGRAMME snapshots that match the strict navigation
 * cleanup rule. Preserve the one-task-per-source rule and never select legacy
 * tasks without an explicit raw_record_id.
 */
export function selectDeterministicProgrammeTaskIds(
  pendingSnapshots: readonly PendingDeterministicProgrammeSnapshot[],
  dueTasks: readonly DueNormalizationTaskCandidate[],
  limit = 1,
  excludedSourceIds: readonly string[] = [],
): string[] {
  const maxTasks = Math.max(0, Math.floor(limit));
  if (maxTasks === 0) return [];

  const sourceByRawId = new Map<string, string>();
  for (const raw of pendingSnapshots) {
    if (
      raw.id &&
      raw.source_id &&
      deterministicProgrammeSnapshotReason({
        classification: raw.classification,
        finalUrl: raw.final_url,
        pageTitle: raw.page_title,
      })
    ) {
      sourceByRawId.set(raw.id, raw.source_id);
    }
  }

  const selectedIds: string[] = [];
  const selectedSources = new Set<string>(excludedSourceIds.filter(Boolean));
  for (const task of dueTasks) {
    if (!task.id || !task.source_id || selectedSources.has(task.source_id)) continue;
    const payload =
      task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
        ? (task.payload as Record<string, unknown>)
        : {};
    if (String(payload.classification ?? "").toUpperCase() !== "PROGRAMME") continue;
    const rawRecordId = payload.raw_record_id;
    if (typeof rawRecordId !== "string" || !rawRecordId.trim()) continue;
    if (sourceByRawId.get(rawRecordId) !== task.source_id) continue;

    selectedIds.push(task.id);
    selectedSources.add(task.source_id);
    if (selectedIds.length >= maxTasks) break;
  }
  return selectedIds;
}
