// Canonical writers for the non-vacancy entity types. Every row written here
// passed: deterministic gate -> Nemotron extraction -> strict validation ->
// controlled topic classification. Provenance is always recorded.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { NVIDIA_MODEL } from "../llm-config.server";
import { eventGate, programmeGate, projectGate, researcherGate } from "../llm-gating.server";
import {
  extractEvent,
  extractProgramme,
  extractProject,
  extractResearcher,
} from "./entities.server";
import { classifyTopics, topicIdsFor } from "./topics.server";
import type { ExtractionInput } from "./engine.server";
import { normalizeStructuredNonVacancy } from "./structured.server";

export type CanonicalResult = {
  status: "NORMALIZED" | "SKIPPED" | "FAILED";
  reason?: string | undefined;
  entity_id?: string | undefined;
};

export type RawRecord = {
  id: string;
  final_url: string | null;
  page_title: string | null;
  text_content: string | null;
  classification: string | null;
  institution_id: string | null;
  source_id: string | null;
  content_hash: string | null;
  payload?: unknown;
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function sha6(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 6);
}

/** Keep slugs unique without ever merging two distinct records. */
async function uniqueSlug(
  table: "projects" | "courses" | "researchers" | "events",
  base: string,
  url: string,
  keepId?: string,
) {
  const slug = base || (await sha6(url));
  const { data } = await supabaseAdmin.from(table).select("id").eq("slug", slug).maybeSingle();
  if (!data || data.id === keepId) return slug;
  return `${slug.slice(0, 70)}-${await sha6(url)}`;
}

async function linkTopics(
  table: "project_topics" | "course_topics" | "researcher_topics" | "event_topics",
  column: "project_id" | "course_id" | "researcher_id" | "event_id",
  entityId: string,
  topicNames: string[],
  weighted: boolean,
): Promise<number> {
  const ids = await topicIdsFor(topicNames);
  if (ids.length === 0) return 0;
  const rows = ids.map((topic_id) =>
    weighted ? { [column]: entityId, topic_id, weight: 1 } : { [column]: entityId, topic_id },
  );
  await supabaseAdmin
    .from(table)
    .upsert(rows as never, { onConflict: `${column},topic_id`, ignoreDuplicates: true });
  return ids.length;
}

async function recordEvidence(input: {
  entityType: string;
  entityId: string;
  raw: RawRecord;
  claim: string;
  sourceType: string;
}): Promise<void> {
  const { data } = await supabaseAdmin
    .from("record_sources")
    .select("id")
    .eq("entity_type", input.entityType)
    .eq("entity_id", input.entityId)
    .eq("source_url", input.raw.final_url ?? "")
    .maybeSingle();
  const evidence = {
    source_id: input.raw.source_id,
    source_url: input.raw.final_url ?? "",
    source_type: input.sourceType as never,
    original_title: input.raw.page_title,
    claim: input.claim,
    verification_status: "auto_discovered" as never,
    confidence: "medium" as never,
    is_primary: true,
    last_checked_at: new Date().toISOString(),
  };
  if (data) {
    await supabaseAdmin.from("record_sources").update(evidence).eq("id", data.id);
    return;
  }
  await supabaseAdmin.from("record_sources").insert({
    entity_type: input.entityType,
    entity_id: input.entityId,
    ...evidence,
  });
}

async function logChange(input: {
  changeType: string;
  entityType: string;
  entityId: string;
  raw: RawRecord;
  title: string;
}): Promise<void> {
  await supabaseAdmin.from("academic_changes").insert({
    change_type: input.changeType,
    entity_type: input.entityType,
    entity_id: input.entityId,
    source_id: input.raw.source_id,
    title: input.title,
    summary: `Discovered on ${input.raw.final_url}`,
    details: { extracted_by: "NVIDIA_NEMOTRON", model: NVIDIA_MODEL } as never,
  });
}

function projectStatus(start: string | null, end: string | null): string {
  const today = new Date().toISOString().slice(0, 10);
  if (end && end < today) {
    const ended = new Date(`${end}T00:00:00Z`).getTime();
    return Date.now() - ended < 365 * 86_400_000 ? "recently_completed" : "completed";
  }
  if (start && start > today) return "planned";
  if (start || end) return "active";
  return "unknown";
}

const DEGREE_TYPE: Record<string, "Master" | "Doctoral"> = {
  master: "Master",
  doctoral: "Doctoral",
};

