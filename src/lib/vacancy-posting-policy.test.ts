import { describe, expect, test } from "bun:test";
import {
  hasRoleTitle,
  isDeterministicallyEligibleVacancySnapshot,
  shouldApplyAdapterClassificationOverride,
  looksLikeSinglePosting,
  normalizeVacancyTitle,
} from "./vacancy-posting-policy";

const validPostingText = [
  "We invite applications for a doctoral researcher in photogrammetry and remote sensing.",
  "Your tasks include processing point clouds, evaluating geospatial datasets, and documenting reproducible methods.",
  "Required qualifications include GIS, photogrammetry, or geomatics experience.",
  "This is a full-time, fixed-term position. Application deadline: 30 November 2026.",
  "Please submit your application with a CV and relevant qualifications before the application deadline.",
].join(" ").repeat(3);

describe("vacancy posting policy", () => {
  test("recognizes role-bearing link labels through the shared policy helper", () => {
    expect(hasRoleTitle("Doctoral Researcher in Photogrammetry")).toBe(true);
    expect(hasRoleTitle("Careers and Opportunities")).toBe(false);
  });
  test("uses the same site-chrome title cleanup as normalization", () => {
    expect(normalizeVacancyTitle("Doctoral Researcher in Photogrammetry | ETH Zurich Careers"))
      .toBe("Doctoral Researcher in Photogrammetry");
  });

  test("allows a single, sufficiently detailed geospatial vacancy posting", () => {
    expect(isDeterministicallyEligibleVacancySnapshot({
      final_url: "https://example.edu/jobs/doctoral-researcher-photogrammetry",
      page_title: "Doctoral Researcher in Photogrammetry | Example University Careers",
      text_content: validPostingText,
    })).toBe(true);
  });

  test("accepts geospatial evidence from strict JobPosting JSON-LD when page text is sparse", () => {
    const structuredPostingText = [
      "Doctoral Researcher in Photogrammetry",
      "The role develops remote sensing methods and processes LiDAR point clouds for environmental monitoring.",
      "Tasks include validating geospatial datasets and documenting reproducible workflows.",
      "Required qualifications include GIS, geomatics, and spatial data analysis.",
      "Application deadline: 30 November 2026. This is a full-time fixed-term research position.",
    ].join(" ").repeat(3);

    expect(isDeterministicallyEligibleVacancySnapshot({
      final_url: "https://example.edu/jobs/doctoral-researcher",
      page_title: "Current job",
      text_content: "Apply online",
      structured_posting_title: "Doctoral Researcher in Photogrammetry",
      structured_posting_text: structuredPostingText,
    })).toBe(true);
  });

  test("rejects a careers index even when its body is long", () => {
    expect(isDeterministicallyEligibleVacancySnapshot({
      final_url: "https://jobs.ethz.ch/site/index",
      page_title: "Stellenangebote der ETH Zürich",
      text_content: validPostingText,
    })).toBe(false);
  });

  test("rejects a long editorial article misclassified as a vacancy", () => {
    expect(isDeterministicallyEligibleVacancySnapshot({
      final_url: "https://www.nasa.gov/directorates/esdmd/hhp/carbon-dioxide-risk/",
      page_title: "Risk of Nominal Acute and Chronic Ambient Carbon Dioxide Exposure - NASA",
      text_content: validPostingText,
    })).toBe(false);
  });

  test("rejects thin or role-less pages before fallback selection", () => {
    expect(looksLikeSinglePosting(
      "https://example.edu/jobs/",
      "Jobs and Careers",
      "We work with geospatial data and photogrammetry.",
    ).ok).toBe(false);
    expect(isDeterministicallyEligibleVacancySnapshot({
      final_url: "https://example.edu/jobs/overview",
      page_title: "Jobs and Careers",
      text_content: validPostingText,
    })).toBe(false);
  });
  test("rejects geospatial keywords found only in unrelated page chrome", () => {
    const body =
      "How to apply and university navigation. ".repeat(25) +
      "closing date " +
      "unrelated page chrome and generic links. ".repeat(90) +
      "mapping resources";
    const structuredDescription = [
      "A funded PhD studentship in molecular biology and peptide engineering.",
      "The project focuses on ribosome profiling, cell biology, and biotechnology.",
      "The student will work on protein engineering and co-translational separation.",
    ].join(" ").repeat(5);

    expect(looksLikeSinglePosting(
      "https://www.cam.ac.uk/jobs/astrazeneca-funded-non-clinical-phd-studentship",
      "AstraZeneca funded Non-clinical PhD Studentship",
      body,
      structuredDescription,
    )).toEqual({
      ok: false,
      reason: "no strong geospatial relevance evidence",
    });
  });

  test("rejects a NASA editorial when job-like and geospatial words are far apart", () => {
    const body =
      "NASA site navigation and general content. ".repeat(100) +
      "E 13" +
      " unrelated page text and footer links. ".repeat(110) +
      "Lidar resources";

    expect(looksLikeSinglePosting(
      "https://www.nasa.gov/centers-and-facilities/armstrong/nasa-intern-took-career-from-car-engines-to-cockpits/",
      "NASA Intern Took Career from Car Engines to Cockpits - NASA",
      body,
    )).toEqual({
      ok: false,
      reason: "no strong geospatial relevance evidence",
    });
  });

  test("accepts geospatial evidence near job-specific text for a generic role title", () => {
    const body = [
      "Your tasks include processing LiDAR point clouds and validating spatial datasets.",
      "Required qualifications include GIS, photogrammetry, or geomatics experience.",
      "This is a full-time, fixed-term position. Application deadline: 30 November 2026.",
    ].join(" ").repeat(4);

    expect(looksLikeSinglePosting(
      "https://example.edu/jobs/doctoral-researcher",
      "Doctoral Researcher",
      body,
    ).ok).toBe(true);
  });

});


