// Deterministic candidate selection. No model request is made for pages that
// obviously cannot yield a canonical record — this is the cost gate.
// The model can reject a candidate but can NEVER overturn a rejection here.
import { looksLikeSinglePosting } from "./ingest.server";

export type Candidate =
  | "VACANCY_CANDIDATE"
  | "PROGRAMME_CANDIDATE"
  | "PROJECT_CANDIDATE"
  | "RESEARCHER_CANDIDATE"
  | "EVENT_CANDIDATE"
  | "TOPIC_CLASSIFICATION_CANDIDATE"
  | "NOT_A_CANDIDATE";

export type CandidateDecision = { candidate: Candidate; reason: string };

const JUNK_PATH =
  /\/(privacy|datenschutz|impressum|imprint|cookie|terms|agb|login|signin|sign-in|anmelden|search|suche|sitemap|rss|feed|newsletter|accessibility|barrierefreiheit)(\/|$|\?)/i;
const JUNK_TITLE =
  /^(privacy|data protection|datenschutz|impressum|imprint|cookie|terms|login|sign in|search|sitemap|accessibility|barrierefreiheit|newsletter|404|page not found)/i;
const ASSET = /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|svg|mp4|ics)$/i;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return (url || "").toLowerCase();
  }
}

/* ------------------------------------------------------------------ */
/* PER-ENTITY DETERMINISTIC GATES                                      */
/* ------------------------------------------------------------------ */

export type Gate = { ok: boolean; reason?: string };

/** Index/listing titles that describe a collection, never one record. */
const LIST_TITLE =
  /^(all\s+)?(research\s+)?(projects?|projekte|forschungsprojekte|publications?|publikationen|people|staff|team|members|mitarbeiter(innen)?|personen|events?|veranstaltungen|news|aktuelles|courses?|lehre|lehrveranstaltungen|study(ing)?|studium|studiengänge|studiengaenge|programmes?|programs?|degree programmes?|overview|übersicht|uebersicht|archive|archiv)\b[\s|:–-]*$/i;

const PROJECT_BODY =
  /(project (duration|period|partners?|lead|coordinator|homepage)|projektlaufzeit|laufzeit|projektpartner|funded by|funding (programme|program|body|agency|reference)|gef[oö]rdert (von|durch)|f[oö]rderkennzeichen|grant (no|number|agreement)|principal investigator|projektleit|duration:|consortium|work packages?|arbeitspakete|horizon (2020|europe)|dfg|bmbf|erc|nsf)/i;

export function projectGate(url: string, title: string, text: string): Gate {
  const t = (title || "").trim();
  if (!t) return { ok: false, reason: "no title" };
  if (LIST_TITLE.test(t)) return { ok: false, reason: "project index/listing page, not one project" };
  if (/^\/?(projects?|projekte|forschung(sprojekte)?)\/?$/i.test(pathOf(url)))
    return { ok: false, reason: "projects index path" };
  if (text.length < 700) return { ok: false, reason: "page too thin to be a project description" };
  if (!PROJECT_BODY.test(text))
    return { ok: false, reason: "no project signals (duration, funder, partners, grant, PI)" };
  return { ok: true };
}

const DEGREE_TITLE =
  /(m\.?sc\.?|b\.?sc\.?|m\.?eng|b\.?eng|master|bachelor|msc|bsc|diplom|doctoral (programme|program|school)|graduate school|studiengang|studienprogramm|degree programme|degree program|joint programme|erasmus mundus|phd programme|phd program)/i;
const GENERIC_STUDY_TITLE =
  /^(study(ing)?( (at|with|here))?|studium|studies|study programmes?|degree programmes?|programmes?|programs?|academics|education|teaching|lehre|prospective students|admissions|apply now|bewerbung)\b[\s|:–-]*$/i;
const PROGRAMME_BODY =
  /(credits?|ects|semester|module|curriculum|studienverlauf|admission|zulassung|application (deadline|period|procedure)|bewerbungsfrist|tuition|studienbeitrag|degree awarded|abschluss|standard period of study|regelstudienzeit|language of instruction|unterrichtssprache|duration|research (programme|program|training)|training programme|fellowship|doctoral training|graduate training|scientific programme)/i;

