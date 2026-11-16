"""Estado persistente del laboratorio. Guarda mundos sintéticos, operaciones y checkpoints, no conversaciones ni credenciales."""

from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS lab (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL, kind TEXT NOT NULL,
  identity TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, scopes TEXT NOT NULL,
  budget_tokens INTEGER NOT NULL, reason TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, run_id TEXT, agent_id TEXT, action TEXT, resource TEXT, decision TEXT NOT NULL,
  code TEXT NOT NULL, reason TEXT, policy_version TEXT, agent_state TEXT, agent_version INTEGER, source TEXT);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, root_span TEXT NOT NULL, started TEXT NOT NULL, ended TEXT,
  agent_id TEXT, profile TEXT, scenario TEXT, mode TEXT, request TEXT, outcome TEXT, next_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL,
  trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_id TEXT, type TEXT NOT NULL, agent_id TEXT, profile TEXT,
  outcome TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE TABLE IF NOT EXISTS budget (agent_id TEXT NOT NULL, scope TEXT NOT NULL, reserved INTEGER NOT NULL, used INTEGER NOT NULL,
  PRIMARY KEY (agent_id, scope));
CREATE TABLE IF NOT EXISTS counters (agent_id TEXT NOT NULL, handler TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (agent_id, handler));
CREATE TABLE IF NOT EXISTS missions (
  sid TEXT NOT NULL, profile TEXT NOT NULL, world TEXT NOT NULL, journal TEXT NOT NULL,
  PRIMARY KEY (sid, profile));
CREATE TABLE IF NOT EXISTS mission_checkpoints (
  id TEXT PRIMARY KEY, sid TEXT NOT NULL, run_id TEXT NOT NULL, profile TEXT NOT NULL, source TEXT NOT NULL,
  label TEXT NOT NULL, world TEXT NOT NULL, journal TEXT NOT NULL, proposal TEXT NOT NULL, manifest TEXT NOT NULL);
"""

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_path: Path | None = None


def state_dir() -> Path:
    return Path(os.getenv("DEMO_STATE_DIR") or Path(__file__).resolve().parent.parent / ".state")


def configure(path: Path | None = None) -> None:
    """Cierra la conexión y apunta a otro directorio (las pruebas usan uno temporal)."""
    global _conn, _path
    with _lock:
        if _conn is not None:
            _conn.close()
        _conn = None
        _path = path


def db() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            folder = _path or state_dir()
            folder.mkdir(parents=True, exist_ok=True)
            _conn = sqlite3.connect(folder / "lab.sqlite3", check_same_thread=False, isolation_level=None)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.execute("PRAGMA busy_timeout=5000")
            _conn.executescript(SCHEMA)
        return _conn


@contextmanager
def tx():
    """Transacción serializada: un solo proceso, y el lock evita carreras entre los hilos de FastAPI."""
    with _lock:
        c = db()
        c.execute("BEGIN IMMEDIATE")
        try:
            yield c
        except BaseException:
            c.execute("ROLLBACK")
            raise
        c.execute("COMMIT")


def query(sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    with _lock:
        return db().execute(sql, args).fetchall()
