import { describe, expect, test } from "bun:test";
import { deterministicMediaSnapshotReason, deterministicProgrammeSnapshotReason, deterministicNormalizationFallbackLimit, discoveryFallbackPolicy, hasProviderCircuitOpenSignal, hasProviderGatewayFailureSignal, isIndependentProviderConfigured, normalizationWavePolicy, selectDeterministicMediaTaskIds, selectDeterministicProgrammeTaskIds, selectDeterministicVacancyTaskIds, selectPreferredDeterministicVacancyTaskIds, selectDeterministicResearchNewsTaskIds, shouldRunDeterministicNormalizationFallback, shouldRunNormalizationWave, shouldThrottleSteadyStateDrain } from "./queue-drain-policy";

describe("shouldThrottleSteadyStateDrain", () => {
  test("keeps the interval for a small, recently due queue after recent work", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 7,
      batchSize: 4,
      oldestDueAgeMinutes: 5,
    })).toBe(true);
  });

  test("allows bounded catch-up when a small queue has aged beyond the limit", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 7,
      batchSize: 4,
      oldestDueAgeMinutes: 15,
    })).toBe(false);
  });

  test("keeps the interval if due-task age is unknown after a telemetry read error", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 7,
      batchSize: 4,
      oldestDueAgeMinutes: null,
    })).toBe(true);
  });

  test("allows bounded catch-up when due work exceeds two steady-state waves", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 23,
      batchSize: 4,
      oldestDueAgeMinutes: 2,
    })).toBe(false);
  });

  test("does not throttle when there was no recent work", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: false,
      dueTasks: 4,
      batchSize: 4,
      oldestDueAgeMinutes: 2,
    })).toBe(false);
  });

  test("scales the catch-up threshold with larger steady-state batches", () => {
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 10,
      batchSize: 6,
      oldestDueAgeMinutes: 2,
    })).toBe(true);
    expect(shouldThrottleSteadyStateDrain({
      recentWork: true,
      dueTasks: 13,
      batchSize: 6,
      oldestDueAgeMinutes: 2,
    })).toBe(false);
  });
});



describe("isIndependentProviderConfigured", () => {
  test("recognizes NVIDIA as an independent provider", () => {
    expect(isIndependentProviderConfigured({ nvidiaKey: "nvidia-secret" })).toBe(true);
  });

  test("recognizes an OpenAI key", () => {
    expect(isIndependentProviderConfigured({ openAIKey: "openai-secret" })).toBe(true);
  });

  test("requires both OpenRouter key and model", () => {
    expect(isIndependentProviderConfigured({ openRouterKey: "router-secret" })).toBe(false);
    expect(isIndependentProviderConfigured({
      openRouterKey: "router-secret",
      openRouterModel: "model-id",
    })).toBe(true);
  });

  test("treats whitespace-only keys as absent", () => {
    expect(isIndependentProviderConfigured({
      nvidiaKey: "  ",
      openAIKey: "",
      openRouterKey: " ",
      openRouterModel: "model-id",
    })).toBe(false);
  });
});

describe("normalizationWavePolicy", () => {
  test("serializes normalization when no independent provider is configured", () => {
    expect(normalizationWavePolicy({
      mode: "BACKLOG",
      batch: 4,
      independentFallbackConfigured: false,
    })).toEqual({ target: 4, waveSize: 1, concurrency: 1 });
  });

  test("allows eight deterministic-only slots when the circuit is already open", () => {
    expect(normalizationWavePolicy({
      mode: "BACKLOG",
      batch: 20,
      independentFallbackConfigured: false,
      providerCircuitOpen: true,
    })).toEqual({ target: 8, waveSize: 1, concurrency: 1 });
  });

  test("does not widen the target when the circuit is closed", () => {
    expect(normalizationWavePolicy({
      mode: "BACKLOG",
      batch: 20,
      independentFallbackConfigured: false,
      providerCircuitOpen: false,
    })).toEqual({ target: 4, waveSize: 1, concurrency: 1 });
  });

  test("preserves bounded parallel waves when an independent provider is configured", () => {
    expect(normalizationWavePolicy({
      mode: "BACKLOG",
      batch: 4,
      independentFallbackConfigured: true,
    })).toEqual({ target: 4, waveSize: 2, concurrency: 3 });
    expect(normalizationWavePolicy({
      mode: "STEADY_STATE",
      batch: 3,
      independentFallbackConfigured: true,
    })).toEqual({ target: 3, waveSize: 2, concurrency: 2 });
  });
});

