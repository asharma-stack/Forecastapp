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
from harvest_client import fetch_time_entries, aggregate_entries, month_windows

_scheduler = None
_sync_lock = threading.Lock()


def run_sync(days_back=2):
    """Refresh actuals for the current and previous calendar month, in full.

    We deliberately re-fetch WHOLE months rather than a small rolling window.
    Actuals are stored as one total per (person, project, month) and each write
    replaces that total, so a partial-window write clobbers the month's real total
    with just the days inside the window - which is exactly the bug that made older
    months read far too low. Re-fetching the current + previous month in full every
    run is cheap, keeps each stored month an exact mirror of Harvest, and is
    self-healing: it picks up time entries and billable-rate changes made in Harvest
    days after the fact (the old 2-day window missed anything logged late). The
    `days_back` argument is kept for call-site compatibility; it only nudges how far
    back we guarantee coverage near a month boundary, and the previous month is
    always included regardless.
    """
    with _sync_lock:
        today = datetime.date.today()
        first_of_this_month = today.replace(day=1)
        # Start from the first day of the previous month, plus a little slack if a
        # larger days_back was requested (so a big overlap still lands on a month start).
        from_date = min(
            first_of_this_month - datetime.timedelta(days=1),
            today - datetime.timedelta(days=days_back),
        ).replace(day=1)
        to_date = today

        total_entries = 0
        total_missing_rate_hours = 0.0
        agg_keys = set()

        conn = db.get_connection()
        try:
            for month_str, m_from, m_to in month_windows(from_date, to_date):
                entries = fetch_time_entries(m_from, m_to)
                hours_agg, dollars_agg, missing_rate_hours = aggregate_entries(entries)
                # Rebuild the month exactly: clear it, then insert full-month totals.
                conn.execute('DELETE FROM actuals WHERE month = ?', (month_str,))
                for key, hours in hours_agg.items():
                    person, project_id, month = key
                    if month != month_str:
                        continue  # defensive: a full-month fetch only yields this month
                    conn.execute(
                        'INSERT INTO actuals (person, project_id, month, hours, dollars) VALUES (?, ?, ?, ?, ?)',
                        (person, project_id, month, hours, dollars_agg.get(key, 0))
                    )
                total_entries += len(entries)
                total_missing_rate_hours += missing_rate_hours
                agg_keys.update(hours_agg.keys())
            conn.commit()
        finally:
            conn.close()

        if total_missing_rate_hours > 0:
            print(f'[scheduler] WARNING - {total_missing_rate_hours:.1f} billable hours had no billable_rate from Harvest (likely a token permissions issue) - actual $ for those hours defaulted to $0.')

        db.set_meta('last_harvest_sync', datetime.datetime.now().isoformat())
        db.set_meta('last_harvest_sync_entries', str(total_entries))
        return {'entries_fetched': total_entries, 'aggregated_keys': len(agg_keys)}


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
