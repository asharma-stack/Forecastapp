"""
seed_data.py - one-time population of the database with the same 45 active
projects, 491 team assignments, and 2026 forecast data that was extracted
from your original Master_forecast.xlsx, so this app starts with real data
instead of an empty shell.

Run once:
    python seed_data.py

Safe to re-run - it clears and re-inserts (won't duplicate), but note this
means it will overwrite any manual edits to projects/team/forecast you've
already made through the app. It does NOT touch actuals (Harvest data).
"""
import json
import os
import db

DATA_FILE = os.path.join(os.path.dirname(__file__), 'seed_data.json')


def main():
    db.init_db()
    if not os.path.exists(DATA_FILE):
        print(f'{DATA_FILE} not found - nothing to seed. The app will start empty; '
              f'add projects through the UI instead.')
        return

    with open(DATA_FILE) as f:
        data = json.load(f)

    conn = db.get_connection()
    try:
        conn.execute('DELETE FROM forecast')
        conn.execute('DELETE FROM team')
        conn.execute('DELETE FROM projects')

        for p in data['projects']:
            conn.execute(
                'INSERT INTO projects (id, name, client, type, status, budget, actual_to_date) VALUES (?,?,?,?,?,?,?)',
                (p['id'], p['name'], p.get('client', ''), p.get('type', 'time'),
                 p.get('status', 'Contracted'), p.get('budget', 0), p.get('actualToDate', 0))
            )
        for t in data['team']:
            conn.execute(
                'INSERT INTO team (id, project_id, person, role, rate) VALUES (?,?,?,?,?)',
                (t['id'], t['projectId'], t['person'], t.get('role', 'Consultant'), t.get('rate', 0))
            )
        for key, days in data['forecast'].items():
            team_id, month = key.split('|')
            conn.execute('INSERT INTO forecast (team_id, month, days) VALUES (?,?,?)', (team_id, month, days))

        conn.commit()
        print(f"Seeded {len(data['projects'])} projects, {len(data['team'])} team rows, "
              f"{len(data['forecast'])} forecast entries.")
    finally:
        conn.close()


if __name__ == '__main__':
    main()