describe("provider gateway failure signals", () => {
  test("detects a gateway deferral so the drain can stop before claiming another task", () => {
    expect(hasProviderGatewayFailureSignal([
      "DEFERRED NORMALIZE: TRANSIENT_EXTRACTION_FAILURE GATEWAY_5XX: HTTP_502",
    ])).toBe(true);
  });

  test("detects HTTP 504 so the drain stops before claiming another normalization task", () => {
    expect(hasProviderGatewayFailureSignal([
      "DEFERRED NORMALIZE: TRANSIENT_EXTRACTION_FAILURE HTTP_504: gateway timeout",
    ])).toBe(true);
  });

  test("detects an explicit circuit-open response", () => {
    expect(hasProviderCircuitOpenSignal([
      "DEFERRED NORMALIZE: circuit open after repeated recent primary gateway HTTP 502/503/530 failures",
    ])).toBe(true);
  });

  test("does not classify ordinary extraction validation failures as gateway outages", () => {
    expect(hasProviderGatewayFailureSignal(["FAILED NORMALIZE: missing title"])).toBe(false);
    expect(hasProviderCircuitOpenSignal(["FAILED NORMALIZE: missing title"])).toBe(false);
  });
});

describe("shouldRunNormalizationWave", () => {
  test("does not claim normalization work while the provider circuit is open", () => {
    expect(shouldRunNormalizationWave({
      providerCircuitOpen: true,
      processed: 0,
      target: 4,
    })).toBe(false);
  });

  test("continues bounded normalization waves when the circuit is closed", () => {
    expect(shouldRunNormalizationWave({
      providerCircuitOpen: false,
      processed: 0,
      target: 4,
    })).toBe(true);
    expect(shouldRunNormalizationWave({
      providerCircuitOpen: false,
      processed: 4,
      target: 4,
    })).toBe(false);
  });
});

describe("discoveryFallbackPolicy", () => {
  test("runs one bounded discovery task with a longer budget during provider circuit", () => {
    expect(discoveryFallbackPolicy(true, 8)).toEqual({
      limit: 1,
      timeoutMs: 150_000,
    });
  });

  test("preserves the ordinary discovery batch and timeout when the circuit is closed", () => {
    expect(discoveryFallbackPolicy(false, 4)).toEqual({
      limit: 4,
      timeoutMs: 15_000,
    });
  });
});


describe("selectDeterministicVacancyTaskIds", () => {
  test("selects only an exact pending vacancy snapshot for the same source", () => {
    expect(selectDeterministicVacancyTaskIds(
      [
        { id: "raw-vacancy", source_id: "source-a" },
        { id: "raw-other", source_id: "source-b" },
      ],
      [
        { id: "task-exact", source_id: "source-a", payload: { raw_record_id: "raw-vacancy" } },
        { id: "task-wrong-source", source_id: "source-a", payload: { raw_record_id: "raw-other" } },
        { id: "task-legacy", source_id: "source-a", payload: { classification: "VACANCY" } },
      ],
      1,
    )).toEqual(["task-exact"]);
  });

  test("does not select more than one task per source or exceed the limit", () => {
    expect(selectDeterministicVacancyTaskIds(
      [
        { id: "raw-a", source_id: "source-a" },
        { id: "raw-b", source_id: "source-a" },
        { id: "raw-c", source_id: "source-c" },
      ],
      [
        { id: "task-a1", source_id: "source-a", payload: { raw_record_id: "raw-a" } },
        { id: "task-a2", source_id: "source-a", payload: { raw_record_id: "raw-b" } },
        { id: "task-c1", source_id: "source-c", payload: { raw_record_id: "raw-c" } },
      ],
      2,
    )).toEqual(["task-a1", "task-c1"]);
  });

  test("returns no candidates when exact snapshot IDs are missing or stale", () => {
    expect(selectDeterministicVacancyTaskIds(
      [{ id: "raw-vacancy", source_id: "source-a" }],
      [
        { id: "task-legacy", source_id: "source-a", payload: { classification: "VACANCY" } },
        { id: "task-stale", source_id: "source-a", payload: { raw_record_id: "raw-deleted" } },
      ],
      1,
    )).toEqual([]);
  });
});


