import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { effectiveSourceRefreshHours, isSourceRefreshDue } from "./source-refresh-policy";

export type StageCounts = {
  sources_total: number;
  sources_pending: number;
  sources_fetched: number;
  sources_failed: number;
  sources_blocked: number;
  raw_total: number;
  raw_classified: number;
  raw_normalized: number;
  raw_skipped: number;
  raw_failed: number;
  tasks_queued: number;
  tasks_retry: number;
  tasks_dead: number;
  tasks_complete: number;
  canonical_opportunities_real: number;
  canonical_opportunities_demo: number;
  canonical_institutions_real: number;
  canonical_institutions_demo: number;
  canonical_projects_real: number;
  canonical_researchers_real: number;
  canonical_events_real: number;
  canonical_courses_real: number;
  canonical_publications_real: number;
  canonical_total_real: number;
  changes_total: number;
};

export type PipelineHealth = {
  env: { supabase_url: string; project_id: string };
  counts: StageCounts;
  bottleneck: { stage: string; reason: string };
  recent_runs: {
    id: string;
    adapter_key: string;
    success: boolean | null;
    started_at: string;
    response_time_ms: number | null;
    error_message: string | null;
  }[];
  recent_raw: {
    id: string;
    final_url: string | null;
    page_title: string | null;
    classification: string | null;
    classification_confidence: number | null;
    normalization_status: string | null;
    normalization_error: string | null;
    fetched_at: string;
  }[];
  failing_sources: {
    id: string;
    url: string;
    status: string | null;
    last_http_status: number | null;
    last_error: string | null;
  }[];
  classification_breakdown: { classification: string; count: number }[];
};

