export type PublicOpportunitySourceHealthResult = {
  suppressed_opportunity_ids: unknown;
};

export type PublicOpportunitySourceHealthLookup = (
  opportunityIds: string[],
) => Promise<unknown>;

/**
 * Apply server-verified dead-source suppression without granting the browser
 * role direct access to source provenance tables. Fail open only on lookup
 * failure so a transient health-check outage cannot break public surfaces.
 */
export async function filterPublicOpportunityIdsByServerHealth(
  publicIds: readonly string[],
  lookup: PublicOpportunitySourceHealthLookup,
): Promise<string[]> {
  if (publicIds.length === 0) return [];

  try {
    const result = await lookup([...publicIds]) as Partial<PublicOpportunitySourceHealthResult> | null;
    const suppressedIds = result?.suppressed_opportunity_ids;
    if (
      !Array.isArray(suppressedIds) ||
      suppressedIds.some((id) => typeof id !== "string")
    ) {
      throw new Error("Source-health lookup returned an invalid response");
    }

    const suppressed = new Set(suppressedIds as string[]);
    return publicIds.filter((id) => !suppressed.has(id));
  } catch (error) {
    console.warn(
      "[jobs] server-side source-health lookup failed; preserving evidence-filtered listings",
      error instanceof Error ? error.message : String(error),
    );
    return [...publicIds];
  }
}


export type PublicPulseOpportunityReference = {
  entity_type: string | null;
  entity_id: string | null;
};

/**
 * Filter opportunity-linked pulse rows against the public jobs IDs and a fresh
 * source-health lookup. This second check is intentional: a cached opportunities
 * query must not reintroduce a dead-source row into the homepage pulse feed.
 */
export async function filterPublicPulseRowsByServerHealth<T extends PublicPulseOpportunityReference>(
  pulseRows: readonly T[],
  publicOpportunityIds: ReadonlySet<string>,
  lookup: PublicOpportunitySourceHealthLookup,
): Promise<T[]> {
  const candidateIds = [
    ...new Set(
      pulseRows
        .filter(
          (row) =>
            row.entity_type === "opportunity" &&
            typeof row.entity_id === "string" &&
            publicOpportunityIds.has(row.entity_id),
        )
        .map((row) => row.entity_id as string),
    ),
  ];
  const liveIds = new Set(await filterPublicOpportunityIdsByServerHealth(candidateIds, lookup));

  return pulseRows.filter((row) => {
    if (row.entity_type !== "opportunity") return true;
    return (
      typeof row.entity_id === "string" &&
      publicOpportunityIds.has(row.entity_id) &&
      liveIds.has(row.entity_id)
    );
  });
}
