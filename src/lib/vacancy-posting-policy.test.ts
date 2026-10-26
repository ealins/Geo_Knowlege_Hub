import { describe, expect, test } from "bun:test";
import {
  hasRoleTitle,
  isDeterministicallyEligibleVacancySnapshot,
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
});
