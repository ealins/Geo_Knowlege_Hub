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
  /(phd|ph\.d|doctoral|doktorand|promotionsstelle|post ?doc|postdoctoral|professor|professur|juniorprofessur|lecturer|research(er)?|scientist|engineer|ingenieur|developer|analyst|technician|techniker|specialist|consultant|surveyor|geomatics|remote sensing|photogrammetr|gis\b|wissenschaftliche[rn]? mitarbeiter|w\/?m\/?d|m\/?w\/?d|f\/?m\/?d|assistant|associate|fellow|intern(ship)?|trainee|manager|lead|head of)/i;
/** A real posting reads like a job ad. */
const POSTING_BODY =
  /(application deadline|apply by|closing date|deadline for applications|bewerbungsfrist|bewerbungen? bis|reference number|kennziffer|ref\.? no|job id|requisition|full[- ]time|part[- ]time|vollzeit|teilzeit|fixed[- ]term|befristet|salary|remuneration|entgeltgruppe|verg[uü]tung|tv-?l|tv-?[oö]d|e ?13|start(ing)? date|eintrittstermin|your (tasks|profile|responsibilities)|ihre aufgaben|ihr profil|we offer|wir bieten|required qualifications|qualification[s]? required|how to apply|submit your application|bewerbungsunterlagen)/i;
const STRONG_GEOSPATIAL =
  /(photogrammetr|remote sensing|fernerkundung|geoinformat|geospatial|geographic information systems?|\bgis\b|geodes[yi]|geomatic|earth observation|geoai|lidar|laser scann|point cloud|punktwolke|synthetic aperture radar|\bsar\b|spatial data|surveying|cartograph|mapping|satellite imagery)/i;

export function hasStrongGeospatialEvidence(title: string, text: string): boolean {
  return STRONG_GEOSPATIAL.test(`${title}\n${text.slice(0, 12_000)}`);
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
): { ok: boolean; reason?: string } {
  const t = (title || "").trim();
  const body = text || "";
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
  if (body.length < 600) return { ok: false, reason: "page too thin to be a posting" };
  if (!ROLE_TITLE.test(t)) return { ok: false, reason: "title does not name a role" };
  if (!POSTING_BODY.test(body))
    return {
      ok: false,
      reason: "no job-ad signals (deadline, contract, tasks, salary)",
    };
  if (!STRONG_GEOSPATIAL.test(t + "\n" + body.slice(0, 12000))) {
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
  const rawTitle = (raw.page_title ?? "").trim();
  const title = normalizeVacancyTitle(raw.page_title);
  const url = raw.final_url ?? "";
  const text = raw.text_content ?? "";
  if (!title || !looksLikeSinglePosting(url, title, text).ok) return false;

  const rawPath = pathOf(url);
  const vacancyLanding =
    /(?:^|\/)(?:jobs?|vacancies|careers)\/term(?:\/|$)/i.test(rawPath) ||
    /(?:^|\/)(?:jobs?|vacancies|careers)\/(?:search|listing|list|all)(?:\/|$)/i.test(rawPath) ||
    /(?:\bvacancies?\b|\bjob listings?\b|\bcareer(?:s)?\b)\s*$/i.test(rawTitle);
  return !vacancyLanding;
}