/** Internal operational data: admin session required, enforced server-side. */
export const getPipelineHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PipelineHealth> => {
    await assertAdmin(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    type AnyQuery = {
      select: (c: string, o: unknown) => AnyQuery;
      eq: (c: string, v: unknown) => AnyQuery;
      not: (c: string, op: string, v: unknown) => AnyQuery;
    };

    const count = async (
      table: string,
      filter?: { col: string; value?: unknown; notNull?: boolean },
    ): Promise<number> => {
      let query = (supabaseAdmin.from(table as never) as unknown as AnyQuery).select("id", {
        count: "exact",
        head: true,
      });
      if (filter?.notNull) query = query.not(filter.col, "is", null);
      else if (filter) query = query.eq(filter.col, filter.value);
      const { count: c, error } = (await (query as unknown as Promise<{
        count: number | null;
        error: unknown;
      }>)) as {
        count: number | null;
        error: unknown;
      };
      if (error) return 0;
      return c ?? 0;
    };

    const [
      sources_total,
      sources_pending,
      sources_fetched,
      sources_failed,
      sources_blocked,
      raw_total,
      raw_classified,
      raw_normalized,
      raw_skipped,
      raw_failed,
      tasks_queued,
      tasks_retry,
      tasks_dead,
      tasks_complete,
      canonical_opportunities_real,
      canonical_opportunities_demo,
      canonical_institutions_real,
      canonical_institutions_demo,
      canonical_projects_real,
      canonical_researchers_real,
      canonical_events_real,
      canonical_courses_real,
      canonical_publications_real,
      changes_total,
    ] = await Promise.all([
      count("sources"),
      count("sources", { col: "status", value: "PENDING" }),
      count("sources", { col: "status", value: "FETCHED" }),
      count("sources", { col: "status", value: "FAILED" }),
      count("sources", { col: "status", value: "BLOCKED" }),
      count("raw_records"),
      count("raw_records", { col: "classification", notNull: true }),
      count("raw_records", { col: "normalization_status", value: "NORMALIZED" }),
      count("raw_records", { col: "normalization_status", value: "SKIPPED" }),
      count("raw_records", { col: "normalization_status", value: "FAILED" }),
      count("ingestion_tasks", { col: "status", value: "QUEUED" }),
      count("ingestion_tasks", { col: "status", value: "RETRY" }),
      count("ingestion_tasks", { col: "status", value: "DEAD" }),
      count("ingestion_tasks", { col: "status", value: "COMPLETE" }),
      count("opportunities", { col: "is_demo", value: false }),
      count("opportunities", { col: "is_demo", value: true }),
      count("institutions", { col: "is_demo", value: false }),
      count("institutions", { col: "is_demo", value: true }),
      count("projects", { col: "is_demo", value: false }),
      count("researchers", { col: "is_demo", value: false }),
      count("events", { col: "is_demo", value: false }),
      count("courses", { col: "is_demo", value: false }),
      count("publications", { col: "is_demo", value: false }),
      count("academic_changes"),
    ]);

    const canonical_total_real =
      canonical_opportunities_real +
      canonical_institutions_real +
      canonical_projects_real +
      canonical_researchers_real +
      canonical_events_real +
      canonical_courses_real +
      canonical_publications_real;

    const counts: StageCounts = {
      sources_total,
      sources_pending,
      sources_fetched,
      sources_failed,
      sources_blocked,
      raw_total,
      raw_classified,
      raw_normalized,
      raw_skipped,
      raw_failed,
      tasks_queued,
      tasks_retry,
      tasks_dead,
      tasks_complete,
      canonical_opportunities_real,
      canonical_opportunities_demo,
      canonical_institutions_real,
      canonical_institutions_demo,
      canonical_projects_real,
      canonical_researchers_real,
      canonical_events_real,
      canonical_courses_real,
      canonical_publications_real,
      canonical_total_real,
      changes_total,
    };

    const bottleneck = (() => {
      if (sources_total === 0)
        return { stage: "DISCOVERY", reason: "No sources registered — discovery has never run." };
      if (raw_total === 0)
        return { stage: "FETCH", reason: "Sources exist but nothing has been fetched yet." };
      if (raw_classified === 0)
        return { stage: "CLASSIFY", reason: "Raw pages stored but none classified." };
      if (raw_normalized === 0)
        return {
          stage: "NORMALIZE",
          reason: "Pages are classified but no canonical record has been extracted yet.",
        };
      if (canonical_total_real === 0)
        return {
          stage: "CANONICAL",
          reason: "Normalization ran but no source-backed canonical record exists.",
        };
      if (tasks_retry > 0 || sources_failed > 0)
        return {
          stage: "DEGRADED",
          reason: `${tasks_retry} active retrying tasks and ${sources_failed} failed sources need attention. ${tasks_dead} terminal dead tasks and ${sources_blocked} blocked sources are retained as diagnostics.`,
        };
      return {
        stage: "HEALTHY",
        reason: `Active processing is clear. ${tasks_dead} terminal dead tasks and ${sources_blocked} blocked sources are retained as diagnostics and do not hold the live queue open.`,
      };
    })();

    const [runs, raws, failing, classes] = await Promise.all([
      supabaseAdmin
        .from("sync_runs")
        .select("id, adapter_key, success, started_at, response_time_ms, error_message")
        .order("started_at", { ascending: false })
        .limit(15),
      supabaseAdmin
        .from("raw_records")
        .select(
          "id, final_url, page_title, classification, classification_confidence, normalization_status, normalization_error, fetched_at",
        )
        .order("fetched_at", { ascending: false })
        .limit(20),
      supabaseAdmin
        .from("sources")
        .select("id, url, status, last_http_status, last_error")
        .in("status", ["FAILED", "BLOCKED"])
        .order("updated_at", { ascending: false })
        .limit(15),
      supabaseAdmin.from("raw_records").select("classification").limit(1000),
    ]);

    const breakdown = new Map<string, number>();
    for (const row of classes.data ?? []) {
      const key = row.classification ?? "UNCLASSIFIED";
      breakdown.set(key, (breakdown.get(key) ?? 0) + 1);
    }

    return {
      env: {
        supabase_url: process.env["SUPABASE_URL"] ?? "missing",
        project_id: process.env["SUPABASE_PROJECT_ID"] ?? "missing",
      },
      counts,
      bottleneck,
      recent_runs: (runs.data ?? []) as PipelineHealth["recent_runs"],
      recent_raw: (raws.data ?? []) as PipelineHealth["recent_raw"],
      failing_sources: (failing.data ?? []) as PipelineHealth["failing_sources"],
      classification_breakdown: Array.from(breakdown.entries())
        .map(([classification, c]) => ({ classification, count: c }))
        .sort((a, b) => b.count - a.count),
    };
  });

async function assertAdmin(context: { userId: string }) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("user_id", context.userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error || !data) throw new Error("Forbidden: admin role required");
}

export const runDiscovery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { institutionSlug: string }) => input)
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { discoverInstitutionSources } = await import("./ingest.server");
    const { data: inst, error } = await supabaseAdmin
      .from("institutions")
      .select("id")
      .eq("slug", data.institutionSlug)
      .maybeSingle();
    if (error) throw error;
    if (!inst) throw new Error(`No institution with slug ${data.institutionSlug}`);
    return await discoverInstitutionSources(inst.id);
  });

