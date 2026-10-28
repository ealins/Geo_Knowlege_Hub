import { hasRoleTitle } from "./vacancy-posting-policy";

/**
 * A URL under /jobs/, /vacancies/, or /careers/ is not by itself proof of a
 * single posting. Generic career resources such as /careers/peacecorps/ must
 * not become vacancy snapshots merely because of the path. The later legacy
 * html-vacancy adapter override still requires structured JobPosting evidence
 * to pass the existing deterministic quality gate.
 */
export function classifyExplicitVacancyDetailPath(
  path: string,
  title: string,
): "VACANCY" | "GENERAL" | null {
  if (!/(?:^|\/)(?:jobs?|vacancies|careers)\/[^/]+/i.test(path)) return null;
  return hasRoleTitle(title) ? "VACANCY" : "GENERAL";
}

const VACANCY_PATH_TITLE_TERMS = [
  "vacanc",
  "job",
  "stellenangebot",
  "stellen",
  "career",
  "offene-stellen",
  "open-position",
  "promotion",
  "doktorand",
  "phd-position",
  "recruit",
] as const;

/**
 * A page-body mention of careers/jobs is too weak to classify the page itself
 * as a vacancy. Require a vacancy signal in the URL path or title before a
 * body-scored VACANCY classification is accepted.
 */
export function hasVacancyPathOrTitleSignal(path: string, title: string): boolean {
  const value = `${path} ${title}`.toLowerCase().replace(/\s+/g, "-");
  return VACANCY_PATH_TITLE_TERMS.some((term) => value.includes(term));
}

export function shouldDowngradeBodyOnlyVacancy(
  classification: string,
  path: string,
  title: string,
): boolean {
  return classification === "VACANCY" && !hasVacancyPathOrTitleSignal(path, title);
}
