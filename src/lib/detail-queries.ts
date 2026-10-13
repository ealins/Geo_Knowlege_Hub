import { supabase } from "@/integrations/supabase/client";
import { queryOptions } from "@tanstack/react-query";
import {
  LIVE_OPPORTUNITY_STATUSES,
  PUBLIC_CONFIDENCE_LEVELS,
  PUBLIC_VERIFICATION_STATUSES,
  canonicalCountry,
} from "@/lib/public-data";

/* ---------- provenance ---------- */

export type RecordSource = {
  id: string;
  source_url: string;
  source_organization: string | null;
  source_type: string;
  original_title: string | null;
  claim: string | null;
  discovered_at: string;
  last_checked_at: string | null;
  last_verified_at: string | null;
  verification_status: string;
  confidence: string;
  is_primary: boolean;
};

export type HistoryEntry = {
  id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  change_reason: string | null;
  source_url: string | null;
  changed_at: string;
};

export function evidenceQuery(entityType: string, entityId: string | undefined) {
  return queryOptions({
    queryKey: ["evidence", entityType, entityId],
    enabled: Boolean(entityId),
    queryFn: async () => {
      const [sources, history] = await Promise.all([
        supabase
          .from("public_record_sources")
          .select(
            `id, source_url, source_organization, source_type, original_title, claim,
             discovered_at, last_checked_at, last_verified_at, verification_status,
             confidence, is_primary`,
          )
          .eq("entity_type", entityType)
          .eq("entity_id", entityId!)
          .order("is_primary", { ascending: false }),
        supabase
          .from("entity_history")
          .select("id, field, old_value, new_value, change_reason, source_url, changed_at")
          .eq("entity_type", entityType)
          .eq("entity_id", entityId!)
          .order("changed_at", { ascending: false })
          .limit(25),
      ]);
      if (sources.error) throw sources.error;
      if (history.error) throw history.error;
      return {
        sources: (sources.data ?? []) as RecordSource[],
        history: (history.data ?? []) as HistoryEntry[],
      };
    },
  });
}

export const sourceRegistryQuery = queryOptions({
  queryKey: ["source-registry"],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("public_source_registry")
      .select(
        `id, name, url, organization, source_type, trust_level,
         refresh_frequency_hours, active`,
      )
      .order("trust_level", { ascending: false })
      .order("name");
    if (error) throw error;
    return data ?? [];
  },
});

/* ---------- detail pages ---------- */

export function institutionDetailQuery(slug: string) {
  return queryOptions({
    queryKey: ["institution-detail", slug],
    throwOnError: true,
    queryFn: async () => {
      const { data: institution, error } = await supabase
        .from("institutions")
        .select(
          `id, name, slug, abbreviation, city, country, continent, institution_type,
           official_url, careers_url, research_url, institution_identifier, openalex_id,
           description, verification_status, last_verified_at, is_demo,
           institution_topics ( weight, research_topics ( name, slug ) )`,
        )
        .eq("slug", slug)
        .eq("is_demo", false)
        .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
        .maybeSingle();
      if (error) throw error;
      if (!institution) return null;

      const id = institution.id;
      const [departments, groups, researchers, opportunities, projects, publications, courses] =
        await Promise.all([
          supabase
            .from("departments")
            .select("id, name, slug, website, description, verification_status")
            .eq("institution_id", id)
            .eq("is_demo", false)
            .order("name"),
          supabase
            .from("research_groups")
            .select("id, name, slug, website, description")
            .eq("institution_id", id)
            .eq("is_demo", false)
            .order("name"),
          supabase
            .from("researchers")
            .select(
              "id, full_name, slug, academic_title, current_position, verification_status, researcher_topics(topic_id)",
            )
            .eq("institution_id", id)
            .eq("is_demo", false)
            .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
            .order("full_name"),
          supabase
            .from("opportunities")
            .select(
              "id, title, slug, opportunity_type, status, application_deadline, application_url, official_source_url, verification_status, confidence, opportunity_topics(topic_id)",
            )
            .eq("institution_id", id)
            .eq("is_demo", false)
            .in("status", LIVE_OPPORTUNITY_STATUSES)
            .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
            .in("confidence", PUBLIC_CONFIDENCE_LEVELS)
            .not("official_source_url", "is", null)
            .order("application_deadline", { ascending: true, nullsFirst: false }),
          supabase
            .from("projects")
            .select(
              "id, name, slug, acronym, status, start_date, end_date, funding_organization, website, project_topics(topic_id)",
            )
            .eq("institution_id", id)
            .eq("is_demo", false)
            .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
            .in("status", ["planned", "active"])
            .order("start_date", { ascending: false, nullsFirst: false }),
          supabase
            .from("publications")
            .select(
              "id, title, doi, venue, year, citation_count, is_open_access, landing_url, publication_topics(topic_id)",
            )
            .eq("institution_id", id)
            .eq("is_demo", false)
            .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
            .order("year", { ascending: false, nullsFirst: false })
            .limit(25),
          supabase
            .from("courses")
            .select(
              "id, title, slug, degree_type, language, duration, website, course_topics(topic_id)",
            )
            .eq("institution_id", id)
            .eq("is_demo", false)
            .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
            .neq("confidence", "low")
            .order("title"),
        ]);

      const relatedError =
        departments.error ||
        groups.error ||
        researchers.error ||
        opportunities.error ||
        projects.error ||
        publications.error ||
        courses.error;
      if (relatedError) throw relatedError;

      return {
        institution,
        departments: departments.data ?? [],
        groups: groups.data ?? [],
        researchers: researchers.data ?? [],
        opportunities: opportunities.data ?? [],
        projects: projects.data ?? [],
        publications: publications.data ?? [],
        courses: courses.data ?? [],
      };
    },
  });
}

