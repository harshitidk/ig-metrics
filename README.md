# IG Metrics Automator

Local web app that takes multiple Instagram post/reel URLs, lets you tick exactly which
fields you want from a full catalog of everything the two Apify scrapers return, fetches
them, shows a preview, and gives you a one-click copy that pastes cleanly across Google
Sheets cells (tab-separated, so it spreads into columns instead of one cell).

## Stack

- **Node.js 18+** + **Express** — single backend file (`server.js`).
- **Vanilla HTML/CSS/JS** — single `public/index.html`, no framework, no bundler.
- **`apify-client`** (official npm) to run actors + read datasets.
- **`dotenv`** for secrets. Apify calls are **server-side only**; the token never reaches the browser.

## Setup

```bash
npm install
cp .env.example .env      # then open .env and add your Apify token
```

The two actor IDs and their input keys are already wired in `CONFIG` (verified against the
live Apify input schema on 2026-09-26):

- `PRIMARY_ACTOR_ID` = `data-slayer/instagram-post-details`, `PRIMARY_INPUT_KEY` = `postUrls`
  (the bulk array field; `postCode` is the legacy single field).
- `FALLBACK_ACTOR_ID` = `apify/instagram-reel-scraper`, `FALLBACK_INPUT_KEY` = `username`
  (the array field that accepts direct reel URLs).

> Heads-up: the primary actor returns the **raw Instagram web-info JSON** (358 keys like
> `metrics.like_count`, `user.username`, `caption.text`), not the clean names its README
> advertises. Every `primary` path in `FIELD_CATALOG` has been re-verified against a live
> run, so the app works out of the box — but if you see a blank column, the single catalog
> line for that field is where to look.

```bash
npm start
```

Open http://localhost:3000

## Deploy to Vercel

The app runs as a single serverless Vercel Function (Vercel auto-detects the Express app in
`server.js`) and serves `public/index.html` from the CDN. No build step required.

1. Push to GitHub and import the repo at https://vercel.com/new (or run `vercel` from the
   CLI after `npm i -g vercel`).
2. Add one environment variable in **Settings → Environment Variables**:
   - `APIFY_TOKEN` — your Apify token (`PORT` is not needed; Vercel manages it).
3. Deploy. Vercel picks up `server.js` and `vercel.json` automatically.

> The scrape waits on Apify (~15–30s), so `vercel.json` sets `maxDuration: 300`. The
> function's Hobby-plan limit is 300s — very large batches may time out, so keep runs to a
> reasonable number of URLs.

## Usage

1. Paste Instagram post/reel/tv URLs — one per line (commas/spaces also fine).
2. Pick the fields you want. Four core fields (Likes, Comments, Views, Posted time) start
   checked; everything else is unchecked. Groups have a "select all" toggle, and there's a
   filter input plus master Select all / Select none / Reset to defaults.
3. Click **Run**. Then **Copy for Sheets** and paste into Google Sheets — values spread
   across columns.

## Adding / renaming a field

Everything derives from one array — `FIELD_CATALOG` in `server.js`. Add a field = add one
entry (key, label, group, type, default, primary path, fallback path, optional `sub`). The
UI checklist, column order, and extraction all pick it up automatically.

Some `primary` keys come from Doc 1's prose rather than its sample and are marked
`// verify key` in the catalog. If a column keeps coming back blank, fix that single line.

## Notes

- Results are matched to inputs by **shortcode**, not array order (actors reorder and
  normalize `/reel/` ↔ `/p/`). The primary reports the shortcode as `code`; the fallback as
  `shortCode`.
- At most **two batched actor runs** per submission (never one-run-per-URL). The fallback
  reel scraper only runs when a selected field needs it, or to gap-fill hidden values.
- **Views vs plays:** Instagram reels report `plays`, not `views`. On reels `Views` is
  usually blank and `Plays` is populated — tick **Plays** for reels. `views` / `plays` /
  duration are blank on photo posts — expected.
- Reel-only fields (latest comments, first comment, transcript, display URL, carousel count)
  are marked `reel scraper` in the UI and will trigger a fallback run over all URLs.
- Duplicate URLs are deduped so you aren't billed twice for the same post.
