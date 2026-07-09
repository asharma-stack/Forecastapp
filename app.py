"""
app.py - Forecast Ledger local server.

Run with:
    python app.py

Then open http://localhost:5000 in your browser. See README.md for setup.
"""
import os
import uuid
import threading
from flask import Flask, request, jsonify, send_from_directory
from dotenv import load_dotenv

load_dotenv()

import db
from scheduler import start_scheduler, run_sync
from harvest_client import fetch_time_entries, aggregate_entries

app = Flask(__name__, static_folder='static', template_folder='templates')


def new_id(prefix=''):
    return prefix + uuid.uuid4().hex[:10]


# ---------------------------------------------------------------- frontend
@app.route('/')
def index():
    return send_from_directory('templates', 'index.html')


# ---------------------------------------------------------------- bootstrap
NON_BILLABLE_PREFIXES = ('BFAG',)
NON_BILLABLE_SUFFIXES = ('BIZ',)

def is_billable(project_id):
    pid = project_id or ''
    if any(pid.startswith(p) for p in NON_BILLABLE_PREFIXES):
        return False
    if any(pid.endswith(s) for s in NON_BILLABLE_SUFFIXES):
        return False
    return True


@app.route('/api/bootstrap')
def bootstrap():
    """Everything the frontend needs on load, for a given year (forecast/actuals scoped to that year to keep payload small).
    Non-billable project codes (see NON_BILLABLE_PREFIXES/SUFFIXES above) are filtered out here, once, so every tab
    in the frontend automatically only sees billable projects - no per-tab filtering needed."""
    year = request.args.get('year', '2026')

    all_projects = db.query('SELECT * FROM projects ORDER BY id')
    projects = [p for p in all_projects if is_billable(p['id'])]
    billable_ids = {p['id'] for p in projects}

    all_team = db.query('SELECT * FROM team ORDER BY project_id, person')
    team = [t for t in all_team if t['project_id'] in billable_ids]
    team_ids = {t['id'] for t in team}

    all_milestones = db.query('SELECT * FROM milestones ORDER BY project_id, month')
    milestones = [m for m in all_milestones if m['project_id'] in billable_ids]

    working_days = db.query('SELECT * FROM working_days')

    all_forecast_rows = db.query("SELECT * FROM forecast WHERE month LIKE ?", (f'{year}-%',))
    forecast_rows = [r for r in all_forecast_rows if r['team_id'] in team_ids]

    all_actuals_rows = db.query("SELECT * FROM actuals WHERE month LIKE ?", (f'{year}-%',))
    actuals_rows = [r for r in all_actuals_rows if r['project_id'] in billable_ids]

    last_sync = db.get_meta('last_harvest_sync')
    last_sync_entries = db.get_meta('last_harvest_sync_entries')
    locked_months = [r['month'] for r in db.query('SELECT month FROM locked_months')]
    people_status = {r['person']: r['status'] for r in db.query('SELECT * FROM people')}

    forecast = {f"{r['team_id']}|{r['month']}": r['days'] for r in forecast_rows}
    actuals = {f"{r['person']}|{r['project_id']}|{r['month']}": r['hours'] for r in actuals_rows}
    working_days_map = {r['month']: r['days'] for r in working_days}

    return jsonify({
        'projects': projects, 'team': team, 'milestones': milestones,
        'workingDays': working_days_map, 'forecast': forecast, 'actuals': actuals,
        'lastHarvestSync': last_sync, 'lastHarvestSyncEntries': last_sync_entries,
        'lockedMonths': locked_months, 'peopleStatus': people_status,
    })


# ---------------------------------------------------------------- projects
@app.route('/api/projects', methods=['POST'])
def add_project():
    p = request.json
    db.execute(
        'INSERT INTO projects (id, name, client, type, status, budget, actual_to_date) VALUES (?,?,?,?,?,?,?)',
        (p['id'], p.get('name', p['id']), p.get('client', ''), p.get('type', 'time'),
         p.get('status', 'Contracted'), float(p.get('budget', 0)), float(p.get('actualToDate', 0)))
    )
    return jsonify({'ok': True})


@app.route('/api/projects/<project_id>', methods=['DELETE'])
def delete_project(project_id):
    db.execute('DELETE FROM projects WHERE id = ?', (project_id,))  # cascades to team, milestones, forecast
    return jsonify({'ok': True})


