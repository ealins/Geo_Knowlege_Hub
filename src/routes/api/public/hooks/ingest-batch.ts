import { createFileRoute } from "@tanstack/react-router";
import type { ExternalFetchCompletion, ExternalReviewCompletion } from "@/lib/ingest.server";
import { discoveryFallbackPolicy, hasProviderCircuitOpenSignal, hasProviderGatewayFailureSignal, normalizationWavePolicy, shouldRunNormalizationWave, shouldThrottleSteadyStateDrain } from "@/lib/queue-drain-policy";

type Body = {
  action?:
    | "enqueue-discovery"
    | "discover-programmes"
    | "drain"
    | "refresh-due"
    | "deadline-sweep"
    | "backfill-raw"
    | "backfill-providers"
    | "drain-providers"
    | "reseed-high-value"
    | "recover-detail-sources"
    | "recover-semantic-failures"
    | "worker-status"
    | "lease-fetch"
    | "complete-fetch"
    | "lease-review"
    | "complete-review"
    | "sync-pulse"
    | "refresh-insights";
  limit?: number;
  trigger?: string;
  model_available?: boolean;
  probe?: boolean;
  completion?: ExternalFetchCompletion | ExternalReviewCompletion;
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(label + " timed out after " + timeoutMs + "ms")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeEqual(left: string, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

/**
 * Batch ingestion driver for the institution backlog.
 * Auth: a dedicated server-only secret must be sent as a Bearer token.
 *   POST { action: "enqueue-discovery", limit } -> queues DISCOVER tasks for institutions without sources
 *   POST { action: "drain", limit }             -> processes queued FETCH/CLASSIFY/NORMALIZE work
 */
export const Route = createFileRoute("/api/public/hooks/ingest-batch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["INGESTION_HOOK_SECRET"] ?? "";
        if (!expected) {
          console.error("[ingestion-hook] INGESTION_HOOK_SECRET is not configured");
          return json({ error: "Ingestion hook is not configured" }, 503);
        }
        const authorization = request.headers.get("authorization") ?? "";
        const supplied = authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : (request.headers.get("x-ingestion-secret") ?? "");
        if (!safeEqual(supplied, expected)) {
          return json({ error: "Unauthorized" }, 401);
        }

        let body: Body = {};
        try {
          body = (await request.json()) as Body;
        } catch {
          body = {};
        }
        const action = body.action ?? "drain";
        const limit = Math.min(50, Math.max(1, body.limit ?? 8));
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const recordSkippedPipelineRun = async (
          reason: string,
          details: Record<string, unknown>,
        ) => {
          const startedAt = new Date();
          const { data: run, error } = await supabaseAdmin
            .from("pipeline_runs")
            .insert({
              trigger: body.trigger ?? "cron",
              started_at: startedAt.toISOString(),
              finished_at: startedAt.toISOString(),
              duration_ms: 0,
              tasks_processed: 0,
              tasks_ok: 0,
              tasks_failed: 0,
              tasks_dead: 0,
              errors: 0,
              details: {
                skipped: true,
                reason,
                ...details,
              } as never,
            } as never)
            .select("id")
            .maybeSingle();
          if (error) throw error;

          return run?.id ?? null;
        };

        try {
          if (action === "enqueue-discovery") {
            const { enqueue } = await import("@/lib/ingest.server");
            const { data: withSources } = await supabaseAdmin
              .from("sources")
              .select("institution_id")
              .not("institution_id", "is", null);
            const covered = new Set((withSources ?? []).map((r) => r.institution_id as string));

            const { data: pendingTasks } = await supabaseAdmin
              .from("ingestion_tasks")
              .select("institution_id")
              .eq("task_type", "DISCOVER")
              .in("status", ["QUEUED", "PROCESSING", "RETRY"]);
            for (const t of pendingTasks ?? []) {
              if (t.institution_id) covered.add(t.institution_id);
            }

            const { data: institutions, error } = await supabaseAdmin
              .from("institutions")
              .select("id, name, official_url, research_url, careers_url")
              .not("official_url", "is", null)
              .limit(500);
            if (error) return json({ error: error.message }, 500);

            // Institutions with a dedicated research/careers URL crawl best, so go first.
            const backlog = (institutions ?? [])
              .filter((i) => !covered.has(i.id))
              .sort((a, b) => {
                const score = (i: { research_url: string | null; careers_url: string | null }) =>
                  (i.research_url ? 2 : 0) + (i.careers_url ? 1 : 0);
                return score(b) - score(a);
              });
            const targets = backlog.slice(0, limit);
            for (const inst of targets) {
              await enqueue("DISCOVER", { institution_id: inst.id });
            }
            return json({
              action,
              queued: targets.length,
              names: targets.map((t) => t.name),
              remaining: backlog.length - targets.length,
            });
          }
          if (action === "discover-programmes") {
            const { enqueueProgrammeDiscovery } = await import("@/lib/ingest.server");
            const result = await enqueueProgrammeDiscovery(
              Math.min(200, Math.max(1, body.limit ?? 100)),
            );
            return json({ action, ...result });
          }

          // One-time backfill planners. They only ENQUEUE work from data that is
          // already stored; the autonomous drain loop does the processing.
          if (action === "backfill-raw") {
            const { enqueueRawBackfill } = await import("@/lib/backfill.server");
            const result = await enqueueRawBackfill(Math.min(1000, Math.max(1, body.limit ?? 400)));
            return json({ action, ...result });
          }
          if (action === "backfill-providers") {
            const { enqueueProviderBackfill } = await import("@/lib/backfill.server");
            const result = await enqueueProviderBackfill(
              Math.min(400, Math.max(1, body.limit ?? 120)),
            );
            return json({ action, ...result });
          }

          if (action === "sync-pulse") {
            const { backfillPulseEvents } = await import("@/lib/pulse.server");
            const result = await backfillPulseEvents(
              Math.min(250, Math.max(10, body.limit ?? 120)),
            );
            return json({ action, ...result });
          }

          if (action === "refresh-insights") {
            const { backfillPulseEvents } = await import("@/lib/pulse.server");
            const pulse = await backfillPulseEvents(Math.min(250, Math.max(1, body.limit ?? 1)));
            const { data: insights, error } = await supabaseAdmin.rpc("refresh_public_insights");
            if (!error) return json({ action, pulse, insights });

            // Compatibility path during a rolling deployment: momentum existed
            // before the combined insight refresh migration. Keep it fresh while
            // clearly reporting that collaboration refresh is not available yet.
            const { data: momentum, error: momentumError } =
              await supabaseAdmin.rpc("refresh_topic_momentum");
            if (momentumError) return json({ error: error.message }, 500);
            return json({
              action,
              pulse,
              insights: { momentum_topics: momentum, collaboration: null },
              partial: true,
              migration_pending: true,
            });
          }

          if (action === "reseed-high-value") {
            const { enqueueHighValueReseed } = await import("@/lib/ingest.server");
            const result = await enqueueHighValueReseed(
              Math.min(300, Math.max(10, body.limit ?? 150)),
            );
            return json({ action, ...result });
          }

          if (action === "recover-semantic-failures") {
            const { enqueueSemanticFailureRecovery } = await import("@/lib/ingest.server");
            const result = await enqueueSemanticFailureRecovery(
              Math.min(1000, Math.max(10, body.limit ?? 500)),
            );
            return json({ action, ...result });
          }

          if (action === "recover-detail-sources") {
            const { enqueueExistingDetailRecovery } = await import("@/lib/ingest.server");
            const result = await enqueueExistingDetailRecovery(
              Math.min(1000, Math.max(10, body.limit ?? 300)),
            );
            return json({ action, ...result });
          }

          // Expensive network fetching runs on the persistent worker. The app
          // only leases bounded tasks and stores validated, compact snapshots.
          if (action === "worker-status") {
            const { getExternalWorkerStatus } = await import("@/lib/ingest.server");
            return json({ action, ...(await getExternalWorkerStatus()) });
          }
          if (action === "lease-fetch") {
            // Probe mode is non-mutating and exists for production smoke tests.
            // It proves the public route can reach the ingestion queue without
            // claiming a task just to test health.
            if (body.probe === true) {
              const { data, error } = await supabaseAdmin
                .from("ingestion_tasks")
                .select("id")
                .eq("task_type", "FETCH")
                .in("status", ["QUEUED", "RETRY"])
                .lte("run_after", new Date().toISOString())
                .limit(1);
              if (error) return json({ action, probe: true, error: error.message }, 500);
              return json({
                action,
                probe: true,
                due: (data ?? []).length > 0,
              });
            }
            // leaseExternalFetchTasks performs the backpressure check itself.
            // Avoid a duplicate worker-status query here: on a large backlog the
            // exact-count queries can exceed the public request budget before the
            // actual lease transaction even starts.
            const { leaseExternalFetchTasks } = await import("@/lib/external-fetch-lease.server");
            const leases = await leaseExternalFetchTasks(
              Math.min(20, Math.max(1, body.limit ?? 8)),
            );
            return json({
              action,
              leases,
              count: leases.length,
              paused: leases.length === 0,
            });
          }
          if (action === "complete-fetch") {
            if (!body.completion || typeof body.completion !== "object") {
              return json({ error: "Missing completion payload" }, 400);
            }
            const { completeExternalFetch } = await import("@/lib/ingest.server");
            const result = await completeExternalFetch(body.completion as ExternalFetchCompletion);
            return json({ action, ...result }, result.status === "STALE" ? 409 : 200);
          }
          if (action === "lease-review") {
            const { leaseExternalReviewTasks } = await import("@/lib/ingest.server");
            const leases = await leaseExternalReviewTasks(
              Math.min(10, Math.max(1, body.limit ?? 4)),
              body.model_available === true,
            );
            return json({ action, leases, count: leases.length });
          }
          if (action === "complete-review") {
            if (!body.completion || typeof body.completion !== "object") {
              return json({ error: "Missing completion payload" }, 400);
            }
            const { completeExternalReview } = await import("@/lib/ingest.server");
            const result = await completeExternalReview(
              body.completion as ExternalReviewCompletion,
            );
            return json({ action, ...result }, result.status === "STALE" ? 409 : 200);
          }

          // Structured-provider drain (ROR/OpenAIRE/Crossref). Never calls a model,
          // so it is safe to run on its own cheap cadence.
          if (action === "drain-providers") {
            const { runQueueBatch } = await import("@/lib/ingest.server");
            const result = await withTimeout(
              runQueueBatch(
                Math.min(30, Math.max(1, body.limit ?? 12)),
                ["PROMOTE_INSTITUTION", "IMPORT_PUBLICATIONS", "IMPORT_PROJECTS"],
                2,
              ),
              60_000,
              "structured provider drain",
            );
            return json({ action, ...result });
          }

          // Time-based source refresh: turns elapsed intervals into fetch work.
          // Only sources whose own cadence is due are queued.
          if (action === "refresh-due") {
            const { enqueueDueRefreshes } = await import("@/lib/schedule.server");
            const result = await enqueueDueRefreshes(Math.min(200, Math.max(1, body.limit ?? 40)));
            return json({ action, ...result });
          }

          // Deterministic deadline maintenance — pure date arithmetic, no model call.
          if (action === "deadline-sweep") {
            const { sweepOpportunityDeadlines } = await import("@/lib/schedule.server");
            const result = await sweepOpportunityDeadlines();
            return json({ action, ...result });
          }

          // Queue processing: waking up is cheap, working is not. Check first.
          const { runQueueBatch, recoverStaleQueueLeases } = await import("@/lib/ingest.server");
          const { loadSchedule, readQueueState } = await import("@/lib/schedule.server");
          const schedule = await loadSchedule();
          // Recover only application-owned DISCOVER/NORMALIZE leases before any
          // early return. A provider-circuit skip must not strand a crashed task
          // in PROCESSING indefinitely. External FETCH leases remain RPC-owned.
          const staleLeaseRecovery = await recoverStaleQueueLeases(["DISCOVER", "NORMALIZE"]);
          const queueState = await readQueueState(schedule);

          if (queueState.due_tasks === 0) {
            // Nothing to do: no fetch, no extraction, no NVIDIA call.
            const runId = await recordSkippedPipelineRun("queue empty", {
              mode: queueState.mode,
              due_tasks: queueState.due_tasks,
            });
            return json({
              action: "drain",
              run_id: runId,
              skipped: true,
              reason: "queue empty",
              stale_leases_recovered: staleLeaseRecovery.recovered,
              stale_leases_dead: staleLeaseRecovery.dead,
              ...queueState,
            });
          }

          // Do not claim NORMALIZE tasks while the primary AI gateway circuit is open.
          // This is a preflight guard: it leaves task attempts, leases, retry timestamps,
          // and exact-snapshot payloads untouched. Other deterministic queue work can run.
          let providerCircuitOpen = false;
          let providerGatewayFailure = false;
          const independentFallbackConfigured = Boolean(
            process.env["OPENAI_API_KEY"]?.trim() ||
              (process.env["OPENROUTER_API_KEY"]?.trim() &&
                process.env["OPENROUTER_MODEL"]?.trim()),
          );
          if (!independentFallbackConfigured) {
            const { AI_PROVIDER } = await import("@/lib/llm-config.server");
            const { shouldOpenOmniRouteCircuit, OMNIROUTE_CIRCUIT_WINDOW_MS } = await import("@/lib/extraction/transient-errors");
            // Match the 30-minute deferral applied to a task after a confirmed gateway outage.
            const circuitWindowStart = new Date(Date.now() - OMNIROUTE_CIRCUIT_WINDOW_MS).toISOString();
            const { count: recentGatewayFailures, error: circuitReadError } = await supabaseAdmin
              .from("llm_processing_runs")
              .select("id", { count: "exact", head: true })
              .eq("provider", AI_PROVIDER)
              .eq("status", "FAILED")
              .in("http_status", [502, 503, 530])
              .gte("created_at", circuitWindowStart);

            // Fail open on telemetry-read errors; a database read issue must not
            // silently block legitimate normalization after the provider recovers.
            if (!circuitReadError) {
              providerCircuitOpen = shouldOpenOmniRouteCircuit({
                recentGatewayFailures: recentGatewayFailures ?? 0,
                independentFallbackConfigured: false,
              });
            }
          }

          // Keep the circuit guard scoped to model-dependent NORMALIZE work.
          // The ordinary discovery fallback below is deterministic and should still
          // progress while the AI provider is unavailable.
          const providerCircuitReason = providerCircuitOpen
            ? "CIRCUIT_OPEN_GATEWAY_5XX: normalization deferred before claiming tasks; deterministic discovery may continue and no independent fallback is configured"
            : null;

          // In steady state the processor only works every steady_interval_minutes
          // even though the scheduler wakes on the backlog cadence.
          let oldestDueAgeMinutes: number | null = null;
          if (queueState.mode === "STEADY_STATE") {
            const cutoff = new Date(
              Date.now() - queueState.interval_minutes * 60_000,
            ).toISOString();
            const { data: recent } = await supabaseAdmin
              .from("pipeline_runs")
              .select("id")
              .gt("started_at", cutoff)
              .gt("tasks_processed", 0)
              .limit(1)
              .maybeSingle();

            // Measure age from task creation, not run_after: each retry advances
            // run_after and would otherwise make an old task look newly queued.
            // The run_after filter still respects retry cooldowns. If this read
            // fails, retain the ordinary steady-state throttle.
            if (recent && queueState.due_tasks > 0) {
              const { data: oldestDueTask, error: oldestDueTaskError } = await supabaseAdmin
                .from("ingestion_tasks")
                .select("created_at")
                .in("status", ["QUEUED", "RETRY"])
                .in("task_type", ["DISCOVER", "FETCH", "NORMALIZE"])
                .lte("run_after", new Date().toISOString())
                .order("created_at", { ascending: true })
                .limit(1)
                .maybeSingle();
              if (!oldestDueTaskError && oldestDueTask?.created_at) {
                oldestDueAgeMinutes = Math.max(
                  0,
                  (Date.now() - Date.parse(oldestDueTask.created_at)) / 60_000,
                );
              }
            }

            // Permit bounded catch-up when due work is either larger than two
            // steady-state waves or has waited at least 15 minutes past run_after.
            // Batch size, concurrency, timeout, provider deferrals and quality gates
            // remain unchanged.
            if (
              !providerCircuitOpen &&
              recent &&
              shouldThrottleSteadyStateDrain({
                recentWork: true,
                dueTasks: queueState.due_tasks,
                batchSize: queueState.batch_size,
                oldestDueAgeMinutes,
              })
            ) {
              const runId = await recordSkippedPipelineRun("steady-state interval not elapsed", {
                mode: queueState.mode,
                interval_minutes: queueState.interval_minutes,
                due_tasks: queueState.due_tasks,
                oldest_due_age_minutes: oldestDueAgeMinutes,
                recent_run_id: recent.id,
              });
              return json({
                action: "drain",
                run_id: runId,
                skipped: true,
                reason: "steady-state interval not elapsed",
                oldest_due_age_minutes: oldestDueAgeMinutes,
                ...queueState,
              });
            }
          }

          const batch = Math.min(50, Math.max(1, body.limit ?? queueState.batch_size));

          // Every autonomous tick is recorded so /admin/pipeline-health can prove
          // that scheduled processing is really running.
          const startedAt = new Date();
          const { data: run } = await supabaseAdmin
            .from("pipeline_runs")
            .insert({
              trigger: body.trigger ?? "cron",
              started_at: startedAt.toISOString(),
              details: {
                mode: queueState.mode,
                batch_size: batch,
                due_tasks: queueState.due_tasks,
                oldest_due_age_minutes: oldestDueAgeMinutes,
              } as never,
            } as never)
            .select("id")
            .maybeSingle();

          try {
            // Backlog draining is adaptive: process NORMALIZE in small waves with
            // Use bounded parallelism on the paid Workers plan while keeping each
            // invocation below the six simultaneous outgoing-connection limit.
            // Throughput tuned for the Cloudflare Workers Paid plan (30s CPU
            // per invocation): up to 4 normalizations per tick in BACKLOG
            // mode, 3 in steady state, 2 concurrent. The wave timeout and
            // budget below still guard against overruns.
            const normalizePolicy = normalizationWavePolicy({
              mode: queueState.mode,
              batch,
              independentFallbackConfigured,
            });
            const normalizeTarget = normalizePolicy.target;
            // When no independent provider is configured, process one task at
            // a time so the first gateway failure can stop further task claims.
            // With a fallback configured, preserve the existing bounded waves.
            const normalizeWave = normalizePolicy.waveSize;
            const normalizeConcurrency = normalizePolicy.concurrency;
            const normalizeBudgetMs = queueState.mode === "BACKLOG" ? 28_000 : 24_000;
            const emptyResult = () => ({
              processed: 0,
              ok: 0,
              failed: 0,
              dead: 0,
              normalized: 0,
              skipped: 0,
              details: [] as string[],
            });
            const result = emptyResult();
            if (providerCircuitReason) result.details.push(providerCircuitReason);
            let normalizeWaves = 0;
            let taskGroup: "NORMALIZE" | "DISCOVER" = "NORMALIZE";

            while (
              shouldRunNormalizationWave({
                providerCircuitOpen,
                processed: result.processed,
                target: normalizeTarget,
              }) &&
              Date.now() - startedAt.getTime() < normalizeBudgetMs
            ) {
              const remaining = normalizeTarget - result.processed;
              const wave = await withTimeout(
                runQueueBatch(
                  Math.min(normalizeWave, remaining),
                  ["NORMALIZE"],
                  normalizeConcurrency,
                ),
                25_000,
                "normalization wave",
              );
              normalizeWaves += 1;
              result.processed += wave.processed;
              result.ok += wave.ok;
              result.failed += wave.failed;
              result.dead += wave.dead;
              result.normalized += wave.normalized;
              result.skipped += wave.skipped;
              result.details.push(...wave.details);

              if (hasProviderCircuitOpenSignal(wave.details)) {
                providerCircuitOpen = true;
              }
              if (
                !independentFallbackConfigured &&
                hasProviderGatewayFailureSignal(wave.details)
              ) {
                providerGatewayFailure = true;
                // The current task is already deferred by the provider policy.
                // Stop before another task can be claimed in this invocation.
                break;
              }
              if (providerCircuitOpen) break;
              if (wave.processed === 0) break;
              // If a wave ends with multiple hard failures, stop this tick and let
              // exponential retry/backoff cool the provider down before the next wake.
              if (wave.failed + wave.dead >= 2) break;
            }

            if (result.processed === 0) {
              // FETCH is exclusively owned by the external fetch worker. The
              // Cloudflare queue drain must never claim FETCH tasks itself:
              // production does not inherit the legacy Fly-only environment flag,
              // and a second consumer would invalidate the external worker lease.
              taskGroup = "DISCOVER";
              // Discovery can perform several bounded network checks and serial
              // source-registration writes. During a provider circuit, process one
              // deterministic task with a longer but still bounded caller budget.
              const discoveryPolicy = discoveryFallbackPolicy(providerCircuitOpen, batch);
              const collection = await withTimeout(
                runQueueBatch(discoveryPolicy.limit, ["DISCOVER"], 1),
                discoveryPolicy.timeoutMs,
                "discovery batch",
              );
              result.processed = collection.processed;
              result.ok = collection.ok;
              result.failed = collection.failed;
              result.dead = collection.dead;
              result.normalized = collection.normalized;
              result.skipped = collection.skipped;
              result.details.push(...collection.details);
            }
            const { data: llm } = await supabaseAdmin
              .from("llm_processing_runs")
              .select("cached")
              .gte("created_at", startedAt.toISOString());
            const calls = llm ?? [];
            if (run?.id) {
              await supabaseAdmin
                .from("pipeline_runs")
                .update({
                  finished_at: new Date().toISOString(),
                  duration_ms: Date.now() - startedAt.getTime(),
                  tasks_processed: result.processed,
                  tasks_ok: result.ok,
                  tasks_failed: result.failed,
                  tasks_dead: result.dead,
                  nvidia_calls: calls.length,
                  nvidia_cached: calls.filter((c) => c.cached).length,
                  errors: result.failed + result.dead,
                  details: {
                    mode: queueState.mode,
                    batch_size: taskGroup === "NORMALIZE" ? normalizeTarget : batch,
                    task_group: taskGroup,
                    normalize_waves: taskGroup === "NORMALIZE" ? normalizeWaves : 0,
                    normalize_target: taskGroup === "NORMALIZE" ? normalizeTarget : 0,
                    normalize_budget_ms: taskGroup === "NORMALIZE" ? normalizeBudgetMs : 0,
                    provider_circuit_open: providerCircuitOpen,
                    provider_gateway_failure: providerGatewayFailure,
                    normalized: result.normalized,
                    skipped: result.skipped,
                    sample: result.details.slice(0, 20),
                  } as never,
                })
                .eq("id", run.id);
            }
            return json({
              action: "drain",
              run_id: run?.id ?? null,
              mode: queueState.mode,
              task_group: taskGroup,
              provider_circuit_open: providerCircuitOpen,
              provider_gateway_failure: providerGatewayFailure,
              stale_leases_recovered: staleLeaseRecovery.recovered,
              stale_leases_dead: staleLeaseRecovery.dead,
              ...result,
            });
          } catch (e) {
            const message = errorMessage(e);
            const timedOut = /timed out after \d+ms/i.test(message);
            if (run?.id) {
              await supabaseAdmin
                .from("pipeline_runs")
                .update({
                  finished_at: new Date().toISOString(),
                  duration_ms: Date.now() - startedAt.getTime(),
                  errors: 1,
                  error_message: message.slice(0, 1000),
                  details: {
                    mode: queueState.mode,
                    partial: timedOut,
                    timeout: timedOut,
                    error: message.slice(0, 1000),
                  } as never,
                })
                .eq("id", run.id);
            }
            // A single slow normalization/discovery batch must not abort the
            // entire ingestion workflow. The next scheduled tick can recover
            // its stale lease and continue from the remaining queue.
            if (timedOut) {
              return json({
                action: "drain",
                run_id: run?.id ?? null,
                partial: true,
                timed_out: true,
                error: message,
              });
            }
            return json({ error: message }, 500);
          }
        } catch (error) {
          const message = errorMessage(error);
          console.error(`[ingestion-hook] ${action} failed`, error);
          return json(
            {
              action,
              error: "Ingestion action failed",
              message: message.slice(0, 1000),
            },
            500,
          );
        }
      },
    },
  },
});