describe("adapter classification override quality gate", () => {
  test("does not force a legacy generic vacancy adapter onto an editorial NASA page", () => {
    expect(shouldApplyAdapterClassificationOverride({
      adapterKey: "html-vacancy",
      classification: "GENERAL",
      confidence: 0.1,
      url: "https://www.nasa.gov/langley/history/",
      title: "The History of NASA Langley Research Center",
      text: ("NASA research history and information about careers and opportunities. ").repeat(20),
    })).toBe(false);
  });

  test("keeps a real geospatial posting discovered from a generic vacancy URL", () => {
    expect(shouldApplyAdapterClassificationOverride({
      adapterKey: "html-vacancy",
      classification: "GENERAL",
      confidence: 0.1,
      url: "https://example.edu/opportunities/123",
      title: "Research Engineer in Geospatial AI",
      text: validPostingText,
    })).toBe(true);
  });

  test("uses structured JobPosting title and description instead of generic page chrome", () => {
    expect(shouldApplyAdapterClassificationOverride({
      adapterKey: "html-vacancy",
      classification: "GENERAL",
      confidence: 0.1,
      url: "https://example.edu/careers/role-123",
      title: "Stellenangebote",
      text: "Career page navigation and links.".repeat(20),
      structuredPostingTitle: "Research Engineer in Geospatial AI",
      structuredPostingText: validPostingText,
    })).toBe(true);
  });

  test("does not force a listing path to VACANCY even when it contains structured JobPosting data", () => {
    expect(shouldApplyAdapterClassificationOverride({
      adapterKey: "html-vacancy",
      classification: "GENERAL",
      confidence: 0.95,
      url: "https://www.cam.ac.uk/jobs/term/Yusuf-Hamied-Department-of-Chemistry",
      title: "Yusuf Hamied Department of Chemistry vacancies | University of Cambridge",
      text: validPostingText,
      structuredPostingTitle: "Research Engineer in Geospatial AI",
      structuredPostingText: validPostingText,
    })).toBe(false);
  });

  test("preserves specific detail-adapter overrides", () => {
    expect(shouldApplyAdapterClassificationOverride({
      adapterKey: "html-programmes-detail",
      classification: "GENERAL",
      confidence: 0.1,
      url: "https://example.edu/programmes/geoinformatics",
      title: "Geoinformatics MSc",
      text: "Programme details.",
    })).toBe(true);
  });

  test("does not override an already-specific classification", () => {
    expect(shouldApplyAdapterClassificationOverride({
      adapterKey: "html-vacancy",
      classification: "EVENT",
      confidence: 0.9,
      url: "https://example.edu/events/",
      title: "Geospatial Workshop",
      text: "Event page.",
    })).toBe(false);
  });
});
