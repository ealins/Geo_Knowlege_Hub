// Server-only AI provider client. OpenAI is preferred; OmniRoute is the controlled fallback. The API key is read inside the call,
// never logged, never returned to callers, never written to the database.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  AI_PROVIDER,
  LLM_DEFAULT_MAX_TOKENS,
  LLM_DEFAULT_TEMPERATURE,
  NVIDIA_MAX_CONCURRENCY,
  NVIDIA_MODEL,
  NVIDIA_MODEL_BY_TIER,
  NVIDIA_RETRY_LIMIT,
  NVIDIA_TIMEOUT_BY_TIER,
  type LlmOperation,
  type NvidiaModelTier,
} from "./llm-config.server";

export type NemotronCall = {
  system: string;
  user: string;
  operation: LlmOperation;
  sourceId?: string | null;
  rawRecordId?: string | null;
  contentHash?: string | null;
  contentReduced?: boolean;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  modelTier?: NvidiaModelTier;
  retryLimit?: number;
};

export type NemotronResult = {
  ok: boolean;
  content: string | null;
  httpStatus: number | null;
  latencyMs: number;
  model: string;
  provider: string;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  runId: string | null;
  finishReason?: string | null;
  outputTokens?: number | null;
};

/* ---------------- concurrency gate ---------------- */
let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < NVIDIA_MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release(): void {
  active = Math.max(0, active - 1);
  const next = waiting.shift();
  if (next) next();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isAIConfigured(): boolean {
  return Boolean(process.env["OMNIROUTE_API_KEY"] || process.env["OMNIROUTE_URL"]);
}
export const isNvidiaConfigured = isAIConfigured;

async function logRun(row: Record<string, unknown>): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("llm_processing_runs")
    .insert(row as never)
    .select("id")
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Single entry point for every semantic AI request.
 * Every attempt — success, failure or missing secret — is recorded in
 * llm_processing_runs. Retries only on 429 / 5xx / network errors.
 */
export async function callNemotron(call: NemotronCall): Promise<NemotronResult> {
  const model = call.model ?? (call.modelTier ? NVIDIA_MODEL_BY_TIER[call.modelTier] : (process.env["OMNIROUTE_MODEL"] ?? "auto"));
  const tier: NvidiaModelTier =
    call.modelTier ??
    (model === NVIDIA_MODEL_BY_TIER.ULTRA
      ? "ULTRA"
      : model === NVIDIA_MODEL_BY_TIER.SUPER
        ? "SUPER"
        : "NANO");
  const retryLimit = Math.max(1, call.retryLimit ?? NVIDIA_RETRY_LIMIT);
  const base = {
    provider: AI_PROVIDER,
    model,
    operation: call.operation,
    source_id: call.sourceId ?? null,
    raw_page_id: call.rawRecordId ?? null,
    content_hash: call.contentHash ?? null,
    content_reduced: call.contentReduced ?? false,
    input_characters: call.system.length + call.user.length,
  };

  const apiKey = process.env["OMNIROUTE_API_KEY"];
  const endpoint = process.env["OMNIROUTE_URL"]?.replace(/\/$/, "") ?? "https://omniroute.geoacademic.app/v1";
  const providerModel = model;
  if (!apiKey) {
    const runId = await logRun({
      ...base,
      status: "FAILED",
      completed_at: new Date().toISOString(),
      latency_ms: 0,
      error_code: "AI_PROVIDER_NOT_CONFIGURED",
      error_message: `OmniRoute is not configured. Set OMNIROUTE_API_KEY or OMNIROUTE_URL on the server.`,
    });
    return {
      ok: false,
      content: null,
      httpStatus: null,
      latencyMs: 0,
      model,
      provider: AI_PROVIDER,
      attempt: 0,
      errorCode: "AI_PROVIDER_NOT_CONFIGURED",
      errorMessage: `No AI provider is configured. Set OPENAI_API_KEY or OMNIROUTE_API_KEY on the server.`,
      runId,
    };
  }

  let lastResult: NemotronResult | null = null;

  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    const startedAt = new Date();
    const t0 = Date.now();
    await acquire();
    let httpStatus: number | null = null;
    let content: string | null = null;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let finishReason: string | null = null;
    let outputTokens: number | null = null;
    let retryAfterMs: number | null = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), NVIDIA_TIMEOUT_BY_TIER[tier]);
      const response = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: providerModel,
          temperature: call.temperature ?? LLM_DEFAULT_TEMPERATURE,
          max_tokens: call.maxTokens ?? LLM_DEFAULT_MAX_TOKENS,
          // GeoAcademic Radar uses Nemotron for terse structured extraction,
          // not open-ended reasoning. Nemotron 3 enables thinking by default;
          // disabling it avoids spending most of the time/token budget before
          // the JSON payload is produced.
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: "system", content: call.system },
            { role: "user", content: call.user },
          ],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      httpStatus = response.status;
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = seconds * 1000;
        else {
          const at = Date.parse(retryAfter);
          if (Number.isFinite(at)) retryAfterMs = Math.max(0, at - Date.now());
        }
      }
      const bodyText = await response.text();

      if (!response.ok) {
        errorCode = `HTTP_${response.status}`;
        errorMessage = bodyText.slice(0, 800);
      } else {
        try {
          const parsed = JSON.parse(bodyText) as {
            choices?: { message?: { content?: string }; finish_reason?: string }[];
            usage?: { completion_tokens?: number };
          };
          content = parsed.choices?.[0]?.message?.content ?? null;
          finishReason = parsed.choices?.[0]?.finish_reason ?? null;
          outputTokens = parsed.usage?.completion_tokens ?? null;
          if (!content) {
            errorCode = finishReason === "length" ? "OUTPUT_TRUNCATED" : "EMPTY_COMPLETION";
            errorMessage = `finish_reason=${finishReason ?? "unknown"} completion_tokens=${outputTokens ?? "?"} ${bodyText.slice(0, 300)}`;
          } else if (finishReason === "length" && !content.trimEnd().endsWith("}")) {
            // Truncated mid-JSON: treat as a failure rather than feeding a
            // half object into validation.
            errorCode = "OUTPUT_TRUNCATED";
            errorMessage = `finish_reason=length completion_tokens=${outputTokens ?? "?"}`;
            content = null;
          }
        } catch {
          errorCode = "UNPARSEABLE_RESPONSE";
          errorMessage = bodyText.slice(0, 400);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errorCode = message.includes("abort") ? "TIMEOUT" : "NETWORK_ERROR";
      errorMessage = message.slice(0, 500);
    } finally {
      release();
    }

    const latencyMs = Date.now() - t0;
    const ok = Boolean(content) && !errorCode;
    const runId = await logRun({
      ...base,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      status: ok ? "SUCCESS" : "FAILED",
      latency_ms: latencyMs,
      attempt,
      http_status: httpStatus,
      output_characters: content?.length ?? 0,
      error_code: errorCode,
      error_message: errorMessage,
    });

    lastResult = {
      ok,
      content,
      httpStatus,
      latencyMs,
      model,
      provider: AI_PROVIDER,
      attempt,
      errorCode,
      errorMessage,
      runId,
      finishReason,
      outputTokens,
    };

    if (ok) return lastResult;

    const retriable =
      errorCode === "NETWORK_ERROR" ||
      errorCode === "TIMEOUT" ||
      httpStatus === 429 ||
      (httpStatus !== null && httpStatus >= 500);
    if (!retriable || attempt === retryLimit) return lastResult;

    // Capacity/rate-limit failures benefit from a slightly longer cool-down.
    // Honour Retry-After when NVIDIA provides it; otherwise use bounded
    // exponential backoff with a little jitter so concurrent workers do not
    // retry at exactly the same millisecond.
    const providerBaseMs = httpStatus === 503 ? 4_000 : httpStatus === 429 ? 3_000 : 1_000;
    const exponentialMs = providerBaseMs * 2 ** (attempt - 1);
    const jitterMs = Math.floor(Math.random() * 500);
    await sleep(Math.max(retryAfterMs ?? 0, exponentialMs) + jitterMs);
  }

  return lastResult!;
}
