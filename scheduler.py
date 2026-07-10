"""
scheduler.py - runs the Harvest sync automatically on a schedule, while this
app is running.

Honest caveat: this is a background job inside a process that has to be
running for it to fire - it's not a system-level cron job. If your machine
sleeps or the app isn't running at the scheduled time, that day's automatic
sync won't happen (though "sync on startup if overdue" below covers the
common case of starting your laptop for the day).

For a sync that runs even when this app isn't open, use a real OS-level
scheduler (cron on macOS/Linux, Task Scheduler on Windows) to run
`python sync_once.py` on its own - see README.md.
"""
import datetime
import threading
from apscheduler.schedulers.background import BackgroundScheduler

import db
from harvest_client import fetch_time_entries, aggregate_entries

_scheduler = None
_sync_lock = threading.Lock()


def run_sync(days_back=2):
    """
    Pull the last `days_back` days of time entries and merge them into the
    actuals table. A small overlap (default 2 days) covers entries that were
    added or edited in Harvest after the day they're dated for.
    """
    with _sync_lock:
        to_date = datetime.date.today()
        from_date = to_date - datetime.timedelta(days=days_back)
        entries = fetch_time_entries(from_date.isoformat(), to_date.isoformat())
        hours_agg, dollars_agg, missing_rate_hours = aggregate_entries(entries)

        conn = db.get_connection()
        try:
            for key, hours in hours_agg.items():
                person, project_id, month = key
                dollars = dollars_agg.get(key, 0)
                conn.execute(
                    '''INSERT INTO actuals (person, project_id, month, hours, dollars)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(person, project_id, month)
                       DO UPDATE SET hours = excluded.hours, dollars = excluded.dollars''',
                    (person, project_id, month, hours, dollars)
                )
            conn.commit()
        finally:
            conn.close()

        if missing_rate_hours > 0:
            print(f'[scheduler] WARNING - {missing_rate_hours:.1f} billable hours had no billable_rate from Harvest (likely a token permissions issue) - actual $ for those hours defaulted to $0.')

        db.set_meta('last_harvest_sync', datetime.datetime.now().isoformat())
        db.set_meta('last_harvest_sync_entries', str(len(entries)))
        return {'entries_fetched': len(entries), 'aggregated_keys': len(hours_agg)}


def start_scheduler(interval_hours=24):
    global _scheduler
    if _scheduler is not None:
        return _scheduler
    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.add_job(
        lambda: _safe_run_sync(),
        'interval', hours=interval_hours,
        id='harvest_daily_sync', next_run_time=datetime.datetime.now() + datetime.timedelta(seconds=15)
    )
    _scheduler.start()
    return _scheduler


def _safe_run_sync():
    try:
        run_sync()
    except Exception as e:
        print(f'[scheduler] Harvest sync failed: {e}')