export const runQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { limit?: number }) => input)
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    const { runQueueBatch } = await import("./ingest.server");
    const limit = Math.min(20, Math.max(1, data.limit ?? 8));
    const normalize = await runQueueBatch(Math.min(8, limit), ["NORMALIZE"], 2);
    if (normalize.processed > 0) return { ...normalize, task_group: "NORMALIZE" as const };
    const collection = await runQueueBatch(limit, ["FETCH", "DISCOVER"]);
    return { ...collection, task_group: "FETCH_DISCOVER" as const };
  });

export const requeueDeadTasks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error, count } = await supabaseAdmin
      .from("ingestion_tasks")
      .update(
        { status: "QUEUED", attempts: 0, run_after: new Date().toISOString(), last_error: null },
        { count: "exact" },
      )
      .in("status", ["DEAD", "RETRY"]);
    if (error) throw error;
    return { requeued: count ?? 0 };
  });

export type SchedulerJob = {
  jobname: string;
  schedule: string;
  active: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_message: string | null;
  runs_24h: number;
};

export type SchedulerHealth = {
  jobs: SchedulerJob[];
  recent_ticks: {
    id: string;
    trigger: string;
    started_at: string;
    duration_ms: number | null;
    tasks_processed: number;
    tasks_ok: number;
    tasks_failed: number;
    nvidia_calls: number;
    nvidia_cached: number;
    error_message: string | null;
  }[];
};

/** Proof that autonomous processing is running: cron jobs + recorded ticks. */
export const getSchedulerHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SchedulerHealth> => {
    await assertAdmin({ userId: context.userId });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: jobs } = await supabaseAdmin.rpc("scheduler_status");
    const { data: ticks } = await supabaseAdmin
      .from("pipeline_runs")
      .select(
        "id, trigger, started_at, duration_ms, tasks_processed, tasks_ok, tasks_failed, nvidia_calls, nvidia_cached, error_message",
      )
      .order("started_at", { ascending: false })
      .limit(10);

    return {
      jobs: (Array.isArray(jobs) ? jobs : []) as SchedulerJob[],
      recent_ticks: (ticks ?? []) as SchedulerHealth["recent_ticks"],
    };
  });

export type OperationsSummary = {
  mode: "BACKLOG" | "STEADY_STATE";
  due_tasks: number;
  pending_tasks: number;
  batch_size: number;
  interval_minutes: number;
  config: {
    backlog_threshold: number;
    backlog_batch_size: number;
    steady_batch_size: number;
    backlog_interval_minutes: number;
    steady_interval_minutes: number;
    refresh_hours: Record<string, number>;
    discovery_days: number;
    adaptive_backoff_max: number;
  };
  categories: {
    category: string;
    label: string;
    refresh_hours: number;
    sources: number;
    due_now: number;
  }[];
  efficiency: {
    window_hours: number;
    fetches: number;
    fetches_unchanged: number;
    deterministic_rejects: number;
    normalized: number;
    model_calls: number;
    model_cached: number;
    cache_hit_rate: number;
    unchanged_rate: number;
    ticks: number;
    ticks_with_work: number;
  };
};

/** Operating mode, per-category cadence and cost-avoidance metrics. Admin only. */
export const getOperationsSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<OperationsSummary> => {
    await assertAdmin(context as never);
    const {
      loadSchedule,
      readQueueState,
      readEfficiencyMetrics,
      refreshHoursFor,
      CATEGORY_LABELS,
    } = await import("./schedule.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const config = await loadSchedule();
    const [state, efficiency] = await Promise.all([
      readQueueState(config),
      readEfficiencyMetrics(24),
    ]);

    // Supabase's default row cap is lower than the live source registry. Page
    // deterministically so the admin freshness summary counts every active source.
    const sourceRows: {
      category: string | null;
      last_success_at: string | null;
      refresh_frequency_hours: number | null;
      status: string | null;
    }[] = [];
    const sourcePageSize = 1000;
    for (let offset = 0; ; offset += sourcePageSize) {
      const { data, error } = await supabaseAdmin
        .from("sources")
        .select("category, last_success_at, refresh_frequency_hours, status")
        .eq("active", true)
        .order("id", { ascending: true })
        .range(offset, offset + sourcePageSize - 1);
      if (error) throw error;
      const page = data ?? [];
      sourceRows.push(...page);
      if (page.length < sourcePageSize) break;
    }

    const now = Date.now();
    const categories = CATEGORY_LABELS.map(({ category, label }) => {
      const hours = refreshHoursFor(config, category);
      const rows = sourceRows.filter((s) => (s.category ?? "default") === category);
      const due = rows.filter((s) => {
        if (s.status === "BLOCKED") return false;
        const effectiveHours = effectiveSourceRefreshHours(
          hours,
          s.refresh_frequency_hours,
          config.adaptive_backoff_max,
        );
        return isSourceRefreshDue(s.last_success_at, effectiveHours, now);
      }).length;
      return { category, label, refresh_hours: hours, sources: rows.length, due_now: due };
    });

    return { ...state, config, categories, efficiency };
  });

