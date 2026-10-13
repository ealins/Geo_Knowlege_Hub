import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ExternalLink } from "lucide-react";

import { AppShell, PageHeader, ProvenanceChips, TopicPills } from "@/components/layout/AppShell";
import { researchersQuery } from "@/lib/radar-queries";
import { Skeleton } from "@/components/ui/skeleton";
import { CardLink } from "@/components/CardLink";

export const Route = createFileRoute("/researchers/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(researchersQuery),
  head: () => ({
    meta: [
      { title: "Researchers — GeoAcademic Radar" },
      {
        name: "description",
        content:
          "Professors and researchers in photogrammetry, remote sensing and geoinformatics, with position, institution, research focus and official profile links.",
      },
      { property: "og:title", content: "Researchers — GeoAcademic Radar" },
      {
        property: "og:description",
        content:
          "People behind photogrammetry, remote sensing and geoinformatics research, sourced from official institutional profiles.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:image", content: "https://geoacademic.app/og-geoacademic-radar.jpg" },
      { name: "twitter:image", content: "https://geoacademic.app/og-geoacademic-radar.jpg" },
    ],
  }),
  component: ResearchersPage,
});

function ResearchersPage() {
  const data = Route.useLoaderData();
  const isLoading = false;
  const error = null;
  const [visible, setVisible] = useState(36);
  const rows = data ?? [];
  const visibleRows = rows.slice(0, visible);

  return (
    <AppShell>
      <PageHeader
        eyebrow="People"
        title="Researchers"
        description="Names, positions and stated research focus, taken from official institutional profile pages. Positions change — each entry links back to the page it came from."
      />
      <div className="mx-auto w-full max-w-7xl px-6 py-8">
        {error ? (
          <p className="text-sm text-destructive">Researchers could not be loaded.</p>
        ) : null}
        {isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full" />
            ))}
          </div>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleRows.map((r) => (
              <li key={r.id} className="panel panel-hover rise-in relative flex flex-col p-5">
                <CardLink
                  to="/researchers/$slug"
                  params={{ slug: r.slug }}
                  label={`${r.full_name}: open researcher profile`}
                />
                <p className="text-[0.65rem] uppercase tracking-[0.16em] text-primary">
                  {r.academic_title ?? "Title not stated"}
                </p>
                <Link
                  to="/researchers/$slug"
                  params={{ slug: r.slug }}
                  className="mt-1.5 text-base font-semibold text-foreground hover:text-primary"
                >
                  {r.full_name}
                </Link>

                <p className="mt-1 text-xs text-muted-foreground">
                  {r.current_position ?? "Position not stated"}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {r.institutions?.name ?? "Institution not stated"}
                  {r.institutions?.country ? ` · ${r.institutions.country}` : ""}
                </p>
                {r.research_summary ? (
                  <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-foreground/80">
                    {r.research_summary}
                  </p>
                ) : null}
                <div className="mt-3">
                  <TopicPills
                    topics={(r.researcher_topics ?? []).map((t) => t.research_topics?.name)}
                  />
                </div>
                <div className="mt-auto pt-4">
                  <ProvenanceChips verification={r.verification_status} isDemo={r.is_demo} />
                  {r.official_profile_url ? (
                    <a
                      href={r.official_profile_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="relative z-10 mt-3 inline-flex items-center gap-1 text-[0.7rem] font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Official profile <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {!isLoading && rows.length > visibleRows.length ? (
          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={() => setVisible((count) => count + 36)}
              className="rounded-md border border-border bg-muted/40 px-4 py-2 text-xs font-medium text-foreground hover:border-primary/40 hover:text-primary"
            >
              Show 36 more · {rows.length - visibleRows.length} remaining
            </button>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
