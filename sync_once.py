#!/usr/bin/env python3
"""
sync_once.py - run a single Harvest sync and exit.

Use this with a real OS-level scheduler so Harvest data updates even when
the Forecast Ledger app itself isn't open:

    macOS/Linux (crontab -e), daily at 6am:
        0 6 * * * cd /path/to/forecast_ledger && /usr/bin/python3 sync_once.py >> sync.log 2>&1

    Windows (Task Scheduler):
        Program: python.exe
        Arguments: sync_once.py
        Start in: C:\\path\\to\\forecast_ledger

Requires the same .env file (HARVEST_ACCOUNT_ID, HARVEST_ACCESS_TOKEN) as
the main app, and writes to the same forecast_ledger.db, so the app picks up
whatever this script fetched next time you open it.
"""
import sys
from dotenv import load_dotenv

load_dotenv()

import db
from scheduler import run_sync

if __name__ == '__main__':
    db.init_db()
    days_back = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    try:
        result = run_sync(days_back=days_back)
        print(f"Synced: fetched {result['entries_fetched']} entries, "
              f"{result['aggregated_keys']} person/project/month combinations updated.")
    except Exception as e:
        print(f'Sync failed: {e}', file=sys.stderr)
        sys.exit(1)
