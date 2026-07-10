"""
db.py - SQLite connection and small query helpers for Forecast Ledger.

Using plain sqlite3 (stdlib) rather than an ORM on purpose: this app's data
model is simple enough that an ORM would add dependency weight without much
benefit, and plain SQL keeps it easy for you to inspect/edit the database
directly (e.g. with the `sqlite3` CLI or DB Browser for SQLite) if you ever
want to.
"""
import sqlite3
import os

# DATA_DIR defaults to this file's folder (fine for local use). On Railway,
# set DATA_DIR to your mounted volume's path (e.g. /app/data) so the database
# survives restarts/redeploys - do NOT mount a volume at /app itself, since
# that's where your app code also lives and an empty volume there would hide it.
DATA_DIR = os.environ.get('DATA_DIR', os.path.dirname(__file__))
os.makedirs(DATA_DIR, exist_ok=True)

DB_PATH = os.path.join(DATA_DIR, 'forecast_ledger.db')
SCHEMA_PATH = os.path.join(os.path.dirname(__file__), 'schema.sql')


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def init_db():
    conn = get_connection()
    with open(SCHEMA_PATH, 'r') as f:
        conn.executescript(f.read())
    conn.commit()
    # Migration: existing databases (created before the `dollars` column existed)
    # need it added explicitly - SQLite has no "ADD COLUMN IF NOT EXISTS", so we
    # try and silently ignore the error if it's already there.
    try:
        conn.execute('ALTER TABLE actuals ADD COLUMN dollars REAL NOT NULL DEFAULT 0')
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists
    conn.close()


def query(sql, params=()):
    conn = get_connection()
    try:
        cur = conn.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]
        return rows
    finally:
        conn.close()


def execute(sql, params=()):
    conn = get_connection()
    try:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def executemany(sql, param_list):
    conn = get_connection()
    try:
        conn.executemany(sql, param_list)
        conn.commit()
    finally:
        conn.close()


def get_meta(key, default=None):
    rows = query('SELECT value FROM meta WHERE key = ?', (key,))
    return rows[0]['value'] if rows else default


def set_meta(key, value):
    execute(
        'INSERT INTO meta (key, value) VALUES (?, ?) '
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        (key, value)
    )
