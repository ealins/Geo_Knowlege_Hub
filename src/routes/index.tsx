import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, queryOptions } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ArrowUpRight, ExternalLink } from "lucide-react";

import { AppShell, PageHeader, ProvenanceChips, StatTile } from "@/components/layout/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { CardExternalLink } from "@/components/CardLink";
import { countsQuery, pulseQuery } from "@/lib/radar-queries";
import { isPublicOpportunityEvidence } from "@/lib/public-data";
import { InstitutionSnapshot } from "@/components/InstitutionSnapshot";
import { PulseHub, type Cluster } from "@/components/PulseHub";
import type { GlobeArc, GlobePoint } from "@/components/Globe";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";

const hubGlobeQuery = queryOptions({
  queryKey: ["hub-globe"],
  queryFn: async () => {
    const [institutions, opportunities, edges] = await Promise.all([
      supabase.from("institutions").select("id, name, slug, country, latitude, longitude").eq("is_demo", false),
      supabase
        .from("opportunities")
        .select("institution_id, title, description, official_source_url, confidence, verification_status, is_demo, status, application_deadline")
        .in("status", ["open", "closing_soon", "rolling", "possibly_open"])
        .eq("is_demo", false),
      supabase
        .from("collaboration_edges")
        .select("source_entity_id, target_entity_id, weight")
        .eq("is_demo", false)
        .order("weight", { ascending: false })
        .limit(80),
    ]);
    if (institutions.error) throw institutions.error;
    if (opportunities.error) throw opportunities.error;
    if (edges.error) throw edges.error;
    return {
      institutions: institutions.data ?? [],
      opportunities: opportunities.data ?? [],
      edges: edges.data ?? [],
    };
  },
});

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Research Pulse — GeoAcademic Radar" },
      {
        name: "description",
        content:
          "Live feed for photogrammetry, remote sensing and geoinformatics: academic and industry roles, papers, projects and events, each with a source link.",
      },
      { property: "og:title", content: "Research Pulse — GeoAcademic Radar" },
      {
        property: "og:description",
        content:
          "Live research and industry intelligence for photogrammetry, remote sensing and geoinformatics, with provenance on every record.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:image", content: "https://geoacademic.app/og-geoacademic-radar.jpg" },
      { name: "twitter:image", content: "https://geoacademic.app/og-geoacademic-radar.jpg" },
    ],
  }),
  loader: async ({ context }) => {
    // Render the live public counts and source-backed pulse feed in the server
    // HTML as well as after hydration. The globe remains a non-blocking client query.
    await Promise.allSettled([
      context.queryClient.ensureQueryData(countsQuery),
      context.queryClient.ensureQueryData(pulseQuery),
    ]);
  },
  component: AcademicPulse,
});

const CATEGORY: Record<string, { label: string; tone: string }> = {
  PHD: { label: "Position", tone: "border-deadline/40 bg-deadline/12 text-deadline" },
  PAPER: { label: "Publication", tone: "border-primary/40 bg-primary/10 text-primary" },
  PROJECT: { label: "Project", tone: "border-signal/40 bg-signal/12 text-signal" },
  EVENT: { label: "Event", tone: "border-growth/40 bg-growth/12 text-growth" },
  PEOPLE: { label: "People", tone: "border-border bg-muted/60 text-muted-foreground" },
  DATASET: { label: "Dataset", tone: "border-border bg-muted/60 text-muted-foreground" },
  DISSERTATION: { label: "Dissertation", tone: "border-border bg-muted/60 text-muted-foreground" },
  STANDARD: { label: "Standard", tone: "border-border bg-muted/60 text-muted-foreground" },
  FUNDING: { label: "Funding", tone: "border-border bg-muted/60 text-muted-foreground" },
};

