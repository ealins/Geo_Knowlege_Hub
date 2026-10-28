import { createServerFn } from "@tanstack/react-start";
import type { PublicSourceHealth } from "./public-source-health";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PUBLIC_IDS = 200;

type PublicOpportunitySourceHealthInput = {
  opportunityIds: string[];
};

/**
 * Return only IDs of currently public opportunities whose every recorded
 * source is confirmed terminal. Use the server-only Supabase client because
 * the anonymous role intentionally cannot read record_sources or sources.
 */
export const getPublicOpportunitySourceHealth = createServerFn({ method: "POST" })
  .validator((input: PublicOpportunitySourceHealthInput) => {
    if (!input || !Array.isArray(input.opportunityIds)) {
      throw new Error("opportunityIds must be an array");
    }
    if (input.opportunityIds.length > MAX_PUBLIC_IDS) {
      throw new Error(`At most ${MAX_PUBLIC_IDS} opportunity IDs may be checked per request`);
    }
    const ids = input.opportunityIds.map((id) => typeof id === "string" ? id.trim() : "");
    if (ids.some((id) => !UUID_PATTERN.test(id))) {
      throw new Error("Every opportunity ID must be a UUID");
    }
    return { opportunityIds: [...new Set(ids)] };
  })
  .handler(async ({ data }) => {
    const requestedIds = data.opportunityIds;
    if (requestedIds.length === 0) return { suppressed_opportunity_ids: [] as string[] };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const {
      LIVE_OPPORTUNITY_STATUSES,
      PUBLIC_CONFIDENCE_LEVELS,
      PUBLIC_VERIFICATION_STATUSES,
      isPublicOpportunityEvidence,
    } = await import("./public-data");
    const { filterPublicOpportunityIdsBySourceHealth } = await import("./public-source-health");

    const { data: evidence, error: evidenceError } = await supabaseAdmin
      .from("opportunities")
      .select("id, title, description, official_source_url, confidence, verification_status, status, application_deadline, last_checked_at, is_demo")
      .eq("is_demo", false)
      .in("id", requestedIds)
      .in("status", [...LIVE_OPPORTUNITY_STATUSES])
      .in("verification_status", [...PUBLIC_VERIFICATION_STATUSES])
      .in("confidence", [...PUBLIC_CONFIDENCE_LEVELS])
      .not("official_source_url", "is", null);

    if (evidenceError) {
      console.warn("[public-source-health] public opportunity lookup failed", evidenceError.message);
      throw new Error("Public opportunity source-health lookup unavailable");
    }

    const publicEvidence = (evidence ?? []).filter((row) => isPublicOpportunityEvidence(row));
    const publicIds = publicEvidence.map((row) => row.id);
    if (publicIds.length === 0) return { suppressed_opportunity_ids: [] as string[] };

    const { data: sourceLinks, error: sourceLinksError } = await supabaseAdmin
      .from("record_sources")
      .select("entity_id, source_id, last_checked_at")
      .eq("entity_type", "opportunity")
      .in("entity_id", publicIds);

    if (sourceLinksError) {
      console.warn("[public-source-health] source-link lookup failed", sourceLinksError.message);
      throw new Error("Public opportunity source-health lookup unavailable");
    }

    const linksByOpportunity = new Map<string, { source_id: string | null; last_checked_at: string | null }[]>();
    for (const link of sourceLinks ?? []) {
      if (!link.entity_id) continue;
      const links = linksByOpportunity.get(link.entity_id) ?? [];
      links.push({ source_id: link.source_id, last_checked_at: link.last_checked_at });
      linksByOpportunity.set(link.entity_id, links);
    }

    const sourceIds = [...new Set(
      (sourceLinks ?? [])
        .map((link) => link.source_id)
        .filter((id): id is string => Boolean(id)),
    )];
    const sourcesById = new Map<string, PublicSourceHealth>();

    if (sourceIds.length > 0) {
      const { data: sourceRows, error: sourceError } = await supabaseAdmin
        .from("sources")
        .select("id, active, status, last_http_status, last_success_at, last_failure_at")
        .in("id", sourceIds);

      if (sourceError) {
        console.warn("[public-source-health] source lookup failed", sourceError.message);
        throw new Error("Public opportunity source-health lookup unavailable");
      }

      for (const source of sourceRows ?? []) {
        sourcesById.set(source.id, source as PublicSourceHealth);
      }
    }

    const checkedAtByOpportunity = new Map(
      publicEvidence.map((row) => [row.id, row.last_checked_at as string | null]),
    );
    const liveIds = new Set(filterPublicOpportunityIdsBySourceHealth({
      publicIds,
      linksByOpportunity,
      sourcesById,
      checkedAtByOpportunity,
      healthLookupSucceeded: true,
    }));

    return {
      suppressed_opportunity_ids: publicIds.filter((id) => !liveIds.has(id)),
    };
  });
