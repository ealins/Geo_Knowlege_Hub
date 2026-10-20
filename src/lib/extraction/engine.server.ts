// Generic extraction engine. Every entity type goes through this one path:
// cleaned content -> validated cache -> adaptive Nemotron model ladder ->
// schema validation -> business-rule validation -> recorded run.
import { cleanPageText } from "../content-clean.server";
import {
  LLM_EXTRACTION_ENABLED,
  LLM_INPUT_CHARS,
  LLM_MAX_TOKENS,
  LLM_SHRINK_RETRY_FACTOR,
  NVIDIA_MODEL_BY_TIER,
  NVIDIA_MODEL_CHAIN,
  type LlmOperation,
  type NvidiaModelTier,
} from "../llm-config.server";
import { callNemotron, isAIConfigured } from "../nvidia.server";
import { findCachedResult, logCacheHit, recordValidatedResult } from "./validate.server";
import type { ValidationOutcome } from "./shared.server";

export type ExtractionOutcome<T> = {
  used: boolean;
  cached: boolean;
  value: T | null;
  errorCode: string | null;
  errorMessage: string | null;
  model?: string | null;
  modelsTried?: string[];
  finishReason?: string | null;
  outputTokens?: number | null;
  droppedFields?: string[];
};

export type ExtractionInput = {
  url: string;
  title: string;
  text: string;
  sourceId?: string | null;
  rawRecordId?: string | null;
  contentHash?: string | null;
};

function modelName(tier: NvidiaModelTier): string {
  return NVIDIA_MODEL_BY_TIER[tier];
}

/**
 * Try the operation's cheapest suitable model first and escalate only when the
 * model request or strict validator cannot produce a usable object. A valid
 * rejection (for example, "this is not a single project") is a valid result
 * and is never escalated just to force acceptance.
 */
export async function runExtraction<T>(args: {
  operation: LlmOperation;
  system: string;
  validate: (completion: string, text: string) => ValidationOutcome<T> & { dropped?: string[] };
  input: ExtractionInput;
  extraUser?: string;
}): Promise<ExtractionOutcome<T>> {
  const none: ExtractionOutcome<T> = {
    used: false,
    cached: false,
    value: null,
    errorCode: null,
    errorMessage: null,
  };
  if (!LLM_EXTRACTION_ENABLED) return none;
  if (!isAIConfigured()) return { ...none, errorCode: "AI_PROVIDER_NOT_CONFIGURED" };

  // A previous validated result remains valid regardless of which Nemotron
  // tier produced it. This preserves the large Ultra-era cache.
  const cached = await findCachedResult({
    operation: args.operation,
    contentHash: args.input.contentHash ?? null,
  });
  if (cached) {
    await logCacheHit({
      operation: args.operation,
      contentHash: args.input.contentHash ?? null,
      sourceId: args.input.sourceId ?? null,
      rawRecordId: args.input.rawRecordId ?? null,
      result: cached.result,
      model: cached.model,
    });
    return {
      used: true,
      cached: true,
      value: cached.result as T,
      errorCode: null,
      errorMessage: null,
      model: cached.model,
      modelsTried: [],
    };
  }

  const budget = LLM_INPUT_CHARS[args.operation];
  const modelsTried: string[] = [];
  let lastErrorCode: string | null = null;
  let lastErrorMessage: string | null = null;
  let lastFinishReason: string | null = null;
  let lastOutputTokens: number | null = null;
  let lastModel: string | null = null;

  const fallbackModels = NVIDIA_MODEL_CHAIN[args.operation].map(modelName);
  const candidateModels = ["auto", ...fallbackModels.filter((model) => model !== "auto")];

  for (const model of candidateModels) {
    const tier = NVIDIA_MODEL_CHAIN[args.operation].find((candidate) => modelName(candidate) === model) ?? "NANO";
    modelsTried.push(model);
    lastModel = model;

    // One normal pass and, only for timeout/truncation, one reduced-input pass.
    for (let pass = 0; pass < 2; pass += 1) {
      const maxChars =
        pass === 0 ? budget : Math.max(1500, Math.floor(budget * LLM_SHRINK_RETRY_FACTOR));
      const cleaned = cleanPageText(args.input.text, {
        maxChars,
        prioritiseJobSections: args.operation === "VACANCY_EXTRACTION",
      });

      const user = `PAGE URL: ${args.input.url}
PAGE TITLE: ${args.input.title}
${args.extraUser ? `\n${args.extraUser}\n` : ""}
PAGE TEXT:
"""
${cleaned.text}
"""`;

      const call = await callNemotron({
        system: args.system,
        user,
        operation: args.operation,
        sourceId: args.input.sourceId ?? null,
        rawRecordId: args.input.rawRecordId ?? null,
        contentHash: args.input.contentHash ?? null,
        contentReduced: cleaned.contentReduced,
        maxTokens: LLM_MAX_TOKENS[args.operation],
        model,
        modelTier: tier,
      });

      lastErrorCode = call.errorCode;
      lastErrorMessage = call.errorMessage;
      lastFinishReason = call.finishReason ?? null;
      lastOutputTokens = call.outputTokens ?? null;

      if (!call.ok || !call.content) {
        const shrinkable = call.errorCode === "TIMEOUT" || call.errorCode === "OUTPUT_TRUNCATED";
        if (pass === 0 && shrinkable) continue;
        break; // move to the next model tier
      }

      const validated = args.validate(call.content, cleaned.text);
      if (validated.ok) {
        await recordValidatedResult({
          runId: call.runId,
          result: validated.value,
          status: "SUCCESS",
        });
        return {
          used: true,
          cached: false,
          value: validated.value,
          errorCode: null,
          errorMessage: null,
          model,
          modelsTried,
          finishReason: call.finishReason ?? null,
          outputTokens: call.outputTokens ?? null,
          droppedFields: validated.dropped ?? [],
        };
      }

      // The request succeeded, but the object failed our schema/business rules.
      // Record the failure against this model, then escalate to the next tier.
      await recordValidatedResult({
        runId: call.runId,
        result: { raw_completion: call.content.slice(0, 4000) },
        status: "VALIDATION_FAILED",
        errorCode: validated.code,
        errorMessage: validated.message,
      });
      lastErrorCode = validated.code;
      lastErrorMessage = validated.message;
      break;
    }
  }

  return {
    used: true,
    cached: false,
    value: null,
    errorCode: lastErrorCode ?? "NO_RESULT",
    errorMessage: lastErrorMessage,
    model: lastModel,
    modelsTried,
    finishReason: lastFinishReason,
    outputTokens: lastOutputTokens,
  };
}
