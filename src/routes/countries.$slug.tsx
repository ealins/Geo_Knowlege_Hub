import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ExternalLink, MapPin } from "lucide-react";

import { AppShell, PageHeader, ProvenanceChips, StatTile } from "@/components/layout/AppShell";
import { countryDetailQuery, degreeLabel } from "@/lib/category-queries";
import { STATUS_LABEL, TYPE_LABEL, daysUntil, formatDate } from "@/lib/radar-queries";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/countries/$slug")({
  head: ({ params }) => {
    const pretty = params.slug.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
    return {
      meta: [
        { title: `${pretty} — Geospatial research synopsis | GeoAcademic Radar` },
        {
          name: "description",
          content: `Institutions, open PhD calls, degree programmes, projects and events in photogrammetry, remote sensing and geoinformatics across ${pretty}.`,
        },
        { property: "og:title", content: `${pretty} — Geospatial research synopsis` },
        {
          property: "og:description",
          content: `One-page country synopsis of geospatial academic capacity in ${pretty}.`,
        },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary_large_image" },
        { property: "og:image", content: "https://geoacademic.app/og-geoacademic-radar.jpg" },
        { name: "twitter:image", content: "https://geoacademic.app/og-geoacademic-radar.jpg" },
      ],
    };
  },
  component: CountryDetail,
  errorComponent: () => (
    <AppShell>
      <div className="p-8 text-sm text-destructive">This country page could not be loaded.</div>
    </AppShell>
  ),
  notFoundComponent: () => (
    <AppShell>
      <div className="p-8 text-sm text-muted-foreground">No such country is tracked yet.</div>
    </AppShell>
  ),
});

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-baseline gap-2 text-[0.68rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {title}
          {typeof count === "number" ? <span className="mono-num opacity-70">{count}</span> : null}
        </h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}


