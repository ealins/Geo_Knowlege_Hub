export type PublicOpportunitySourceHealthResult = {
  suppressed_opportunity_ids: unknown;
};

export type PublicOpportunitySourceHealthLookup = (
  opportunityIds: string[],
) => Promise<unknown>;

/**
 * Apply server-verified dead-source suppression without granting the browser
 * role direct access to source provenance tables. Fail open only on lookup
 * failure so a transient health-check outage cannot break the jobs catalogue.
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
