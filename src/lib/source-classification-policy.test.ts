import { describe, expect, test } from "bun:test";
import {
  hasVacancyPathOrTitleSignal,
  shouldDowngradeBodyOnlyVacancy,
} from "./source-classification-policy";

describe("body-only vacancy classification guard", () => {
  test("downgrades editorial and informational pages with no vacancy signal in URL/title", () => {
    expect(shouldDowngradeBodyOnlyVacancy(
      "VACANCY",
      "/missions/station/iss-research/food-on-iss/",
      "Food on the International Space Station - NASA",
    )).toBe(true);

    expect(shouldDowngradeBodyOnlyVacancy(
      "VACANCY",
      "/analog-missions/",
      "Analog Missions - NASA",
    )).toBe(true);
  });

  test("keeps vacancy pages when the URL path contains a job signal", () => {
    expect(shouldDowngradeBodyOnlyVacancy(
      "VACANCY",
      "/careers/research-engineer/",
      "Research Engineer",
    )).toBe(false);
  });

  test("keeps vacancy pages when the title contains a job signal", () => {
    expect(shouldDowngradeBodyOnlyVacancy(
      "VACANCY",
      "/opportunities/123/",
      "PhD-Position in Geospatial AI",
    )).toBe(false);
  });

  test("does not affect other classifications", () => {
    expect(shouldDowngradeBodyOnlyVacancy(
      "PROJECT",
      "/missions/station/iss-research/",
      "International Space Station Research",
    )).toBe(false);
  });

  test("recognizes normalized spaces in title signals", () => {
    expect(hasVacancyPathOrTitleSignal("/opportunities/123/", "Open Position in Remote Sensing")).toBe(true);
  });
});