export function researcherDetailQuery(slug: string) {
  return queryOptions({
    queryKey: ["researcher-detail", slug],
    throwOnError: true,
    queryFn: async () => {
      const { data: researcher, error } = await supabase
        .from("researchers")
        .select(
          `id, full_name, slug, academic_title, current_position, orcid, openalex_author_id,
           official_profile_url, google_scholar_url, research_summary, verification_status,
           last_verified_at, is_demo,
           institutions ( id, name, slug, country ),
           departments ( name, slug ),
           research_groups ( name, slug ),
           researcher_topics ( weight, research_topics ( name, slug ) )`,
        )
        .eq("slug", slug)
        .eq("is_demo", false)
        .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
        .maybeSingle();
      if (error) throw error;
      if (!researcher) return null;

      const id = researcher.id;
      const [roles, pubs, projects, supervising, courses] = await Promise.all([
        supabase
          .from("researcher_roles")
          .select(
            `role, is_leadership, valid_from, valid_to, verification_status,
             institutions ( name, slug ), departments ( name )`,
          )
          .eq("researcher_id", id)
          .order("valid_from", { ascending: false, nullsFirst: false }),
        supabase
          .from("publication_researchers")
          .select(
            `author_position,
             publications ( id, title, doi, venue, year, citation_count, is_open_access,
               landing_url, is_demo, verification_status, publication_topics(topic_id) )`,
          )
          .eq("researcher_id", id)
          .limit(50),
        supabase
          .from("project_researchers")
          .select(
            `role, projects ( id, name, slug, acronym, status, funding_organization,
              website, is_demo, verification_status, project_topics(topic_id) )`,
          )
          .eq("researcher_id", id),
        supabase
          .from("opportunities")
          .select(
            "id, title, slug, opportunity_type, status, application_deadline, application_url, official_source_url, verification_status, confidence, opportunity_topics(topic_id)",
          )
          .eq("supervisor_id", id)
          .eq("is_demo", false)
          .in("status", LIVE_OPPORTUNITY_STATUSES)
          .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
          .in("confidence", PUBLIC_CONFIDENCE_LEVELS)
          .not("official_source_url", "is", null)
          .order("application_deadline", { ascending: true, nullsFirst: false }),
        supabase
          .from("course_researchers")
          .select(
            `courses ( id, title, slug, degree_type, is_demo, verification_status,
              course_topics(topic_id) )`,
          )
          .eq("researcher_id", id),
      ]);

      const relatedError =
        roles.error || pubs.error || projects.error || supervising.error || courses.error;
      if (relatedError) throw relatedError;

      return {
        researcher,
        roles: roles.data ?? [],
        publications: (pubs.data ?? [])
          .map((r: any) => ({ ...r.publications, author_position: r.author_position }))
          .filter((p: any) => p?.id && !p.is_demo)
          .sort((a: any, b: any) => (b.year ?? 0) - (a.year ?? 0)),
        projects: (projects.data ?? [])
          .map((r: any) => ({ ...r.projects, member_role: r.role }))
          .filter((p: any) => p?.id && !p.is_demo),
        supervising: supervising.data ?? [],
        courses: (courses.data ?? [])
          .map((r: any) => r.courses)
          .filter((c: any) => c && !c.is_demo),
      };
    },
  });
}

