"""
harvest_client.py - talks to the real Harvest API v2 directly.

This runs server-side (inside this Flask app on your machine), which is
exactly what the browser-artifact version could never do reliably: no CORS,
no sandbox restrictions, no "Script error." - just a normal HTTPS request
with your own credentials.

Credentials come from environment variables (see .env.example):
    HARVEST_ACCOUNT_ID
    HARVEST_ACCESS_TOKEN

Get both from https://id.getharvest.com/developers (create a Personal Access Token).
"""
import os
import requests

API_BASE = 'https://api.harvestapp.com/v2'


def _headers():
    account_id = os.environ.get('HARVEST_ACCOUNT_ID', '')
    token = os.environ.get('HARVEST_ACCESS_TOKEN', '')
    if not account_id or not token:
        raise RuntimeError(
            'HARVEST_ACCOUNT_ID and/or HARVEST_ACCESS_TOKEN are not set. '
            'Copy .env.example to .env and fill them in, then restart the app.'
        )
    return {
        'Harvest-Account-Id': account_id,
        'Authorization': f'Bearer {token}',
        'User-Agent': 'Forecast Ledger (internal PM tool)',
    }


def fetch_time_entries(from_date, to_date):
    """
    Fetch ALL time entries between from_date and to_date (inclusive, 'YYYY-MM-DD'),
    following pagination automatically. Returns a list of raw Harvest time_entry dicts.
    """
    entries = []
    url = f'{API_BASE}/time_entries'
    params = {'from': from_date, 'to': to_date, 'per_page': 100}
    headers = _headers()

    while url:
        resp = requests.get(url, headers=headers, params=params, timeout=90)
        resp.raise_for_status()
        data = resp.json()
        entries.extend(data.get('time_entries', []))
        next_link = (data.get('links') or {}).get('next')
        url = next_link
        params = None  # the 'next' link already includes all query params
    return entries


def is_billable_entry(entry):
    """Harvest marks each time entry billable or not independently of the project
    it's logged under - a billable project can still have non-billable entries
    (write-offs, internal work logged under a client code, etc). Defaults to
    True only if the field is genuinely missing, to avoid silently dropping data
    from an unexpected API response shape."""
    return bool(entry.get('billable', True))


def aggregate_entries(entries):
    """
    Collapse raw time entries into {(person, project_id, month): hours} totals -
    the same aggregation the app stores, so a multi-year pull never becomes a
    multi-hundred-thousand-row problem in memory or in the database.

    Only billable entries are included (see is_billable_entry above). This matters
    because every dollar figure in this app - Forecast vs Actual Amount, Project
    Forecast vs Actual ($), the "Actual (Harvest-synced)" KPI - is computed as
    hours x rate. Including non-billable hours in that math overstates actual
    revenue and produces misleading variance numbers.
    """
    agg = {}
    for e in entries:
        if not is_billable_entry(e):
            continue
        spent_date = e.get('spent_date', '')
        if not spent_date or len(spent_date) < 7:
            continue
        month = spent_date[:7]  # 'YYYY-MM-DD' -> 'YYYY-MM'
        person = (e.get('user') or {}).get('name', '')
        project = e.get('project') or {}
        project_id = project.get('code') or project.get('name', '')
        hours = e.get('hours', 0) or 0
        key = (person, project_id, month)
        agg[key] = agg.get(key, 0) + float(hours)
    return agg
