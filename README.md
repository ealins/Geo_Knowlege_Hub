# Geo Radar

A small radar for fresh academic jobs, courses and events in photogrammetry, remote sensing and geoinformatics.

It does not keep a research database. It fetches a list of sources every 6 hours, keeps only items that match the domain keywords, and drops anything not seen for 45 days.

## How it works

1. `config/sources.json` lists sources (RSS/Atom feeds or listing pages). Set `enabled: true` once a URL is confirmed.
2. `scripts/radar.mjs` fetches enabled sources, checks robots.txt, parses items, keeps those matching `config/domain.json`, and merges them into `data/feed.json`.
3. `scripts/build.mjs` copies the page and data into `dist/`.
4. `.github/workflows/radar.yml` runs steps 2 and 3 on a schedule, commits the feed, and deploys `dist/` to GitHub Pages, plus Cloudflare Pages when configured.

No database, no LLM, no dependencies. Node 20+.

## Run locally

```bash
node scripts/radar.mjs
node scripts/build.mjs
```

## Setup checklist

- **GitHub Pages:** Settings → Pages → Source: *GitHub Actions*.
- **Default branch:** `main` is the default. Scheduled runs only fire from the default branch.
- **Cloudflare Pages (optional):** add repository secret `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and variable `CF_PAGES_PROJECT`. The workflow deploys there only when all three are set.
- **Sources:** add entries to `config/sources.json`. Prefer RSS/Atom. For HTML pages, keep `include` narrow.

## Freshness rules

- Items show `first_seen` and `last_seen`. The "New" badge means first seen in the last 7 days.
- Each kind has its own window in `config/domain.json` (`retain_days`): jobs 30 days, papers 21, events 60, courses 120, news 7. An item disappears once it has gone unseen for longer than its window.
- A source that fails 5 times in a row is paused. Set its `consecutive_failures` in `data/status.json` to `0` to retry.
- Sources that disallow the bot in robots.txt are skipped and shown as errors.
