// Server-only scheduling policy for autonomous academic monitoring.
// Everything here is deterministic: no model call is ever needed to decide
// whether a source is due or whether a deadline has passed.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type RefreshHours = Record<string, number>;

export type ScheduleConfig = {
  /** Below this many due queue tasks the system switches to STEADY_STATE. */
  backlog_threshold: number;
  backlog_batch_size: number;
  steady_batch_size: number;
  backlog_interval_minutes: number;
  steady_interval_minutes: number;
  refresh_hours: RefreshHours;
  discovery_days: number;
  /** Max multiplier applied to a source that keeps coming back unchanged. */
  adaptive_backoff_max: number;
};

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  backlog_threshold: 25,
  backlog_batch_size: 8,
  steady_batch_size: 4,
  backlog_interval_minutes: 10,
  steady_interval_minutes: 30,
  refresh_hours: {
    vacancies: 24,
    projects: 72,
    events: 72,
    programmes: 168,
    courses: 168,
    publications: 168,
    people: 720,
    department: 720,
    research_groups: 720,
    research: 720,
    default: 720,
  },
  discovery_days: 30,
  adaptive_backoff_max: 2,
};

/** Categories surfaced in the admin panel, in the order they are shown. */
export const CATEGORY_LABELS: { category: string; label: string }[] = [
  { category: "vacancies", label: "Vacancies / PhD positions" },
  { category: "projects", label: "Research projects" },
  { category: "events", label: "Academic events" },
  { category: "programmes", label: "Study programmes" },
  { category: "courses", label: "Courses" },
  { category: "publications", label: "Publications" },
  { category: "people", label: "Researcher profiles" },
  { category: "department", label: "Departments / leadership" },
  { category: "research_groups", label: "Research groups" },
  { category: "research", label: "Research pages / news" },
];

export async function loadSchedule(): Promise<ScheduleConfig> {
  const { data } = await supabaseAdmin
    .from("pipeline_settings")
    .select("value")
    .eq("key", "schedule")
    .maybeSingle();
  const stored = (data?.value ?? {}) as Partial<ScheduleConfig>;
  return {
    ...DEFAULT_SCHEDULE,
    ...stored,
    refresh_hours: { ...DEFAULT_SCHEDULE.refresh_hours, ...(stored.refresh_hours ?? {}) },
  };
}

export async function saveSchedule(
  patch: Partial<ScheduleConfig>,
  userId: string | null,
): Promise<ScheduleConfig> {
  const current = await loadSchedule();
  const next: ScheduleConfig = {
    ...current,
    ...patch,
    refresh_hours: { ...current.refresh_hours, ...(patch.refresh_hours ?? {}) },
  };
  await supabaseAdmin
    .from("pipeline_settings")
    .upsert({ key: "schedule", value: next as never, updated_by: userId } as never, {
      onConflict: "key",
    });
  return next;
}

export function refreshHoursFor(config: ScheduleConfig, category: string | null): number {
  if (!category) return config.refresh_hours["default"] ?? 720;
  return config.refresh_hours[category] ?? config.refresh_hours["default"] ?? 720;
}

export type OperatingMode = "BACKLOG" | "STEADY_STATE";

export type QueueState = {
  mode: OperatingMode;
  due_tasks: number;
  pending_tasks: number;
  batch_size: number;
  interval_minutes: number;
};

