# The Bengal Reader

A civic journalism and political accountability website for the 2026 West Bengal Assembly Election. Non-partisan, data-driven, and updated automatically every 6 hours.

**Live site:** https://voting-awareness-psi.vercel.app

---

## What this is

The Bengal Reader tracks political corruption cases, monitors elected officials' asset declarations, follows BJP's post-election promises, and provides contextual data on all 294 assembly constituencies. It is not affiliated with any party or government body.

---

## Pages

| Route | File | Description |
|---|---|---|
| `/` | `bengal-voter-guide.html` | Main editorial — "Three parties, one machine" |
| `/parties` | `political-parties-comparison.html` | Radar chart comparing BJP, TMC, CPIM, INC, ISF |
| `/constituencies` | `constituencies.html` | All 294 assembly seat results |
| `/accountability` | `accountability.html` | BJP's 24 pre-election pledges tracker |
| `/corruption` | `corruption-tracker.html` | 8 major corruption case dossiers |
| `/bonds` | `electoral-bonds.html` | Electoral bonds money trail |
| `/mlas` | `mla-criminal-records.html` | MLA criminal record database |
| `/assets` | `asset-growth.html` | MLA wealth declarations (2021→2026) |
| `/demonetisation` | `demonetisation.html` | Demonetisation economic impact data |
| `/methodology` | `methodology.html` | Sources and editorial principles |

---

## Architecture

This is a **pure static site** served by Vercel. There is no framework or build step for the pages themselves.

```
public/          ← all HTML pages + static assets (served directly by Vercel)
  *.html         ← 10 page files
  shared.css     ← common styles (nav, scroll bar, theme, reduced motion)
  shared.js      ← common JS (theme toggle, language toggle, scroll progress)
  analytics.js   ← cookieless Plausible analytics (loaded on every page)
  data/          ← JSON data files (auto-updated by GitHub Actions)
scripts/         ← Node.js automation scripts
.github/
  workflows/     ← 4 GitHub Actions workflows
vercel.json      ← URL rewrites (clean paths → .html files)
```

**URL routing** is handled entirely by `vercel.json` rewrites — no server-side logic.

---

## Data pipeline

Data is refreshed automatically without a backend:

1. **GitHub Actions** runs `scripts/update.mjs` every 6 hours
2. The script fetches Google News RSS, ED press releases, and CBI press releases
3. Updated JSON is committed to `public/data/`
4. Vercel detects the commit and redeploys within ~30 seconds

Constituency results are scraped from ECI 3× daily via `scripts/scrape-results.mjs`.

---

## Local development

No build step is required. Open any HTML file directly in a browser, or serve the `public/` directory with any static file server:

```bash
# Install dev tools (linting only)
npm install

# Lint HTML and CSS
npm run lint

# Validate structure and data freshness
npm run validate

# Regenerate sitemap.xml
npm run generate-sitemap

# Regenerate rss.xml (requires public/data/news.json)
npm run generate-rss

# Run the data update script locally
npm run update-data
```

---

## Custom domain

The site domain defaults to `voting-awareness.vercel.app`. To switch to a custom domain, set the `SITE_DOMAIN` environment variable (without `https://`) in Vercel's project settings. This updates the sitemap and RSS feed automatically.

---

## Data files

| File | Updated | Description |
|---|---|---|
| `data/cases.json` | On significant developments | Corruption case timelines |
| `data/news.json` | Every 6 hours | Latest headlines per case |
| `data/meta.json` | Every 6 hours | Timestamps and election result summary |
| `data/pledges.json` | Every 6 hours | BJP pledge statuses and latest news |
| `data/mlas.json` | Manually | MLA criminal records |
| `data/assets.json` | Manually | MLA asset declarations |
| `data/parties.json` | Manually | Party policy dimension scores |

---

## Corrections

If you find a factual error, cite the correct primary source (ECI, affidavit, court order) and open an issue. Screenshots and social posts are not accepted as corrections.
