export type PublicSourceHealth = {
  id: string;
  active: boolean | null;
  status: string | null;
  last_http_status: number | null;
  last_success_at: string | null;
  last_failure_at: string | null;
};

export type OpportunitySourceLink = {
  source_id: string | null;
  last_checked_at: string | null;
};

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A source is confirmed dead only when it is inactive, marked FAILED, its
 * latest HTTP failure is 404/410, and that failure is newer than its last
 * success and any recorded checks of the linked opportunity/evidence.
 *
 * Transient failures (403/429/5xx), missing source metadata, and failures
 * followed by a success never hide a public opportunity.
 */
export function isConfirmedDeadOpportunitySource(
  source: PublicSourceHealth | null | undefined,
  opportunityLastCheckedAt: string | null | undefined,
  recordSourceLastCheckedAt: string | null | undefined,
): boolean {
  if (!source || source.active !== false || source.status?.toUpperCase() !== "FAILED") {
    return false;
  }
  if (source.last_http_status !== 404 && source.last_http_status !== 410) {
    return false;
  }

  const failedAt = parseTimestamp(source.last_failure_at);
  if (failedAt === null) return false;

  const succeededAt = parseTimestamp(source.last_success_at);
  if (succeededAt !== null && failedAt <= succeededAt) return false;

  for (const checkedAt of [opportunityLastCheckedAt, recordSourceLastCheckedAt]) {
    const checked = parseTimestamp(checkedAt);
    if (checkedAt && (checked === null || failedAt <= checked)) return false;
  }

  return true;
}

/**
 * Hide a live opportunity only when every recorded source link is backed by a
 * confirmed dead source. Unknown/missing links preserve the listing, and no
 * canonical row is mutated.
 */
export function isOpportunityOnlyBackedByDeadSources(
  links: readonly OpportunitySourceLink[],
  sourcesById: ReadonlyMap<string, PublicSourceHealth>,
  opportunityLastCheckedAt: string | null | undefined,
): boolean {
  if (links.length === 0) return false;

  return links.every((link) => {
    if (!link.source_id) return false;
    return isConfirmedDeadOpportunitySource(
      sourcesById.get(link.source_id),
      opportunityLastCheckedAt,
      link.last_checked_at,
    );
  });
}

/**
 * Apply terminal-source suppression only when both source-link and source-health
 * lookups completed. These reads are an availability enhancement: if Supabase
 * times out, preserve the existing public evidence-filtered catalogue instead
 * of turning the entire jobs route into a 500 response.
 */
export function filterPublicOpportunityIdsBySourceHealth(input: {
  publicIds: readonly string[];
  linksByOpportunity: ReadonlyMap<string, readonly OpportunitySourceLink[]>;
  sourcesById: ReadonlyMap<string, PublicSourceHealth>;
  checkedAtByOpportunity: ReadonlyMap<string, string | null>;
  healthLookupSucceeded: boolean;
}): string[] {
  if (!input.healthLookupSucceeded) return [...input.publicIds];

  return input.publicIds.filter((id) => !isOpportunityOnlyBackedByDeadSources(
    input.linksByOpportunity.get(id) ?? [],
    input.sourcesById,
    input.checkedAtByOpportunity.get(id),
  ));
}
