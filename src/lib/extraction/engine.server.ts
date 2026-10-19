// Generic extraction engine. Every entity type goes through one path:
//cleaned content validated cache adaptive Nemotron model ladder
//schema validation business-rule validation recorded run.
import cleanPageText "../content-clean.server";
import LLM_EXTRACTION_ENABLED from "../llm-config.server";
import LLM_INPUT_CHARS from "../llm-config.server";
import LLM_MAX_TOKENS from "../llm-config.server";
import LLM_SHRINK_RETRY_FACTOR from "../llm-config.server";
import LlmOperation, NvidiaModelTier from "../llm-config.server";
import callNemotron, isAIConfigured from "../nvidia.server";
import findCachedResult, logCacheHit, recordValidatedResult from "./validate.server";
import type ValidationOutcome from "./shared.server";

export type ExtractionOutcome<T> {
  used: boolean;
  cached: boolean;
  value: cached.result;
  errorCode: null;
  errorMessage: null;
  model: cached.model;
  modelsTried: [];
  outputTokens: number;
}

export type ExtractionInput<T> {
  system: string;
  user: string;
  operation: LlmOperation;
  input: T;
  contentHash: string;
  sourceId: string;
  rawRecordId: string;
}

/**
 * Detect if page text contains coding-related content
 */
function detectCodingContent(pageText: string): boolean {
  const codingIndicators = [
    "code",
    "function",
    "class",
    "import ",
    "export ",
    "def ",
    "interface",
    "type ",
    "npm ",
    "yarn ",
    "pnpm ",
    "package.json",
    "tsconfig",
    "docker",
    "dockerfile",
    "api docs",
    "sdk reference",
  ];
  const lowerText = pageText.toLowerCase();
  const matches = codingIndicators.filter((ind) => lowerText.includes(ind));
  return matches.length >= 3;
}

/**
 * Get candidate models for the given operation, including the OmniRoute coding model
 * when the content is code-heavy.
 */
function getCandidateModels(
  operation: LlmOperation,
  pageText: string,
  omniRouteCodingModel: string
): string[] {
  const fallbackModels = NVIDIA_MODEL_CHAIN[operation];
  const candidateModels = ["auto", ...fallbackModels.filter((model) => model !== "auto")];

  // If the page contains coding content, prepend the coding model
  if (detectCodingContent(pageText)) {
    const codingModel = omniRouteCodingModel === "auto/coding:free" ? "auto/coding:free" : omniRouteCodingModel;
    // Insert coding model after "auto" but before NANO if NANO is in the chain
    const insertIndex = candidateModels.indexOf("auto");
    if (insertIndex >= 0) {
      candidateModels.splice(insertIndex + 1, 0, codingModel);
    } else {
      candidateModels.unshift(codingModel);
    }
  }

  return candidateModels;
}

export async functionextractWithCache<T>({system, user, operation, input, contentHash, sourceId, rawRecordId}: ExtractionInput<T>): Promise<ExtractionOutcome<T>> {
  const cached = await findCachedResult({
    operation,
    contentHash,
    sourceId,
    rawRecordId,
  });

  if (cached) {
    await logCacheHit({
      operation,
      contentHash,
      sourceId,
      rawRecordId,
    });
    return {
      used: false,
      cached: true,
      value: cached.result,
      errorCode: null,
      errorMessage: null,
      model: cached.model,
      modelsTried: [],
      outputTokens: 0,
    };
  }

  const pageText = String(input.text || "");
  if (pageText.length < 120) {
    throw new Error("Page text too short for extraction");
  }

  if (!isAIConfigured()) {
    return {
      used: false,
      cached: false,
      value: null,
      errorCode: "AI_PROVIDER_NOT_CONFIGURED",
      errorMessage: "AI provider not configured",
      model: null,
      modelsTried: [],
      outputTokens: 0,
    };
  }

  const omniRouteCodingModel = process.env.OMNIROUTE_CODING_MODEL ?? "auto/coding:free";

  const candidateModels = getCandidateModels(operation, pageText, omniRouteCodingModel);

  let lastErrorCode: string | null = null;
  let lastErrorMessage: string | null = null;
  let lastFinishReason: string | null = null;
  let lastOutputTokens: number | null = null;
  let lastModel: string | null = null;

  for (let pass = 0; pass < 2; pass += 1) {
    const maxChars = pass === 0
      ? LLM_INPUT_CHARS[operation]
      : Math.max(1500, Math.floor(LLM_INPUT_CHARS[operation] * LLM_SHRINK_RETRY_FACTOR));

    const cleaned = cleanPageText({text: pageText, maxChars});

    const completion = await callNemotron({
      system,
      user,
      operation,
      model: candidateModels[0], // Will be updated in the loop
    });

    // ... rest of the extraction logic
    const validated = await validateBasicExtraction(cleaned);

    if (validated.status === "SUCCESS") {
      recordValidatedResult({
        operation,
        contentHash,
        sourceId,
        rawRecordId,
        result: validated.result,
        model: candidateModels[0],
      });

      return {
        used: true,
        cached: false,
        value: validated.result,
        errorCode: null,
        errorMessage: null,
        model: candidateModels[0],
        modelsTried: [candidateModels[0]],
        outputTokens: validated.outputTokens ?? 0,
      };
    }

    // Record the model we tried
    lastModel = candidateModels[0];
    lastErrorCode = validated.code;
    lastErrorMessage = validated.message;

    // On timeout/truncation, try with reduced input on second pass
    if (pass === 0) {
      continue;
    }
  }

  return {
    used: false,
    cached: false,
    value: null,
    errorCode: lastErrorCode,
    errorMessage: lastErrorMessage,
    model: lastModel,
    modelsTried: [lastModel],
    outputTokens: lastOutputTokens ?? 0,
  };
}