function CountryDetail() {
  const { slug } = Route.useParams();
  const { data, isLoading } = useQuery(countryDetailQuery(slug));

  if (isLoading) {
    return (
      <AppShell>
        <div className="mx-auto w-full max-w-7xl space-y-3 p-8">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell>
        <div className="p-8 text-sm text-muted-foreground">
          No records for this country yet.{" "}
          <Link to="/countries" className="text-primary hover:underline">
            Back to countries
          </Link>
        </div>
      </AppShell>
    );
  }

  const byDegree = new Map<string, typeof data.courses>();
  for (const c of data.courses) {
    const key = degreeLabel(c.degree_type);
    byDegree.set(key, [...(byDegree.get(key) ?? []), c]);
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow={data.continent ?? "Country synopsis"}
        title={data.country}
        description="A single page that answers what happens here: who does the research, what you can apply for, what you can study, and what is being funded."
      />
      <div className="mx-auto w-full max-w-7xl px-6 py-8">
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <StatTile
            label="Academic pulse"
            value={data.totals.pulse}
            tone="signal"
            hint="One point for each qualifying sourced Pulse signal"
          />
          <StatTile label="Institutions" value={data.totals.institutions} />
          <StatTile label="Open calls" value={data.totals.openCalls} tone="deadline" />
          <StatTile label="Programmes" value={data.totals.programmes} />
          <StatTile label="Active projects" value={data.totals.projects} />
          <StatTile label="Papers (3y)" value={data.totals.publications} tone="growth" />
        </div>

        {data.topics.length > 0 ? (
          <Section
            title="Research focus in this country"
            count={data.topics.length}
            action={
              <Link to="/topics" className="text-[0.7rem] font-medium text-primary underline-offset-4 hover:underline">
                Taxonomy →
              </Link>
            }
          >
            <div className="flex flex-wrap gap-1.5">
              {data.topics.map((t) => (
                <Link
                  key={t.slug}
                  to="/topics/$slug"
                  params={{ slug: t.slug }}
                  className="rounded-md border border-signal/30 bg-signal/10 px-2.5 py-1 text-xs text-foreground/85 hover:border-primary/50 hover:text-primary"
                >
                  {t.name} <span className="mono-num opacity-60">{t.count}</span>
                </Link>
              ))}
            </div>
          </Section>
        ) : null}

        <Section
          title="Institutions ranked by academic pulse"
          count={data.institutions.length}
          action={
            <Link to="/institutions" className="text-[0.7rem] font-medium text-primary underline-offset-4 hover:underline">
              All institutions →
            </Link>
          }
        >
          <ul className="grid gap-2 lg:grid-cols-2">
            {data.institutions.map((i, idx) => (
              <li key={i.id} className="panel panel-hover flex items-center gap-3 p-4">
                <span className="mono-num w-6 text-xs text-muted-foreground">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <Link
                    to="/institutions/$slug"
                    params={{ slug: i.slug }}
                    className="block truncate text-sm font-semibold text-foreground hover:text-primary"
                  >
                    {i.name}
                  </Link>
                  <p className="mt-0.5 flex items-center gap-1 text-[0.7rem] text-muted-foreground">
                    <MapPin className="h-3 w-3" />
                    {i.city ?? "City not stated"} · {i.institution_type.replace(/_/g, " ")}
                  </p>
                </div>
                <div className="mono-num shrink-0 text-right text-[0.68rem] text-muted-foreground">
                  <p className="text-primary">{Math.round(i.pulse)} pulse</p>
                  <p>
                    {i.openCalls} calls · {i.programmes} progs
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Open and recent calls"
          count={data.opportunities.length}
          action={
            <span className="flex gap-3">
              <Link to="/jobs" search={{ sector: "academic" }} className="text-[0.7rem] font-medium text-primary underline-offset-4 hover:underline">
                Academic jobs →
              </Link>
              <Link to="/jobs" search={{ sector: "industry" }} className="text-[0.7rem] font-medium text-primary underline-offset-4 hover:underline">

                Industry roles →
              </Link>
            </span>
          }
        >
          {data.opportunities.length === 0 ? (
            <p className="text-sm text-muted-foreground">No calls recorded for this country yet.</p>
          ) : (
            <ul className="grid gap-2 lg:grid-cols-2">
              {data.opportunities.map((o) => {
                const d = daysUntil(o.application_deadline);
                return (
                  <li key={o.id} className="panel panel-hover p-4">
                    <Link
                      to="/jobs/$slug"
                      params={{ slug: o.slug }}
                      className="text-sm font-semibold leading-snug text-foreground hover:text-primary"
                    >
                      {o.title}
                    </Link>
                    <p className="mt-1 text-[0.72rem] text-muted-foreground">
                      {o.institutions?.name ?? "Institution not stated"} ·{" "}
                      {TYPE_LABEL[o.opportunity_type] ?? o.opportunity_type} ·{" "}
                      {STATUS_LABEL[o.status] ?? o.status}
                    </p>
                    <p className="mono-num mt-1.5 text-[0.7rem] text-muted-foreground">
                      {o.application_deadline
                        ? `Deadline ${formatDate(o.application_deadline)}${
                            d !== null && d >= 0 ? ` · ${d} days left` : ""
                          }`
                        : "No stated deadline"}
                    </p>
                    <div className="mt-2">
                      <ProvenanceChips verification={o.verification_status} isDemo={o.is_demo} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section
          title="Degree programmes by level"
          count={data.courses.length}
          action={
            <Link to="/programmes" className="text-[0.7rem] font-medium text-primary underline-offset-4 hover:underline">
              Full catalogue →
            </Link>
          }
        >
          {data.courses.length === 0 ? (
            <p className="text-sm text-muted-foreground">No programmes recorded here yet.</p>
          ) : (
            <div className="space-y-5">
              {[...byDegree.entries()].map(([level, list]) => (
                <div key={level}>
                  <p className="text-xs font-medium text-foreground/80">
                    {level} <span className="mono-num text-muted-foreground">{list.length}</span>
                  </p>
                  <ul className="mt-2 grid gap-2 lg:grid-cols-2">
                    {list.map((c) => (
                      <li key={c.id} className="panel panel-hover p-3.5">
                        <Link
                          to="/programmes/$slug"
                          params={{ slug: c.slug }}
                          className="text-sm font-medium text-foreground hover:text-primary"
                        >
                          {c.title}
                        </Link>
                        <p className="mt-1 text-[0.7rem] text-muted-foreground">
                          {c.institutions?.name} · {c.language ?? "Language not stated"} ·{" "}
                          {c.duration ?? "Duration not stated"}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section
            title="Projects"
            count={data.projects.length}
            action={
              <Link to="/projects" className="text-[0.7rem] font-medium text-primary underline-offset-4 hover:underline">
                All projects →
              </Link>
            }
          >
            <ul className="space-y-2">
              {data.projects.map((p) => (
                <li key={p.id} className="panel panel-hover p-3.5">
                  <Link
                    to="/projects/$slug"
                    params={{ slug: p.slug }}
                    className="text-sm font-medium text-foreground hover:text-primary"
                  >
                    {p.name}
                  </Link>
                  <p className="mt-1 text-[0.7rem] text-muted-foreground">
                    {p.status} · {p.funding_organization ?? "Funder not stated"}
                  </p>
                </li>
              ))}
              {data.projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">No projects recorded yet.</p>
              ) : null}
            </ul>
          </Section>

          <Section
            title="Researchers"
            count={data.researchers.length}
            action={
              <Link to="/researchers" className="text-[0.7rem] font-medium text-primary underline-offset-4 hover:underline">
                All researchers →
              </Link>
            }
          >
            <ul className="space-y-2">
              {data.researchers.slice(0, 12).map((r) => (
                <li key={r.id} className="panel panel-hover p-3.5">
                  <Link
                    to="/researchers/$slug"
                    params={{ slug: r.slug }}
                    className="text-sm font-medium text-foreground hover:text-primary"
                  >
                    {r.academic_title ? `${r.academic_title} ` : ""}
                    {r.full_name}
                  </Link>
                  <p className="mt-1 text-[0.7rem] text-muted-foreground">
                    {r.current_position ?? "Position not stated"} · {r.institutions?.name}
                  </p>
                </li>
              ))}
              {data.researchers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No researchers recorded yet.</p>
              ) : null}
            </ul>
          </Section>
        </div>

        <Section
          title="Events hosted here"
          count={data.events.length}
          action={
            <Link to="/events" className="text-[0.7rem] font-medium text-primary underline-offset-4 hover:underline">
              Full calendar →
            </Link>
          }
        >
          {data.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded in this country.</p>
          ) : (
            <ul className="grid gap-2 lg:grid-cols-2">
              {data.events.map((e) => (
                <li key={e.id} className="panel p-3.5">
                  <p className="text-sm font-medium text-foreground">{e.title}</p>
                  <p className="mono-num mt-1 flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
                    <CalendarDays className="h-3 w-3" />
                    {formatDate(e.start_date)} · {e.location ?? "Location not stated"}
                  </p>
                  {e.website ? (
                    <a
                      href={e.website}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1.5 inline-flex items-center gap-1 text-[0.7rem] text-primary hover:underline"
                    >
                      Official page <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </AppShell>
  );
}