/** Lets an admin retune cadence without a code change. */
export const updateScheduleConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: Partial<OperationsSummary["config"]>) => input)
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    const { saveSchedule } = await import("./schedule.server");
    return await saveSchedule(data as never, context.userId);
  });

export type RealDataMigration = {
  raw_pages: number;
  raw_processed: number;
  raw_pending: number;
  candidates: {
    label: string;
    classification: string;
    candidates: number;
    created_real: number;
    demo_remaining: number;
  }[];
  publications: { provider_backed: number; demo_remaining: number };
  institutions: {
    total: number;
    source_backed: number;
    demo_remaining: number;
    with_ror_identity: number;
  };
  queue: {
    normalize_open: number;
    promote_open: number;
    publications_open: number;
    projects_open: number;
  };
  model: { calls: number; cache_hits: number; validation_rejects: number };
  manual_review: number;
};

/** REAL DATA MIGRATION progress — every number is a live database count. */
export const getRealDataMigration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RealDataMigration> => {
    await assertAdmin(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    type Q = {
      select: (c: string, o?: unknown) => Q;
      eq: (c: string, v: unknown) => Q;
      in: (c: string, v: unknown[]) => Q;
      not: (c: string, o: string, v: unknown) => Q;
    };
    const run = async (build: (q: Q) => Q, table: string): Promise<number> => {
      const q = build(
        (supabaseAdmin.from(table as never) as unknown as Q).select("id", {
          count: "exact",
          head: true,
        }),
      );
      const { count } = (await (q as unknown as Promise<{ count: number | null }>)) as {
        count: number | null;
      };
      return count ?? 0;
    };

    const rawByClass = async (classification: string) =>
      run((q) => q.eq("classification", classification), "raw_records");
    const realRows = async (table: string) => run((q) => q.eq("is_demo", false), table);
    const demoRows = async (table: string) => run((q) => q.eq("is_demo", true), table);

    const [
      raw_pages,
      raw_processed,
      raw_pending,
      candProject,
      candResearcher,
      candEvent,
      candProgramme,
      candCourse,
      candVacancy,
      realProjects,
      demoProjects,
      realResearchers,
      demoResearchers,
      realEvents,
      demoEvents,
      realCourses,
      demoCourses,
      realOpps,
      demoOpps,
      pubsProvider,
      pubsDemo,
      instTotal,
      instReal,
      instDemo,
      normalizeOpen,
      promoteOpen,
      publicationsOpen,
      projectsOpen,
      modelCalls,
      modelCached,
      validationRejects,
      reviewDupes,
      reviewNeeds,
    ] = await Promise.all([
      run((q) => q, "raw_records"),
      run((q) => q.eq("normalization_status", "NORMALIZED"), "raw_records"),
      run((q) => q.eq("normalization_status", "PENDING"), "raw_records"),
      rawByClass("PROJECT"),
      rawByClass("RESEARCHER"),
      rawByClass("EVENT"),
      rawByClass("PROGRAMME"),
      rawByClass("COURSE"),
      rawByClass("VACANCY"),
      realRows("projects"),
      demoRows("projects"),
      realRows("researchers"),
      demoRows("researchers"),
      realRows("events"),
      demoRows("events"),
      realRows("courses"),
      demoRows("courses"),
      realRows("opportunities"),
      demoRows("opportunities"),
      run((q) => q.not("external_id", "is", null).eq("is_demo", false), "publications"),
      demoRows("publications"),
      run((q) => q, "institutions"),
      realRows("institutions"),
      demoRows("institutions"),
      run(
        (q) => q.eq("task_type", "NORMALIZE").in("status", ["QUEUED", "RETRY", "PROCESSING"]),
        "ingestion_tasks",
      ),
      run(
        (q) =>
          q.eq("task_type", "PROMOTE_INSTITUTION").in("status", ["QUEUED", "RETRY", "PROCESSING"]),
        "ingestion_tasks",
      ),
      run(
        (q) =>
          q.eq("task_type", "IMPORT_PUBLICATIONS").in("status", ["QUEUED", "RETRY", "PROCESSING"]),
        "ingestion_tasks",
      ),
      run(
        (q) => q.eq("task_type", "IMPORT_PROJECTS").in("status", ["QUEUED", "RETRY", "PROCESSING"]),
        "ingestion_tasks",
      ),
      run((q) => q, "llm_processing_runs"),
      run((q) => q.eq("cached", true), "llm_processing_runs"),
      run((q) => q.eq("status", "VALIDATION_FAILED"), "llm_processing_runs"),
      run((q) => q.eq("resolved", false), "duplicate_candidates"),
      run((q) => q.eq("verification_status", "needs_review"), "opportunities"),
    ]);

    const { data: identityRows } = await supabaseAdmin
      .from("institutions")
      .select("institution_identifier")
      .not("institution_identifier", "is", null)
      .limit(1000);
    const instIdentity = (identityRows ?? []).filter((row) =>
      /^(?:https?:\/\/ror\.org\/)?0[a-z0-9]{8}$/i.test((row.institution_identifier ?? "").trim()),
    ).length;

    return {
      raw_pages,
      raw_processed,
      raw_pending,
      candidates: [
        {
          label: "Research projects",
          classification: "PROJECT",
          candidates: candProject,
          created_real: realProjects,
          demo_remaining: demoProjects,
        },
        {
          label: "Researcher profiles",
          classification: "RESEARCHER",
          candidates: candResearcher,
          created_real: realResearchers,
          demo_remaining: demoResearchers,
        },
        {
          label: "Academic events",
          classification: "EVENT",
          candidates: candEvent,
          created_real: realEvents,
          demo_remaining: demoEvents,
        },
        {
          label: "Programmes / courses",
          classification: "PROGRAMME+COURSE",
          candidates: candProgramme + candCourse,
          created_real: realCourses,
          demo_remaining: demoCourses,
        },
        {
          label: "Positions / vacancies",
          classification: "VACANCY",
          candidates: candVacancy,
          created_real: realOpps,
          demo_remaining: demoOpps,
        },
      ],
      publications: { provider_backed: pubsProvider, demo_remaining: pubsDemo },
      institutions: {
        total: instTotal,
        source_backed: instReal,
        demo_remaining: instDemo,
        with_ror_identity: instIdentity,
      },
      queue: {
        normalize_open: normalizeOpen,
        promote_open: promoteOpen,
        publications_open: publicationsOpen,
        projects_open: projectsOpen,
      },
      model: { calls: modelCalls, cache_hits: modelCached, validation_rejects: validationRejects },
      manual_review: reviewDupes + reviewNeeds,
    };
  });

