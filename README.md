# Forecast Ledger - local app

A real local application (Flask + SQLite) that replaces the browser-artifact
version. Built specifically because the artifact version hit two hard walls:

1. **Browsers block cross-site fetches** from both sandboxed previews and
   locally-opened files - confirmed by testing - so it could never pull from
   Harvest or a Google Sheet automatically.
2. **Browser storage has a real size limit** that years of aggregated
   Harvest timesheet data will eventually exceed, however cleverly it's
   chunked.

Running as a real backend on your own machine removes both problems
entirely: it talks to Harvest's API directly (server-to-server, no CORS),
and stores data in a SQLite database on disk (no practical size limit).

## Setup

```bash
cd forecast_ledger
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` and fill in your Harvest credentials:

```
HARVEST_ACCOUNT_ID=...
HARVEST_ACCESS_TOKEN=...
```

Get both from https://id.getharvest.com/developers (create a Personal
Access Token there).

Load your real project/team/forecast data (extracted from your original
Master_forecast.xlsx - 45 active projects, 491 team assignments, 2026
forecast days):

```bash
python seed_data.py
```

Start the app:

```bash
python app.py
```

Open **http://localhost:5000** in your browser.

## What's inside

| File | Purpose |
|---|---|
| `app.py` | Flask server + REST API |
| `db.py` | SQLite connection helpers |
| `schema.sql` | Database schema (projects, team, forecast, milestones, actuals, working_days) |
| `harvest_client.py` | Direct Harvest API v2 client (server-side, no CORS) |
| `scheduler.py` | Background job that re-syncs Harvest every 24h while the app is running |
| `sync_once.py` | Standalone script for a real OS-level cron/Task Scheduler job |
| `seed_data.py` / `seed_data.json` | One-time load of your real extracted workbook data |
| `templates/index.html`, `static/app.js`, `static/style.css` | Frontend (same look and feature set as the artifact version) |

## Automatic Harvest sync - what "automatic" actually means here

While `app.py` is running, a background job (APScheduler) re-syncs the last
2 days of Harvest time entries every 24 hours, and once on startup. This is
real automation, but it only fires while the Python process is alive - if
you close the app or your machine sleeps through the scheduled time, that
sync won't happen.

For a sync that runs independent of whether the app is open, set up a real
OS-level scheduled task that runs `sync_once.py`:

**macOS/Linux** (`crontab -e`), daily at 6am:
```
0 6 * * * cd /path/to/forecast_ledger && /usr/bin/python3 sync_once.py >> sync.log 2>&1
```

**Windows** (Task Scheduler): create a task that runs
`python.exe sync_once.py` with "Start in" set to this folder.

Both the app and `sync_once.py` write to the same `forecast_ledger.db`, so
whichever one runs, the app picks up the latest data next time you open it.

## Deploying so your team can use it (not just you)

Right now this only runs on one machine with one database. To let others
use the same shared data, deploy it to a small hosting service - **Railway**
is a good fit specifically because it supports persistent storage for the
SQLite database on its lower tiers (some hosts wipe the filesystem on every
restart, which would silently delete your data).

1. Push this folder to a GitHub repo (Railway deploys from a repo).
2. On Railway: New Project -> Deploy from GitHub repo -> pick this repo.
3. Add a **volume** in Railway's dashboard, mounted at `/app` (or wherever
   this code lives on their system) - this is what makes `forecast_ledger.db`
   survive restarts and redeploys instead of being wiped.
4. Set environment variables in Railway's dashboard (not a `.env` file):
   `HARVEST_ACCOUNT_ID`, `HARVEST_ACCESS_TOKEN`.
5. Railway auto-detects the `Procfile` (`web: gunicorn app:app`) and runs
   the real production server - no code changes needed.
6. Once deployed, run `python seed_data.py` once via Railway's shell/console
   feature to load your real project data into the fresh database.

Your team then visits the URL Railway gives you - no login required,
anyone with the link has full access. Keep that URL private to people who
should be able to edit this data, since there's no access control at all.

Honest limitations of this simple approach, worth knowing:
- **No login/access control** - anyone with the URL can view and edit
  everything, including deleting projects. Fine for sharing within a small
  trusted team over a private link; not something to post publicly.
- **SQLite is fine for a small team's usage pattern** (a handful of people
  editing occasionally) but isn't built for many people writing
  simultaneously at high volume - not a concern at this app's current scale.
- The automatic 24-hour Harvest sync (via the background scheduler) keeps
  running once deployed, same as locally, as long as the service stays up.

## Backing up your data

Everything lives in one file: `forecast_ledger.db`. Copy it to back up.
Re-running `seed_data.py` will overwrite projects/team/forecast (not
actuals) with the original extracted data - only run it again if you
actually want to reset those to the original workbook's numbers.

## Features carried over from the artifact version

- Dashboard: revenue by project by month, budget burn
- Forecast: per-project team & rate grid, editable inline, revenue-by-month row, per-month locking
- Projects: add/remove, time-based or milestone-based
- Milestones: tranche-based revenue for grant/milestone projects
- Utilization (Forecast): forecasted % per person per month, expandable per-project breakdown
- % Utilization vs Forecast: forecast % vs actual % side by side, expandable
- Forecast vs Actual: forecast vs Harvest-synced actual days, side by side, expandable
- Forecast vs Actual - Amount: same, in dollars
- Actuals & Harvest Sync: direct sync button, run-rate tracker for the current month, data trim/clear tools
- Multi-year support via the Year selector
- Searchable "type or click" project and person dropdowns throughout
- Open access - no login required, anyone with the link can use it
