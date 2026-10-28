// One-time backfill planner: turns ALREADY STORED raw pages and existing
// institution rows into queued work. Nothing here fetches the web, and nothing
// here calls a model — it only enqueues tasks that the deployed autonomous
// drain loop processes with the existing gates, cache and validators.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { canPinLegacyNormalizationTaskToPendingSnapshot, countUnsupportedPending, selectNewerPendingSnapshotForTransientRetry, shouldSupersedeTransientRetryForNewerPendingSnapshot, staleNormalizationTargetReason } from "./backfill-coverage";
import { assertBackfillDbSuccess } from "./backfill-db-errors";
import { shouldRetryInstitutionlessVacancy } from "./semantic-recovery-policy";

/** Skip reasons written before the entity extractors existed — safe to retry. */
const LEGACY_SKIP = "unsupported record type for canonical extraction";
const LEGACY_SKIP_ALT = "no extractor for classification";
const SEMANTIC_REVIEW_MISSING =
  "semantic vacancy review is required but no validated result is available";
const RETIRED_NVIDIA_MODEL = "NVIDIA HTTP 410";
const NVIDIA_NOT_CONFIGURED = "NVIDIA_SECRET_NOT_CONFIGURED";

/** Classifications that now have a gate + extractor + canonical writer. */
export const BACKFILL_CLASSIFICATIONS = [
  "PROJECT",
  "RESEARCHER",
  "EVENT",
  "PROGRAMME",
  "COURSE",
  "VACANCY",
] as const;

export type BackfillPlan = {
  raw_candidates: number;
  queued: number;
  already_queued: number;
  /** Open tasks that target the exact selected raw snapshot. */
  exact_snapshot_queued: number;
  /** Candidates deferred because another snapshot already occupies the source's one-task slot. */
  deferred_by_source: number;
  /** Pending raw rows whose classifications have no canonical backfill extractor. */
  unsupported_pending: number;
  /** Queued/retry tasks retired because their explicit raw target was terminal or mismatched. */
  stale_tasks_retired: number;
  /** Legacy PENDING_OLDEST tasks pinned to the exact snapshot selected by backfill. */
  legacy_tasks_pinned: number;
  /** Old provider-outage retries yielded to newer pending snapshots; raw failures are retained. */
  transient_retries_superseded: number;
  by_classification: Record<string, number>;
};

/**
 * Enqueues NORMALIZE work for stored raw pages that have never been processed
 * successfully by the current extraction pipeline.
 */
