# GeoAcademic Radar operations

## Required server-side configuration

- `INGESTION_HOOK_SECRET`: a high-entropy random secret shared only by the web deployment and legacy ingestion worker.
- `ADMIN_BOOTSTRAP_EMAILS`: comma-separated email addresses allowed to claim the first admin role.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only database key.
- `NVIDIA_API_KEY`: server-only extraction-provider key when model enrichment is enabled.

Never prefix server secrets with `VITE_`.

The web deployment and local tools must target the Supabase project linked in `supabase/config.toml`. After changing the linked project, configure the matching service-role key and apply every migration under `supabase/migrations/`.

A quick production connectivity check is:

```bash
curl https://geoacademic.app/api/public/data-health
```

It must return HTTP 200 with `"ok":true` before starting ingestion.

## Public data read path

Public pages read the canonical Supabase tables by default, because ingestion writes those tables directly. The optional Open Engine projection can lag behind ingestion; enable `VITE_GEOACADEMIC_USE_OPEN_ENGINE=true` only after verifying that projection is current. Changing this browser-visible build variable requires a new web deployment.

## Production architecture

The intended production split is:

- **Cloudflare Workers**: TanStack Start web application and SSR at `https://geoacademic.app`.
- **Supabase PostgreSQL/Auth**: canonical records, provenance/evidence, user data, queues, read models and RPCs.
- **GitHub Actions/manual ingestion runner**: bounded ingestion and normalization when explicitly invoked.
- **OmniRoute**: primary AI review/enrichment provider.

Google Cloud Compute is **not part of the production architecture**. GeoAcademic no longer provisions or deploys Cloud Run services/jobs, Cloud Scheduler triggers, Cloud Build workloads, Artifact Registry images, or GCP runtime service accounts from this repository.

The legacy `geoacademic-dispatcher-5m` remains paused and must not be resumed automatically.

The repository may retain Python ingestion/runtime code under `open-engine/cloudrun/` because the code is reusable as a local/GitHub Actions execution target; the directory name does not imply a Google Cloud deployment.

## Ingestion workflow

The canonical refresh path is a bounded ingestion cycle that writes to Supabase and uses OmniRoute as the primary AI provider. The production workflow must not depend on a Google Cloud scheduler or Cloud Run job.

`.github/workflows/geoacademic-ingestion.yml` runs every 15 minutes. Each run
fetches a bounded batch of due sources, then drains normalization and vacancy
review work. Monitor its `FETCH leased`, `complete`, `retry`, and `stale` log
fields together with the queue counts returned by the hook endpoints. A
successful workflow run does not mean every source was checked; source
category intervals and adaptive backoff still determine which sources are due.

The former Google Cloud provisioning scripts have been removed from the repository. Do not recreate them as part of normal maintenance.

The manual GitHub Actions workflow `.github/workflows/geoacademic-cloudrun-ingestion.yml` is a runner workflow only; despite its historical filename, it does **not** provision or invoke Google Cloud. It should remain manual-only.

## Database migrations and backups

Before any production migration, pause writers and confirm a usable restore point in **Supabase Dashboard → Database → Backups**.

For an additional logical backup:

```bash
mkdir -p backups
bunx supabase@2.116.0 db dump --linked --role-only --file backups/roles.sql
bunx supabase@2.116.0 db dump --linked --file backups/schema.sql
bunx supabase@2.116.0 db dump --linked --data-only --use-copy --file backups/data.sql
```

Apply pending migrations from an authenticated operator environment:

```bash
bunx supabase@2.116.0 login
bunx supabase@2.116.0 link --project-ref rqalvagtdcqurubrsdnc
bunx supabase@2.116.0 migration list --linked
bunx supabase@2.116.0 db push --linked --dry-run
bunx supabase@2.116.0 db push --linked
```

Do not use `db reset --linked` in production.

## Local production preview

`bun run build` emits the Cloudflare Nitro bundle under `.output/`.

```bash
bun run preview
```

Do not replace this with `vite preview`; the TanStack/Nitro target is different.

## Supabase Auth redirects

Allow:

- `https://geoacademic.app/auth/callback`
- any active preview-domain equivalent that is intentionally used for authentication.

## Trust lifecycle

- Strict schema.org records and official vacancy pages with explicit facts can be verified immediately.
- Ambiguous model-extracted records remain automatically discovered on first fetch.
- A successful unchanged repeat fetch may promote source-backed records to verified.
- Opportunities not checked for 30 days become possibly outdated.
- Expired opportunities become closed.
- Known non-opportunity landing pages should be archived rather than repeatedly surfaced.