/** Enqueues the one-time backfill of already-stored pages + provider imports. */
export const startRealDataBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as never);
    const { enqueueRawBackfill, enqueueProviderBackfill } = await import("./backfill.server");
    const raw = await enqueueRawBackfill(400);
    const providers = await enqueueProviderBackfill(120);
    return { raw, providers };
  });

/** Whether the current signed-in user holds the admin role. Never returns tokens. */
export const getAdminStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ isAdmin: boolean; adminExists: boolean }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("user_roles")
      .select("id")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    const { count } = await supabaseAdmin
      .from("user_roles")
      .select("user_id", { count: "exact", head: true })
      .eq("role", "admin");
    return { isAdmin: Boolean(data), adminExists: (count ?? 0) > 0 };
  });

/** One-time bootstrap, restricted to an explicitly configured operator email. */
export const claimAdminRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ isAdmin: boolean }> => {
    const allowed = (process.env["ADMIN_BOOTSTRAP_EMAILS"] ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const email = typeof context.claims.email === "string" ? context.claims.email.toLowerCase() : "";
    if (allowed.length === 0) {
      throw new Error("Admin bootstrap is disabled until ADMIN_BOOTSTRAP_EMAILS is configured");
    }
    if (!email || !allowed.includes(email)) {
      throw new Error("This account is not allowed to claim the admin role");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.rpc("claim_admin_if_unclaimed", {
      target_user_id: context.userId,
    });
    if (error) throw new Error(error.message);
    return { isAdmin: data === true };
  });