describe("selectPreferredDeterministicVacancyTaskIds", () => {
  test("prioritizes a gate-passing snapshot over an older rejected snapshot", () => {
    expect(selectPreferredDeterministicVacancyTaskIds(
      [
        { id: "raw-rejected", source_id: "source-a" },
        { id: "raw-eligible", source_id: "source-b" },
      ],
      new Set(["raw-eligible"]),
      [
        { id: "task-rejected", source_id: "source-a", payload: { raw_record_id: "raw-rejected" } },
        { id: "task-eligible", source_id: "source-b", payload: { raw_record_id: "raw-eligible" } },
      ],
      1,
    )).toEqual(["task-eligible"]);
  });

  test("drains one exact rejected snapshot when no gate-passing snapshot is available", () => {
    expect(selectPreferredDeterministicVacancyTaskIds(
      [{ id: "raw-rejected", source_id: "source-a" }],
      new Set(),
      [{ id: "task-rejected", source_id: "source-a", payload: { raw_record_id: "raw-rejected" } }],
      1,
    )).toEqual(["task-rejected"]);
  });

  test("drains up to three rejected snapshots from distinct sources during provider outage", () => {
    expect(selectPreferredDeterministicVacancyTaskIds(
      [
        { id: "raw-a", source_id: "source-a" },
        { id: "raw-b", source_id: "source-b" },
        { id: "raw-c", source_id: "source-c" },
        { id: "raw-d", source_id: "source-d" },
      ],
      new Set(),
      [
        { id: "task-a", source_id: "source-a", payload: { raw_record_id: "raw-a" } },
        { id: "task-b", source_id: "source-b", payload: { raw_record_id: "raw-b" } },
        { id: "task-c", source_id: "source-c", payload: { raw_record_id: "raw-c" } },
        { id: "task-d", source_id: "source-d", payload: { raw_record_id: "raw-d" } },
      ],
      3,
    )).toEqual(["task-a", "task-b", "task-c"]);
  });

  test("never falls back to a legacy task without an exact raw_record_id", () => {
    expect(selectPreferredDeterministicVacancyTaskIds(
      [{ id: "raw-rejected", source_id: "source-a" }],
      new Set(),
      [{ id: "task-legacy", source_id: "source-a", payload: { classification: "VACANCY" } }],
      1,
    )).toEqual([]);
  });
});