/** Cheap read used at the very start of every tick. */
export async function readQueueState(config: ScheduleConfig): Promise<QueueState> {
  const nowIso = new Date().toISOString();
  const [{ count: due }, { count: pending }] = await Promise.all([
    supabaseAdmin
      .from("ingestion_tasks")
      .select("id", { count: "exact", head: true })
      .in("status", ["QUEUED", "RETRY"])
      .in("task_type", ["DISCOVER", "FETCH", "NORMALIZE"])
      .lte("run_after", nowIso),
    supabaseAdmin
      .from("ingestion_tasks")
      .select("id", { count: "exact", head: true })
      .in("status", ["QUEUED", "RETRY"])
      .in("task_type", ["DISCOVER", "FETCH", "NORMALIZE"]),
  ]);
  const dueTasks = due ?? 0;
  const mode: OperatingMode = dueTasks >= config.backlog_threshold ? "BACKLOG" : "STEADY_STATE";
  return {
    mode,
    due_tasks: dueTasks,
    pending_tasks: pending ?? 0,
    batch_size: mode === "BACKLOG" ? config.backlog_batch_size : config.steady_batch_size,
    interval_minutes:
      mode === "BACKLOG" ? config.backlog_interval_minutes : config.steady_interval_minutes,
  };
}

/**
 * Enqueues FETCH work only for sources whose own refresh interval has elapsed.
 * A tick of the queue processor never implies a crawl — only this function
 * turns "time has passed" into fetch work.
 */
