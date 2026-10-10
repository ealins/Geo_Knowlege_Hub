// Structured-provider ingestion for GeoAcademic Radar.
// Primary sources: ROR for institution identity, OpenAIRE Graph for funded projects
// and publications, Crossref as a DOI/bibliographic fallback.
// Kept under the historical filename to avoid a disruptive import rename.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { topicIdsFor } from "./extraction/topics.server";

const UA = "GeoAcademicRadarBot/1.1 (mailto:hello@geoacademic.app)";
const ROR_API = "https://api.ror.org/v2/organizations";
const OPENAIRE_API = "https://api.openaire.eu/graph/v3";
const CROSSREF_API = "https://api.crossref.org/works";
const CONTACT = "hello@geoacademic.app";

export const DOMAIN_QUERIES = [
  "photogrammetry",
  "remote sensing",
  "geodesy",
  "geoinformatics",
  "earth observation",
  "lidar point cloud",
];

/** Provider capacity/rate-limit signal. Deferrals must not consume retry attempts. */
export class ProviderBudgetError extends Error {
  retryAfterMinutes: number;
  provider: string;

  constructor(provider: string, retryAfterMinutes = 30) {
    super(`${provider.toUpperCase()}_DEFERRED`);
    this.provider = provider;
    this.retryAfterMinutes = retryAfterMinutes;
  }
}

function retryMinutes(res: Response, fallback = 30): number {
  const raw = res.headers.get("retry-after");
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds / 60));
  const when = new Date(raw).getTime();
  return Number.isFinite(when) ? Math.max(1, Math.ceil((when - Date.now()) / 60_000)) : fallback;
}

async function getJson<T>(
  url: string,
  provider: string,
  extraHeaders: Record<string, string> = {},
): Promise<T | null> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json", ...extraHeaders },
  });
  if (res.status === 429 || res.status === 503) {
    throw new ProviderBudgetError(provider, retryMinutes(res));
  }
  if (!res.ok) throw new Error(`${provider.toUpperCase()}_HTTP_${res.status}`);
  return (await res.json()) as T;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\b(university|universität|universitaet|univ|of|the|for|und|and|de|di|del)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 90) || "record"
  );
}

function rorUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const id = value.replace(/^https?:\/\/ror\.org\//, "").trim();
  return /^0[a-z0-9]{8}$/i.test(id) ? `https://ror.org/${id}` : null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/* ----------------------- ROR institution identity ----------------------- */

type RorOrganization = {
  id?: string;
  names?: { value?: string; types?: string[] }[];
  domains?: string[];
  links?: { value?: string; type?: string }[];
  locations?: {
    geonames_details?: {
      country_code?: string;
      country_name?: string;
      name?: string;
    };
  }[];
};

type RorAffiliationItem = {
  chosen?: boolean;
  score?: number;
  organization?: RorOrganization;
};

export type PromotionResult = {
  institution: string;
  matched: boolean;
  promoted: boolean;
  provider_id?: string | null;
  ror?: string | null;
  reason?: string;
};

async function ensureRorEvidence(
  inst: { id: string; name: string; is_demo: boolean },
  ror: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { data: existingEvidence } = await supabaseAdmin
    .from("record_sources")
    .select("id")
    .eq("entity_type", "institution")
    .eq("entity_id", inst.id)
    .eq("source_url", ror)
    .maybeSingle();

  if (!existingEvidence) {
    await supabaseAdmin.from("record_sources").insert({
      entity_type: "institution",
      entity_id: inst.id,
      source_url: ror,
      source_organization: "ROR",
      source_type: "api" as never,
      original_title: inst.name,
      claim: "Institution identity matched by the ROR affiliation service",
      verification_status: "verified" as never,
      confidence: "high" as never,
      is_primary: false,
      last_checked_at: now,
      last_verified_at: now,
    });
  }

  if (inst.is_demo) {
    await supabaseAdmin.from("entity_history").insert({
      entity_type: "institution",
      entity_id: inst.id,
      field: "is_demo",
      old_value: "true",
      new_value: "false",
      change_reason: "Promoted to source-backed record via ROR",
      source_url: ror,
    });
    await supabaseAdmin.from("academic_changes").insert({
      change_type: "INSTITUTION_PROMOTED",
      entity_type: "institution",
      entity_id: inst.id,
      title: inst.name,
      summary: "Seed record promoted to verified using ROR identity",
      details: { ror } as never,
    });
  }
}

export async function promoteInstitution(institutionId: string): Promise<PromotionResult> {
  const { data: inst } = await supabaseAdmin
    .from("institutions")
    .select(
      "id, name, city, country, country_code, official_url, institution_identifier, verification_status, is_demo",
    )
    .eq("id", institutionId)
    .maybeSingle();

  if (!inst) {
    return {
      institution: institutionId,
      matched: false,
      promoted: false,
      reason: "institution not found",
    };
  }

  const existingRor = rorUrl(inst.institution_identifier);
  if (existingRor) {
    const now = new Date().toISOString();
    await supabaseAdmin
      .from("institutions")
      .update({
        institution_identifier: existingRor.replace("https://ror.org/", ""),
        verification_status: "verified",
        last_verified_at: now,
        is_demo: false,
      } as never)
      .eq("id", inst.id);
    await ensureRorEvidence(inst, existingRor);
    return {
      institution: inst.name,
      matched: true,
      promoted: inst.is_demo,
      provider_id: existingRor,
      ror: existingRor,
    };
  }

  const clientId = process.env["ROR_CLIENT_ID"];
  const headers = clientId ? { "Client-Id": clientId } : {};
  const affiliation = [inst.name, inst.city, inst.country].filter(Boolean).join(", ");
  const payload = await getJson<{ items?: RorAffiliationItem[] }>(
    `${ROR_API}?affiliation=${encodeURIComponent(affiliation)}`,
    "ror",
    headers,
  );
  const chosen = (payload?.items ?? []).find(
    (item) => item.chosen && item.organization,
  )?.organization;

  if (!chosen?.id) {
    return {
      institution: inst.name,
      matched: false,
      promoted: false,
      reason: "no confident ROR affiliation match",
    };
  }

  const ror = rorUrl(chosen.id);
  if (!ror) {
    return {
      institution: inst.name,
      matched: false,
      promoted: false,
      reason: "ROR returned an invalid identifier",
    };
  }

  const domain = chosen.domains?.[0] ?? null;
  const website =
    chosen.links?.find((link) => link.type === "website")?.value ??
    chosen.links?.[0]?.value ??
    null;
  const location = chosen.locations?.[0]?.geonames_details;
  const officialHost = hostOf(inst.official_url);
  const domainEvidence =
    !officialHost ||
    !domain ||
    officialHost === domain ||
    officialHost.endsWith(`.${domain}`) ||
    domain.endsWith(`.${officialHost}`);

  // ROR's chosen=true is the primary identity signal. If both sides expose a
  // domain and they directly conflict, require manual review instead of promoting.
  if (!domainEvidence) {
    return {
      institution: inst.name,
      matched: false,
      promoted: false,
      reason: "ROR match conflicts with the stored official domain",
    };
  }

  const now = new Date().toISOString();
  const bareRor = ror.replace("https://ror.org/", "");
  await supabaseAdmin
    .from("institutions")
    .update({
      institution_identifier: bareRor,
      verification_status: "verified",
      last_verified_at: now,
      is_demo: false,
      ...(!inst.country_code && location?.country_code
        ? { country_code: location.country_code }
        : {}),
      ...(!inst.country && location?.country_name ? { country: location.country_name } : {}),
      ...(!inst.official_url && website ? { official_url: website } : {}),
    } as never)
    .eq("id", inst.id);

  await ensureRorEvidence(inst, ror);

  return {
    institution: inst.name,
    matched: true,
    promoted: inst.is_demo,
    provider_id: ror,
    ror,
  };
}

/* -------------------- OpenAIRE + Crossref publications -------------------- */

type OpenAireProduct = Record<string, unknown> & {
  id?: string;
  mainTitle?: string;
  publicationDate?: string;
  authors?: { fullName?: string; rank?: number }[];
  pids?: { scheme?: string; value?: string }[];
  publisher?: string;
  descriptions?: unknown[];
  subjects?: unknown[];
  bestAccessRight?: { label?: string };
  indicators?: Record<string, unknown>;
  instances?: unknown[];
};

type CrossrefItem = {
  DOI?: string;
  title?: string[];
  issued?: { "date-parts"?: number[][] };
  published?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  "is-referenced-by-count"?: number;
  URL?: string;
  subject?: string[];
};

type ProviderWork = {
  id: string;
  provider: "openaire" | "crossref";
  doi: string | null;
  title: string;
  publication_date: string | null;
  publication_year: number | null;
  cited_by_count: number | null;
  is_oa: boolean | null;
  landing_url: string | null;
  venue: string | null;
  authors: string[];
  topics: string[];
  abstract: string | null;
};

function oaDescription(work: OpenAireProduct): string | null {
  for (const description of arr(work.descriptions)) {
    if (typeof description === "string" && description.trim()) return description.trim();
    const record = obj(description);
    const value = text(record["value"]) ?? text(record["description"]);
    if (value) return value;
  }
  return null;
}

function oaSubjects(work: OpenAireProduct): string[] {
  return arr(work.subjects)
    .flatMap((subject) => {
      if (typeof subject === "string") return [subject];
      const record = obj(subject);
      const value = text(record["subject"]) ?? text(record["value"]) ?? text(record["label"]);
      return value ? [value] : [];
    })
    .slice(0, 30);
}

function oaDoi(work: OpenAireProduct): string | null {
  const value = (work.pids ?? []).find((pid) => (pid.scheme ?? "").toLowerCase() === "doi")?.value;
  return value ? value.replace(/^https?:\/\/doi\.org\//, "").toLowerCase() : null;
}

function oaCitationCount(work: OpenAireProduct): number | null {
  const indicators = obj(work.indicators);
  for (const value of [
    indicators["citationCount"],
    indicators["citationsCount"],
    indicators["citation_count"],
    work["citationCount"],
  ]) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  }
  return null;
}

function oaLanding(work: OpenAireProduct, doi: string | null): string | null {
  if (doi) return `https://doi.org/${doi}`;
  for (const instance of arr(work.instances)) {
    const record = obj(instance);
    for (const key of ["url", "landingPage", "webresourceUrl"]) {
      const value = text(record[key]);
      if (value) return value;
    }
  }
  return work.id ? `${OPENAIRE_API}/research-products/${encodeURIComponent(work.id)}` : null;
}

async function openAireWorks(
  ror: string,
  query: string,
  since: number,
  pageSize: number,
): Promise<ProviderWork[]> {
  const url =
    `${OPENAIRE_API}/research-products?rorId=${encodeURIComponent(ror)}` +
    `&type=publication&fromPublicationYear=${since}` +
    `&search=${encodeURIComponent(query)}&pageSize=${pageSize}` +
    `&sortBy=${encodeURIComponent("publicationDate DESC")}`;
  const payload = await getJson<{ results?: OpenAireProduct[] }>(url, "openaire");

  return (payload?.results ?? []).flatMap((work) => {
    const title = text(work.mainTitle);
    if (!title || !work.id) return [];
    const doi = oaDoi(work);
    const date = text(work.publicationDate);
    const year = date ? Number(date.slice(0, 4)) || null : null;
    const access = text(obj(work.bestAccessRight)["label"]);
    const authors = (work.authors ?? [])
      .slice()
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
      .map((author) => author.fullName)
      .filter((name): name is string => Boolean(name))
      .slice(0, 25);

    return [
      {
        id: work.id,
        provider: "openaire" as const,
        doi,
        title,
        publication_date: date,
        publication_year: year,
        cited_by_count: oaCitationCount(work),
        is_oa: access ? /open/i.test(access) : null,
        landing_url: oaLanding(work, doi),
        venue: text(work.publisher),
        authors,
        topics: oaSubjects(work),
        abstract: oaDescription(work),
      },
    ];
  });
}

async function crossrefWorks(
  ror: string,
  query: string,
  since: number,
  rows: number,
): Promise<ProviderWork[]> {
  // ror-id is an exact Crossref works filter and avoids fuzzy affiliation leakage.
  const filter = `from-pub-date:${since}-01-01,ror-id:${ror}`;
  const url =
    `${CROSSREF_API}?query.bibliographic=${encodeURIComponent(query)}` +
    `&filter=${encodeURIComponent(filter)}&rows=${rows}` +
    `&sort=published&order=desc&mailto=${encodeURIComponent(CONTACT)}`;
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (res.status === 429 || res.status === 503) {
    throw new ProviderBudgetError("crossref", retryMinutes(res));
  }
  if (!res.ok) throw new Error(`CROSSREF_HTTP_${res.status}`);

  const body = (await res.json()) as { message?: { items?: CrossrefItem[] } };
  return (body.message?.items ?? []).flatMap((item) => {
    const doi = item.DOI?.toLowerCase();
    const title = item.title?.[0]?.trim();
    if (!doi || !title) return [];
    const parts = item.published?.["date-parts"]?.[0] ?? item.issued?.["date-parts"]?.[0] ?? [];
    const [year, month, day] = parts;
    const date = year
      ? `${year}-${String(month ?? 1).padStart(2, "0")}-${String(day ?? 1).padStart(2, "0")}`
      : null;
    const authors = (item.author ?? [])
      .map((author) => author.name ?? [author.given, author.family].filter(Boolean).join(" "))
      .filter(Boolean)
      .slice(0, 25);

    return [
      {
        id: doi,
        provider: "crossref" as const,
        doi,
        title,
        publication_date: date,
        publication_year: year ?? null,
        cited_by_count: item["is-referenced-by-count"] ?? null,
        is_oa: null,
        landing_url: item.URL ?? `https://doi.org/${doi}`,
        venue: item["container-title"]?.[0] ?? null,
        authors,
        topics: item.subject ?? [],
        abstract: null,
      },
    ];
  });
}

export type PublicationImportResult = {
  institution: string;
  queries: number;
  seen: number;
  inserted: number;
  updated: number;
  skipped: number;
  provider: string;
};

export async function importInstitutionPublications(
  institutionId: string,
  opts: {
    queries?: number;
    perQuery?: number;
    sinceYear?: number;
    minCitations?: number;
  } = {},
): Promise<PublicationImportResult> {
  const { data: inst } = await supabaseAdmin
    .from("institutions")
    .select("id, name, institution_identifier, is_demo")
    .eq("id", institutionId)
    .maybeSingle();
  if (!inst) {
    return {
      institution: institutionId,
      queries: 0,
      seen: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      provider: "none",
    };
  }

  const ror = rorUrl(inst.institution_identifier);
  if (!ror || inst.is_demo) {
    return {
      institution: inst.name,
      queries: 0,
      seen: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      provider: "waiting-for-ROR",
    };
  }

  const perQuery = Math.min(50, opts.perQuery ?? 10);
  // Default to last 12 months for lean ingestion; allow override via sinceYear
  const since = opts.sinceYear ?? new Date().getUTCFullYear() - 1;
  // Freshness radar: a source-backed domain match is sufficient. Citation
  // counts must not suppress new or not-yet-cited work by default.
  const minCitations = opts.minCitations ?? 0;
  const queries = DOMAIN_QUERIES.slice(
    0,
    Math.max(1, Math.min(DOMAIN_QUERIES.length, opts.queries ?? 3)),
  );
  const out: PublicationImportResult = {
    institution: inst.name,
    queries: queries.length,
    seen: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    provider: "OpenAIRE → Crossref",
  };

  for (const query of queries) {
    const [openAire, crossref] = await Promise.all([
      openAireWorks(ror, query, since, perQuery),
      crossrefWorks(ror, query, since, perQuery),
    ]);

    // Merge provider results, deduplicate by DOI/title, and keep the newest
    // source-dated work first. OpenAIRE-only fallback missed Crossref's newer
    // records whenever OpenAIRE returned any results at all.
    const merged = [...openAire, ...crossref].sort((a, b) =>
      (b.publication_date ?? "").localeCompare(a.publication_date ?? ""),
    );
    const seenWorks = new Set<string>();
    const works = merged.filter((work) => {
      const key = work.doi ? `doi:${work.doi.toLowerCase()}` : `title:${normalizeName(work.title)}`;
      if (seenWorks.has(key)) return false;
      seenWorks.add(key);
      return true;
    }).slice(0, perQuery);

    for (const work of works) {
      out.seen += 1;
      if (!work.title) {
        out.skipped += 1;
        continue;
      }

      // "Remote sensing" also appears in astronomy and planetary science. Keep
      // those records out unless the work itself contains explicit Earth/
      // geospatial evidence; broad provider query terms alone are insufficient.
      const topicalText = [work.title, work.abstract ?? "", work.venue ?? "", ...work.topics]
        .join(" ")
        .toLowerCase();
      const nonEarthSpaceSignal =
        /\b(exoplanet|astronom\w*|astrophysic\w*|space weather|solar orbiter|solar energetic electron|transiting neptune|rover permittivity|planetary atmosphere|stellar)\b/i.test(topicalText);
      const earthGeoSignal =
        /\b(earth observation|earth system|geospatial|geographic information|gis|land cover|land use|forest|agricultur\w*|crop|water|flood|urban|satellite imagery|photogrammetr\w*|lidar|point cloud|geodesy|gnss|cartograph\w*|terrain|soil|vegetation|river|coastal|ocean|climate|snowpack|glacier|seafloor|bathymetr\w*|ecosystem|biodiversity|sea ice|scatterometer|earth surface|remote sensing of (?:the )?earth)\b/i.test(topicalText);
      if (nonEarthSpaceSignal && !earthGeoSignal) {
        out.skipped += 1;
        continue;
      }

      // Only apply a citation threshold when a caller explicitly asks for one.
      // Unknown counts are normal for fresh work and are not a reason to drop it.
      if (minCitations > 0 && work.cited_by_count !== null && work.cited_by_count < minCitations) {
        out.skipped += 1;
        continue;
      }

      let existingId: string | null = null;
      if (work.doi) {
        const { data } = await supabaseAdmin
          .from("publications")
          .select("id")
          .ilike("doi", work.doi)
          .maybeSingle();
        existingId = data?.id ?? null;
      }
      if (!existingId) {
        const { data } = await supabaseAdmin
          .from("publications")
          .select("id")
          .eq("source", work.provider)
          .eq("external_id", work.id)
          .maybeSingle();
        existingId = data?.id ?? null;
      }

      const row = {
        doi: work.doi,
        title: work.title.slice(0, 500),
        normalized_title: normalizeName(work.title).slice(0, 300),
        publication_date: work.publication_date,
        year: work.publication_year,
        venue: work.venue,
        authors_text: work.authors.join(", ") || null,
        citation_count: work.cited_by_count,
        citation_source: work.provider,
        is_open_access: work.is_oa,
        abstract: work.abstract?.slice(0, 5000) ?? null,
        source: work.provider,
        external_id: work.id,
        landing_url: work.landing_url,
        institution_id: inst.id,
        verification_status: "verified" as never,
        confidence: "high" as never,
        last_verified_at: new Date().toISOString(),
        is_demo: false,
      };

      let publicationId = existingId;
      if (existingId) {
        // Do not overwrite the primary institution of a publication already owned
        // by another institution; the many-to-many table records this affiliation.
        const { institution_id: _ignored, ...update } = row;
        await supabaseAdmin
          .from("publications")
          .update(update as never)
          .eq("id", existingId);
        out.updated += 1;
      } else {
        const { data, error } = await supabaseAdmin
          .from("publications")
          .insert(row as never)
          .select("id")
          .maybeSingle();
        if (error || !data) {
          out.skipped += 1;
          continue;
        }
        publicationId = data.id;
        out.inserted += 1;
        await supabaseAdmin.from("academic_changes").insert({
          change_type: "NEW_PUBLICATION",
          entity_type: "publication",
          entity_id: publicationId,
          title: row.title,
          summary: `Imported from ${work.provider === "openaire" ? "OpenAIRE" : "Crossref"} for ${inst.name}`,
          details: {
            external_id: work.id,
            doi: work.doi,
            provider: work.provider,
          } as never,
        });
      }

      if (!publicationId) continue;
      await supabaseAdmin
        .from("publication_institutions")
        .upsert({ publication_id: publicationId, institution_id: inst.id } as never, {
          onConflict: "publication_id,institution_id",
          ignoreDuplicates: true,
        });

      const evidenceUrl =
        work.provider === "openaire"
          ? `${OPENAIRE_API}/research-products/${encodeURIComponent(work.id)}`
          : `https://doi.org/${work.doi}`;
      const { data: existingEvidence } = await supabaseAdmin
        .from("record_sources")
        .select("id")
        .eq("entity_type", "publication")
        .eq("entity_id", publicationId)
        .eq("source_url", evidenceUrl)
        .maybeSingle();
      if (!existingEvidence) {
        await supabaseAdmin.from("record_sources").insert({
          entity_type: "publication",
          entity_id: publicationId,
          source_url: evidenceUrl,
          source_organization: work.provider === "openaire" ? "OpenAIRE Graph" : "Crossref",
          source_type: "publication_database" as never,
          original_title: row.title,
          claim: `Bibliographic metadata supplied by ${work.provider === "openaire" ? "OpenAIRE Graph" : "Crossref"}`,
          verification_status: "verified" as never,
          confidence: "high" as never,
          is_primary: true,
          last_checked_at: new Date().toISOString(),
          last_verified_at: new Date().toISOString(),
        });
      }

      // Classify from the work's own metadata, never from the provider search query.
      // Adding `query` here made every result of a broad "remote sensing" search
      // look like an Environmental Remote Sensing paper, even when it was astronomy.
      const topicEvidence = [
        work.title,
        work.abstract ?? "",
        work.venue ?? "",
        ...work.topics,
      ].filter(Boolean);
      const topicIds = await topicIdsFor(topicEvidence);
      if (topicIds.length) {
        await supabaseAdmin
          .from("publication_topics")
          .upsert(
            topicIds.map((topic_id) => ({ publication_id: publicationId!, topic_id })) as never,
            { onConflict: "publication_id,topic_id", ignoreDuplicates: true },
          );
      }
      const { ensurePulseForEntity } = await import("./pulse.server");
      await ensurePulseForEntity("publication", publicationId);
    }
  }

  return out;
}

/* ---------------------------- OpenAIRE projects --------------------------- */

type OpenAireOrganization = { id?: string };
type OpenAireProject = Record<string, unknown> & {
  id?: string;
  code?: string;
  acronym?: string;
  title?: string;
  websiteUrl?: string;
  startDate?: string;
  endDate?: string;
  keywords?: string;
  subjects?: unknown[];
  summary?: string;
  fundings?: { name?: string; shortName?: string }[];
  granted?: { fundedAmount?: number; currency?: string };
};

const openAireOrgCache = new Map<string, string | null>();

async function openAireOrganizationId(ror: string): Promise<string | null> {
  if (openAireOrgCache.has(ror)) return openAireOrgCache.get(ror) ?? null;
  const payload = await getJson<{ results?: OpenAireOrganization[] }>(
    `${OPENAIRE_API}/organizations?pid=${encodeURIComponent(ror)}&pageSize=5`,
    "openaire",
  );
  const id = payload?.results?.find((organization) => Boolean(organization.id))?.id ?? null;
  openAireOrgCache.set(ror, id);
  return id;
}

export type ProjectImportResult = {
  institution: string;
  seen: number;
  inserted: number;
  updated: number;
  skipped: number;
};

export async function importInstitutionProjects(
  institutionId: string,
  opts: { perQuery?: number; queries?: number } = {},
): Promise<ProjectImportResult> {
  const { data: inst } = await supabaseAdmin
    .from("institutions")
    .select("id, name, institution_identifier, is_demo")
    .eq("id", institutionId)
    .maybeSingle();
  if (!inst) {
    return { institution: institutionId, seen: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const ror = rorUrl(inst.institution_identifier);
  if (!ror || inst.is_demo) {
    return { institution: inst.name, seen: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const openAireOrgId = await openAireOrganizationId(ror);
  if (!openAireOrgId) {
    return { institution: inst.name, seen: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const out: ProjectImportResult = {
    institution: inst.name,
    seen: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
  };
  const queries = DOMAIN_QUERIES.slice(0, Math.max(1, Math.min(3, opts.queries ?? 2)));
  const pageSize = Math.min(50, opts.perQuery ?? 25);

  for (const query of queries) {
    const base =
      `&search=${encodeURIComponent(query)}&fromStartDate=2020-01-01&pageSize=${pageSize}` +
      `&sortBy=${encodeURIComponent("startDate DESC")}`;
    // Prefer the canonical institution name. ROR/OpenAIRE organization mappings can
    // point to a parent or stale organization and produce unrelated historical grants.
    const nameUrl =
      `${OPENAIRE_API}/projects?relOrganizationName=${encodeURIComponent(inst.name)}${base}`;
    let payload = await getJson<{ results?: OpenAireProject[] }>(nameUrl, "openaire");

    // Fall back to the ROR-linked OpenAIRE organization only when the name query
    // returns no modern projects.
    const hasModern = (payload?.results ?? []).some((project) => {
      const start = text(project.startDate);
      return Boolean(start && start >= "2020-01-01");
    });
    if (!hasModern) {
      const idUrl =
        `${OPENAIRE_API}/projects?relOrganizationId=${encodeURIComponent(openAireOrgId)}${base}`;
      const byId = await getJson<{ results?: OpenAireProject[] }>(idUrl, "openaire");
      if ((byId?.results ?? []).length) payload = byId;
    }

    for (const project of payload?.results ?? []) {
      out.seen += 1;
      const name = text(project.title);
      if (!name || !project.id) {
        out.skipped += 1;
        continue;
      }

      const { data: candidates } = await supabaseAdmin
        .from("projects")
        .select("id, name")
        .eq("institution_id", inst.id)
        .ilike("name", name)
        .limit(2);
      const existing = candidates?.find(
        (candidate) => normalizeName(candidate.name) === normalizeName(name),
      );

      const today = new Date().toISOString().slice(0, 10);
      const start = text(project.startDate);
      const end = text(project.endDate);
      // Never promote historical projects into the current catalogue. The API filter is
      // an optimization; this local barrier protects us if a provider ignores a filter.
      if (!start || start < "2020-01-01") {
        out.skipped += 1;
        continue;
      }
      const status =
        start && start > today ? "planned" : end && end < today ? "completed" : "active";
      const funder = project.fundings?.[0]?.name ?? project.fundings?.[0]?.shortName ?? null;
      const granted = obj(project.granted);
      const row = {
        name: name.slice(0, 500),
        slug: `${slugify(name)}-${slugify(project.id).slice(-10)}`,
        acronym: text(project.acronym),
        institution_id: inst.id,
        start_date: start,
        end_date: end,
        status: status as "planned" | "active" | "completed",
        funding_organization: funder,
        funding_amount:
          typeof granted["fundedAmount"] === "number" ? granted["fundedAmount"] : null,
        funding_currency: text(granted["currency"]),
        website:
          text(project.websiteUrl) ?? `${OPENAIRE_API}/projects/${encodeURIComponent(project.id)}`,
        summary: text(project.summary)?.slice(0, 6000) ?? null,
        verification_status: "verified" as never,
        confidence: "high" as never,
        last_verified_at: new Date().toISOString(),
        is_demo: false,
      };

      let projectId = existing?.id ?? null;
      if (projectId) {
        const { slug: _slug, ...update } = row;
        await supabaseAdmin
          .from("projects")
          .update(update as never)
          .eq("id", projectId);
        out.updated += 1;
      } else {
        const { data, error } = await supabaseAdmin
          .from("projects")
          .insert(row as never)
          .select("id")
          .maybeSingle();
        if (error || !data) {
          out.skipped += 1;
          continue;
        }
        projectId = data.id;
        out.inserted += 1;
        await supabaseAdmin.from("academic_changes").insert({
          change_type: "NEW_PROJECT",
          entity_type: "project",
          entity_id: projectId,
          title: name,
          summary: `Imported from OpenAIRE Graph for ${inst.name}`,
          details: { openaire_id: project.id, ror } as never,
        });
      }

      if (!projectId) continue;
      const evidenceUrl = `${OPENAIRE_API}/projects/${encodeURIComponent(project.id)}`;
      const { data: existingEvidence } = await supabaseAdmin
        .from("record_sources")
        .select("id")
        .eq("entity_type", "project")
        .eq("entity_id", projectId)
        .eq("source_url", evidenceUrl)
        .maybeSingle();
      if (!existingEvidence) {
        await supabaseAdmin.from("record_sources").insert({
          entity_type: "project",
          entity_id: projectId,
          source_url: evidenceUrl,
          source_organization: "OpenAIRE Graph",
          source_type: "api" as never,
          original_title: name,
          claim: "Funded-project metadata supplied by OpenAIRE Graph",
          verification_status: "verified" as never,
          confidence: "high" as never,
          is_primary: true,
          last_checked_at: new Date().toISOString(),
          last_verified_at: new Date().toISOString(),
        });
      }

      // As with publications, topic tags must come from project evidence, not
      // the broad search phrase that happened to retrieve the record.
      const labels = [
        name,
        text(project.summary) ?? "",
        text(project.keywords) ?? "",
        ...arr(project.subjects).map((subject) =>
          typeof subject === "string"
            ? subject
            : (text(obj(subject)["label"]) ?? text(obj(subject)["value"]) ?? ""),
        ),
      ].filter(Boolean);
      const topicIds = await topicIdsFor(labels);
      if (topicIds.length) {
        await supabaseAdmin
          .from("project_topics")
          .upsert(topicIds.map((topic_id) => ({ project_id: projectId!, topic_id })) as never, {
            onConflict: "project_id,topic_id",
            ignoreDuplicates: true,
          });
      }

      const { ensurePulseForEntity } = await import("./pulse.server");
      await ensurePulseForEntity("project", projectId);
    }
  }

  return out;
}
