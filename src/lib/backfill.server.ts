// One-time backfill planner: turns ALREADY STORED raw pages and existing
// institution rows into queued work. Nothing here fetches the web, and nothing
// here calls a model — it only enqueues tasks that the deployed autonomous
// drain loop processes with the existing gates, cache and validators.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
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
    by_classification: {},
  };

  const rawFields =
    "id, source_id, classification, normalization_status, normalization_error, fetched_at";

  // Query pending rows independently and oldest-first. Previously we took the
  // newest 2,000 raw records and only then filtered in memory; a steady stream of
  // newer records could permanently hide older PENDING rows from backfill.
  const [pendingResult, retryableResult] = await Promise.all([
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
  ]);
  if (pendingResult.error) throw pendingResult.error;
  if (retryableResult.error) throw retryableResult.error;
  const raws = [...(pendingResult.data ?? []), ...(retryableResult.data ?? [])];

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
  const bySource = new Map<string, { classification: string; rawRecordId: string }>();
  for (const r of candidates) {
    if (!bySource.has(r.source_id as string)) {
      bySource.set(r.source_id as string, {
        classification: r.classification ?? "UNKNOWN",
        rawRecordId: r.id,
      });
    }
  }
  plan.raw_candidates = bySource.size;

  const { data: openTasks } = await supabaseAdmin
    .from("ingestion_tasks")
    .select("source_id")
    .eq("task_type", "NORMALIZE")
    .in("status", ["QUEUED", "PROCESSING", "RETRY"]);
  const open = new Set(
    (openTasks ?? []).map((t) => t.source_id).filter(Boolean) as string[],
  );

  const rows: {
    task_type: string;
    source_id: string;
    payload: Record<string, unknown>;
  }[] = [];
  for (const [sourceId, candidate] of bySource) {
    const { classification, rawRecordId } = candidate;
    plan.by_classification[classification] =
      (plan.by_classification[classification] ?? 0) + 1;
    if (open.has(sourceId)) {
      plan.already_queued += 1;
      continue;
    }
    if (rows.length >= limit) continue;
    rows.push({
      task_type: "NORMALIZE",
      source_id: sourceId,
      payload: { backfill: true, classification, raw_record_id: rawRecordId },
    });
  }

  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await supabaseAdmin
      .from("ingestion_tasks")
      .insert(chunk as never);
    if (!error) plan.queued += chunk.length;
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

  const { data: openTasks } = await supabaseAdmin
    .from("ingestion_tasks")
    .select("task_type, institution_id")
    .in("task_type", [
      "PROMOTE_INSTITUTION",
      "IMPORT_PUBLICATIONS",
      "IMPORT_PROJECTS",
    ])
    .in("status", ["QUEUED", "PROCESSING", "RETRY"]);
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

  // Do not repeatedly enqueue the same provider import every 15-minute tick.
  // A completed or exhausted task is considered recently handled for seven
  // days; queued/retry/processing tasks remain protected by openKey.
  const openKey = new Set([
    ...(openTasks ?? []).map((t) => `${t.task_type}:${t.institution_id}`),
    ...((recentTerminalTasks.data ?? []).map((t) => `${t.task_type}:${t.institution_id}`)),
  ]);

  const { data: institutions } = await supabaseAdmin
    .from("institutions")
    .select("id, name, institution_identifier, is_demo")
    .order("is_demo", { ascending: false })
    .limit(500);

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
    await supabaseAdmin
      .from("ingestion_tasks")
      .insert(rows.slice(i, i + 100) as never);
  }
  return out;
}
