# Avis SEA Watch

Watches Avis.com for rental car availability at Seattle-Tacoma Airport (SEA)
for a specific date range, and pings you when it goes from sold out to
available.

Default dates baked in: **pickup Sep 4, 2026 4:00 PM → return Sep 12, 2026
4:00 PM**. Change these anytime in repo Settings → Actions → Variables (see
below) without touching code.

## Important: read this first

Avis.com has no public API for this, so the checker drives a real headless
browser through their actual booking search on a schedule. That means two
honest caveats:

1. **It may need one round of fixing.** The exact field labels/selectors on
   Avis's site could not be verified from the environment that wrote this
   script (no live access to avis.com there). The script uses several
   fallback strategies and always saves a screenshot + full HTML dump to
   `docs/debug/` and as a downloadable Action artifact, specifically so a
   failure is easy to diagnose and fix. If the first few runs come back
   `status: "unknown"`, check `docs/debug/latest.png` from the workflow run
   and send it back for a selector fix.
2. **Sites like this sometimes block automated browsers.** If every run
   comes back `error`, that's the likely cause. Nothing here tries to evade
   detection.

## One-time setup

1. **Create the repo.** From this folder:
   ```bash
   git init
   git add -A
   git commit -m "Avis SEA availability watcher"
   git branch -M main
   git remote add origin https://github.com/<your-username>/avis-sea-watch.git
   git push -u origin main
   ```
2. **Enable GitHub Pages.** Repo Settings → Pages → Source: "Deploy from a
   branch" → Branch: `main`, folder: `/docs`. Save. Your status page will be
   at `https://<your-username>.github.io/avis-sea-watch/`.
3. **Enable Actions** if prompted (Settings → Actions → General → Allow all
   actions).
4. **(Recommended) Set up a push notification.** This uses
   [ntfy.sh](https://ntfy.sh) — free, no account needed:
   - The workflow only notifies if a repo variable is set: Settings →
     Secrets and variables → Actions → Variables tab → `NTFY_TOPIC` → a
     random topic string only you know (anyone who knows the exact topic
     name can subscribe to it too, and — since Actions logs are public on a
     public repo — the topic value is technically visible there to anyone
     who goes looking, so don't reuse a topic you care about keeping
     secret).
   - Install the ntfy app (iOS/Android) or open https://ntfy.sh in a
     browser and subscribe to that same topic.
   - A GitHub issue is also opened automatically the moment status flips to
     `available` (no setup needed) — turn on "Watch → All Activity" on this
     repo (top right of the repo page) to get that as an email.
5. **Kick off a manual run** to confirm it works: Actions tab → "Check Avis
   SEA Availability" → Run workflow. Check the run's summary and
   `docs/debug/latest.png` artifact.

## Changing the trip (location/dates)

Repo Settings → Secrets and variables → Actions → Variables tab → add/edit:

| Variable | Example | Notes |
|---|---|---|
| `PICKUP_LOCATION` | `SEA` | Airport/location code typed into the search box |
| `PICKUP_LOCATION_LABEL` | `Seattle-Tacoma Airport` | Just used for display/notifications |
| `PICKUP_DATE` | `2026-09-04` | `YYYY-MM-DD` |
| `PICKUP_TIME` | `4:00 PM` | Must match one of Avis's dropdown options |
| `RETURN_DATE` | `2026-09-12` | `YYYY-MM-DD` |
| `RETURN_TIME` | `4:00 PM` | Must match one of Avis's dropdown options |
| `NTFY_TOPIC` | `avis-sea-watch-3a678452486a` | Push notification topic |

No code changes needed — the workflow reads these each run.

## How it decides "available" vs "sold out"

After submitting the search, it reads the results page text:

- If it finds an explicit sold-out/no-availability message and no prices →
  `sold_out`.
- If it finds dollar-amount price text (e.g. `$54/day`) → `available`, and
  counts how many price-like matches it saw as a rough vehicle count.
- Otherwise → `unknown` (ambiguous page state — check the debug screenshot).

You'll only get a push notification / GitHub issue the moment status
*changes into* `available` (not on every run), so it won't spam you every
20 minutes once a car shows up.

## Files

- `check.js` — the Playwright script that does the actual check.
- `.github/workflows/check.yml` — runs it every 20 minutes, notifies on
  change, commits the result, uploads debug artifacts.
- `docs/index.html` + `docs/status.json` — the GitHub Pages status page.
- `docs/debug/` — latest screenshot/HTML dump for troubleshooting selectors.

## Stopping it

Actions tab → "Check Avis SEA Availability" → "..." → Disable workflow. Or
just delete the repo.
