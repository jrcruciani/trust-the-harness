"""Evidencia de cada ejecución: eventos correlacionados, ordenados y saneados. Nunca guarda prompts completos ni credenciales."""

from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone

from . import state

RUN_ID = re.compile(r"^[a-z0-9][a-z0-9-]{5,63}$")
# Teléfonos con prefijo (+34, (+34), 0034) y separadores, o móviles/fijos españoles de 9 cifras sin prefijo.
_PHONE = re.compile(r"(?:(?:\(\+\d{2}\)|\+\d{2}|\b00\d{2})[\s.-]?\d(?:[\s.-]?\d){7,12}|\b[6789]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b)")
# IBAN completos o parciales (al menos dos grupos tras el código de país), con espacios o guiones.
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?:[\s-]?\d{4}){2,7}(?:[\s-]?\d{1,3})?\b")
_MAIL = re.compile(r"\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)\b")
_SECRET = re.compile(r"(?i)(bearer\s+[\w.-]+|api[_-]?key\S*|eyJ[\w-]{10,}\.[\w-]+\.[\w-]+)")
MAX_TEXT = 300


class DuplicateRun(ValueError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def valid_run_id(run_id: str | None) -> bool:
    return bool(run_id and RUN_ID.match(run_id))


def new_run_id(prefix: str = "run") -> str:
    return f"{prefix}-{secrets.token_hex(6)}"


def _mask_phone(m: re.Match) -> str:
    raw = m.group(0)
    d = re.sub(r"\D", "", raw)
    prefix = f"+{d[2:4]} " if raw.startswith("00") else (f"+{d[:2]} " if raw.lstrip("(").startswith("+") else "")
    return f"{prefix}*** *** {d[-3:]}"


def _mask_iban(m: re.Match) -> str:
    raw = re.sub(r"[\s-]", "", m.group(0))
    return f"{raw[:2]}** **** … {raw[-4:]}"


def _mask_mail(m: re.Match) -> str:
    # El dominio es evidencia (un dominio que imita al del proveedor); el buzón no hace falta.
    return f"{m.group(1)[:2]}***@{m.group(2)}"


def mask(text: str) -> str:
    """Enmascara credenciales, IBAN, teléfonos y buzones de correo sin recortar el texto."""
    v = _SECRET.sub("[credencial retirada]", text)
    v = _IBAN.sub(_mask_iban, v)
    v = _PHONE.sub(_mask_phone, v)
    return _MAIL.sub(_mask_mail, v)


def sanitize(value, depth: int = 0):
    if depth > 6:
        return "…"
    if isinstance(value, str):
        v = mask(value)
        return v if len(v) <= MAX_TEXT else v[:MAX_TEXT].rsplit(" ", 1)[0] + " …"
    if isinstance(value, dict):
        return {str(k): sanitize(v, depth + 1) for k, v in list(value.items())[:40]}
    if isinstance(value, (list, tuple)):
        return [sanitize(v, depth + 1) for v in list(value)[:40]]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return sanitize(str(value), depth + 1)


def start_run(run_id: str, agent_id: str, profile: str | None, scenario: str | None, mode: str,
              request: str | None, *, exclusive: bool = False) -> dict:
    trace_id, root = secrets.token_hex(16), secrets.token_hex(8)
    with state.tx() as c:
        existing = c.execute("SELECT trace_id, root_span FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if existing:
            if exclusive:
                raise DuplicateRun("run_id ya utilizado; usa una nueva ejecución.")
            return {"run_id": run_id, "trace_id": existing["trace_id"], "root_span": existing["root_span"]}
        c.execute("INSERT INTO runs (run_id, trace_id, root_span, started, agent_id, profile, scenario, mode, request, next_seq) "
                  "VALUES (?,?,?,?,?,?,?,?,?,1)",
                  (run_id, trace_id, root, now(), agent_id, profile, scenario, mode, sanitize(request or "")))
    return {"run_id": run_id, "trace_id": trace_id, "root_span": root}


def event(run_id: str, type_: str, outcome: str = "", data: dict | None = None, agent_id: str | None = None,
          profile: str | None = None, parent: str | None = None) -> dict:
    """Añade un evento a la ejecución con número de secuencia atómico. Devuelve el evento (con su span)."""
    span = secrets.token_hex(8)
    with state.tx() as c:
        run = c.execute("SELECT trace_id, root_span, next_seq FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if not run:
            c.execute("INSERT INTO runs (run_id, trace_id, root_span, started, agent_id, profile, mode, next_seq) VALUES (?,?,?,?,?,?,?,1)",
                      (run_id, secrets.token_hex(16), secrets.token_hex(8), now(), agent_id, profile, "control"))
            run = c.execute("SELECT trace_id, root_span, next_seq FROM runs WHERE run_id=?", (run_id,)).fetchone()
        seq = run["next_seq"]
        c.execute("UPDATE runs SET next_seq=? WHERE run_id=?", (seq + 1, run_id))
        ev = {"run_id": run_id, "seq": seq, "ts": now(), "trace_id": run["trace_id"], "span_id": span,
              "parent_id": parent or run["root_span"], "type": type_, "agent_id": agent_id, "profile": profile,
              "outcome": outcome, "data": sanitize(data or {})}
        cur = c.execute("INSERT INTO events (run_id, seq, ts, trace_id, span_id, parent_id, type, agent_id, profile, outcome, data) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (run_id, seq, ev["ts"], ev["trace_id"], span, ev["parent_id"], type_, agent_id, profile, outcome,
                         json.dumps(ev["data"], ensure_ascii=False)))
        ev["id"] = cur.lastrowid
    return ev


def end_run(run_id: str, outcome: str) -> None:
    with state.tx() as c:
        c.execute("UPDATE runs SET ended=?, outcome=? WHERE run_id=?", (now(), sanitize(outcome), run_id))


def _row(r) -> dict:
    d = dict(r)
    d["data"] = json.loads(d["data"])
    return d


def events(run_id: str | None = None, after: int = 0, limit: int = 200, *, tail: bool = False) -> list[dict]:
    """Con run_id, el cursor es la secuencia de esa ejecución; sin él, el id global (línea de tiempo del laboratorio)."""
    limit = max(1, min(int(limit), 500))
    if run_id:
        rows = state.query("SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?", (run_id, int(after), limit))
    elif tail and not after:
        rows = list(reversed(state.query("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))))
    else:
        rows = state.query("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?", (int(after), limit))
    return [_row(r) for r in rows]


def runs(limit: int = 30) -> list[dict]:
    rows = state.query("SELECT run_id, started, ended, agent_id, profile, scenario, mode, request, outcome FROM runs "
                       "ORDER BY started DESC LIMIT ?", (max(1, min(int(limit), 100)),))
    return [dict(r) for r in rows]


def export(run_id: str) -> dict | None:
    run = state.query("SELECT * FROM runs WHERE run_id=?", (run_id,))
    if not run:
        return None
    run = dict(run[0])
    run.pop("next_seq", None)
    evs = events(run_id, 0, 500)
    decisions = [dict(r) for r in state.query("SELECT * FROM decisions WHERE run_id=? ORDER BY ts", (run_id,))]
    first_block = next((e for e in evs if e["outcome"] in ("deny", "block", "blocked", "route", "flag")), None)
    return {
        "format": "trust-harness-lab/evidence@1",
        "generated": now(),
        "note": "Exportación saneada: sin prompts completos, credenciales, IBAN ni teléfonos completos. No incluye razonamiento interno del modelo.",
        "run": run,
        "summary": {
            "events": len(evs),
            "inferences": sum(1 for e in evs if e["type"] == "inference.end"),
            "tools_executed": sum(1 for e in evs if e["type"] == "tool.end" and e["outcome"] not in ("deny", "blocked")),
            "denied": sum(1 for d in decisions if d["decision"] == "deny"),
            "first_control_to_act": first_block and {"seq": first_block["seq"], "type": first_block["type"], "data": first_block["data"]},
        },
        "decisions": decisions,
        "events": evs,
    }


def clear() -> None:
    with state.tx() as c:
        c.execute("DELETE FROM events")
        c.execute("DELETE FROM runs")
        c.execute("DELETE FROM decisions")
