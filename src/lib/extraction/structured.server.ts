// Deterministic structured-metadata fast path.
//
// Goal: keep obvious schema.org/JSON-LD records out of the LLM path. The
// parser stores a compact snapshot at fetch time; normalization then accepts
// only strict, single-entity records and writes them with normal provenance.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { topicIdsFor } from "./topics.server";

export type StructuredNode = Record<string, unknown>;
export type StructuredSnapshot = {
  jsonld: StructuredNode[];
  meta: Record<string, string>;
  types: string[];
};

export type StructuredRawRecord = {
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

export type StructuredCanonicalResult = {
  status: "NORMALIZED" | "SKIPPED" | "FAILED";
  reason?: string | undefined;
  entity_id?: string | undefined;
  entity_action?: "created" | "updated" | undefined;
};

export type StructuredVacancy = {
  title: string | null;
  description: string | null;
  application_deadline: string | null;
  start_date: string | null;
  city: string | null;
  country: string | null;
  application_url: string | null;
  employment_type: string | null;
  organization: string | null;
};

const MAX_JSONLD_BLOCKS = 30;
const MAX_JSONLD_CHARS = 24_000;

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function compactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value))
    return value
      .slice(0, 12)
      .map((v) => compactValue(v, depth + 1))
      .filter((v) => v !== undefined);
  if (typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    const compacted = compactValue(nested, depth + 1);
    if (compacted !== undefined) out[key] = compacted;
  }
  return out;
}

