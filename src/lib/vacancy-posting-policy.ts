/**
 * Pure vacancy quality policy shared by canonical normalization and the
 * provider-circuit deterministic fallback. Keep the final-write gate and the
 * fallback selector aligned so low-quality pages do not consume the bounded
 * fallback slot.
 */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/* ------------------------------------------------------------------ */
/* SINGLE-POSTING GATE                                                 */
/* ------------------------------------------------------------------ */

/** Words that mark a page as a careers *landing/listing* page, not one posting. */
const LISTING_TITLE =
  /^(careers?|jobs?|vacancies|open (job )?positions?|positions?|recruitment|stellenangebote|stellen|job ?board|work (with|for) us|join (our team|us)|life at|our people|talent|employment)\b/i;
const NON_POSTING =
  /(meet [a-z]|faces|blog|news|resources?|contact|use ?cases?|products?|solutions?|api\b|webinar|podcast|events?|privacy|imprint|impressum|cookie|newsletter|about us|our story|benefits|culture|diversity|academy|careers? in|working at|employee stor(?:y|ies)|learning (?:&|and) development|leadership track|u[.]?gro programme|talent community|graduate programme|programme careers?|internship programme overview|how we hire|hiring process|candidate privacy|applicant privacy|privacy policy|search for your career|job alerts?|equal opportunity|accommodation request)/i;
/** A real posting names a role in its title. */
const ROLE_TITLE =
  /(\bphd\b|\bph\.d\b|\bdoctoral\b|\bdoktorand\b|\bpromotionsstelle\b|\bpost ?doc\b|\bpostdoctoral\b|\bprofessor\b|\bprofessur\b|\bjuniorprofessur\b|\blecturer\b|\bresearch(er)?\b|\bscientist\b|\bengineer\b|\bingenieur\b|\bdeveloper\b|\banalyst\b|\btechnician\b|\btechniker\b|\bspecialist\b|\bconsultant\b|\bsurveyor\b|\bgeomatics\b|\bremote sensing\b|\bphotogrammetr\w*\b|\bgis\b|\bwissenschaftliche[rn]?\s+mitarbeiter\b|\bw\/?m\/?d\b|\bm\/?w\/?d\b|\bf\/?m\/?d\b|\bassistant\b|\bassociate\b|\bfellow\b|\bintern(ship)?\b|\btrainee\b|\bmanager\b|\blead\b|\bhead of\b)/i;

/** True when a vacancy-source link label names a role. */
export function hasRoleTitle(value: string): boolean {
  return ROLE_TITLE.test(value);
}
/** A real posting reads like a job ad. */
const POSTING_BODY =
  /(application deadline|apply by|closing date|deadline for applications|bewerbungsfrist|bewerbungen? bis|reference number|kennziffer|ref\.? no|job id|requisition|full[- ]time|part[- ]time|vollzeit|teilzeit|fixed[- ]term|befristet|salary|remuneration|entgeltgruppe|verg[uü]tung|tv-?l|tv-?[oö]d|e ?13|start(ing)? date|eintrittstermin|your (tasks|profile|responsibilities)|ihre aufgaben|ihr profil|we offer|wir bieten|required qualifications|qualification[s]? required|how to apply|submit your application|bewerbungsunterlagen)/i;
const STRONG_GEOSPATIAL =
  /(photogrammetr|remote sensing|fernerkundung|geoinformat|geospatial|geographic information systems?|\bgis\b|geodes[yi]|geomatic|earth observation|geoai|lidar|laser scann|point cloud|punktwolke|synthetic aperture radar|\bsar\b|spatial data|surveying|cartograph|mapping|satellite imagery)/i;

export function hasStrongGeospatialEvidence(title: string, text: string): boolean {
  return STRONG_GEOSPATIAL.test(`${title}\n${text.slice(0, 12_000)}`);
}

/**
 * Geospatial words in site navigation, related links, or footer chrome must not
 * make an unrelated vacancy look relevant. Without a structured JobPosting
 * description, require the geospatial signal near a job-specific signal; a
 * strict structured posting may instead use its own title/description.
 */
function hasPostingSpecificGeospatialEvidence(
  title: string,
  body: string,
  postingText?: string,
): boolean {
  if (STRONG_GEOSPATIAL.test(title)) return true;
  if (postingText !== undefined) {
    return STRONG_GEOSPATIAL.test(postingText.slice(0, 12_000));
  }

  const excerpt = body.slice(0, 12_000);
  const signalPattern = new RegExp(POSTING_BODY.source, "ig");
  let match: RegExpExecArray | null;
  while ((match = signalPattern.exec(excerpt)) !== null) {
    const start = Math.max(0, match.index - 2_000);
    const end = Math.min(excerpt.length, match.index + match[0].length + 2_000);
    if (STRONG_GEOSPATIAL.test(excerpt.slice(start, end))) return true;
    if (match[0].length === 0) signalPattern.lastIndex += 1;
  }
  return false;
}

