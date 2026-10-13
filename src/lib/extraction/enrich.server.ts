// Optional Nemotron enrichment for a vacancy page that already passed the
// deterministic gate. Only adds validated fields; never overturns the gate.
import { LLM_EXTRACTION_ENABLED } from "../llm-config.server";
import { isAIConfigured } from "../nvidia.server";
import { extractVacancy, type VacancyExtraction } from "./vacancy.server";
import { findCachedResult, logCacheHit, recordValidatedResult, validateVacancy } from "./validate.server";

export type EnrichOutcome = {
  used: boolean;
  cached: boolean;
  extraction: VacancyExtraction | null;
  errorCode: string | null;
  errorMessage: string | null;
};

const NONE: EnrichOutcome = { used: false, cached: false, extraction: null, errorCode: null, errorMessage: null };

export async function enrichVacancy(input: {
  url: string;
  title: string;
  text: string;
  sourceId?: string | null;
  rawRecordId?: string | null;
  contentHash?: string | null;
}): Promise<EnrichOutcome> {
  if (!LLM_EXTRACTION_ENABLED) return NONE;
  if (!isAIConfigured()) return { ...NONE, errorCode: "AI_PROVIDER_NOT_CONFIGURED" };

  const cached = (await findCachedResult({ operation: "VACANCY_EXTRACTION", contentHash: input.contentHash ?? null })) as
    | VacancyExtraction
    | null;
  if (cached) {
    await logCacheHit({
      operation: "VACANCY_EXTRACTION",
      contentHash: input.contentHash ?? null,
      sourceId: input.sourceId ?? null,
      rawRecordId: input.rawRecordId ?? null,
      result: cached,
    });
    return { used: true, cached: true, extraction: cached, errorCode: null, errorMessage: null };
  }

  const { call } = await extractVacancy(input);
  if (!call.ok || !call.content) {
    return { used: true, cached: false, extraction: null, errorCode: call.errorCode, errorMessage: call.errorMessage };
  }

  const validated = validateVacancy(call.content);
  if (!validated.ok) {
    await recordValidatedResult({
      runId: call.runId,
      result: { raw_completion: call.content.slice(0, 4000) },
      status: "VALIDATION_FAILED",
      errorCode: validated.code,
      errorMessage: validated.message,
    });
    return { used: true, cached: false, extraction: null, errorCode: validated.code, errorMessage: validated.message };
  }

  await recordValidatedResult({ runId: call.runId, result: validated.value, status: "SUCCESS" });
  return { used: true, cached: false, extraction: validated.value, errorCode: null, errorMessage: null };
}