export function opportunityDetailQuery(slug: string) {
  return queryOptions({
    queryKey: ["opportunity-detail", slug],
    throwOnError: true,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("opportunities")
        .select(
          `id, title, slug, opportunity_type, description, requirements, funding_type,
           salary_text, city, country, start_date, application_deadline, application_url,
           official_source_url, supervisor_name, status, confidence, verification_status,
           first_discovered_at, last_checked_at, last_verified_at, is_demo,
           institutions ( id, name, slug, country, careers_url ),
           departments ( name, slug ),
           research_groups ( name ),
           researchers ( full_name, slug, current_position ),
           projects ( name, slug, acronym ),
           opportunity_topics ( research_topics ( name, slug ) )`,
        )
        .eq("slug", slug)
        .eq("is_demo", false)
        .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
        .in("confidence", PUBLIC_CONFIDENCE_LEVELS)
        .not("official_source_url", "is", null)
        .maybeSingle();
      if (error) throw error;
      return data ? { ...data, country: canonicalCountry(data.country) } : null;
    },
  });
}

export function topicDetailQuery(slug: string) {
  return queryOptions({
    queryKey: ["topic-detail", slug],
    throwOnError: true,
    queryFn: async () => {
      const { data: topic, error } = await supabase
        .from("research_topics")
        .select("id, name, slug, category, description")
        .eq("slug", slug)
        .eq("active", true)
        .maybeSingle();
      if (error) throw error;
      if (!topic) return null;

      const id = topic.id;
      const [momentum, opportunities, publications, projects, researchers, institutions, events] =
        await Promise.all([
          supabase
            .from("topic_momentum")
            .select(
              `pubs_last_12m, pubs_prev_12m, pubs_last_36m, active_projects, open_opportunities,
               institutions_active, growth_ratio, trend_signal, computed_at`,
            )
            .eq("topic_id", id)
            .maybeSingle(),
          supabase
            .from("opportunity_topics")
            .select(
              `opportunities ( id, title, slug, opportunity_type, status, application_deadline,
                 official_source_url, confidence, verification_status, is_demo,
                 institutions ( name, slug, is_demo ) )`,
            )
            .eq("topic_id", id),
          supabase
            .from("publication_topics")
            .select(
              `publications ( id, title, doi, venue, year, citation_count, landing_url,
                verification_status, is_demo )`,
            )
            .eq("topic_id", id),
          supabase
            .from("project_topics")
            .select(
              `projects ( id, name, slug, acronym, status, funding_organization,
                verification_status, is_demo )`,
            )
            .eq("topic_id", id),
          supabase
            .from("researcher_topics")
            .select(
              `weight, researchers ( id, full_name, slug, current_position, verification_status,
                is_demo, institutions ( name, slug, is_demo ) )`,
            )
            .eq("topic_id", id),
          supabase
            .from("institution_topics")
            .select(
              `weight, institutions ( id, name, slug, country, verification_status, is_demo )`,
            )
            .eq("topic_id", id)
            .order("weight", { ascending: false }),
          supabase
            .from("event_topics")
            .select(
              `events ( id, title, slug, start_date, location, abstract_deadline,
                verification_status, is_demo )`,
            )
            .eq("topic_id", id),
        ]);

      const relatedError =
        momentum.error ||
        opportunities.error ||
        publications.error ||
        projects.error ||
        researchers.error ||
        institutions.error ||
        events.error;
      if (relatedError) throw relatedError;

      const isPublicRecord = (value: any) =>
        value &&
        !value.is_demo &&
        (PUBLIC_VERIFICATION_STATUSES as readonly string[]).includes(value.verification_status);
      const pick = <T>(rows: any[] | null, key: string): T[] =>
        (rows ?? []).map((r) => r[key]).filter(isPublicRecord) as T[];

      return {
        topic,
        momentum: momentum.data,
        opportunities: pick<any>(opportunities.data, "opportunities").filter(
          (row) =>
            (LIVE_OPPORTUNITY_STATUSES as readonly string[]).includes(row.status) &&
            (PUBLIC_CONFIDENCE_LEVELS as readonly string[]).includes(row.confidence) &&
            Boolean(row.official_source_url),
        ),
        publications: pick<any>(publications.data, "publications").sort(
          (a, b) => (b.year ?? 0) - (a.year ?? 0),
        ),
        projects: pick<any>(projects.data, "projects"),
        researchers: (researchers.data ?? [])
          .map((r: any) => ({ ...r.researchers, weight: r.weight }))
          .filter(isPublicRecord),
        institutions: (institutions.data ?? [])
          .map((r: any) => ({ ...r.institutions, weight: r.weight }))
          .filter(isPublicRecord),
        events: pick<any>(events.data, "events"),
      };
    },
  });
}

/* ---------- search ---------- */

export type SearchHit = {
  entity_type: string;
  entity_id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  score: number;
};

export async function runGlobalSearch(q: string): Promise<SearchHit[]> {
  if (q.trim().length < 2) return [];
  const { data, error } = await supabase.rpc("global_search", {
    q: q.trim(),
    max_results: 24,
  });
  if (error) throw error;
  return (data ?? []) as SearchHit[];
}