function AcademicPulse() {
  const { data: events, isLoading, error } = useQuery(pulseQuery);
  const { data: counts } = useQuery(countsQuery);
  const { data: globe, isLoading: globeLoading } = useQuery(hubGlobeQuery);
  const [selectedPoint, setSelectedPoint] = useState<string | null>(null);

  const points: GlobePoint[] = useMemo(() => {
    if (!globe) return [];
    const live = new Set(globe.opportunities.filter((o: any) => isPublicOpportunityEvidence(o)).map((o: any) => o.institution_id));
    return globe.institutions
      .filter((i: any) => i.latitude !== null && i.longitude !== null)
      .map((i: any) => ({
        id: i.id,
        name: i.name,
        slug: i.slug,
        lat: Number(i.latitude),
        lon: Number(i.longitude),
        country: i.country,
        weight: 2,
        live: live.has(i.id),
      }));
  }, [globe]);

  const globeArcs: GlobeArc[] = useMemo(
    () =>
      (globe?.edges ?? []).map((e: any) => ({
        from: e.source_entity_id,
        to: e.target_entity_id,
        weight: Number(e.weight) || 1,
      })),
    [globe],
  );

  const clusters: Cluster[] = useMemo(
    () => [
      {
        key: "monitor",
        label: "Monitor",
        tone: "monitor",
        blurb: "Watch the field move: where capacity sits, what is rising, who works with whom.",
        spokes: [
          { to: "/atlas", label: "World Monitor", count: points.length },
          { to: "/trends", label: "Research trends" },
          { to: "/collaboration", label: "Collaboration graph" },
        ],
      },
      {
        key: "act",
        label: "Act",
        tone: "act",
        blurb: "Time-critical surfaces: open calls, matched positions and closing deadlines.",
        spokes: [
          { to: "/jobs", label: "Jobs", count: counts?.opportunities ?? "—" },
          { to: "/matcher", label: "Matcher" },
          { to: "/events", label: "Events & deadlines", count: counts?.events ?? "—" },
          { to: "/programmes", label: "Programmes" },
        ],
      },
      {
        key: "knowledge",
        label: "Knowledge base",
        tone: "knowledge",
        blurb: "The sourced record: institutions, people, projects, literature and taxonomy.",
        spokes: [
          { to: "/institutions", label: "Institutions", count: counts?.institutions ?? "—" },
          { to: "/researchers", label: "Researchers", count: counts?.researchers ?? "—" },
          { to: "/projects", label: "Projects", count: counts?.projects ?? "—" },
          { to: "/publications", label: "Publications", count: counts?.publications ?? "—" },
          { to: "/topics", label: "Topics" },
        ],
      },
    ],
    [counts, points.length],
  );

  return (
    <AppShell>
      <PageHeader
        eyebrow="Global research & industry intelligence"
        title="Research Pulse"
        description="What moved in photogrammetry, remote sensing and geoinformatics: new academic and industry positions, publications, projects and events. Every signal keeps its source link and verification status; derived display labels are based on sourced fields rather than invented facts."
        actions={
          <Link
            to="/jobs"
            search={{ sector: "academic" }}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Open jobs radar <ArrowUpRight className="h-4 w-4" />
          </Link>
        }
      />

      <div className="mx-auto w-full max-w-7xl px-6 py-8">
        <section className="panel signal-wash p-6 text-center">
          <p className="text-sm leading-relaxed text-muted-foreground md:text-base">
            Every record links back to an official source and carries a verification status. Some display labels, such as “closing soon”, are computed from sourced dates.
          </p>
        </section>

        <section className="grid-lines mt-8 rounded-lg border border-border/70 bg-card/40 px-4 py-6 md:px-10">
          <p className="mx-auto max-w-xl text-center text-xs leading-relaxed text-muted-foreground">
            The centre is the sourced world: every mapped institution, green where a call is live.
            The rings are the three ways in — pick a spoke to enter that part of the record.
          </p>
          <div className="mt-4">
            <PulseHub
              clusters={clusters}
              points={points}
              arcs={globeArcs}
              loading={globeLoading}
              selectedId={selectedPoint}
              onSelectPoint={setSelectedPoint}
            />
          </div>
        </section>

        <section className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-6">
          <StatTile label="Institutions" value={counts?.institutions ?? "—"} to="/institutions" />
          <StatTile
            label="Researchers"
            value={counts?.researchers ?? "—"}
            tone="signal"
            to="/researchers"
          />
          <StatTile
            label="Positions"
            value={counts?.opportunities ?? "—"}
            tone="deadline"
            to="/jobs"
            search={{ sector: "all" }}
          />
          <StatTile
            label="Publications"
            value={counts?.publications ?? "—"}
            tone="growth"
            to="/publications"
          />
          <StatTile label="Projects" value={counts?.projects ?? "—"} to="/projects" />
          <StatTile label="Events" value={counts?.events ?? "—"} tone="signal" to="/events" />
        </section>

        <section className="mt-10">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Latest signals
            </h2>
            <span className="mono-num text-xs text-muted-foreground">
              {(events?.length ?? 0) > 0 ? `Latest ${events?.length}` : <EmptyState variant="badge" />}
            </span>
          </div>

          {error ? (
            <p className="mt-4 text-sm text-destructive">The feed could not be loaded.</p>
          ) : null}

          {isLoading ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-28 w-full" />
              ))}
            </div>
          ) : (
            <ul className="mt-4 grid gap-3 md:grid-cols-2">
              {events?.map((e) => {
                const cat = CATEGORY[e.category] ?? CATEGORY["PEOPLE"]!;
                const href = e.link_url ?? e.source_url;
                return (
                  <li key={e.id} className="panel panel-hover rise-in relative p-4">
                    {href ? <CardExternalLink href={href} label={`${e.title}: open source`} /> : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wider ${cat.tone}`}
                      >
                        {cat.label}
                      </span>
                      <span className="mono-num text-[0.68rem] text-muted-foreground">
                        {new Date(e.event_date).toLocaleDateString()}
                      </span>
                      {e.country ? (
                        <span className="text-[0.68rem] text-muted-foreground">{e.country}</span>
                      ) : null}
                    </div>

                    <h3 className="mt-2.5 text-sm font-semibold leading-snug text-foreground">
                      {e.title}
                    </h3>
                    {e.summary ? (
                      <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                        {e.summary}
                      </p>
                    ) : null}

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <ProvenanceChips
                        verification={e.verification_status}
                        confidence={e.confidence}
                        isDemo={e.is_demo}
                      />
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="relative z-10 inline-flex items-center gap-1 text-[0.7rem] font-medium text-primary underline-offset-4 hover:underline"
                        >
                          Source <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {!isLoading && !error && (events?.length ?? 0) === 0 ? (
            <div className="mt-4">
              <EmptyState />
            </div>
          ) : null}
        </section>
      </div>

      <InstitutionSnapshot
        slug={points.find((p) => p.id === selectedPoint)?.slug ?? null}
        open={Boolean(selectedPoint)}
        onOpenChange={(o) => {
          if (!o) setSelectedPoint(null);
        }}
      />
    </AppShell>
  );
}
