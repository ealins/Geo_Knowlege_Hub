export const PUBLIC_VERIFICATION_STATUSES = [
  "verified",
  "auto_discovered",
  "possibly_outdated",
] as const;

export const PUBLIC_CONFIDENCE_LEVELS = ["high", "medium"] as const;

export const LIVE_OPPORTUNITY_STATUSES = [
  "open",
  "closing_soon",
  "rolling",
  "possibly_open",
] as const;

export type PublicOpportunityEvidence = {
  title: string | null;
  description: string | null;
  country?: string | null;
  city?: string | null;
  sector?: string | null;
  employer_name?: string | null;
  seniority?: string | null;
  official_source_url: string | null;
  confidence: string | null;
  verification_status: string | null;
  status: string | null;
  application_deadline: string | null;
  is_demo: boolean | null;
};

const PUBLIC_NON_POSTING_TITLE =
  /^(careers?|jobs?|vacancies|recruitment|working at|join us|how we hire|search for your career|academy|careers? in|employee stor(?:y|ies)|learning (?:&|and) development|leadership track|u[.]?gro programme|talent community|graduate programme|programme careers?|privacy|cookie|job alerts?|applicant|candidate privacy|equal opportunity)/i;

const PUBLIC_NON_POSTING_PATH =
  /\/(privacy|polic(?:y|ies)|how-we-hire|hiring-process|job-alerts?|candidate|applicant|job-openings?|employment-opportunities?|employment|opportunities?|job_opportunities|careers?\/?)$/i;

const PUBLIC_POSTING_PATH =
  /\/(?:jobs?|vacancies|careers|recruitment)(?:\/|$)/i;

const PUBLIC_POSTING_TITLE =
  /\b(?:p[.]?h[.]?d|post[- ]?doc(?:toral)?|doctoral|research assistant|research associate|research scientist|research fellow|scientist|engineer|developer|analyst|professor|lecturer|faculty|fellowship|fellow|intern(?:ship)?|technician|manager|coordinator|officer|specialist|principal|director|assistant professor|associate professor)\b/i;

const PUBLIC_ACADEMIC_ROLE = /\b(?:phd|doctoral|postdoc|post-doctoral|research (?:assistant|associate|scientist|fellow)|professor|lecturer|faculty|fellowship|academic)\b/i;
const PUBLIC_GENERIC_SUPPORT_ROLE = /\b(?:business continuity|restaurant|clinical lecturer|ethics|publications? coordinator|outreach associate|administrative|administration|finance|human resources|hr|procurement|legal|communications?|marketing|sales|customer|facilities?|building|warehouse|lager|secretar(?:y|iat)|recruiter|recruitment|talent)\b/i;
const PUBLIC_GEOSPATIAL_TITLE = /\b(?:photogrammetr|remote sensing|geospatial|geoinformat|geomatic|geodes|gis|geoai|lidar|earth observation|satellite|mapping|cartograph|spatial data|surveying|point cloud)\b/i;

const PUBLIC_GEOSPATIAL =
  /(photogrammetr|remote sensing|fernerkundung|geoinformat|geospatial|geographic information systems?|\bgis\b|geodes[yi]|geomatic|earth observation|geoai|lidar|laser scann|point cloud|punktwolke|synthetic aperture radar|\bsar\b|spatial data|surveying|cartograph|mapping|satellite imagery)/i;

/** Single source of truth for whether an opportunity is allowed on public surfaces. */
export function isPublicOpportunityEvidence(
  row: PublicOpportunityEvidence,
): boolean {
  if (row.is_demo || !row.official_source_url || !row.title?.trim()) {
    return false;
  }

  if (
    !(LIVE_OPPORTUNITY_STATUSES as readonly string[]).includes(
      row.status ?? "",
    )
  ) {
    return false;
  }

  if (
    !(PUBLIC_VERIFICATION_STATUSES as readonly string[]).includes(
      row.verification_status ?? "",
    )
  ) {
    return false;
  }

  if (
    !(PUBLIC_CONFIDENCE_LEVELS as readonly string[]).includes(
      row.confidence ?? "",
    )
  ) {
    return false;
  }

  const today = new Date().toISOString().slice(0, 10);

  if (row.application_deadline && row.application_deadline < today) {
    return false;
  }

  if (!row.application_deadline && row.status !== "rolling") {
    return false;
  }

  if (PUBLIC_NON_POSTING_TITLE.test(row.title.trim())) {
    return false;
  }

  if (/\b(?:vacancies|job listings?|career(?:s)?)\s*$/i.test(row.title.trim())) {
    return false;
  }

  try {
    const url = new URL(row.official_source_url);
    const path = url.pathname.toLowerCase();

    if (PUBLIC_NON_POSTING_PATH.test(path)) {
      return false;
    }

    if (
      /(?:^|\/)\b(?:jobs?|vacancies|careers)\/term(?:\/|$)/i.test(path)
    ) {
      return false;
    }

    if (
      /(?:^|\/)\b(?:jobs?|vacancies|careers)\/(?:search|listing|list|all)(?:\/|$)/i.test(
        path,
      )
    ) {
      return false;
    }

    if (
      /\/(jobs?|vacancies|careers)$/i.test(path) &&
      /\b(jobs?|vacancies|careers?|recruitment)\b/i.test(row.title)
    ) {
      return false;
    }

    if (
      !PUBLIC_POSTING_PATH.test(path) &&
      !PUBLIC_POSTING_TITLE.test(row.title)
    ) {
      return false;
    }
  } catch {
    return false;
  }

  return PUBLIC_GEOSPATIAL.test(
    [row.title, row.description?.slice(0, 2000) ?? ""].join("\n"),
  );
}

function countryKey(country: string): string {
  return country
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const COUNTRY_NAMES: Record<string, string> = {
  deutschland: "Germany",
  holland: "Netherlands",
  uk: "United Kingdom",
  "u-k": "United Kingdom",
  "great-britain": "United Kingdom",
  usa: "United States",
  "u-s": "United States",
  "u-s-a": "United States",
  "united-states-of-america": "United States",
  "estados-unidos": "United States",
};

const COUNTRY_VARIANTS: Record<string, string[]> = {
  Germany: ["Germany", "Deutschland"],
  Netherlands: ["Netherlands", "Holland"],
  "United Kingdom": ["United Kingdom", "UK", "U.K.", "Great Britain"],
  "United States": [
    "United States",
    "United States of America",
    "USA",
    "U.S.A.",
    "US",
    "U.S.",
    "Estados Unidos",
  ],
};

/** Keep country tabs, rollups and detail links stable across source spellings. */
export function canonicalCountry(
  country: string | null | undefined,
): string | null {
  if (!country?.trim()) return null;

  const trimmed = country.trim();

  return COUNTRY_NAMES[countryKey(trimmed)] ?? trimmed;
}

export function countrySlug(country: string): string {
  return countryKey(canonicalCountry(country) ?? country);
}

export function countryVariants(country: string): string[] {
  const canonical = canonicalCountry(country) ?? country.trim();

  return [
    ...new Set([
      country.trim(),
      canonical,
      ...(COUNTRY_VARIANTS[canonical] ?? []),
    ]),
  ];
}