export async function enqueueDueRefreshes(
  limit = 40,
): Promise<{ queued: number; by_category: Record<string, number>; scanned: number }> {
  const config = await loadSchedule();
  const { enqueue } = await import("./ingest.server");
  const by: Record<string, number> = {};
  let queued = 0;
  let scanned = 0;

  const pageOffsets = [0, 1000, 2000, 3000, 4000];
  const sourcePages = await Promise.all(
    pageOffsets.map((offset) =>
      supabaseAdmin
        .from("sources")
        .select("id, category, institution_id, last_success_at, refresh_frequency_hours, status, active")
        .neq("status", "BLOCKED")
        .eq("active", true)
        .order("last_success_at", { ascending: true, nullsFirst: true })
        .order("id", { ascending: true })
        .range(offset, offset + 999),
    ),
  );
  for (const result of sourcePages) {
    if (result.error) throw result.error;
  }
  const sources = sourcePages.flatMap((result) => result.data ?? []);

  const pendingPages = await Promise.all(
    pageOffsets.map((offset) =>
      supabaseAdmin
        .from("ingestion_tasks")
        .select("source_id")
        .eq("task_type", "FETCH")
        .in("status", ["QUEUED", "PROCESSING", "RETRY"])
        .not("source_id", "is", null)
        .order("id", { ascending: true })
        .range(offset, offset + 999),
    ),
  );
  for (const result of pendingPages) {
    if (result.error) throw result.error;
  }
  const pendingSourceIds = new Set<string>(
    pendingPages.flatMap((result) =>
      (result.data ?? [])
        .map((task) => task.source_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const now = Date.now();
  for (const s of sources ?? []) {
    if (queued >= limit) break;
    scanned += 1;
    // Do not count already queued/in-flight/retrying fetches against this tick's
    // enqueue budget. Otherwise the same failing sources can consume all 40 slots
    // and prevent other due sources from ever entering the queue.
    if (pendingSourceIds.has(s.id)) continue;
    const base = refreshHoursFor(config, s.category);
    // A source that keeps coming back unchanged carries a larger stored
    // interval; we honour it up to the configured backoff ceiling.
    const stored = s.refresh_frequency_hours ?? base;
    const hours = Math.min(Math.max(stored, base), base * config.adaptive_backoff_max);
    const last = s.last_success_at ? new Date(s.last_success_at).getTime() : 0;
    if (last && now - last < hours * 3_600_000) continue;
    await enqueue("FETCH", { source_id: s.id, institution_id: s.institution_id ?? undefined });
    queued += 1;
    const key = s.category ?? "default";
    by[key] = (by[key] ?? 0) + 1;
  }
  return { queued, by_category: by, scanned };
}

/**
 * Deterministic deadline/status maintenance. Pure date arithmetic — the
 * intelligence engine is never consulted to learn that a date has passed.
 */
export async function sweepOpportunityDeadlines(): Promise<{
  closed: number;
  closing_soon: number;
  reopened: number;
  stale: number;
}> {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const soon = new Date(today.getTime() + 14 * 86_400_000);

  const closed = await supabaseAdmin
    .from("opportunities")
    .update(
      { status: "closed" as never, verification_status: "closed" as never },
      { count: "exact" },
    )
    .in("status", ["open", "closing_soon", "possibly_open"])
    .not("application_deadline", "is", null)
    .lt("application_deadline", iso(today));

  const closingSoon = await supabaseAdmin
    .from("opportunities")
    .update(
      { status: "closing_soon" as never },
      { count: "exact" },
    )
    .in("status", ["open", "possibly_open"])
    .not("application_deadline", "is", null)
    .gte("application_deadline", iso(today))
    .lte("application_deadline", iso(soon));

  const reopened = await supabaseAdmin
    .from("opportunities")
    .update(
      { status: "open" as never },
      { count: "exact" },
    )
    .eq("status", "closing_soon")
    .not("application_deadline", "is", null)
    .gt("application_deadline", iso(soon));

  // Date arithmetic must not pretend that a source was checked. Records whose
  // official page has not been fetched recently are explicitly downgraded.
  const staleCutoff = new Date(today.getTime() - 30 * 86_400_000).toISOString();
  const stale = await supabaseAdmin
    .from("opportunities")
    .update({ verification_status: "possibly_outdated" as never }, { count: "exact" })
    .in("status", ["open", "closing_soon", "rolling", "possibly_open"])
    .in("verification_status", ["verified", "auto_discovered", "unverified"])
    .or(`last_checked_at.is.null,last_checked_at.lt.${staleCutoff}`);

  return {
    closed: closed.count ?? 0,
    closing_soon: closingSoon.count ?? 0,
    reopened: reopened.count ?? 0,
    stale: stale.count ?? 0,
  };
}

export type EfficiencyMetrics = {
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

/** Rolling efficiency view: how much work the system avoided paying for. */
export async function readEfficiencyMetrics(windowHours = 24): Promise<EfficiencyMetrics> {
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const head = { count: "exact" as const, head: true };

  const [fetches, unchanged, rejects, normalized, llm, cached, ticks, working] = await Promise.all([
    supabaseAdmin.from("sync_runs").select("id", head).gte("started_at", since).eq("success", true),
    supabaseAdmin
      .from("sync_runs")
      .select("id", head)
      .gte("started_at", since)
      .eq("success", true)
      .eq("records_changed", 0),
    supabaseAdmin
      .from("raw_records")
      .select("id", head)
      .gte("fetched_at", since)
      .eq("normalization_status", "SKIPPED"),
    supabaseAdmin
      .from("raw_records")
      .select("id", head)
      .gte("fetched_at", since)
      .eq("normalization_status", "NORMALIZED"),
    supabaseAdmin.from("llm_processing_runs").select("id", head).gte("created_at", since),
    supabaseAdmin
      .from("llm_processing_runs")
      .select("id", head)
      .gte("created_at", since)
      .eq("cached", true),
    supabaseAdmin.from("pipeline_runs").select("id", head).gte("started_at", since),
    supabaseAdmin
      .from("pipeline_runs")
      .select("id", head)
      .gte("started_at", since)
      .gt("tasks_processed", 0),
  ]);

  const calls = llm.count ?? 0;
  const hits = cached.count ?? 0;
  const f = fetches.count ?? 0;
  const u = unchanged.count ?? 0;
  return {
    window_hours: windowHours,
    fetches: f,
    fetches_unchanged: u,
    deterministic_rejects: rejects.count ?? 0,
    normalized: normalized.count ?? 0,
    model_calls: calls,
    model_cached: hits,
    cache_hit_rate: calls === 0 ? 0 : Math.round((hits / calls) * 100),
    unchanged_rate: f === 0 ? 0 : Math.round((u / f) * 100),
    ticks: ticks.count ?? 0,
    ticks_with_work: working.count ?? 0,
  };
}