# ---------------------------------------------------------------- team
@app.route('/api/team', methods=['POST'])
def add_team_member():
    t = request.json
    tid = new_id('T')
    db.execute(
        'INSERT INTO team (id, project_id, person, role, rate) VALUES (?,?,?,?,?)',
        (tid, t['projectId'], t['person'], t.get('role', 'Consultant'), float(t.get('rate', 0)))
    )
    return jsonify({'ok': True, 'id': tid})


@app.route('/api/team/<team_id>', methods=['PUT'])
def update_team_member(team_id):
    t = request.json
    db.execute('UPDATE team SET person=?, role=?, rate=? WHERE id=?',
               (t['person'], t['role'], float(t['rate']), team_id))
    return jsonify({'ok': True})


@app.route('/api/team/<team_id>', methods=['DELETE'])
def delete_team_member(team_id):
    db.execute('DELETE FROM team WHERE id = ?', (team_id,))  # cascades to forecast
    return jsonify({'ok': True})


# ---------------------------------------------------------------- forecast
@app.route('/api/forecast', methods=['POST'])
def set_forecast_cell():
    f = request.json
    locked = db.query('SELECT 1 FROM locked_months WHERE month = ?', (f['month'],))
    if locked:
        return jsonify({'ok': False, 'error': f"{f['month']} is locked - no further changes are allowed for this month."}), 403
    if float(f.get('days', 0)) == 0:
        db.execute('DELETE FROM forecast WHERE team_id=? AND month=?', (f['teamId'], f['month']))
    else:
        db.execute(
            '''INSERT INTO forecast (team_id, month, days) VALUES (?,?,?)
               ON CONFLICT(team_id, month) DO UPDATE SET days = excluded.days''',
            (f['teamId'], f['month'], float(f['days']))
        )
    return jsonify({'ok': True})


@app.route('/api/months/lock', methods=['POST'])
def lock_month():
    """Locking is permanent by design - there is no unlock endpoint, matching the
    requirement that once locked, a month stays locked even in the future."""
    month = (request.json or {}).get('month')
    if not month:
        return jsonify({'ok': False, 'error': 'month required (YYYY-MM)'}), 400
    db.execute(
        'INSERT INTO locked_months (month, locked_at) VALUES (?, ?) ON CONFLICT(month) DO NOTHING',
        (month, __import__('datetime').datetime.now().isoformat())
    )
    return jsonify({'ok': True})


@app.route('/api/people/status', methods=['POST'])
def set_person_status():
    """Sets a person's employment status (Employee/Contractor/Ex-employee), used
    purely for color-coding in the UI. Persists independent of team assignments."""
    body = request.json or {}
    person = body.get('person')
    status = body.get('status', 'Employee')
    if not person:
        return jsonify({'ok': False, 'error': 'person required'}), 400
    db.execute(
        'INSERT INTO people (person, status) VALUES (?,?) ON CONFLICT(person) DO UPDATE SET status = excluded.status',
        (person, status)
    )
    return jsonify({'ok': True})


# ---------------------------------------------------------------- milestones
@app.route('/api/milestones', methods=['POST'])
def add_milestone():
    m = request.json
    mid = new_id('M')
    db.execute(
        'INSERT INTO milestones (id, project_id, name, amount, month, status) VALUES (?,?,?,?,?,?)',
        (mid, m['projectId'], m['name'], float(m.get('amount', 0)), m['month'], m.get('status', 'Pending'))
    )
    return jsonify({'ok': True, 'id': mid})


@app.route('/api/milestones/<milestone_id>', methods=['DELETE'])
def delete_milestone(milestone_id):
    db.execute('DELETE FROM milestones WHERE id = ?', (milestone_id,))
    return jsonify({'ok': True})


# ---------------------------------------------------------------- working days
@app.route('/api/working-days', methods=['POST'])
def set_working_days():
    w = request.json
    db.execute(
        '''INSERT INTO working_days (month, days) VALUES (?,?)
           ON CONFLICT(month) DO UPDATE SET days = excluded.days''',
        (w['month'], int(w['days']))
    )
    return jsonify({'ok': True})


def _date_chunks(from_date, to_date, chunk_days=30):
    import datetime
    start = datetime.date.fromisoformat(from_date)
    end = datetime.date.fromisoformat(to_date)
    cur = start
    while cur <= end:
        chunk_end = min(cur + datetime.timedelta(days=chunk_days - 1), end)
        yield cur.isoformat(), chunk_end.isoformat()
        cur = chunk_end + datetime.timedelta(days=1)


