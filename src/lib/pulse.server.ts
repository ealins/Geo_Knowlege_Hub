import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isPublicOpportunityEvidence } from "@/lib/public-data";

type PulseEntityType = "opportunity" | "project" | "researcher" | "event" | "publication";

async function topicIdsForEntity(entityType: PulseEntityType, entityId: string): Promise<string[]> {
  if (entityType === "opportunity") {
    const { data } = await supabaseAdmin
      .from("opportunity_topics")
      .select("topic_id")
      .eq("opportunity_id", entityId);
    return (data ?? []).map((row) => row.topic_id);
  }
  if (entityType === "project") {
    const { data } = await supabaseAdmin
      .from("project_topics")
      .select("topic_id")
      .eq("project_id", entityId);
    return (data ?? []).map((row) => row.topic_id);
  }
  if (entityType === "researcher") {
    const { data } = await supabaseAdmin
      .from("researcher_topics")
      .select("topic_id")
      .eq("researcher_id", entityId);
    return (data ?? []).map((row) => row.topic_id);
  }
  if (entityType === "event") {
    const { data } = await supabaseAdmin
      .from("event_topics")
      .select("topic_id")
      .eq("event_id", entityId);
    return (data ?? []).map((row) => row.topic_id);
  }
  const { data } = await supabaseAdmin
    .from("publication_topics")
    .select("topic_id")
    .eq("publication_id", entityId);
  return (data ?? []).map((row) => row.topic_id);
}

type PulseRow = {
  category: "PHD" | "PROJECT" | "PAPER" | "EVENT" | "PEOPLE";
  title: string;
  summary: string | null;
  event_date: string;
  importance: number;
  link_url: string | null;
  source_url: string | null;
  verification_status:
    | "verified"
    | "auto_discovered"
    | "needs_review"
    | "possibly_outdated"
    | "closed"
    | "archived"
    | "unverified";
  confidence: "high" | "medium" | "low";
  is_demo: false;
  country: string | null;
  institution_id: string | null;
  researcher_id: string | null;
  entity_type: string;
  entity_id: string;
};

