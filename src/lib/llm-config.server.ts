// Server-only configuration for the GeoAcademic Radar intelligence engine.
export const AI_PROVIDER = "OmniRoute";

// OmniRoute provides the OpenAI-compatible gateway for the whole routing ladder. Model ids can be
// overridden per environment without changing source code.
// Nemotron 3 Nano 30B A3B was retired from the hosted NVIDIA endpoint on
// 2026-09-01. Lightning 3.5 is the current hosted 30B A3B workhorse model.
export const NVIDIA_MODEL_NANO =
  process.env["NVIDIA_MODEL_NANO"] ?? "nvidia/nemotron-3.5-lightning-30b-a3b";
export const NVIDIA_MODEL_SUPER =
  process.env["NVIDIA_MODEL_SUPER"] ?? "nvidia/nemotron-3-super-120b-a12b";
export const NVIDIA_MODEL_ULTRA =
  process.env["NVIDIA_MODEL_ULTRA"] ?? "nvidia/nemotron-3-ultra-550b-a55b";

// Backwards-compatible alias used by older status/provenance code. The primary
// routine model is Nano; difficult operations route upward automatically.
export const NVIDIA_MODEL = NVIDIA_MODEL_NANO;
export const NVIDIA_MODEL_CHAIN_LABEL = "Lightning 3.5 → Super → Ultra";

export type NvidiaModelTier = "NANO" | "SUPER" | "ULTRA";
export const NVIDIA_MODEL_BY_TIER: Record<NvidiaModelTier, string> = {
  NANO: NVIDIA_MODEL_NANO,
  SUPER: NVIDIA_MODEL_SUPER,
  ULTRA: NVIDIA_MODEL_ULTRA,
};

export const NVIDIA_MAX_CONCURRENCY = 2;
// Keep retries short inside one model. The extraction engine can escalate to a
// stronger model instead of spending several minutes retrying the same model.
export const NVIDIA_RETRY_LIMIT = 2;
export const LLM_EXTRACTION_ENABLED = true;
/** Hard cap on characters sent to the model per request. */
export const LLM_MAX_INPUT_CHARS = 12_000;
export const LLM_DEFAULT_TEMPERATURE = 0.1;
export const LLM_DEFAULT_MAX_TOKENS = 2000;

export type LlmOperation =
  | "CONNECTION_TEST"
  | "VACANCY_EXTRACTION"
  | "PROGRAMME_EXTRACTION"
  | "PROJECT_EXTRACTION"
  | "RESEARCHER_EXTRACTION"
  | "EVENT_EXTRACTION"
  | "RELEVANCE_CLASSIFICATION";

/**
 * Model routing policy.
 *
 * - Lightning 3.5 handles cheap, high-volume extraction.
 * - Super is the default for the two hardest entity types and the first
 *   fallback for routine extractors.
 * - Ultra is a rare last resort for difficult canonical extraction.
 */
export const NVIDIA_MODEL_CHAIN: Record<LlmOperation, readonly NvidiaModelTier[]> = {
  CONNECTION_TEST: ["NANO"],
  RELEVANCE_CLASSIFICATION: ["NANO", "SUPER"],
  PROGRAMME_EXTRACTION: ["NANO", "SUPER", "ULTRA"],
  EVENT_EXTRACTION: ["NANO", "SUPER", "ULTRA"],
  VACANCY_EXTRACTION: ["NANO", "SUPER", "ULTRA"],
  PROJECT_EXTRACTION: ["SUPER", "ULTRA"],
  RESEARCHER_EXTRACTION: ["SUPER", "ULTRA"],
};

/** Per-model request timeout with reasoning disabled. */
export const NVIDIA_TIMEOUT_BY_TIER: Record<NvidiaModelTier, number> = {
  NANO: 35_000,
  SUPER: 60_000,
  ULTRA: 90_000,
};

/**
 * Output budget per operation. Thinking is disabled, so these budgets are for
 * the JSON payload itself rather than hidden reasoning traces.
 */
export const LLM_MAX_TOKENS: Record<LlmOperation, number> = {
  CONNECTION_TEST: 64,
  VACANCY_EXTRACTION: 1800,
  PROGRAMME_EXTRACTION: 1200,
  PROJECT_EXTRACTION: 1500,
  RESEARCHER_EXTRACTION: 1200,
  EVENT_EXTRACTION: 900,
  RELEVANCE_CLASSIFICATION: 400,
};

/**
 * Input budget per operation. Keep routine extraction compact even though the
 * hosted models support much larger contexts.
 */
export const LLM_INPUT_CHARS: Record<LlmOperation, number> = {
  CONNECTION_TEST: 500,
  VACANCY_EXTRACTION: 8_000,
  PROGRAMME_EXTRACTION: 5_500,
  PROJECT_EXTRACTION: 6_500,
  RESEARCHER_EXTRACTION: 5_500,
  EVENT_EXTRACTION: 4_500,
  RELEVANCE_CLASSIFICATION: 3_500,
};

/** One shrink retry per model after a timeout or truncated JSON response. */
export const LLM_SHRINK_RETRY_FACTOR = 0.5;
