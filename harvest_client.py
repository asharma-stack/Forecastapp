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
    Collapse raw time entries into per (person, project_id, month) totals - the same
    aggregation the app stores, so a multi-year pull never becomes a multi-hundred-
    thousand-row problem in memory or in the database.

    Returns (hours_agg, dollars_agg, missing_rate_hours):
      - hours_agg: total billable hours per key - used for day/utilization comparisons.
      - dollars_agg: actual billed dollar amount per key, computed directly from each
        entry's own `billable_rate` x `hours` - exactly how Harvest's own reports compute
        it. This does NOT use this app's internal forecast rate table. That distinction
        matters: our forecast rates are planning inputs set when building the forecast
        model, and don't necessarily match what's actually configured as each person's
        real billable rate in Harvest today. Multiplying actual hours by our forecast
        rate produced dollar figures that didn't match Harvest's own numbers - sometimes
        higher, sometimes lower, with no consistent pattern, because the two rates are
        simply different things. Using Harvest's own billable_rate per entry makes
        "Actual $" in this app match Harvest's own reports exactly.
      - missing_rate_hours: total hours where Harvest didn't return a billable_rate for
        an otherwise-billable entry (commonly because the API token's user doesn't have
        "view rates" permission in Harvest - usually requires an Administrator-level
        token). Those hours are still counted in hours_agg but contribute $0 to
        dollars_agg, since there's no rate to compute a dollar amount from.

    Only billable entries are included at all (see is_billable_entry above) - a billable
    project can still have individual non-billable entries, and those should count
    toward neither hours nor dollars here.
    """
    hours_agg = {}
    dollars_agg = {}
    missing_rate_hours = 0.0

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
        hours = float(e.get('hours', 0) or 0)
        key = (person, project_id, month)

        hours_agg[key] = hours_agg.get(key, 0) + hours
        dollars_agg.setdefault(key, 0.0)

        rate = e.get('billable_rate')
        if rate is not None:
            dollars_agg[key] += hours * float(rate)
        else:
            missing_rate_hours += hours

    return hours_agg, dollars_agg, missing_rate_hours