export async function enqueueRawBackfill(limit = 400): Promise<BackfillPlan> {
  const plan: BackfillPlan = {
    raw_candidates: 0,
    queued: 0,
    already_queued: 0,
    exact_snapshot_queued: 0,
    deferred_by_source: 0,
    unsupported_pending: 0,
    stale_tasks_retired: 0,
    legacy_tasks_pinned: 0,
    transient_retries_superseded: 0,
    by_classification: {},
  };

  const rawFields =
    "id, source_id, classification, normalization_status, normalization_error, fetched_at";

  // Query pending rows independently and oldest-first. Previously we took the
  // newest 2,000 raw records and only then filtered in memory; a steady stream of
  // newer records could permanently hide older PENDING rows from backfill.
  const [
    pendingResult,
    retryableResult,
    cleanupPendingResult,
    allPendingCountResult,
    supportedPendingCountResult,
  ] = await Promise.all([
    supabaseAdmin
      .from("raw_records")
      .select(rawFields)
      .in("classification", BACKFILL_CLASSIFICATIONS as unknown as string[])
      .eq("normalization_status", "PENDING")
      .order("fetched_at", { ascending: true })
      .limit(2000),
    supabaseAdmin
      .from("raw_records")
      .select(rawFields)
      .in("classification", BACKFILL_CLASSIFICATIONS as unknown as string[])
      .in("normalization_status", ["FAILED", "SKIPPED"])
      .order("fetched_at", { ascending: false })
      .limit(2000),
    // RESEARCH_NEWS has no canonical writer. Queue its exact pending snapshot
    // only for deterministic terminal cleanup; the normalizer returns SKIPPED without an LLM call.
    supabaseAdmin
      .from("raw_records")
      .select(rawFields)
      .eq("classification", "RESEARCH_NEWS")
      .eq("normalization_status", "PENDING")
      .order("fetched_at", { ascending: true })
      .limit(2000),
    supabaseAdmin
      .from("raw_records")
      .select("id", { count: "exact", head: true })
      .eq("normalization_status", "PENDING"),
    supabaseAdmin
      .from("raw_records")
      .select("id", { count: "exact", head: true })
      .eq("normalization_status", "PENDING")
      .in("classification", BACKFILL_CLASSIFICATIONS as unknown as string[]),
  ]);
  if (pendingResult.error) throw pendingResult.error;
  if (retryableResult.error) throw retryableResult.error;
  if (cleanupPendingResult.error) throw cleanupPendingResult.error;
  if (allPendingCountResult.error) throw allPendingCountResult.error;
  if (supportedPendingCountResult.error) throw supportedPendingCountResult.error;
  if (allPendingCountResult.count == null || supportedPendingCountResult.count == null) {
    throw new Error("Could not calculate pending raw-record backfill coverage");
  }
  plan.unsupported_pending = countUnsupportedPending(
    allPendingCountResult.count,
    supportedPendingCountResult.count,
  );
  const raws = [
    ...(pendingResult.data ?? []),
    ...(retryableResult.data ?? []),
    ...(cleanupPendingResult.data ?? []),
  ];

  const candidates = raws.filter((r) => {
    if (!r.source_id) return false;
    const status = r.normalization_status ?? "PENDING";
    if (status === "NORMALIZED") return false;
    if (status === "PENDING") return true;
    const err = r.normalization_error ?? "";

    // The canonical vacancy writer supports a nullable institution link. Retry
    // legacy vacancy rows that were failed only because a general job board had
    // no institution association; the single-posting quality gate still applies.
    if (shouldRetryInstitutionlessVacancy({
      classification: r.classification,
      status,
      error: err,
    })) {
      return true;
    }

    // Retry only failure modes that mean the canonical writer never actually
    // received a usable semantic result. These are infrastructure/model-routing
    // failures, not business-rule rejections. Cloud Run now owns the NVIDIA
    // review lease, so these records are safe to requeue gradually.
    if (
      status === "FAILED" &&
      (err.includes(SEMANTIC_REVIEW_MISSING) ||
        err.includes(RETIRED_NVIDIA_MODEL) ||
        err.includes(NVIDIA_NOT_CONFIGURED) ||
        err.includes("TRANSIENT_EXTRACTION_FAILURE"))
    ) {
      return true;
    }

    // Only retry skips that were caused by missing extractors, never real
    // rejections from the gates or the validator.
    return (
      status === "SKIPPED" &&
      (err.includes(LEGACY_SKIP) || err.includes(LEGACY_SKIP_ALT))
    );
  });

  // One task per source, but carry the exact selected raw snapshot. Without
  // raw_record_id the normalizer falls back to the newest page, which can leave
  // this older PENDING/eligible row untouched forever.
  const bySource = new Map<string, { classification: string; rawRecordId: string; normalizationStatus: string; fetchedAt: string | null }>();
  for (const r of candidates) {
    if (!bySource.has(r.source_id as string)) {
      bySource.set(r.source_id as string, {
        classification: r.classification ?? "UNKNOWN",
        rawRecordId: r.id,
        normalizationStatus: r.normalization_status ?? "PENDING",
        fetchedAt: r.fetched_at ?? null,
      });
    }
  }
  plan.raw_candidates = bySource.size;

  const openTasksResult = await supabaseAdmin
    .from("ingestion_tasks")
    .select("id, status, source_id, payload, created_at, updated_at, run_after, last_error")
    .eq("task_type", "NORMALIZE")
    .in("status", ["QUEUED", "PROCESSING", "RETRY"]);
  assertBackfillDbSuccess("inspect open normalization tasks", openTasksResult.error);

  type OpenNormalizeTask = {
    id: string;
    status: string;
    source_id: string;
    payload: Record<string, unknown>;
    created_at: string;
    updated_at: string;
    run_after: string | null;
    last_error: string | null;
  };
  const openTasks: OpenNormalizeTask[] = (openTasksResult.data ?? []).flatMap((task) => {
    if (!task.source_id) return [];
    const payload =
      task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
        ? (task.payload as Record<string, unknown>)
        : {};
    return [{ id: task.id, status: task.status, source_id: task.source_id, payload, created_at: task.created_at, updated_at: task.updated_at, run_after: task.run_after, last_error: task.last_error }];
  });

  const isUuid = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const rawTargetIds = [...new Set(openTasks
    .map((task) => task.payload.raw_record_id)
    .filter(isUuid))];
  const rawTargetsById = new Map<string, {
    id: string;
    source_id: string | null;
    classification: string | null;
    normalization_status: string | null;
    normalization_error: string | null;
    fetched_at: string | null;
  }>();
  if (rawTargetIds.length > 0) {
    const rawTargetsResult = await supabaseAdmin
      .from("raw_records")
      .select("id, source_id, classification, normalization_status, normalization_error, fetched_at")
      .in("id", rawTargetIds);
    assertBackfillDbSuccess("inspect open normalization raw targets", rawTargetsResult.error);
    for (const raw of rawTargetsResult.data ?? []) rawTargetsById.set(raw.id, raw);
  }

  // Older semantic-failure-recovery-v7 tasks predate raw_record_id but have a
  // defined target intent: the latest FAILED transient snapshot of their class.
  // Resolve those targets read-only so a newer same-class PENDING snapshot can
  // safely take the source slot during provider outages.
  const legacySemanticRetries = openTasks.filter((task) =>
    task.status.toUpperCase() === "RETRY" &&
    task.payload.reason === "semantic-failure-recovery-v7" &&
    !(typeof task.payload.raw_record_id === "string" && task.payload.raw_record_id.trim()) &&
    typeof task.payload.classification === "string" &&
    (task.last_error ?? "").toLowerCase().includes("no independent fallback is configured")
  );
  const legacySourceIds = [...new Set(legacySemanticRetries.map((task) => task.source_id))];
  const legacyFailedTargetsBySourceClass = new Map<string, {
    id: string;
    source_id: string | null;
    classification: string | null;
    normalization_status: string | null;
    normalization_error: string | null;
    fetched_at: string | null;
  }>();
  if (legacySourceIds.length > 0) {
    const legacyFailedTargetsResult = await supabaseAdmin
      .from("raw_records")
      .select("id, source_id, classification, normalization_status, normalization_error, fetched_at")
      .in("source_id", legacySourceIds)
      .eq("normalization_status", "FAILED")
      .like("normalization_error", "TRANSIENT_EXTRACTION_FAILURE%")
      .order("fetched_at", { ascending: false })
      .limit(2000);
    assertBackfillDbSuccess("inspect legacy transient retry targets", legacyFailedTargetsResult.error);
    for (const raw of legacyFailedTargetsResult.data ?? []) {
      if (!raw.source_id || !raw.classification) continue;
      const key = `${raw.source_id}:${raw.classification.trim().toUpperCase()}`;
      // Keep the latest failed transient target even when it lacks the outage
      // marker; the shared predicate must reject it rather than falling back to
      // an older failure that the legacy task did not actually target.
      if (!legacyFailedTargetsBySourceClass.has(key)) legacyFailedTargetsBySourceClass.set(key, raw);
    }
  }

  const openBySource = new Map<string, OpenNormalizeTask[]>();
  for (const task of openTasks) {
    const existing = openBySource.get(task.source_id) ?? [];
    existing.push(task);
    openBySource.set(task.source_id, existing);
  }

  // Prefer a newer same-class pending row when a sole legacy v7 provider retry
  // would otherwise be pinned behind an older pending row of a different class.
  // The normal supersession gate still requires a due, old retry and a resolved
  // FAILED transient target with the explicit missing-provider marker.
  for (const [sourceId, openForSource] of openBySource) {
    if (openForSource.length !== 1) continue;
    const task = openForSource[0];
    if (
      task.status.toUpperCase() !== "RETRY" ||
      task.payload.reason !== "semantic-failure-recovery-v7" ||
      (typeof task.payload.raw_record_id === "string" && task.payload.raw_record_id.trim()) ||
      typeof task.payload.classification !== "string"
    ) continue;
    const taskClass = task.payload.classification.trim().toUpperCase();
    const target = legacyFailedTargetsBySourceClass.get(`${sourceId}:${taskClass}`);
    if (!target) continue;
    const matchingPending = candidates
      .filter((raw) =>
        raw.source_id === sourceId &&
        (raw.normalization_status ?? "PENDING").toUpperCase() === "PENDING" &&
        (raw.classification ?? "").trim().toUpperCase() === taskClass
      )
      .map((raw) => ({
        id: raw.id,
        source_id: sourceId,
        classification: raw.classification,
        normalization_status: raw.normalization_status ?? "PENDING",
        fetched_at: raw.fetched_at ?? null,
      }));
    const selected = selectNewerPendingSnapshotForTransientRetry(matchingPending, task, target);
    if (selected) {
      bySource.set(sourceId, {
        classification: selected.classification ?? "UNKNOWN",
        rawRecordId: selected.id,
        normalizationStatus: selected.normalization_status ?? "PENDING",
        fetchedAt: selected.fetched_at ?? null,
      });
    }
  }

  const rows: {
    task_type: string;
    source_id: string;
    payload: Record<string, unknown>;
  }[] = [];
  for (const [sourceId, candidate] of bySource) {
    const { classification, rawRecordId } = candidate;
    plan.by_classification[classification] =
      (plan.by_classification[classification] ?? 0) + 1;
    if (rows.length >= limit) continue;

    const openForSource = openBySource.get(sourceId) ?? [];
    if (openForSource.length > 0) {
      plan.already_queued += 1;

      // Legacy generic backfill tasks intentionally meant "oldest pending
      // snapshot of this classification". When the provider circuit prevents
      // the worker from claiming them, they can block exact backfill forever.
      // Pin only a sole QUEUED/RETRY legacy task to the same-source, same-class
      // PENDING snapshot already selected oldest-first above. Semantic-failure
      // recovery tasks target FAILED snapshots and must never be pinned here.
      if (openForSource.length === 1) {
        const legacyTask = openForSource[0];
        if (canPinLegacyNormalizationTaskToPendingSnapshot(legacyTask, {
          source_id: sourceId,
          classification,
          normalization_status: candidate.normalizationStatus,
        })) {
          const pinnedPayload = { ...legacyTask.payload, raw_record_id: rawRecordId };
          const { data: pinnedTask, error: pinError } = await supabaseAdmin
            .from("ingestion_tasks")
            .update({ payload: pinnedPayload })
            .eq("id", legacyTask.id)
            .eq("source_id", sourceId)
            .in("status", ["QUEUED", "RETRY"])
            .select("id")
            .maybeSingle();
          assertBackfillDbSuccess(`pin legacy normalization task ${legacyTask.id} to exact raw snapshot`, pinError);
          if (pinnedTask) {
            legacyTask.payload = pinnedPayload;
            rawTargetsById.set(rawRecordId, {
              id: rawRecordId,
              source_id: sourceId,
              classification,
              normalization_status: candidate.normalizationStatus,
              normalization_error: null,
              fetched_at: candidate.fetchedAt,
            });
            plan.legacy_tasks_pinned += 1;
          }
        }
      }

      // A long-waiting provider-outage retry can otherwise occupy this source's
      // only task slot indefinitely and prevent a newer pending snapshot from
      // being processed first. Retire it only when every open task for the source
      // is an exact RETRY of an older same-class FAILED snapshot with the explicit
      // missing-provider marker. The raw FAILED row is not modified and remains
      // eligible for backfill after the pending snapshot drains.
      const supersedableRetries = openForSource.filter((task) => {
        const targetId = typeof task.payload.raw_record_id === "string"
          ? task.payload.raw_record_id
          : "";
        const legacyClass = typeof task.payload.classification === "string"
          ? task.payload.classification.trim().toUpperCase()
          : "";
        const target = targetId
          ? rawTargetsById.get(targetId)
          : task.payload.reason === "semantic-failure-recovery-v7"
            ? legacyFailedTargetsBySourceClass.get(`${task.source_id}:${legacyClass}`)
            : null;
        return shouldSupersedeTransientRetryForNewerPendingSnapshot(
          task,
          target,
          {
            source_id: sourceId,
            classification,
            normalization_status: candidate.normalizationStatus,
            fetched_at: candidate.fetchedAt,
          },
        );
      });
      if (supersedableRetries.length > 0 && supersedableRetries.length === openForSource.length) {
        const supersededAt = new Date().toISOString();
        let supersededAll = true;
        for (const task of supersedableRetries) {
          const explicitFailedRawId = typeof task.payload.raw_record_id === "string"
            ? task.payload.raw_record_id
            : "";
          const legacyClass = typeof task.payload.classification === "string"
            ? task.payload.classification.trim().toUpperCase()
            : "";
          const failedRawId = explicitFailedRawId || legacyFailedTargetsBySourceClass.get(`${task.source_id}:${legacyClass}`)?.id;
          if (!failedRawId) {
            supersededAll = false;
            break;
          }
          const { data: supersededTask, error: supersedeError } = await supabaseAdmin
            .from("ingestion_tasks")
            .update({
              status: "DEAD",
              completed_at: supersededAt,
              started_at: null,
              updated_at: supersededAt,
              last_error: `SUPERSEDED_TRANSIENT_RETRY_BY_NEWER_PENDING_SNAPSHOT: retained failed raw snapshot ${failedRawId}; newer pending snapshot ${rawRecordId} takes the source slot`,
              payload: {
                ...task.payload,
                superseded_by_raw_record_id: rawRecordId,
                superseded_failed_raw_record_id: failedRawId,
                superseded_reason: "older_transient_failed_snapshot_deferred_for_newer_pending",
              },
            })
            .eq("id", task.id)
            .eq("source_id", sourceId)
            .eq("status", "RETRY")
            .eq("updated_at", task.updated_at)
            .select("id")
            .maybeSingle();
          assertBackfillDbSuccess(`supersede old transient retry ${task.id}`, supersedeError);
          if (!supersededTask) {
            supersededAll = false;
            break;
          }
          plan.transient_retries_superseded += 1;
        }
        if (!supersededAll) {
          plan.deferred_by_source += 1;
          continue;
        }
        plan.already_queued = Math.max(0, plan.already_queued - 1);
        rows.push({
          task_type: "NORMALIZE",
          source_id: sourceId,
          payload: {
            backfill: true,
            classification,
            raw_record_id: rawRecordId,
            ...(classification === "RESEARCH_NEWS" ? { deterministic_cleanup: true } : {}),
          },
        });
        continue;
      }

      const staleReasons = openForSource.map((task) => ({
        task,
        reason: staleNormalizationTargetReason(
          task,
          typeof task.payload.raw_record_id === "string"
            ? rawTargetsById.get(task.payload.raw_record_id)
            : null,
        ),
      }));
      const exactSnapshotStillOpen = staleReasons.some(({ task, reason }) =>
        reason === null && task.payload.raw_record_id === rawRecordId
      );
      if (exactSnapshotStillOpen) {
        plan.exact_snapshot_queued += 1;
        continue;
      }

      // Do not let an obsolete QUEUED/RETRY task block the one-task-per-source
      // slot forever. Retire only when every open task for this source has an
      // explicit target proven terminal/missing/mismatched; PROCESSING, legacy,
      // PENDING and FAILED targets remain blockers. The status CAS prevents
      // racing a worker that has already claimed one of these tasks.
      if (staleReasons.some(({ reason }) => reason === null)) {
        plan.deferred_by_source += 1;
        continue;
      }

      const retiredAt = new Date().toISOString();
      let retiredAll = true;
      for (const { task, reason } of staleReasons) {
        if (!reason) {
          retiredAll = false;
          break;
        }
        const { data: retiredTask, error: retireError } = await supabaseAdmin
          .from("ingestion_tasks")
          .update({
            status: "DEAD",
            completed_at: retiredAt,
            started_at: null,
            updated_at: retiredAt,
            last_error: `SUPERSEDED_STALE_RAW_TARGET: ${reason}; replacement pending snapshot ${rawRecordId}`,
            payload: {
              ...task.payload,
              superseded_by_raw_record_id: rawRecordId,
              superseded_reason: reason,
            },
          })
          .eq("id", task.id)
          .in("status", ["QUEUED", "RETRY"])
          .select("id")
          .maybeSingle();
        assertBackfillDbSuccess(`retire stale normalization task ${task.id}`, retireError);
        if (!retiredTask) {
          retiredAll = false;
          break;
        }
        plan.stale_tasks_retired += 1;
      }
      if (!retiredAll) {
        plan.deferred_by_source += 1;
        continue;
      }
    }

    rows.push({
      task_type: "NORMALIZE",
      source_id: sourceId,
      payload: {
        backfill: true,
        classification,
        raw_record_id: rawRecordId,
        ...(classification === "RESEARCH_NEWS" ? { deterministic_cleanup: true } : {}),
      },
    });
  }

  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await supabaseAdmin
      .from("ingestion_tasks")
      .insert(chunk as never);
    assertBackfillDbSuccess(`insert normalization task batch ${Math.floor(i / 100) + 1}`, error);
    plan.queued += chunk.length;
  }
  return plan;
}