function flattenTopLevel(value: unknown, out: StructuredNode[]): void {
  if (out.length >= MAX_JSONLD_BLOCKS) return;
  if (Array.isArray(value)) {
    for (const item of value) flattenTopLevel(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  const graph = obj["@graph"];
  if (Array.isArray(graph)) {
    for (const item of graph) flattenTopLevel(item, out);
  }
  if (obj["@type"] || obj["@id"] || obj["name"] || obj["headline"]) {
    const compacted = compactValue(obj);
    if (compacted && typeof compacted === "object" && !Array.isArray(compacted))
      out.push(compacted as StructuredNode);
  }
}

function extractMeta(html: string, pageUrl: string): Record<string, string> {
  const wanted = new Set([
    "og:title",
    "og:type",
    "og:url",
    "article:published_time",
    "profile:first_name",
    "profile:last_name",
  ]);
  const out: Record<string, string> = { page_url: pageUrl };
  const re =
    /<meta\b[^>]*(?:property|name)=["']([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>|<meta\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const key = (m[1] ?? m[4] ?? "").toLowerCase();
    const value = decodeHtmlEntities(m[2] ?? m[3] ?? "").trim();
    if (wanted.has(key) && value) out[key] = value.slice(0, 1000);
  }
  return out;
}

/** Extract a compact JSON-LD/meta snapshot before script tags are stripped. */
export function extractStructuredSnapshot(
  html: string,
  pageUrl: string,
): StructuredSnapshot | null {
  const nodes: StructuredNode[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  let chars = 0;
  while (
    (m = re.exec(html)) !== null &&
    nodes.length < MAX_JSONLD_BLOCKS &&
    chars < MAX_JSONLD_CHARS
  ) {
    const raw = decodeHtmlEntities((m[1] ?? "").trim());
    if (!raw) continue;
    chars += raw.length;
    try {
      flattenTopLevel(JSON.parse(raw) as unknown, nodes);
    } catch {
      // Invalid publisher JSON-LD is ignored rather than repaired or guessed.
    }
  }
  const types = Array.from(new Set(nodes.flatMap((node) => nodeTypes(node))));
  const meta = extractMeta(html, pageUrl);
  if (nodes.length === 0 && Object.keys(meta).length <= 1) return null;
  return { jsonld: nodes.slice(0, MAX_JSONLD_BLOCKS), meta, types };
}

function snapshotFromPayload(payload: unknown): StructuredSnapshot | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const structured = (payload as Record<string, unknown>)["structured"];
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return null;
  const obj = structured as Record<string, unknown>;
  const jsonld = Array.isArray(obj["jsonld"])
    ? obj["jsonld"]
        .filter(
          (v): v is StructuredNode => Boolean(v) && typeof v === "object" && !Array.isArray(v),
        )
        .slice(0, MAX_JSONLD_BLOCKS)
    : [];
  const metaRaw = obj["meta"];
  const meta: Record<string, string> = {};
  if (metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)) {
    for (const [k, v] of Object.entries(metaRaw as Record<string, unknown>))
      if (typeof v === "string") meta[k] = v;
  }
  const types = Array.isArray(obj["types"])
    ? obj["types"].filter((v): v is string => typeof v === "string")
    : [];
  return jsonld.length || types.length ? { jsonld, meta, types } : null;
}

function nodeTypes(node: StructuredNode): string[] {
  const value = node["@type"];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

function typeMatches(node: StructuredNode, wanted: RegExp): boolean {
  return nodeTypes(node).some((t) => wanted.test(t));
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  for (const key of ["name", "text", "value", "url", "@id"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string")
    return value
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
  if (!Array.isArray(value)) return [];
  return value
    .map(textValue)
    .filter((v): v is string => Boolean(v))
    .slice(0, 20);
}

function nestedObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isoDate(value: unknown): string | null {
  const raw = textValue(value);
  if (!raw) return null;
  const direct = /^(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1];
  if (direct) return direct;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function absoluteUrl(value: unknown, pageUrl: string): string | null {
  const raw = textValue(value);
  if (!raw) return null;
  try {
    return new URL(raw, pageUrl).toString();
  } catch {
    return null;
  }
}

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

async function recordEvidence(input: {
  entityType: string;
  entityId: string;
  raw: StructuredRawRecord;
  claim: string;
  sourceType: string;
}): Promise<void> {
  const sourceUrl = input.raw.final_url ?? "";
  const { data } = await supabaseAdmin
    .from("record_sources")
    .select("id")
    .eq("entity_type", input.entityType)
    .eq("entity_id", input.entityId)
    .eq("source_url", sourceUrl)
    .maybeSingle();
  const now = new Date().toISOString();
  const evidence = {
    source_id: input.raw.source_id,
    source_url: sourceUrl,
    source_type: input.sourceType as never,
    original_title: input.raw.page_title,
    claim: input.claim,
    verification_status: "verified" as never,
    confidence: "high" as never,
    is_primary: true,
    last_checked_at: now,
    last_verified_at: now,
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

async function logStructuredChange(input: {
  changeType: string;
  entityType: string;
  entityId: string;
  raw: StructuredRawRecord;
  title: string;
}): Promise<void> {
  await supabaseAdmin.from("academic_changes").insert({
    change_type: input.changeType,
    entity_type: input.entityType,
    entity_id: input.entityId,
    source_id: input.raw.source_id,
    title: input.title,
    summary: `Discovered from structured metadata on ${input.raw.final_url}`,
    details: { extracted_by: "STRUCTURED_METADATA", format: "schema.org/JSON-LD" } as never,
  });
}

function keywordsFrom(node: StructuredNode): string[] {
  return [...stringList(node["keywords"]), ...stringList(node["about"])].slice(0, 20);
}

/**
 * Person JSON-LD is also commonly used for article authors, press contacts,
 * and page editors. Those are not researcher profiles. Require the page title
 * to identify the same person and reject known editorial/listing routes before
 * creating a canonical researcher.
 */
function researcherProfileGate(
  raw: StructuredRawRecord,
  name: string,
  node: StructuredNode,
): string | null {
  let path: string;
  try {
    path = new URL(raw.final_url ?? "").pathname.toLowerCase();
  } catch {
    return "researcher source URL is invalid";
  }
  if (
    /\/(?:news|live|media-contacts|recently-published|press|press-releases|blog|blogs|articles|stories|people-of-nasa)(?:\/|$)/i.test(path)
  ) {
    return "editorial, news, contact, or public-story page is not a researcher profile";
  }
  if (
    /\/(?:people|staff|team|faculty|researchers|profiles?|persons?)\/?$/i.test(path)
  ) {
    return "generic people listing is not a researcher profile";
  }

  const normalize = (value: string) =>
    value.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  const normalizedName = normalize(name);
  const normalizedTitle = normalize(raw.page_title ?? "");
  if (!normalizedName || !normalizedTitle.includes(normalizedName)) {
    return "page title does not identify the JSON-LD person";
  }

  const affiliation = nestedObject(node["affiliation"] ?? node["worksFor"]);
  const hasProfileSignal = Boolean(
    textValue(node["jobTitle"]) ||
    textValue(node["description"]) ||
    textValue(node["honorificPrefix"]) ||
    textValue(affiliation?.["name"]) ||
    stringList(node["sameAs"]).some((value) => /orcid\.org\//i.test(value)),
  );
  if (!hasProfileSignal) return "person metadata lacks researcher-profile signals";
  return null;
}

async function linkExactTopics(
  table: "project_topics" | "course_topics" | "researcher_topics" | "event_topics",
  column: "project_id" | "course_id" | "researcher_id" | "event_id",
  entityId: string,
  labels: string[],
  weighted: boolean,
): Promise<void> {
  const ids = await topicIdsFor(labels);
  if (!ids.length) return;
  const rows = ids.map((topic_id) =>
    weighted ? { [column]: entityId, topic_id, weight: 1 } : { [column]: entityId, topic_id },
  );
  await supabaseAdmin
    .from(table)
    .upsert(rows as never, { onConflict: `${column},topic_id`, ignoreDuplicates: true });
}

export function structuredVacancyFromPayload(
  payload: unknown,
  pageUrl: string,
): StructuredVacancy | null {
  const snapshot = snapshotFromPayload(payload);
  if (!snapshot) return null;
  const jobs = snapshot.jsonld.filter((node) => typeMatches(node, /^JobPosting$/i));
  if (jobs.length !== 1) return null;
  const node = jobs[0];
  if (!node) return null;
  const title = textValue(node["title"]) ?? textValue(node["name"]);
  if (!title) return null;
  const location = nestedObject(node["jobLocation"]);
  const address = nestedObject(location?.["address"]);
  const org = nestedObject(node["hiringOrganization"]);
  return {
    title,
    description: textValue(node["description"]),
    application_deadline: isoDate(node["validThrough"]),
    start_date: isoDate(node["jobStartDate"] ?? node["startDate"]),
    city: textValue(address?.["addressLocality"]),
    country: textValue(address?.["addressCountry"]),
    application_url: absoluteUrl(node["url"] ?? node["sameAs"], pageUrl) ?? pageUrl,
    employment_type: textValue(node["employmentType"]),
    organization: textValue(org?.["name"] ?? node["hiringOrganization"]),
  };
}

function degreeType(node: StructuredNode): string | null {
  const text =
    `${textValue(node["educationalCredentialAwarded"]) ?? ""} ${textValue(node["name"]) ?? ""}`.toLowerCase();
  if (/master|msc|m\.sc/.test(text)) return "Master";
  if (/bachelor|bsc|b\.sc/.test(text)) return "Bachelor";
  if (/doctoral|doctorate|phd|ph\.d/.test(text)) return "Doctoral";
  if (/certificate/.test(text)) return "Certificate";
  return null;
}

function eventLocation(node: StructuredNode): { location: string | null; country: string | null } {
  const locObj = nestedObject(node["location"]);
  const address = nestedObject(locObj?.["address"]);
  return {
    location: textValue(locObj?.["name"] ?? node["location"]),
    country: textValue(address?.["addressCountry"]),
  };
}

/**
 * Persist strict, single-entity JSON-LD records. Returns null when structured
 * metadata is absent/ambiguous, which deliberately falls through to Nemotron.
 */
export async function normalizeStructuredNonVacancy(
  raw: StructuredRawRecord,
  cleanTitle: string,
): Promise<StructuredCanonicalResult | null> {
  const snapshot = snapshotFromPayload(raw.payload);
  if (!snapshot) return null;
  const url = raw.final_url ?? "";

  if (raw.classification === "EVENT") {
    const events = snapshot.jsonld.filter((node) => typeMatches(node, /Event$/i));
    if (events.length !== 1) return null;
    const node = events[0];
    if (!node) return null;
    const title = textValue(node["name"]) ?? cleanTitle;
    const start = isoDate(node["startDate"]);
    if (!title || !start) return null;
    const end = isoDate(node["endDate"]);
    const loc = eventLocation(node);
    const organizer = textValue(nestedObject(node["organizer"])?.["name"] ?? node["organizer"]);
    const { data: existing } = await supabaseAdmin
      .from("events")
      .select("id")
      .eq("website", url)
      .maybeSingle();
    const slug = await uniqueSlug("events", slugify(title), url, existing?.id);
    const payload = {
      title: title.slice(0, 300),
      slug,
      organization: organizer,
      location: loc.location,
      country: loc.country,
      start_date: start,
      end_date: end,
      website: absoluteUrl(node["url"], url) ?? url,
      summary: textValue(node["description"])?.slice(0, 2000) ?? null,
      source: url,
      event_kind: "other",
      verification_status: "verified" as never,
      confidence: "high" as never,
      last_verified_at: new Date().toISOString(),
      is_demo: false,
    };
    let entityId = existing?.id;
    if (entityId)
      await supabaseAdmin
        .from("events")
        .update(payload as never)
        .eq("id", entityId);
    else
      entityId = (
        await supabaseAdmin
          .from("events")
          .insert(payload as never)
          .select("id")
          .maybeSingle()
      ).data?.id;
    if (!entityId) return { status: "FAILED", reason: "structured event write failed" };
    if (!existing?.id)
      await logStructuredChange({
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
      claim: "Event details published as schema.org JSON-LD on the source page",
      sourceType: "conference",
    });
    await linkExactTopics("event_topics", "event_id", entityId, keywordsFrom(node), false);
    return { status: "NORMALIZED", entity_id: entityId, entity_action: existing?.id ? "updated" : "created", reason: "structured metadata fast path" };
  }

  if (raw.classification === "RESEARCHER") {
    if (!raw.institution_id) return null;
    const people = snapshot.jsonld.filter((node) => typeMatches(node, /^Person$/i));
    if (people.length !== 1) return null;
    const node = people[0];
    if (!node) return null;
    const name = textValue(node["name"]);
    if (!name || name.split(/\s+/).length < 2) return null;
    const profileGate = researcherProfileGate(raw, name, node);
    if (profileGate) return { status: "SKIPPED", reason: profileGate };
    const profileUrl = absoluteUrl(node["url"] ?? node["sameAs"], url) ?? url;
    const sameAs = stringList(node["sameAs"]);
    const orcid =
      sameAs
        .map((v) => /orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i.exec(v)?.[1] ?? null)
        .find(Boolean) ?? null;
    let existingId: string | undefined;
    if (orcid)
      existingId = (
        await supabaseAdmin.from("researchers").select("id").eq("orcid", orcid).maybeSingle()
      ).data?.id;
    if (!existingId)
      existingId = (
        await supabaseAdmin
          .from("researchers")
          .select("id")
          .eq("official_profile_url", profileUrl)
          .maybeSingle()
      ).data?.id;
    const slug = await uniqueSlug("researchers", slugify(name), url, existingId);
    const affiliation = nestedObject(node["affiliation"] ?? node["worksFor"]);
    const payload = {
      full_name: name.slice(0, 200),
      slug,
      normalized_name: name.toLowerCase().slice(0, 200),
      institution_id: raw.institution_id,
      academic_title: textValue(node["honorificPrefix"]),
      current_position: textValue(node["jobTitle"]),
      orcid,
      official_profile_url: profileUrl,
      research_summary: textValue(node["description"])?.slice(0, 2000) ?? null,
      active: true,
      verification_status: "verified" as never,
      last_verified_at: new Date().toISOString(),
      is_demo: false,
    };
    let entityId = existingId;
    if (entityId)
      await supabaseAdmin
        .from("researchers")
        .update(payload as never)
        .eq("id", entityId);
    else
      entityId = (
        await supabaseAdmin
          .from("researchers")
          .insert(payload as never)
          .select("id")
          .maybeSingle()
      ).data?.id;
    if (!entityId) return { status: "FAILED", reason: "structured researcher write failed" };
    if (!existingId)
      await logStructuredChange({
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
      claim: "Researcher identity published as schema.org Person JSON-LD on the institutional page",
      sourceType: "institution",
    });
    await linkExactTopics(
      "researcher_topics",
      "researcher_id",
      entityId,
      [...keywordsFrom(node), textValue(affiliation?.["name"]) ?? ""].filter(Boolean),
      true,
    );
    return { status: "NORMALIZED", entity_id: entityId, entity_action: existingId ? "updated" : "created", reason: "structured metadata fast path" };
  }

  if (raw.classification === "PROGRAMME" || raw.classification === "COURSE") {
    if (!raw.institution_id) return null;
    const programmes = snapshot.jsonld.filter((node) =>
      typeMatches(node, /^(Course|EducationalOccupationalProgram)$/i),
    );
    if (programmes.length !== 1) return null;
    const node = programmes[0];
    if (!node) return null;
    const title = textValue(node["name"]) ?? cleanTitle;
    if (!title) return null;
    const website = absoluteUrl(node["url"], url) ?? url;
    const { data: existing } = await supabaseAdmin
      .from("courses")
      .select("id")
      .eq("website", website)
      .maybeSingle();
    const slug = await uniqueSlug("courses", slugify(title), url, existing?.id);
    const provider = nestedObject(node["provider"]);
    const payload = {
      title: title.slice(0, 300),
      slug,
      degree_type: degreeType(node),
      institution_id: raw.institution_id,
      language: textValue(node["inLanguage"]),
      duration: textValue(node["timeRequired"]),
      website,
      summary: textValue(node["description"])?.slice(0, 2000) ?? null,
      verification_status: "verified" as never,
      last_verified_at: new Date().toISOString(),
      is_demo: false,
    };
    let entityId = existing?.id;
    if (entityId)
      await supabaseAdmin
        .from("courses")
        .update(payload as never)
        .eq("id", entityId);
    else
      entityId = (
        await supabaseAdmin
          .from("courses")
          .insert(payload as never)
          .select("id")
          .maybeSingle()
      ).data?.id;
    if (!entityId) return { status: "FAILED", reason: "structured programme write failed" };
    if (!existing?.id)
      await logStructuredChange({
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
      claim: "Programme/course details published as schema.org JSON-LD on the institutional page",
      sourceType: "institution",
    });
    await linkExactTopics(
      "course_topics",
      "course_id",
      entityId,
      [...keywordsFrom(node), textValue(provider?.["name"]) ?? ""].filter(Boolean),
      false,
    );
    return { status: "NORMALIZED", entity_id: entityId, entity_action: existing?.id ? "updated" : "created", reason: "structured metadata fast path" };
  }

  if (raw.classification === "PROJECT") {
    if (!raw.institution_id) return null;
    const projects = snapshot.jsonld.filter((node) =>
      typeMatches(node, /^(ResearchProject|Project)$/i),
    );
    if (projects.length !== 1) return null;
    const node = projects[0];
    if (!node) return null;
    const name = textValue(node["name"]) ?? cleanTitle;
    if (!name) return null;
    const website = absoluteUrl(node["url"], url) ?? url;
    const { data: existing } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("website", website)
      .maybeSingle();
    const slug = await uniqueSlug("projects", slugify(name), url, existing?.id);
    const start = isoDate(node["startDate"]);
    const end = isoDate(node["endDate"]);
    const today = new Date().toISOString().slice(0, 10);
    const status =
      end && end < today
        ? "completed"
        : start && start > today
          ? "planned"
          : start || end
            ? "active"
            : "unknown";
    const funder = nestedObject(node["funder"] ?? node["sponsor"]);
    const payload = {
      name: name.slice(0, 300),
      slug,
      acronym: textValue(node["alternateName"]),
      institution_id: raw.institution_id,
      start_date: start,
      end_date: end,
      status: status as never,
      funding_organization: textValue(funder?.["name"] ?? node["funder"] ?? node["sponsor"]),
      website,
      summary: textValue(node["description"])?.slice(0, 2000) ?? null,
      verification_status: "verified" as never,
      confidence: "high" as never,
      last_verified_at: new Date().toISOString(),
      is_demo: false,
    };
    let entityId = existing?.id;
    if (entityId)
      await supabaseAdmin
        .from("projects")
        .update(payload as never)
        .eq("id", entityId);
    else
      entityId = (
        await supabaseAdmin
          .from("projects")
          .insert(payload as never)
          .select("id")
          .maybeSingle()
      ).data?.id;
    if (!entityId) return { status: "FAILED", reason: "structured project write failed" };
    if (!existing?.id)
      await logStructuredChange({
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
      claim: "Project details published as schema.org JSON-LD on the institutional page",
      sourceType: "project",
    });
    await linkExactTopics("project_topics", "project_id", entityId, keywordsFrom(node), false);
    return { status: "NORMALIZED", entity_id: entityId, entity_action: existing?.id ? "updated" : "created", reason: "structured metadata fast path" };
  }

  return null;
}
