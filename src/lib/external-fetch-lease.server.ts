import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isUnleaseableFetchSource } from "@/lib/fetch-failure-policy";

export type ExternalFetchLease = {
  task_id: string;
  source_id: string;
  lease_started_at: string;
  url: string;
  adapter_key: string;
  category: string;
  institution_id: string | null;
  refresh_frequency_hours: number | null;
  attempt: number;
  max_attempts: number;
};

/**
 * Terminalize only old, due FETCH tasks that the lease RPC can never claim.
 * This preserves source/raw history while preventing blocked or disabled
 * sources from leaving permanent QUEUED/RETRY rows in front of eligible work.
 * The 24-hour grace period avoids racing recently disabled sources.
 */
async function terminalizeUnleaseableFetchTasks(): Promise<number> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { data: candidates, error: taskError } = await supabaseAdmin
    .from("ingestion_tasks")
    .select("id, source_id")
    .eq("task_type", "FETCH")
    .in("status", ["QUEUED", "RETRY"])
    .lte("run_after", staleCutoff)
    .order("run_after", { ascending: true })
    .limit(1000);
  if (taskError) throw taskError;
  if (!candidates?.length) return 0;

  const sourceIds = [...new Set(
    candidates.map((task) => task.source_id).filter((id): id is string => Boolean(id)),
  )];
  const sourceById = new Map<string, { active: boolean | null; status: string | null }>();
  if (sourceIds.length) {
    const { data: sources, error: sourceError } = await supabaseAdmin
      .from("sources")
      .select("id, active, status")
      .in("id", sourceIds);
    if (sourceError) throw sourceError;
    for (const source of sources ?? []) {
      sourceById.set(source.id, { active: source.active, status: source.status });
    }
  }

  const unleaseableIds = candidates
    .filter((task) => {
      if (!task.source_id) return true;
      const source = sourceById.get(task.source_id);
      return !source || isUnleaseableFetchSource(source);
    })
    .map((task) => task.id);
  if (!unleaseableIds.length) return 0;

  const { data: terminalized, error: updateError } = await supabaseAdmin
    .from("ingestion_tasks")
    .update({
      status: "DEAD",
      started_at: null,
      last_error: "Source is inactive, blocked, or missing; stale FETCH task cannot be leased.",
      updated_at: now.toISOString(),
    })
    .in("id", unleaseableIds)
    .in("status", ["QUEUED", "RETRY"])
    .select("id");
  if (updateError) throw updateError;
  return terminalized?.length ?? 0;
}

export async function leaseExternalFetchTasks(
  limit = 8,
): Promise<ExternalFetchLease[]> {
  // Clear stale, unclaimable rows before asking the database lease RPC for work.
  await terminalizeUnleaseableFetchTasks();

  const requested = Math.min(20, Math.max(1, Math.floor(limit)));
  const { data, error } = await supabaseAdmin.rpc(
    "lease_external_fetch_tasks",
    { p_limit: requested },
  );
  if (error) throw error;
  return (data ?? []) as ExternalFetchLease[];
}
