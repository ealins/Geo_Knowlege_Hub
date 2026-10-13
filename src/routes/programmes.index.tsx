import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GraduationCap, Search } from "lucide-react";

import {
  AppShell,
  PageHeader,
  ProvenanceChips,
  StatTile,
  TopicPills,
} from "@/components/layout/AppShell";
import { CategoryTabs } from "@/components/CategoryTabs";
import {
  DEGREE_ORDER,
  PROGRAMME_FAMILIES,
  degreeLabel,
  programmeCatalogueQuery,
  countrySlug,
} from "@/lib/category-queries";
import { Skeleton } from "@/components/ui/skeleton";
import { CardLink } from "@/components/CardLink";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/programmes/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(programmeCatalogueQuery),
  head: () => ({
    meta: [
      { title: "Degree programmes — Geospatial study catalogue | GeoAcademic Radar" },
      {
        name: "description",
        content:
          "Categorised catalogue of Master's and Doctoral programmes in photogrammetry, remote sensing, geodesy and geoinformatics worldwide.",
      },
      { property: "og:title", content: "Degree programmes — GeoAcademic Radar" },
      {
        property: "og:description",
        content:
          "Filter geospatial degree programmes by level, subject family, country and language.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:image", content: "https://geoacademic.app/og-geoacademic-radar.jpg" },
      { name: "twitter:image", content: "https://geoacademic.app/og-geoacademic-radar.jpg" },
    ],
  }),
  component: ProgrammesPage,
});