describe("selectDeterministicResearchNewsTaskIds", () => {
  test("selects only exact pending RESEARCH_NEWS snapshots marked for cleanup", () => {
    const pending = [
      { id: "news-1", source_id: "source-1", classification: "RESEARCH_NEWS" },
      { id: "news-2", source_id: "source-2", classification: "RESEARCH_NEWS" },
    ];
    const tasks = [
      {
        id: "task-1",
        source_id: "source-1",
        payload: {
          raw_record_id: "news-1",
          classification: "RESEARCH_NEWS",
          deterministic_cleanup: true,
        },
      },
      {
        id: "task-2",
        source_id: "source-2",
        payload: {
          raw_record_id: "news-2",
          classification: "RESEARCH_NEWS",
          deterministic_cleanup: true,
        },
      },
    ];
    expect(selectDeterministicResearchNewsTaskIds(pending, tasks, 1)).toEqual(["task-1"]);
    expect(selectDeterministicResearchNewsTaskIds(pending, tasks, 2)).toEqual(["task-1", "task-2"]);
  });

  test("rejects legacy tasks, wrong-source IDs, other classifications and unmarked tasks", () => {
    const pending = [
      { id: "news-1", source_id: "source-1", classification: "RESEARCH_NEWS" },
    ];
    const tasks = [
      { id: "legacy", source_id: "source-1", payload: { classification: "RESEARCH_NEWS" } },
      {
        id: "wrong-source",
        source_id: "source-2",
        payload: {
          raw_record_id: "news-1",
          classification: "RESEARCH_NEWS",
          deterministic_cleanup: true,
        },
      },
      {
        id: "not-marked",
        source_id: "source-1",
        payload: { raw_record_id: "news-1", classification: "RESEARCH_NEWS" },
      },
      {
        id: "wrong-class",
        source_id: "source-1",
        payload: {
          raw_record_id: "news-1",
          classification: "VACANCY",
          deterministic_cleanup: true,
        },
      },
    ];
    expect(selectDeterministicResearchNewsTaskIds(pending, tasks, 5)).toEqual([]);
  });

  test("does not select a vacancy task from a source already selected for cleanup", () => {
    const pending = [
      { id: "vac-1", source_id: "source-1" },
      { id: "vac-2", source_id: "source-2" },
    ];
    const tasks = [
      { id: "task-1", source_id: "source-1", payload: { raw_record_id: "vac-1" } },
      { id: "task-2", source_id: "source-2", payload: { raw_record_id: "vac-2" } },
    ];
    expect(selectDeterministicVacancyTaskIds(pending, tasks, 2, ["source-1"])).toEqual(["task-2"]);
  });
});


describe("shouldRunDeterministicNormalizationFallback", () => {
  test("runs deterministic cleanup when the circuit was already open", () => {
    expect(shouldRunDeterministicNormalizationFallback({
      providerCircuitOpen: true,
      providerGatewayFailure: false,
      independentFallbackConfigured: false,
    })).toBe(true);
  });

  test("runs bounded cleanup after the first gateway failure in this invocation", () => {
    expect(shouldRunDeterministicNormalizationFallback({
      providerCircuitOpen: false,
      providerGatewayFailure: true,
      independentFallbackConfigured: false,
    })).toBe(true);
  });

  test("does not run outage fallback when an independent provider is configured", () => {
    expect(shouldRunDeterministicNormalizationFallback({
      providerCircuitOpen: true,
      providerGatewayFailure: true,
      independentFallbackConfigured: true,
    })).toBe(false);
  });

  test("does not run outage fallback when the provider is healthy", () => {
    expect(shouldRunDeterministicNormalizationFallback({
      providerCircuitOpen: false,
      providerGatewayFailure: false,
      independentFallbackConfigured: false,
    })).toBe(false);
  });
});


describe("deterministicNormalizationFallbackLimit", () => {
  test("reserves one cleanup slot when a gateway failure consumes the target", () => {
    expect(deterministicNormalizationFallbackLimit({
      target: 4,
      processed: 4,
      providerGatewayFailure: true,
    })).toBe(1);
  });

  test("keeps fallback work at three after a provider failure so total work stays bounded", () => {
    expect(deterministicNormalizationFallbackLimit({
      target: 4,
      processed: 1,
      providerGatewayFailure: true,
    })).toBe(3);
  });

  test("does not grant a failure credit while the provider is healthy", () => {
    expect(deterministicNormalizationFallbackLimit({
      target: 4,
      processed: 4,
      providerGatewayFailure: false,
    })).toBe(0);
  });

  test("uses all four bounded slots when the circuit is already open at preflight", () => {
    expect(deterministicNormalizationFallbackLimit({
      target: 4,
      processed: 0,
      providerGatewayFailure: false,
    })).toBe(4);
  });

  test("keeps ordinary cleanup capped at four even if the requested target is larger", () => {
    expect(deterministicNormalizationFallbackLimit({
      target: 20,
      processed: 0,
      providerGatewayFailure: false,
    })).toBe(4);
  });

  test("allows eight slots only when the circuit was already open at preflight", () => {
    expect(deterministicNormalizationFallbackLimit({
      target: 8,
      processed: 0,
      providerGatewayFailure: false,
      providerCircuitOpen: true,
    })).toBe(8);
  });

  test("keeps the stricter cap after a gateway failure in the current invocation", () => {
    expect(deterministicNormalizationFallbackLimit({
      target: 8,
      processed: 1,
      providerGatewayFailure: true,
      providerCircuitOpen: true,
    })).toBe(3);
  });
});