function isEventListingUrl(value: string): boolean {
  try {
    const path = new URL(value).pathname.replace(/\/+$/, "").toLowerCase();
    return (
      path === "/events" ||
      path === "/event" ||
      path === "/calendar" ||
      path === "/calendar/events" ||
      /\/calendar\/\d{4}$/.test(path) ||
      /\/events\/(?:calendar|archive|upcoming|past|all)$/.test(path)
    );
  } catch {
    return true;
  }
}

/**
 * Extract and persist one canonical record for a non-vacancy raw page.
 * Returns SKIPPED (never FAILED) whenever the page simply is not a record.
 */
export async function normalizeNonVacancy(
  raw: RawRecord,
  cleanTitle: string,
): Promise<CanonicalResult> {
  const url = raw.final_url ?? "";
  const text = raw.text_content ?? "";
  const input: ExtractionInput = {
    url,
    title: cleanTitle,
    text,
    sourceId: raw.source_id,
    rawRecordId: raw.id,
    contentHash: raw.content_hash,
  };

  // Structured metadata is the cheapest trustworthy path. Accept only strict,
  // single-entity schema.org records; ambiguous or absent metadata falls through
  // to the existing deterministic gate + Nemotron + validation pipeline.
  const structured = await normalizeStructuredNonVacancy(raw, cleanTitle);
  if (structured) return structured;

  switch (raw.classification) {
    case "PROJECT": {
      const gate = projectGate(url, cleanTitle, text);
      if (!gate.ok) return { status: "SKIPPED", reason: `project gate: ${gate.reason}` };
      const out = await extractProject(input);
      if (!out.value)
        return {
          status: "SKIPPED",
          reason: `project extraction unusable: ${out.errorCode ?? "no result"}`,
        };
      const ex = out.value;
      if (!ex.is_single_real_project || !ex.title) {
        return {
          status: "SKIPPED",
          reason: `engine rejected project: ${ex.rejection_reason ?? "not a single project"}`,
        };
      }
      if (!raw.institution_id)
        return { status: "SKIPPED", reason: "missing institution for project" };

      const { data: existing } = await supabaseAdmin
        .from("projects")
        .select("id")
        .eq("website", url)
        .maybeSingle();
      const slug = await uniqueSlug("projects", slugify(ex.title), url, existing?.id);
      const payload = {
        name: ex.title.slice(0, 300),
        slug,
        acronym: ex.acronym,
        institution_id: raw.institution_id,
        start_date: ex.start_date,
        end_date: ex.end_date,
        status: projectStatus(ex.start_date, ex.end_date) as never,
        funding_organization: ex.funders[0] ?? ex.funding_programme,
        funding_amount: ex.funding_amount,
        funding_currency: ex.funding_currency,
        website: url,
        summary: ex.summary,
        verification_status: "auto_discovered" as never,
        confidence: (ex.confidence >= 0.75 ? "medium" : "low") as never,
        is_demo: false,
      };
      const entityId = await upsert("projects", existing?.id, payload);
      if (!entityId) return { status: "FAILED", reason: "could not write project" };
      if (!existing?.id)
        await logChange({
          changeType: "NEW_PROJECT",
          entityType: "project",
          entityId,
          raw,
          title: payload.name,
        });
      await recordEvidence({
        entityType: "project",
        entityId,
        raw,
        claim: "Project page published on the institution's own website",
        sourceType: "project",
      });
      await applyTopics({
        input,
        fallback: ex.topics,
        table: "project_topics",
        column: "project_id",
        entityId,
        weighted: false,
      });
      return { status: "NORMALIZED", entity_id: entityId };
    }

    case "PROGRAMME":
    case "COURSE": {
      const gate = programmeGate(url, cleanTitle, text);
      if (!gate.ok) return { status: "SKIPPED", reason: `programme gate: ${gate.reason}` };
      const out = await extractProgramme(input);
      if (!out.value)
        return {
          status: "SKIPPED",
          reason: `programme extraction unusable: ${out.errorCode ?? "no result"}`,
        };
      const ex = out.value;
      if (!ex.is_single_real_programme || !ex.name) {
        return {
          status: "SKIPPED",
          reason: `engine rejected programme: ${ex.rejection_reason ?? "not a single programme"}`,
        };
      }
      if (!raw.institution_id)
        return { status: "SKIPPED", reason: "missing institution for programme" };
      if (ex.degree_level !== "master" && ex.degree_level !== "doctoral") {
        return { status: "SKIPPED", reason: "programme is not Master's or Doctoral" };
      }

      const { data: existing } = await supabaseAdmin
        .from("courses")
        .select("id")
        .eq("website", url)
        .maybeSingle();
      const slug = await uniqueSlug("courses", slugify(ex.name), url, existing?.id);
      const payload = {
        title: ex.name.slice(0, 300),
        slug,
        degree_type: ex.degree_level ? (DEGREE_TYPE[ex.degree_level] ?? null) : null,
        institution_id: raw.institution_id,
        language: ex.language,
        duration: ex.duration,
        website: url,
        summary: ex.summary,
        verification_status: "auto_discovered" as never,
        is_demo: false,
      };
      const entityId = await upsert("courses", existing?.id, payload);
      if (!entityId) return { status: "FAILED", reason: "could not write programme" };
      if (!existing?.id)
        await logChange({
          changeType: "NEW_PROGRAMME",
          entityType: "course",
          entityId,
          raw,
          title: payload.title,
        });
      await recordEvidence({
        entityType: "course",
        entityId,
        raw,
        claim: "Degree programme page published on the institution's own website",
        sourceType: "institution",
      });
      await applyTopics({
        input,
        fallback: ex.topics,
        table: "course_topics",
        column: "course_id",
        entityId,
        weighted: false,
      });
      return { status: "NORMALIZED", entity_id: entityId };
    }

    case "RESEARCHER": {
      const gate = researcherGate(url, cleanTitle, text);
      if (!gate.ok) return { status: "SKIPPED", reason: `researcher gate: ${gate.reason}` };
      const out = await extractResearcher(input);
      if (!out.value)
        return {
          status: "SKIPPED",
          reason: `researcher extraction unusable: ${out.errorCode ?? "no result"}`,
        };
      const ex = out.value;
      if (!ex.is_single_real_profile || !ex.full_name) {
        return {
          status: "SKIPPED",
          reason: `engine rejected profile: ${ex.rejection_reason ?? "not a single profile"}`,
        };
      }
      if (!raw.institution_id)
        return { status: "SKIPPED", reason: "missing institution for researcher" };

      // ORCID is the strongest identity key; fall back to the profile URL.
      let existingId: string | undefined;
      if (ex.orcid) {
        const { data } = await supabaseAdmin
          .from("researchers")
          .select("id")
          .eq("orcid", ex.orcid)
          .maybeSingle();
        existingId = data?.id;
      }
      if (!existingId) {
        const { data } = await supabaseAdmin
          .from("researchers")
          .select("id")
          .eq("official_profile_url", url)
          .maybeSingle();
        existingId = data?.id;
      }
      const slug = await uniqueSlug("researchers", slugify(ex.full_name), url, existingId);
      const payload = {
        full_name: ex.full_name.slice(0, 200),
        slug,
        normalized_name: ex.full_name.toLowerCase().slice(0, 200),
        institution_id: raw.institution_id,
        academic_title: ex.academic_title,
        current_position: ex.current_position,
        orcid: ex.orcid,
        official_profile_url: url,
        research_summary: ex.summary,
        active: true,
        verification_status: "auto_discovered" as never,
        is_demo: false,
      };
      const entityId = await upsert("researchers", existingId, payload);
      if (!entityId) return { status: "FAILED", reason: "could not write researcher" };
      if (!existingId)
        await logChange({
          changeType: "NEW_RESEARCHER",
          entityType: "researcher",
          entityId,
          raw,
          title: payload.full_name,
        });
      await recordEvidence({
        entityType: "researcher",
        entityId,
        raw,
        claim: "Staff profile published on the institution's own website",
        sourceType: "institution",
      });
      await applyTopics({
        input,
        fallback: ex.research_areas,
        table: "researcher_topics",
        column: "researcher_id",
        entityId,
        weighted: true,
      });
      return { status: "NORMALIZED", entity_id: entityId };
    }

    case "EVENT": {
      const gate = eventGate(url, cleanTitle, text);
      if (!gate.ok) return { status: "SKIPPED", reason: `event gate: ${gate.reason}` };
      const out = await extractEvent(input);
      if (!out.value)
        return {
          status: "SKIPPED",
          reason: `event extraction unusable: ${out.errorCode ?? "no result"}`,
        };
      const ex = out.value;
      if (!ex.is_single_real_event || !ex.title) {
        return {
          status: "SKIPPED",
          reason: `engine rejected event: ${ex.rejection_reason ?? "not a single event"}`,
        };
      }

      if (!ex.event_url || isEventListingUrl(ex.event_url)) {
        return { status: "SKIPPED", reason: "event has no exact event URL" };
      }

      // Lean filter: retain only explicitly dated events starting between today
      // and three calendar months from today (UTC).
      if (!ex.start_date) {
        return { status: "SKIPPED", reason: "event has no start date" };
      }
      const today = new Date().toISOString().slice(0, 10);
      if (ex.start_date < today) {
        return { status: "SKIPPED", reason: "event has already started" };
      }
      const horizon = new Date(`${today}T00:00:00Z`);
      horizon.setUTCMonth(horizon.getUTCMonth() + 3);
      if (ex.start_date > horizon.toISOString().slice(0, 10)) {
        return { status: "SKIPPED", reason: "event is too far in the future" };
      }

      const { data: existingBySource } = await supabaseAdmin
        .from("events")
        .select("id")
        .eq("source", url)
        .eq("title", ex.title)
        .maybeSingle();
      const { data: existingByWebsite } = await supabaseAdmin
        .from("events")
        .select("id")
        .eq("website", ex.event_url)
        .maybeSingle();
      const existing = existingByWebsite ?? existingBySource;
      const slug = await uniqueSlug("events", slugify(ex.title), url, existing?.id);

      const payload = {
        title: ex.title.slice(0, 300),
        slug,
        organization: ex.organizer,
        location: ex.location,
        country: ex.country,
        start_date: ex.start_date,
        end_date: ex.end_date,
        abstract_deadline: ex.abstract_deadline,
        paper_deadline: ex.paper_deadline,
        registration_deadline: ex.registration_deadline,
        // Prefer the exact event page extracted from the source page. The raw
        // page remains provenance in `source`, so listing/calendar pages do
        // not become the user's click destination.
        website: ex.event_url ?? url,
        summary: ex.summary,
        source: url,
        event_kind: ex.event_kind ?? "other",
        verification_status: "auto_discovered" as never,
        confidence: (ex.confidence >= 0.75 ? "medium" : "low") as never,
        is_demo: false,
      };
      const entityId = await upsert("events", existing?.id, payload);
      if (!entityId) return { status: "FAILED", reason: "could not write event" };
      if (!existing?.id)
        await logChange({
          changeType: "NEW_EVENT",
          entityType: "event",
          entityId,
          raw,
          title: payload.title,
        });
      await recordEvidence({
        entityType: "event",
        entityId,
        raw,
        claim: "Event page published by the organiser",
        sourceType: "conference",
      });
      if (raw.institution_id) {
        await supabaseAdmin
          .from("event_institutions")
          .upsert({ event_id: entityId, institution_id: raw.institution_id } as never, {
            onConflict: "event_id,institution_id",
            ignoreDuplicates: true,
          });
      }
      await applyTopics({
        input,
        fallback: ex.topics,
        table: "event_topics",
        column: "event_id",
        entityId,
        weighted: false,
      });
      return { status: "NORMALIZED", entity_id: entityId };
    }

    default:
      return {
        status: "SKIPPED",
        reason: `no extractor for classification ${raw.classification ?? "UNKNOWN"}`,
      };
  }
}

async function upsert(
  table: "projects" | "courses" | "researchers" | "events",
  existingId: string | undefined,
  payload: Record<string, unknown>,
): Promise<string | undefined> {
  if (existingId) {
    const { error } = await supabaseAdmin
      .from(table)
      .update(payload as never)
      .eq("id", existingId);
    if (error) return undefined;
    return existingId;
  }
  const { data } = await supabaseAdmin
    .from(table)
    .insert(payload as never)
    .select("id")
    .maybeSingle();
  return (data as { id?: string } | null)?.id;
}

/** Controlled classification first; extractor topic guesses are the fallback. */
async function applyTopics(args: {
  input: ExtractionInput;
  fallback: string[];
  table: "project_topics" | "course_topics" | "researcher_topics" | "event_topics";
  column: "project_id" | "course_id" | "researcher_id" | "event_id";
  entityId: string;
  weighted: boolean;
}): Promise<void> {
  const classified = await classifyTopics(args.input);
  const names = classified.value?.relevant ? classified.value.topics : args.fallback;
  await linkTopics(args.table, args.column, args.entityId, names, args.weighted);
}