function dateOnly(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function institutionCountry(
  institutionId: string | null | undefined,
): Promise<string | null> {
  if (!institutionId) return null;
  const { data } = await supabaseAdmin
    .from("institutions")
    .select("country")
    .eq("id", institutionId)
    .eq("is_demo", false)
    .maybeSingle();
  return data?.country ?? null;
}

async function buildPulseRow(
  entityType: PulseEntityType,
  entityId: string,
): Promise<PulseRow | null> {
  if (entityType === "opportunity") {
    const { data } = await supabaseAdmin
      .from("opportunities")
      .select(
        "id, title, description, official_source_url, application_url, application_deadline, first_discovered_at, created_at, institution_id, country, opportunity_type, status, verification_status, confidence, is_demo",
      )
      .eq("id", entityId)
      .maybeSingle();
    if (!data || data.is_demo || !isPublicOpportunityEvidence(data)) return null;
    const country = data.country ?? (await institutionCountry(data.institution_id));
    const importance =
      data.status === "closing_soon"
        ? 100
        : data.status === "open" || data.status === "rolling"
          ? 90
          : 60;
    return {
      category: "PHD",
      title: data.title,
      summary: data.description?.slice(0, 700) ?? null,
      event_date: dateOnly(data.first_discovered_at ?? data.created_at),
      importance,
      link_url: data.application_url ?? data.official_source_url,
      source_url: data.official_source_url,
      verification_status: data.verification_status,
      confidence: data.confidence,
      is_demo: false,
      country,
      institution_id: data.institution_id,
      researcher_id: null,
      entity_type: "opportunity",
      entity_id: data.id,
    };
  }

  if (entityType === "project") {
    const { data } = await supabaseAdmin
      .from("projects")
      .select(
        "id, name, summary, website, created_at, start_date, institution_id, verification_status, confidence, is_demo",
      )
      .eq("id", entityId)
      .maybeSingle();
    if (!data || data.is_demo) return null;
    return {
      category: "PROJECT",
      title: data.name,
      summary: data.summary?.slice(0, 700) ?? null,
      event_date: dateOnly(data.start_date ?? data.created_at),
      importance: 75,
      link_url: data.website,
      source_url: data.website,
      verification_status: data.verification_status,
      confidence: data.confidence,
      is_demo: false,
      country: await institutionCountry(data.institution_id),
      institution_id: data.institution_id,
      researcher_id: null,
      entity_type: "project",
      entity_id: data.id,
    };
  }

  if (entityType === "researcher") {
    const { data } = await supabaseAdmin
      .from("researchers")
      .select(
        "id, full_name, research_summary, official_profile_url, created_at, institution_id, verification_status, is_demo",
      )
      .eq("id", entityId)
      .maybeSingle();
    if (!data || data.is_demo) return null;
    return {
      category: "PEOPLE",
      title: data.full_name,
      summary: data.research_summary?.slice(0, 700) ?? null,
      event_date: dateOnly(data.created_at),
      importance: 55,
      link_url: data.official_profile_url,
      source_url: data.official_profile_url,
      verification_status: data.verification_status,
      confidence: data.verification_status === "verified" ? "high" : "medium",
      is_demo: false,
      country: await institutionCountry(data.institution_id),
      institution_id: data.institution_id,
      researcher_id: data.id,
      entity_type: "researcher",
      entity_id: data.id,
    };
  }

  if (entityType === "event") {
    const { data } = await supabaseAdmin
      .from("events")
      .select(
        "id, title, summary, website, created_at, start_date, country, verification_status, confidence, is_demo",
      )
      .eq("id", entityId)
      .maybeSingle();
    if (!data || data.is_demo) return null;
    return {
      category: "EVENT",
      title: data.title,
      summary: data.summary?.slice(0, 700) ?? null,
      event_date: dateOnly(data.start_date ?? data.created_at),
      importance: 70,
      link_url: data.website,
      source_url: data.website,
      verification_status: data.verification_status,
      confidence: data.confidence,
      is_demo: false,
      country: data.country,
      institution_id: null,
      researcher_id: null,
      entity_type: "event",
      entity_id: data.id,
    };
  }

  const { data } = await supabaseAdmin
    .from("publications")
    .select(
      "id, title, abstract, landing_url, publication_date, created_at, institution_id, verification_status, confidence, citation_count, is_demo",
    )
    .eq("id", entityId)
    .maybeSingle();
  if (!data || data.is_demo) return null;
  return {
    category: "PAPER",
    title: data.title,
    summary: data.abstract?.slice(0, 700) ?? null,
    event_date: dateOnly(data.publication_date ?? data.created_at),
    importance: Math.min(85, 55 + Math.floor(Math.log10((data.citation_count ?? 0) + 1) * 10)),
    link_url: data.landing_url,
    source_url: data.landing_url,
    verification_status: data.verification_status,
    confidence: data.confidence,
    is_demo: false,
    country: await institutionCountry(data.institution_id),
    institution_id: data.institution_id,
    researcher_id: null,
    entity_type: "publication",
    entity_id: data.id,
  };
}

/** Idempotent projection of one canonical real entity into the homepage pulse feed. */
export async function ensurePulseForEntity(
  entityType: PulseEntityType,
  entityId: string,
): Promise<boolean> {
  const row = await buildPulseRow(entityType, entityId);
  if (!row) return false;
  const topicIds = await topicIdsForEntity(entityType, entityId);
  // The public pulse is a domain signal, not a generic news feed. Untagged
  // records stay in the canonical tables until relevance has been established.
  if (topicIds.length === 0) return false;

  const { data: existing } = await supabaseAdmin
    .from("pulse_events")
    .select("id")
    .eq("entity_type", row.entity_type)
    .eq("entity_id", row.entity_id)
    .maybeSingle();

  let pulseId = existing?.id ?? null;
  if (pulseId) {
    const { error } = await supabaseAdmin
      .from("pulse_events")
      .update(row as never)
      .eq("id", pulseId);
    if (error) return false;
  } else {
    const { data: inserted, error } = await supabaseAdmin
      .from("pulse_events")
      .insert(row as never)
      .select("id")
      .maybeSingle();
    if (error || !inserted) return false;
    pulseId = inserted.id;
  }

  const { error: topicError } = await supabaseAdmin
    .from("pulse_event_topics")
    .upsert(topicIds.map((topic_id) => ({ pulse_event_id: pulseId!, topic_id })) as never, {
      onConflict: "pulse_event_id,topic_id",
      ignoreDuplicates: true,
    });
  return !topicError;
}

/**
 * Backfills the public pulse from existing real canonical records. Safe to run
 * repeatedly; ensurePulseForEntity de-duplicates by entity_type + entity_id.
 */
export async function backfillPulseEvents(limitPerType = 120): Promise<{
  checked: number;
  projected: number;
}> {
  const specs: Array<{
    type: PulseEntityType;
    table: "opportunities" | "projects" | "researchers" | "events" | "publications";
    order: string;
  }> = [
    { type: "opportunity", table: "opportunities", order: "created_at" },
    { type: "project", table: "projects", order: "created_at" },
    { type: "researcher", table: "researchers", order: "created_at" },
    { type: "event", table: "events", order: "created_at" },
    { type: "publication", table: "publications", order: "created_at" },
  ];

  let checked = 0;
  let projected = 0;
  for (const spec of specs) {
    const { data } = await supabaseAdmin
      .from(spec.table)
      .select("id")
      .eq("is_demo", false)
      .order(spec.order, { ascending: false })
      .limit(limitPerType);
    for (const row of data ?? []) {
      checked += 1;
      if (await ensurePulseForEntity(spec.type, row.id)) projected += 1;
    }
  }
  return { checked, projected };
}
