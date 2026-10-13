# GeoAcademic resilient production architecture

This is the target architecture for running GeoAcademic with GitHub, Oracle Cloud and provider-swappable AI without making any one of them the product's permanent backend contract.

## Responsibility split

- **`geoacademic.app`**: React/TanStack presentation and publishing. No database service-role key and no AI provider key belongs in browser code.
- **Oracle / `api.geoacademic.app`**: always-on FastAPI, PostgreSQL/PostGIS, source scheduler, fetch workers, processors, verifier and Pulse generation.
- **Oracle Object Storage**: changed-source evidence plus the degraded-mode public snapshot object.
- **GitHub**: source of truth, CI, controlled deployment to Oracle and an hourly recovery/maintenance path.
- **OpenRouter**: primary optional AI path for ambiguous pages only.
- **NVIDIA API**: independent optional fallback when an OpenRouter attempt fails. Model IDs are environment variables, never hard-coded into product logic.

## Request path

```text
users
  -> geoacademic.app (frontend)
  -> api.geoacademic.app (FastAPI on Oracle)
  -> PostgreSQL/PostGIS

sources/APIs
  -> Oracle scheduler
  -> FETCH queue
  -> fetch workers
  -> content hash / evidence in Object Storage
  -> deterministic JSON-LD extraction
  -> AI fallback only when deterministic extraction produces no candidate
  -> validation / confidence gate
  -> canonical entities + signals
  -> repeat source rechecks
  -> verification promotion
  -> latest feeds + Pulse
```

## Verification rule

Deterministic structured candidates enter as `auto_discovered` with source evidence. AI extraction is bounded and schema-checked. AI candidates are capped below perfect confidence; records below the AI publication threshold or without evidence become `needs_review`, so they are retained for review but excluded from `latest_public_entities` and `live_public_signals`.

Every successful source fetch updates provenance `last_checked_at`, including HTTP 304/unchanged rechecks. The verifier can promote sufficiently confident `auto_discovered` entities to `verified` only after the source has been successfully checked again after the configured minimum age. The default is six hours, but actual promotion also depends on the source's own refresh interval.

No AI provider failure should cause a bad record to be published. If OpenRouter is unavailable, the router can try the direct NVIDIA endpoint. If both fail, no AI candidate is accepted.

## Queue idempotency

Oracle's scheduler and GitHub's recovery workflow are allowed to run at the same time. `002_queue_dedup.sql` collapses duplicate active fetch tasks and creates a partial unique index on active `(FETCH, source_id)` work. This keeps scheduling idempotent even if both controllers enqueue the same due source concurrently.

## Public degraded mode

The `snapshotter` service writes `public/latest.json` to the configured S3-compatible Oracle Object Storage bucket every 15 minutes by default. It contains:

- the top 24-hour Pulse signals,
- the 24-hour Pulse summary,
- latest publications,
- latest programmes,
- latest projects,
- latest opportunities,
- latest events,
- latest researchers,
- latest institutions.

Set `VITE_GEOACADEMIC_SNAPSHOT_URL` in the frontend build environment to a browser-readable URL for this single snapshot object. `src/lib/open-engine-client.ts` still uses the live API first and falls back to this snapshot only on network/server failure; valid 4xx API errors are not hidden by stale data.

Keep the evidence bucket private. Prefer an Oracle Object Storage pre-authenticated request (or another narrowly scoped public object mechanism) for `public/latest.json`, with browser CORS permitting `https://geoacademic.app`. Do not make raw evidence public merely to expose the fallback snapshot.

## Oracle deployment

Use an Oracle Ubuntu ARM64 VM with Docker Engine and the Compose plugin. The Oracle-specific Postgres image builds from the multi-architecture PostgreSQL base image and installs PostGIS inside it.

On the server:

```bash
git clone https://github.com/ealins/research-pulse-global-f9b8742f.git
cd research-pulse-global-f9b8742f/open-engine
cp .env.oracle.example .env.oracle
nano .env.oracle
chmod +x deploy-oracle.sh
./deploy-oracle.sh
```

`docker-compose.oracle.yml` exposes only Caddy on ports 80/443. PostgreSQL, scheduler, verifier and workers remain on the internal Docker network. AI credentials are passed only to the processor container; the fetch worker never receives them.

## Required Oracle environment values

```text
API_DOMAIN=api.geoacademic.app
POSTGRES_PASSWORD=...
S3_ENDPOINT=...
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=geoacademic-evidence
INTERNAL_API_TOKEN=...
```

Optional AI values:

```text
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...
NVIDIA_API_KEY=...
NVIDIA_MODEL=...
```

The processor works without AI keys; it simply uses deterministic extraction only.

## GitHub secrets

### Maintenance

```text
OPEN_ENGINE_BASE_URL=https://api.geoacademic.app
OPEN_ENGINE_INTERNAL_TOKEN=<same value as Oracle INTERNAL_API_TOKEN>
```

`.github/workflows/geoacademic-ingestion.yml` checks the ingestion lease
endpoint, fetches due sources, and drains normalization and vacancy review
backlogs. It runs every 15 minutes and safely fails early when required
credentials are missing. The workflow's successful completion means the
bounded batch completed; it does not mean every source was refreshed.

### Deployment

```text
ORACLE_HOST=<server IPv4 or hostname>
ORACLE_USER=<SSH user>
ORACLE_SSH_PRIVATE_KEY=<deployment private key>
ORACLE_SSH_KNOWN_HOSTS=<pinned known_hosts line>
ORACLE_DEPLOY_PATH=<absolute repository path on the server>
```

`.github/workflows/geoacademic-open-engine-deploy.yml` deploys `main` only after these secrets exist. It uses a pinned `known_hosts` entry instead of disabling SSH host verification.

## Scaling path

Start with one Oracle VM and low worker concurrency. Scale in this order without changing the frontend API contract:

1. increase `WORKER_CONCURRENCY` only while CPU/RAM and target-domain politeness permit;
2. run additional fetch/processor containers or additional worker VMs;
3. move PostgreSQL to dedicated compute and add read replicas/partitioning when needed;
4. introduce Kafka only when the PostgreSQL queue becomes a demonstrated bottleneck;
5. introduce OpenSearch only when PostgreSQL full-text/trigram search becomes a demonstrated bottleneck;
6. replace external AI with vLLM/GPU workers only when inference volume/cost justifies it.

The frontend continues to call the same `/v1/...` endpoints through every stage.

## Rollout order

Do not turn everything on at once.

1. Create Oracle VM and Object Storage bucket.
2. Configure `.env.oracle` on Oracle. Never commit it.
3. Deploy and verify `/health`.
4. Point `api.geoacademic.app` to Oracle and verify HTTPS.
5. Seed a small official source set and verify fetch -> extraction -> canonical -> Pulse end to end.
6. Let at least one source complete a later recheck and verify automatic promotion behavior.
7. Add OpenRouter and/or NVIDIA backend secrets and verify ambiguous extraction.
8. Create a narrowly scoped browser-readable URL for `public/latest.json`; keep raw evidence private.
9. Add `VITE_GEOACADEMIC_API_URL=https://api.geoacademic.app` and `VITE_GEOACADEMIC_SNAPSHOT_URL=<snapshot URL>` to the frontend build environment.
10. Migrate one frontend section at a time to the open-engine client.
11. Configure GitHub maintenance and Oracle deployment secrets.
12. Increase source coverage and worker concurrency gradually while monitoring queue depth and error rates.

The existing Supabase ingestion path can remain available during this migration. The Oracle engine is intentionally additive until each public surface has been verified against live data.