describe("deterministicMediaSnapshotReason", () => {
  test("recognizes legacy ESA multimedia pages misclassified as courses", () => {
    expect(deterministicMediaSnapshotReason({
      classification: "COURSE",
      finalUrl: "https://www.esa.int/ESA_Multimedia/Videos/2026/04/Artemis_II",
    })).toBe("ESA multimedia item is not a course");
    expect(deterministicMediaSnapshotReason({
      classification: "COURSE",
      finalUrl: "https://www.esa.int/ESA_Multimedia/Images/2026/07/Artemis_crew",
    })).toBe("ESA multimedia item is not a course");
  });

  test("does not skip non-ESA URLs, other classifications, or unrelated ESA pages", () => {
    expect(deterministicMediaSnapshotReason({
      classification: "COURSE",
      finalUrl: "https://example.org/ESA_Multimedia/Videos/2026/course",
    })).toBeNull();
    expect(deterministicMediaSnapshotReason({
      classification: "VACANCY",
      finalUrl: "https://www.esa.int/ESA_Multimedia/Videos/2026/04/Artemis_II",
    })).toBeNull();
    expect(deterministicMediaSnapshotReason({
      classification: "COURSE",
      finalUrl: "https://www.esa.int/education/courses/geospatial",
    })).toBeNull();
  });
});

describe("selectDeterministicMediaTaskIds", () => {
  test("selects only exact ESA media COURSE snapshots for the same source", () => {
    expect(selectDeterministicMediaTaskIds(
      [
        { id: "raw-media", source_id: "source-a", classification: "COURSE", final_url: "https://www.esa.int/ESA_Multimedia/Videos/2026/04/Artemis_II" },
        { id: "raw-course", source_id: "source-b", classification: "COURSE", final_url: "https://www.esa.int/education/courses/geospatial" },
      ],
      [
        { id: "task-exact", source_id: "source-a", payload: { classification: "COURSE", raw_record_id: "raw-media" } },
        { id: "task-wrong-source", source_id: "source-b", payload: { classification: "COURSE", raw_record_id: "raw-media" } },
        { id: "task-wrong-class", source_id: "source-a", payload: { classification: "VACANCY", raw_record_id: "raw-media" } },
        { id: "task-legacy", source_id: "source-a", payload: { classification: "COURSE" } },
      ],
      3,
    )).toEqual(["task-exact"]);
  });

  test("respects the cleanup limit and one task per source", () => {
    expect(selectDeterministicMediaTaskIds(
      [
        { id: "raw-a1", source_id: "source-a", classification: "COURSE", final_url: "https://www.esa.int/ESA_Multimedia/Videos/2026/a" },
        { id: "raw-a2", source_id: "source-a", classification: "COURSE", final_url: "https://www.esa.int/ESA_Multimedia/Images/2026/b" },
        { id: "raw-b", source_id: "source-b", classification: "COURSE", final_url: "https://www.esa.int/ESA_Multimedia/Images/2026/c" },
      ],
      [
        { id: "task-a1", source_id: "source-a", payload: { classification: "COURSE", raw_record_id: "raw-a1" } },
        { id: "task-a2", source_id: "source-a", payload: { classification: "COURSE", raw_record_id: "raw-a2" } },
        { id: "task-b", source_id: "source-b", payload: { classification: "COURSE", raw_record_id: "raw-b" } },
      ],
      2,
    )).toEqual(["task-a1", "task-b"]);
  });

  test("honours sources already selected by another deterministic fallback", () => {
    expect(selectDeterministicMediaTaskIds(
      [{ id: "raw-a", source_id: "source-a", classification: "COURSE", final_url: "https://www.esa.int/ESA_Multimedia/Videos/2026/a" }],
      [{ id: "task-a", source_id: "source-a", payload: { classification: "COURSE", raw_record_id: "raw-a" } }],
      1,
      ["source-a"],
    )).toEqual([]);
  });
});


