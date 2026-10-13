import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, ShieldCheck, History, Quote, Copy } from "lucide-react";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { evidenceQuery, citationFor } from "@/lib/detail-queries";
import { formatDate } from "@/lib/radar-queries";

function stamp(value: string | null): string {
  if (!value) return "Not recorded";
  return new Date(value).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function staleness(lastVerified: string | null): {
  label: string;
  tone: string;
} {
  if (!lastVerified) return { label: "Never verified", tone: "text-deadline" };
  const days = Math.floor((Date.now() - new Date(lastVerified).getTime()) / 86_400_000);
  if (days <= 7) return { label: `Fresh — checked ${days}d ago`, tone: "text-growth" };
  if (days <= 30) return { label: `Aging — checked ${days}d ago`, tone: "text-signal" };
  return { label: `Stale — ${days}d since check`, tone: "text-deadline" };
}

export function EvidenceDrawer({
  entityType,
  entityId,
  title,
  verification,
  confidence,
  lastVerified,
  isDemo,
  label = "Evidence",
}: {
  entityType: string;
  entityId: string;
  title: string;
  verification: string;
  confidence?: string | null;
  lastVerified?: string | null;
  isDemo?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({ ...evidenceQuery(entityType, entityId), enabled: open });
  const fresh = staleness(lastVerified ?? null);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-[0.68rem] uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary">
        <ShieldCheck className="h-3.5 w-3.5" />
        {label}
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-left text-base leading-snug">{title}</SheetTitle>
          <SheetDescription className="text-left">
            Where this record comes from, when it was last checked, and what changed.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-5 space-y-5 pb-10">
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div className="panel p-3">
              <dt className="text-muted-foreground">Verification</dt>
              <dd className="mt-1 text-foreground">
                {verification.replace(/_/g, " ")}
              </dd>
            </div>
            <div className="panel p-3">
              <dt className="text-muted-foreground">Confidence</dt>
              <dd className="mt-1 text-foreground">{confidence ?? "Not stated"}</dd>
            </div>
            <div className="panel p-3">
              <dt className="text-muted-foreground">Freshness</dt>
              <dd className={`mt-1 ${fresh.tone}`}>{fresh.label}</dd>
            </div>
            <div className="panel p-3">
              <dt className="text-muted-foreground">Record kind</dt>
              <dd className="mt-1 text-foreground">
                {entityType}
                {isDemo ? " · demo" : ""}
              </dd>
            </div>
          </dl>

          <section>
            <h3 className="flex items-center gap-2 text-[0.68rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              <ExternalLink className="h-3.5 w-3.5" /> Sources
            </h3>
            <div className="mt-3 space-y-2">
              {isLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : (data?.sources.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No source row is attached to this record yet. Treat it as unverified.
                </p>
              ) : (
                data!.sources.map((s) => (
                  <div key={s.id} className="panel p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs text-foreground">
                          {s.source_organization ?? s.source_type}
                          {s.is_primary ? " · primary" : ""}
                        </p>
                        <a
                          href={s.source_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="mt-1 block break-all text-[0.68rem] text-primary hover:underline"
                        >
                          {s.source_url}
                        </a>
                      </div>
                      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                        {s.confidence}
                      </span>
                    </div>
                    {s.claim ? (
                      <p className="mt-2 text-[0.7rem] leading-relaxed text-muted-foreground">
                        Claim: {s.claim}
                      </p>
                    ) : null}
                    <p className="mono-num mt-2 text-[0.62rem] text-muted-foreground">
                      discovered {stamp(s.discovered_at)} · checked {stamp(s.last_checked_at)} ·
                      verified {stamp(s.last_verified_at)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>

          <section>
            <h3 className="flex items-center gap-2 text-[0.68rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              <History className="h-3.5 w-3.5" /> Change history
            </h3>
            {isLoading ? (
              <Skeleton className="mt-3 h-12 w-full" />
            ) : (data?.history.length ?? 0) === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                No field-level changes recorded since this record was created.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data!.history.map((h) => (
                  <li key={h.id} className="panel p-3 text-[0.7rem]">
                    <p className="text-foreground">
                      <span className="text-muted-foreground">{h.field}</span>{" "}
                      {h.old_value ?? "—"} → {h.new_value ?? "—"}
                    </p>
                    <p className="mono-num mt-1 text-[0.62rem] text-muted-foreground">
                      {stamp(h.changed_at)}
                      {h.change_reason ? ` · ${h.change_reason}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="flex items-center gap-2 text-[0.68rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              <Quote className="h-3.5 w-3.5" /> Cite this record
            </h3>
            <p className="mono-num mt-3 rounded-md border border-border bg-muted/40 p-3 text-[0.68rem] leading-relaxed text-muted-foreground">
              {citationFor(entityType, title, typeof window === "undefined" ? "" : window.location.href)}
            </p>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(
                  citationFor(entityType, title, window.location.href),
                );
                toast.success("Citation copied");
              }}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[0.68rem] text-muted-foreground hover:border-primary/40 hover:text-primary"
            >
              <Copy className="h-3.5 w-3.5" /> Copy citation
            </button>
          </section>

          <p className="text-[0.65rem] leading-relaxed text-muted-foreground">
            Something wrong? Every field here is traceable to the source above. Deadlines and
            positions move — always confirm on the official page before acting.
            {" "}
            <span className="text-foreground/80">Retrieved {formatDate(new Date().toISOString().slice(0, 10))}.</span>
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