export function citationFor(kind: string, title: string, url: string) {
  const retrieved = new Date().toISOString().slice(0, 10);
  return `${title}. ${kind} record, GeoAcademic Radar. Retrieved ${retrieved} from ${url}`;
}

/* ---------- project & publication detail ---------- */

export function projectDetailQuery(slug: string) {
  return queryOptions({
    queryKey: ["project-detail", slug],
    throwOnError: true,
    queryFn: async () => {
      const { data: project, error } = await supabase
        .from("projects")
        .select(
          `id, name, slug, acronym, status, start_date, end_date, funding_organization,
           funding_amount, funding_currency, website, summary, verification_status,
           confidence, last_verified_at, is_demo,
           institutions!projects_institution_id_fkey ( id, name, slug, country ),
           departments ( name, slug ),
           organizations!projects_funder_id_fkey ( name, slug, org_type ),
           project_topics ( research_topics ( name, slug ) )`,
        )
        .eq("slug", slug)
        .eq("is_demo", false)
        .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
        .maybeSingle();
      if (error) throw error;
      if (!project) return null;

      const id = project.id;
      const [people, partners, orgs, opportunities] = await Promise.all([
        supabase
          .from("project_researchers")
          .select(
            `role, researchers ( id, full_name, slug, current_position, is_demo, institutions ( name, slug ) )`,
          )
          .eq("project_id", id),
        supabase
          .from("project_institutions")
          .select(`role, institutions ( id, name, slug, country, is_demo )`)
          .eq("project_id", id),
        supabase
          .from("project_organizations")
          .select(`role, organizations ( id, name, slug, org_type )`)
          .eq("project_id", id),
        supabase
          .from("opportunities")
          .select(
            "id, title, slug, opportunity_type, status, application_deadline, application_url, official_source_url, verification_status, confidence, opportunity_topics(topic_id)",
          )
          .eq("project_id", id)
          .eq("is_demo", false)
          .in("status", LIVE_OPPORTUNITY_STATUSES)
          .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
          .in("confidence", PUBLIC_CONFIDENCE_LEVELS)
          .not("official_source_url", "is", null),
      ]);

      const relatedError = people.error || partners.error || orgs.error || opportunities.error;
      if (relatedError) throw relatedError;

      return {
        project,
        people: (people.data ?? [])
          .map((r: any) => ({ ...r.researchers, member_role: r.role }))
          .filter((r: any) => r?.id && !r.is_demo),
        partners: (partners.data ?? [])
          .map((r: any) => ({ ...r.institutions, partner_role: r.role }))
          .filter((r: any) => r?.id && !r.is_demo),
        organizations: (orgs.data ?? [])
          .map((r: any) => ({ ...r.organizations, partner_role: r.role }))
          .filter((r: any) => r?.id && !r.is_demo),
        opportunities: opportunities.data ?? [],
      };
    },
  });
}

export function publicationDetailQuery(id: string) {
  return queryOptions({
    queryKey: ["publication-detail", id],
    throwOnError: true,
    queryFn: async () => {
      const { data: publication, error } = await supabase
        .from("publications")
        .select(
          `id, doi, title, publication_date, year, venue, authors_text, citation_count,
           citation_source, is_open_access, abstract, source, external_id, landing_url,
           verification_status, confidence, last_verified_at, is_demo,
           institutions!publications_institution_id_fkey ( id, name, slug, country ),
           publication_topics ( research_topics ( name, slug ) )`,
        )
        .eq("id", id)
        .eq("is_demo", false)
        .in("verification_status", PUBLIC_VERIFICATION_STATUSES)
        .maybeSingle();
      if (error) throw error;
      if (!publication) return null;

      const [authors, institutions] = await Promise.all([
        supabase
          .from("publication_researchers")
          .select(
            `author_position, researchers ( id, full_name, slug, current_position, is_demo, institutions ( name, slug ) )`,
          )
          .eq("publication_id", publication.id)
          .order("author_position", { ascending: true, nullsFirst: false }),
        supabase
          .from("publication_institutions")
          .select(`institutions ( id, name, slug, country, is_demo )`)
          .eq("publication_id", publication.id),
      ]);

      const relatedError = authors.error || institutions.error;
      if (relatedError) throw relatedError;

      return {
        publication,
        authors: (authors.data ?? [])
          .map((r: any) => ({ ...r.researchers, author_position: r.author_position }))
          .filter((r: any) => r?.id && !r.is_demo),
        institutions: (institutions.data ?? [])
          .map((r: any) => r.institutions)
          .filter((i: any) => i && !i.is_demo),
      };
    },
  });
}