describe("deterministicProgrammeSnapshotReason", () => {
  test("recognizes only known institutional navigation pages misclassified as programmes", () => {
    expect(deterministicProgrammeSnapshotReason({
      classification: "PROGRAMME",
      finalUrl: "https://eaps.mit.edu/internal-resources/department-policies/",
      pageTitle: "Department Policies - MIT EAPS",
    })).toBe("institutional navigation/resource page is not a programme opportunity");
    expect(deterministicProgrammeSnapshotReason({
      classification: "PROGRAMME",
      finalUrl: "https://eps.berkeley.edu/about/department-chairs-letter",
      pageTitle: "Department Chair&#039;s Letter | Earth & Planetary Science",
    })).toBe("institutional navigation/resource page is not a programme opportunity");
    expect(deterministicProgrammeSnapshotReason({
      classification: "PROGRAMME",
      finalUrl: "https://www.esc.cam.ac.uk/about-us/find-us",
      pageTitle: "Visit & Contact Us | Department of Earth Sciences",
    })).toBe("institutional navigation/resource page is not a programme opportunity");
  });

  test("preserves real programmes and avoids title-only or path-only matches", () => {
    expect(deterministicProgrammeSnapshotReason({
      classification: "PROGRAMME",
      finalUrl: "https://www.nasa.gov/learning-resources/internship-programs/nasa-fellowships/",
      pageTitle: "NASA Fellowships - NASA",
    })).toBeNull();
    expect(deterministicProgrammeSnapshotReason({
      classification: "PROGRAMME",
      finalUrl: "https://example.org/programmes/department-policies",
      pageTitle: "Department Policies",
    })).toBeNull();
    expect(deterministicProgrammeSnapshotReason({
      classification: "VACANCY",
      finalUrl: "https://eaps.mit.edu/internal-resources/department-policies/",
      pageTitle: "Department Policies - MIT EAPS",
    })).toBeNull();
  });
});

describe("selectDeterministicProgrammeTaskIds", () => {
  const pending = [
    {
      id: "raw-admin",
      source_id: "source-a",
      classification: "PROGRAMME",
      final_url: "https://eaps.mit.edu/internal-resources/department-policies/",
      page_title: "Department Policies - MIT EAPS",
    },
    {
      id: "raw-real",
      source_id: "source-b",
      classification: "PROGRAMME",
      final_url: "https://www.nasa.gov/learning-resources/internship-programs/nasa-fellowships/",
      page_title: "NASA Fellowships - NASA",
    },
  ];

  test("selects only exact matching programme tasks from distinct sources", () => {
    expect(selectDeterministicProgrammeTaskIds(pending, [
      { id: "task-admin", source_id: "source-a", payload: { raw_record_id: "raw-admin", classification: "PROGRAMME" } },
      { id: "task-wrong-source", source_id: "source-c", payload: { raw_record_id: "raw-admin", classification: "PROGRAMME" } },
      { id: "task-real", source_id: "source-b", payload: { raw_record_id: "raw-real", classification: "PROGRAMME" } },
      { id: "task-legacy", source_id: "source-a", payload: { classification: "PROGRAMME" } },
    ], 3)).toEqual(["task-admin"]);
  });

  test("honors limit and excludes sources already selected for higher-priority cleanup", () => {
    expect(selectDeterministicProgrammeTaskIds(pending, [
      { id: "task-admin", source_id: "source-a", payload: { raw_record_id: "raw-admin", classification: "PROGRAMME" } },
    ], 2, ["source-a"])).toEqual([]);
    expect(selectDeterministicProgrammeTaskIds(pending, [
      { id: "task-admin", source_id: "source-a", payload: { raw_record_id: "raw-admin", classification: "PROGRAMME" } },
    ], 0)).toEqual([]);
  });
});