export type ProviderPlan = {
  promote_queued: number;
  publications_queued: number;
  projects_queued: number;
};

/**
 * Enqueues structured-provider work: institution identity reconciliation via ROR, OpenAIRE project/publication import,
 * and Crossref publication fallback.
 */
export async function enqueueProviderBackfill(
  limit = 120,
): Promise<ProviderPlan> {
  const out: ProviderPlan = {
    promote_queued: 0,
    publications_queued: 0,
    projects_queued: 0,
  };

  const openTasksResult = await supabaseAdmin
    .from("ingestion_tasks")
    .select("task_type, institution_id")
    .in("task_type", [
      "PROMOTE_INSTITUTION",
      "IMPORT_PUBLICATIONS",
      "IMPORT_PROJECTS",
    ])
    .in("status", ["QUEUED", "PROCESSING", "RETRY"]);
  assertBackfillDbSuccess("inspect open structured-provider tasks", openTasksResult.error);

  const recentTerminalTasks = await supabaseAdmin
    .from("ingestion_tasks")
    .select("task_type, institution_id")
    .in("task_type", [
      "PROMOTE_INSTITUTION",
      "IMPORT_PUBLICATIONS",
      "IMPORT_PROJECTS",
    ])
    .in("status", ["COMPLETE", "DEAD"])
    .gte("updated_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  assertBackfillDbSuccess("inspect recently handled structured-provider tasks", recentTerminalTasks.error);

  // Do not repeatedly enqueue the same provider import every 15-minute tick.
  // A completed or exhausted task is considered recently handled for seven
  // days; queued/retry/processing tasks remain protected by openKey.
  const openKey = new Set([
    ...(openTasksResult.data ?? []).map((t) => `${t.task_type}:${t.institution_id}`),
    ...((recentTerminalTasks.data ?? []).map((t) => `${t.task_type}:${t.institution_id}`)),
  ]);

  const institutionsResult = await supabaseAdmin
    .from("institutions")
    .select("id, name, institution_identifier, is_demo")
    .order("is_demo", { ascending: false })
    .limit(500);
  assertBackfillDbSuccess("list institutions for structured-provider backfill", institutionsResult.error);
  const institutions = institutionsResult.data ?? [];

  const rows: {
    task_type: string;
    institution_id: string;
    payload: Record<string, unknown>;
  }[] = [];
  const hasRor = (value: string | null) =>
    /^(?:https?:\/\/ror\.org\/)?0[a-z0-9]{8}$/i.test((value ?? "").trim());

  for (const inst of institutions ?? []) {
    if (rows.length >= limit) break;

    // Provider imports are only allowed after the institution has a verified ROR
    // identity and is no longer a demo row. Promotion is the gate that establishes
    // that identity. Successful promotion queues the downstream imports itself.
    const providerReady = hasRor(inst.institution_identifier) && !inst.is_demo;
    if (!providerReady) {
      if (!openKey.has(`PROMOTE_INSTITUTION:${inst.id}`)) {
        rows.push({
          task_type: "PROMOTE_INSTITUTION",
          institution_id: inst.id,
          payload: { backfill: true },
        });
        out.promote_queued += 1;
      }
      continue;
    }

    if (
      !openKey.has(`IMPORT_PUBLICATIONS:${inst.id}`) &&
      rows.length < limit
    ) {
      rows.push({
        task_type: "IMPORT_PUBLICATIONS",
        institution_id: inst.id,
        payload: { backfill: true },
      });
      out.publications_queued += 1;
    }
    if (!openKey.has(`IMPORT_PROJECTS:${inst.id}`) && rows.length < limit) {
      rows.push({
        task_type: "IMPORT_PROJECTS",
        institution_id: inst.id,
        payload: { backfill: true },
      });
      out.projects_queued += 1;
    }
  }

  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabaseAdmin
      .from("ingestion_tasks")
      .insert(rows.slice(i, i + 100) as never);
    assertBackfillDbSuccess(`insert structured-provider task batch ${Math.floor(i / 100) + 1}`, error);
  }
  return out;
}