/**
 * True only when a fetched page really is ONE vacancy posting.
 * Careers hubs, marketing and resource pages under a /careers/ path must never
 * become an opportunity row — that is how the domain loses credibility.
 */
export function looksLikeSinglePosting(
  url: string,
  title: string,
  text: string,
  postingText?: string,
): { ok: boolean; reason?: string } {
  const t = (title || "").trim();
  const body = text || "";
  const structuredPosting = postingText !== undefined;
  const postingEvidence = postingText ?? body;
  const path = pathOf(url);
  if (!t) return { ok: false, reason: "no title" };
  if (LISTING_TITLE.test(t)) return { ok: false, reason: "careers listing/landing page title" };
  if (NON_POSTING.test(t)) return { ok: false, reason: "marketing/resource page, not a posting" };
  if (/^\/?(careers?|jobs?|vacancies|stellenangebote|stellen|recruitment)\/?$/i.test(path)) {
    return { ok: false, reason: "careers index path" };
  }
  if (
    /\/(privacy|policy|policies|how-we-hire|hiring-process|job-alerts?|candidate|applicant)(\/|$)/i.test(
      path,
    )
  ) {
    return { ok: false, reason: "policy or hiring-information path" };
  }
  if (Math.max(body.length, postingEvidence.length) < 600) {
    return { ok: false, reason: "page too thin to be a posting" };
  }
  if (!ROLE_TITLE.test(t)) return { ok: false, reason: "title does not name a role" };
  // A parsed single schema.org JobPosting is itself strong posting evidence.
  // For ordinary HTML pages, job-ad signals must be present in the fetched text.
  if (!structuredPosting && !POSTING_BODY.test(body)) {
    return {
      ok: false,
      reason: "no job-ad signals (deadline, contract, tasks, salary)",
    };
  }
  if (!hasPostingSpecificGeospatialEvidence(t, body, postingText)) {
    return { ok: false, reason: "no strong geospatial relevance evidence" };
  }
  return { ok: true };
}



/** Match the exact title cleanup used by normalizeSource before its final gate. */
export function normalizeVacancyTitle(pageTitle: string | null | undefined): string {
  return (pageTitle ?? "")
    .replace(
      /\s*[|·–—-]\s*[^|·–—-]*(university|universit\u00e4t|hochschule|institut\w*|careers?|karriere)[^|·–—-]*$/gi,
      "",
    )
    .replace(/\s*(job\s*details?|stellendetails|stellenanzeige|job\s*description)\s*$/i, "")
    .trim();
}

export type VacancySnapshotCandidate = {
  final_url?: string | null;
  page_title?: string | null;
  text_content?: string | null;
  /** Strict JobPosting title/description already extracted from JSON-LD. */
  structured_posting_title?: string | null;
  structured_posting_text?: string | null;
};

/**
 * Only let a pending VACANCY snapshot use the deterministic outage fallback if
 * it passes the same posting-quality checks as normalizeSource. This prevents
 * false-positive classifications (for example a careers index or NASA article)
 * from repeatedly consuming the one-task fallback budget.
 */
export function isDeterministicallyEligibleVacancySnapshot(
  raw: VacancySnapshotCandidate,
): boolean {
  // The final canonical writer prefers the strict JobPosting title over page chrome.
  const title = normalizeVacancyTitle(raw.structured_posting_title ?? raw.page_title);
  const url = raw.final_url ?? "";
  const text = raw.text_content ?? "";
  // Keep outage-fallback selection aligned with normalizeSource's final gate:
  // strict JobPosting JSON-LD may contain the posting evidence omitted by page chrome.
  if (!title || !looksLikeSinglePosting(
    url,
    title,
    text,
    raw.structured_posting_text ?? undefined,
  ).ok) return false;

  const rawPath = pathOf(url);
  const vacancyLanding =
    /(?:^|\/)(?:jobs?|vacancies|careers)\/term(?:\/|$)/i.test(rawPath) ||
    /(?:^|\/)(?:jobs?|vacancies|careers)\/(?:search|listing|list|all)(?:\/|$)/i.test(rawPath) ||
    /(?:\bvacancies?\b|\bjob listings?\b|\bcareer(?:s)?\b)\s*$/i.test(title);
  return !vacancyLanding;
}