def _run_harvest_sync_job(from_date, to_date):
    """Does the actual work, off the request thread - see harvest_sync() below for why.
    Logs each step with print() (flushed immediately) so Railway's log stream shows
    real progress - this replaced a silent version we couldn't debug blind."""
    import datetime, sys
    print(f'[harvest sync] job started: {from_date} to {to_date}', flush=True)
    total_entries = 0
    all_agg_keys = set()
    chunk_errors = []

    chunks = list(_date_chunks(from_date, to_date, chunk_days=30))
    print(f'[harvest sync] split into {len(chunks)} chunk(s): {chunks}', flush=True)

    for i, (chunk_from, chunk_to) in enumerate(chunks):
        print(f'[harvest sync] chunk {i+1}/{len(chunks)}: fetching {chunk_from} to {chunk_to}...', flush=True)
        try:
            entries = fetch_time_entries(chunk_from, chunk_to)
            print(f'[harvest sync] chunk {i+1}/{len(chunks)}: got {len(entries)} raw entries', flush=True)
            agg = aggregate_entries(entries)
            conn = db.get_connection()
            try:
                for (person, project_id, month), hours in agg.items():
                    conn.execute(
                        '''INSERT INTO actuals (person, project_id, month, hours) VALUES (?,?,?,?)
                           ON CONFLICT(person, project_id, month) DO UPDATE SET hours = excluded.hours''',
                        (person, project_id, month, hours)
                    )
                conn.commit()
            finally:
                conn.close()
            total_entries += len(entries)
            all_agg_keys.update(agg.keys())
            print(f'[harvest sync] chunk {i+1}/{len(chunks)}: saved {len(agg)} person/project/month rows', flush=True)
        except Exception as e:
            print(f'[harvest sync] chunk {i+1}/{len(chunks)}: FAILED - {type(e).__name__}: {e}', flush=True)
            chunk_errors.append(f'{chunk_from} to {chunk_to}: {e}')

    db.set_meta('last_harvest_sync', datetime.datetime.now().isoformat())
    db.set_meta('last_harvest_sync_entries', str(total_entries))
    db.set_meta('harvest_sync_in_progress', 'false')
    db.set_meta('last_harvest_sync_errors', '; '.join(chunk_errors) if chunk_errors else '')
    print(f'[harvest sync] job finished: {total_entries} total entries, {len(all_agg_keys)} aggregated rows, {len(chunk_errors)} chunk error(s)', flush=True)


# ---------------------------------------------------------------- actuals / harvest
@app.route('/api/harvest/sync', methods=['POST'])
def harvest_sync():
    """Manual on-demand sync for an arbitrary date range, triggered from the UI.

    This runs in a background thread and returns immediately, rather than making
    the HTTP request wait for the whole sync to finish. This matters because we
    confirmed (via Railway's logs) that something in the hosting platform's own
    network path kills long-lived HTTP requests well under a minute, independent
    of any timeout we configure in gunicorn - raising server-side timeouts alone
    can't fix that. The already-working automatic background sync uses this same
    "don't tie the work to an HTTP request" approach, which is why it never hit
    this problem in the first place."""
    body = request.json or {}
    from_date = body.get('from')
    to_date = body.get('to')
    if not from_date or not to_date:
        return jsonify({'ok': False, 'error': 'from and to dates are required'}), 400

    if db.get_meta('harvest_sync_in_progress') == 'true':
        return jsonify({'ok': False, 'error': 'A sync is already running - wait for it to finish before starting another.'}), 409

    db.set_meta('harvest_sync_in_progress', 'true')
    thread = threading.Thread(target=_run_harvest_sync_job, args=(from_date, to_date), daemon=True)
    thread.start()
    return jsonify({
        'ok': True, 'started': True,
        'message': 'Sync started in the background. Large ranges can take a few minutes - refresh this page to see progress and results.'
    })


@app.route('/api/actuals/clear', methods=['POST'])
def clear_actuals():
    db.execute('DELETE FROM actuals')
    return jsonify({'ok': True})


@app.route('/api/actuals/trim', methods=['POST'])
def trim_actuals():
    cutoff_month = (request.json or {}).get('cutoffMonth')
    if not cutoff_month:
        return jsonify({'ok': False, 'error': 'cutoffMonth required (YYYY-MM)'}), 400
    db.execute('DELETE FROM actuals WHERE month < ?', (cutoff_month,))
    return jsonify({'ok': True})


# Runs at import time (not just under `if __name__=='__main__'`) so this also
# works correctly under a production server like gunicorn, which imports this
# module directly without ever executing the __main__ block below.
db.init_db()
start_scheduler(interval_hours=24)

if __name__ == '__main__':
    app.run(debug=False, port=5000)
