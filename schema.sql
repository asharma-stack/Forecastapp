-- Forecast Ledger - SQLite schema
-- Run automatically by db.py on first start; safe to re-run (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    client TEXT,
    type TEXT NOT NULL DEFAULT 'time',        -- 'time' or 'milestone'
    status TEXT NOT NULL DEFAULT 'Contracted',
    budget REAL NOT NULL DEFAULT 0,
    actual_to_date REAL NOT NULL DEFAULT 0    -- workbook-baseline actual, separate from synced Harvest actuals
);

CREATE TABLE IF NOT EXISTS team (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    person TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'Consultant',
    rate REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_team_project ON team(project_id);
CREATE INDEX IF NOT EXISTS idx_team_person ON team(person);

CREATE TABLE IF NOT EXISTS forecast (
    team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    month TEXT NOT NULL,          -- 'YYYY-MM'
    days REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (team_id, month)
);
CREATE INDEX IF NOT EXISTS idx_forecast_month ON forecast(month);

CREATE TABLE IF NOT EXISTS milestones (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    month TEXT NOT NULL,          -- 'YYYY-MM'
    status TEXT NOT NULL DEFAULT 'Pending'
);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);

CREATE TABLE IF NOT EXISTS working_days (
    month TEXT PRIMARY KEY,       -- 'YYYY-MM'
    days INTEGER NOT NULL
);

-- Aggregated actuals: one row per person + project + month, regardless of how many
-- raw Harvest time entries fed into it. This is what makes arbitrarily large Harvest
-- history (years of data) a non-issue - SQLite handles this natively with no blob-size
-- limits, unlike the old browser-storage approach.
CREATE TABLE IF NOT EXISTS actuals (
    person TEXT NOT NULL,
    project_id TEXT NOT NULL,
    month TEXT NOT NULL,          -- 'YYYY-MM'
    hours REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (person, project_id, month)
);
CREATE INDEX IF NOT EXISTS idx_actuals_person ON actuals(person);
CREATE INDEX IF NOT EXISTS idx_actuals_project ON actuals(project_id);
CREATE INDEX IF NOT EXISTS idx_actuals_month ON actuals(month);

-- Small key/value table for app metadata: last Harvest sync time, etc.
-- (Harvest credentials themselves live in .env, never in the database.)
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Once a month is locked here, forecast edits for that month are rejected server-side
-- (see app.py's set_forecast_cell) regardless of what the frontend allows - locking is
-- permanent by design (no unlock endpoint), matching "no further changes, even in the future".
CREATE TABLE IF NOT EXISTS locked_months (
    month TEXT PRIMARY KEY,   -- 'YYYY-MM'
    locked_at TEXT NOT NULL
);

-- Employment status per person, purely for color-coding in the UI (green dot =
-- Employee, blue = Contractor, grey = Ex-employee). Defaults to 'Employee' for
-- anyone not explicitly set. Not tied to project/team rows on purpose - status
-- persists even if someone's team assignment is later removed.
CREATE TABLE IF NOT EXISTS people (
    person TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'Employee'
);