function ProgrammesPage() {
  const data = Route.useLoaderData();
  const isLoading = false;
  const error = null;
  const [level, setLevel] = useState("all");
  const [family, setFamily] = useState("all");
  const [country, setCountry] = useState("all");
  const [language, setLanguage] = useState("all");
  const [q, setQ] = useState("");
  const [visible, setVisible] = useState(36);

  const rows = useMemo(() => data ?? [], [data]);

  const levelTabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of rows) {
      const label = degreeLabel(c.degree_type);
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const ordered = [...counts.entries()].sort(
      (a, b) => DEGREE_ORDER.indexOf(a[0] as (typeof DEGREE_ORDER)[number]) - DEGREE_ORDER.indexOf(b[0] as (typeof DEGREE_ORDER)[number]),
    );
    return [
      { key: "all", label: "All levels", count: rows.length },
      ...ordered.map(([k, v]) => ({ key: k, label: k, count: v })),
    ];
  }, [rows]);

  const familyTabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of rows) counts.set(c.family, (counts.get(c.family) ?? 0) + 1);
    return [
      { key: "all", label: "All subjects", count: rows.length },
      ...PROGRAMME_FAMILIES.filter((f) => counts.has(f.label)).map((f) => ({
        key: f.label,
        label: f.label,
        count: counts.get(f.label) ?? 0,
      })),
    ];
  }, [rows]);

  const countryTabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of rows) counts.set(c.country, (counts.get(c.country) ?? 0) + 1);
    return [
      { key: "all", label: "All countries", count: rows.length },
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, v]) => ({ key: k, label: k, count: v })),
    ];
  }, [rows]);

  const languageTabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of rows)
      counts.set(c.language ?? "Not stated", (counts.get(c.language ?? "Not stated") ?? 0) + 1);
    return [
      { key: "all", label: "Any language", count: rows.length },
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ key: k, label: k, count: v })),
    ];
  }, [rows]);

  const filtered = rows.filter(
    (c) =>
      (level === "all" || degreeLabel(c.degree_type) === level) &&
      (family === "all" || c.family === family) &&
      (country === "all" || c.country === country) &&
      (language === "all" || (c.language ?? "Not stated") === language) &&
      (q.trim() === "" ||
        `${c.title} ${c.institutions?.name ?? ""} ${c.country}`
          .toLowerCase()
          .includes(q.toLowerCase())),
  );

  const visibleRows = filtered.slice(0, visible);
  const grouped = new Map<string, typeof visibleRows>();
  for (const c of visibleRows) {
    grouped.set(c.family, [...(grouped.get(c.family) ?? []), c]);
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow="Study catalogue"
        title="Degree programmes"
        description="Programmes categorised by level, subject family, country and teaching language — each with an on-site synopsis before you ever leave for the official page."
      />
      <div className="mx-auto w-full max-w-7xl px-6 py-8">
        <div className="grid gap-3 sm:grid-cols-4">
          <StatTile label="Programmes tracked" value={rows.length} tone="signal" />
          <StatTile label="Countries" value={countryTabs.length - 1} />
          <StatTile label="Subject families" value={familyTabs.length - 1} />
          <StatTile label="Matching filters" value={filtered.length} tone="growth" />
        </div>

        <div className="panel mt-6 space-y-3 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search programme, institution or country"
              className="pl-9"
            />
          </div>
          <CategoryTabs tabs={levelTabs} active={level} onSelect={setLevel} />
          <CategoryTabs tabs={familyTabs} active={family} onSelect={setFamily} />
          <CategoryTabs tabs={languageTabs} active={language} onSelect={setLanguage} />
          <div className="max-h-24 overflow-y-auto pr-1">
            <CategoryTabs tabs={countryTabs} active={country} onSelect={setCountry} />
          </div>
        </div>

        {error ? (
          <p className="mt-6 text-sm text-destructive">Programmes could not be loaded.</p>
        ) : null}
        {isLoading ? (
          <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full" />
            ))}
          </div>
        ) : (
          <div className="mt-8 space-y-8">
            {[...grouped.entries()].map(([fam, list]) => (
              <section key={fam}>
                <h2 className="flex items-center gap-2 text-[0.68rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  <GraduationCap className="h-3.5 w-3.5" /> {fam}
                  <span className="mono-num opacity-70">{list.length}</span>
                </h2>
                <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {list.map((c) => (
                    <li key={c.id} className="panel panel-hover rise-in relative flex flex-col p-5">
                      <CardLink
                        to="/programmes/$slug"
                        params={{ slug: c.slug }}
                        label={`${c.title}: open programme synopsis`}
                      />
                      <div className="flex items-start justify-between gap-3">
                        <Link
                          to="/programmes/$slug"
                          params={{ slug: c.slug }}
                          className="text-sm font-semibold leading-snug text-foreground hover:text-primary"
                        >
                          {c.title}
                        </Link>
                        <span className="mono-num shrink-0 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-[0.62rem] text-primary">
                          {degreeLabel(c.degree_type) ?? ""}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[0.72rem] text-muted-foreground">
                        {c.institutions?.slug ? (
                          <Link
                            to="/institutions/$slug"
                            params={{ slug: c.institutions.slug }}
                            className="relative z-10 hover:text-primary"
                          >
                            {c.institutions.name}
                          </Link>
                        ) : (
                          "Institution not stated"
                        )}
                        {" · "}
                        <Link
                          to="/countries/$slug"
                          params={{ slug: countrySlug(c.country) }}
                          className="relative z-10 hover:text-primary"
                        >
                          {c.country}
                        </Link>
                      </p>
                      <p className="mono-num mt-1 text-[0.68rem] text-muted-foreground">
                        {c.language ?? "Language not stated"} ·{" "}
                        {c.duration ?? "Duration not stated"}
                      </p>
                      <div className="mt-3">
                        <TopicPills
                          topics={(c.course_topics ?? []).map((t) => t.research_topics?.name)}
                        />
                      </div>
                      <div className="mt-auto pt-4">
                        <ProvenanceChips verification={c.verification_status} isDemo={c.is_demo} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No programme matches these filters. Try widening the level or country.
              </p>
            ) : null}
            {filtered.length > visibleRows.length ? (
              <div className="text-center">
                <button
                  type="button"
                  onClick={() => setVisible((count) => count + 36)}
                  className="rounded-md border border-border bg-muted/40 px-4 py-2 text-xs font-medium text-foreground hover:border-primary/40 hover:text-primary"
                >
                  Show 36 more · {filtered.length - visibleRows.length} remaining
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </AppShell>
  );
}