// Media/editorial titles must not become academic offerings because their text
// happens to contain generic words such as "course" or "programme".
const NON_COURSE_MEDIA =
  /\b(video|movie|multimedia|image|photo gallery|flyby|launch|rollout|press release|news article|spacecraft|satellite launch)\b/i;

export function programmeGate(url: string, title: string, text: string, classification: string | null = null): Gate {
  const t = (title || "").trim();
  if (!t) return { ok: false, reason: "no title" };
  if (NON_COURSE_MEDIA.test(t) || /\/(?:multimedia|images?|videos?|news|press-releases?)\//i.test(pathOf(url)))
    return { ok: false, reason: "editorial/media page, not a course or degree programme" };
  if (GENERIC_STUDY_TITLE.test(t)) return { ok: false, reason: "generic university study landing page" };
  if (LIST_TITLE.test(t)) return { ok: false, reason: "programme listing page, not one programme" };
  if (text.length < 600) return { ok: false, reason: "page too thin to be a programme description" };
  const degreeEvidence = DEGREE_TITLE.test(t) || DEGREE_TITLE.test(text.slice(0, 2500));
  const researchProgramme = /\b(research|doctoral training|graduate training|scientific|training) (programme|program)\b/i.test(t);
  const specificCourse = classification === "COURSE"
    && !GENERIC_STUDY_TITLE.test(t)
    && (/\/(?:courses?|modules?|lectures?)\//i.test(pathOf(url)) || /\b(course|module|lecture|lab|practical|seminar)\b/i.test(t));
  if (!degreeEvidence && !researchProgramme && !specificCourse)
    return { ok: false, reason: "no degree level, explicit research/training programme, or specific course stated" };
  if (!PROGRAMME_BODY.test(text))
    return { ok: false, reason: "no programme signals (ECTS, semesters, curriculum, admission, training)" };
  return { ok: true };
}

const PERSON_TITLE =
  /(prof\.?|professor|dr\.?[- ]?(ing\.?|rer\.?|habil\.?)?|ph\.?d\.?|dipl\.?[- ]?ing|m\.?sc\.?|apl\.|pd\b|jun\.-prof)/i;
/** "Firstname Lastname" — two to four capitalised words, no listing keyword. */
const NAME_LIKE = /^[A-ZÄÖÜ][\p{L}'’.-]+(?:\s+(?:van|von|de|der|den|di|da|al)?\s?[A-ZÄÖÜ][\p{L}'’.-]+){1,3}$/u;
const PROFILE_BODY =
  /(research (interests?|areas?|focus)|forschungsinteressen|forschungsschwerpunkt|publications?|publikationen|curriculum vitae|\bcv\b|academic career|beruflicher werdegang|teaching|lehre|orcid|google scholar|since \d{4}|seit \d{4})/i;

export function researcherGate(url: string, title: string, text: string): Gate {
  const raw = (title || "").split(/[|·–—]/)[0]?.trim() ?? "";
  if (!raw) return { ok: false, reason: "no title" };
  if (LIST_TITLE.test(raw)) return { ok: false, reason: "people/staff listing page, not one profile" };
  if (/^\/?(people|staff|team|mitarbeiter|personen|members)\/?$/i.test(pathOf(url)))
    return { ok: false, reason: "people index path" };
  if (text.length < 400) return { ok: false, reason: "page too thin to be a profile" };
  const looksPerson = PERSON_TITLE.test(raw) || NAME_LIKE.test(raw.replace(/^(prof\.?|dr\.?)\s+/i, ""));
  if (!looksPerson) return { ok: false, reason: "title does not name a person" };
  if (!PROFILE_BODY.test(text)) return { ok: false, reason: "no profile signals (research interests, CV, publications)" };
  return { ok: true };
}

const EVENT_TITLE =
  /(conference|congress|symposium|workshop|summer school|winter school|colloquium|kolloquium|seminar series|tagung|kongress|woche|week|expo|hackathon|webinar|meeting|assembly|forum)/i;
const EVENT_BODY =
  /(call for (papers|abstracts|contributions)|abstract (submission|deadline)|paper (submission|deadline)|registration (opens?|deadline|fee|is)|programme committee|programmkomitee|keynote|venue|anmeldung|tagungsort|\b\d{1,2}[.\-/ ](\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[.\-/ ]?\d{2,4}\b)/i;
const NEWS_TITLE = /^(news|aktuelles|press release|pressemitteilung|blog|newsletter|report(s)? (from|on)|rückblick|rueckblick)\b/i;

export function eventGate(url: string, title: string, text: string): Gate {
  // Some sites join words with underscores (DLR_Summer_School); normalise first.
  const t = (title || "").replace(/[_]+/g, " ").trim();
  if (!t) return { ok: false, reason: "no title" };
  if (NEWS_TITLE.test(t)) return { ok: false, reason: "news page that merely mentions an event" };
  if (LIST_TITLE.test(t)) return { ok: false, reason: "event listing page, not one event" };
  if (text.length < 400) return { ok: false, reason: "page too thin to be an event page" };
  if (!EVENT_TITLE.test(t)) return { ok: false, reason: "title does not name an event" };
  if (!EVENT_BODY.test(text))
    return { ok: false, reason: "no event signals (dates, call for papers, registration, venue)" };
  return { ok: true };
}

/**
 * Decide whether a raw page is worth a model request, based only on stored
 * deterministic signals.
 */
export function selectCandidate(input: {
  url: string;
  title: string;
  text: string;
  classification: string | null;
}): CandidateDecision {
  const url = input.url ?? "";
  const title = (input.title ?? "").trim();
  const text = input.text ?? "";
  const path = pathOf(url);

  if (ASSET.test(path)) return { candidate: "NOT_A_CANDIDATE", reason: "binary asset, not a web page" };
  if (JUNK_PATH.test(path)) return { candidate: "NOT_A_CANDIDATE", reason: "legal/utility page path" };
  if (JUNK_TITLE.test(title)) return { candidate: "NOT_A_CANDIDATE", reason: "legal/utility page title" };
  if (path === "/" || path === "") return { candidate: "NOT_A_CANDIDATE", reason: "site homepage" };
  if (text.length < 400) return { candidate: "NOT_A_CANDIDATE", reason: "page too thin to extract from" };

  switch (input.classification) {
    case "VACANCY": {
      const gate = looksLikeSinglePosting(url, title, text);
      if (!gate.ok) return { candidate: "NOT_A_CANDIDATE", reason: `deterministic vacancy gate rejected: ${gate.reason}` };
      return { candidate: "VACANCY_CANDIDATE", reason: "single vacancy posting passed the deterministic gate" };
    }
    case "PROGRAMME":
    case "COURSE": {
      const gate = programmeGate(url, title, text, input.classification);
      if (!gate.ok) return { candidate: "NOT_A_CANDIDATE", reason: `deterministic programme gate rejected: ${gate.reason}` };
      return { candidate: "PROGRAMME_CANDIDATE", reason: "single degree programme page passed the deterministic gate" };
    }
    case "PROJECT": {
      const gate = projectGate(url, title, text);
      if (!gate.ok) return { candidate: "NOT_A_CANDIDATE", reason: `deterministic project gate rejected: ${gate.reason}` };
      return { candidate: "PROJECT_CANDIDATE", reason: "single research project page passed the deterministic gate" };
    }
    case "RESEARCHER": {
      const gate = researcherGate(url, title, text);
      if (!gate.ok) return { candidate: "NOT_A_CANDIDATE", reason: `deterministic researcher gate rejected: ${gate.reason}` };
      return { candidate: "RESEARCHER_CANDIDATE", reason: "single researcher profile passed the deterministic gate" };
    }
    case "EVENT": {
      const gate = eventGate(url, title, text);
      if (!gate.ok) return { candidate: "NOT_A_CANDIDATE", reason: `deterministic event gate rejected: ${gate.reason}` };
      return { candidate: "EVENT_CANDIDATE", reason: "single academic event page passed the deterministic gate" };
    }
    case "RESEARCH_NEWS":
    case "RESEARCH_GROUP":
      return { candidate: "TOPIC_CLASSIFICATION_CANDIDATE", reason: "research page eligible for relevance/topic classification" };
    default:
      return { candidate: "NOT_A_CANDIDATE", reason: `classification ${input.classification ?? "UNKNOWN"} has no extractor` };
  }
}
