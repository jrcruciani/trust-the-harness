"""Servidor FastAPI de la demo «Trust the harness»."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from . import data, diagnosis, evidence, governance
from .agent import AGENT_ID, GOOD_LAYERS, LAYERS, LIMITS, MODEL, MODELS, PROMPT, SYSTEMS, GovernanceDenied, compare_checkpoint, new_session, run_turn

ROOT = Path(__file__).resolve().parent.parent
app = FastAPI(title="Trust the harness")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

SESSIONS: dict = {}
_session_locks: dict = {}
_locks_guard = threading.Lock()


def _start_background():
    try:
        governance.registry()
    except Exception:  # noqa: BLE001 - con Agent 365 sin configurar, la UI lo muestra y el control deniega
        pass


_start_background()


def _lock(key) -> threading.Lock:
    with _locks_guard:
        return _session_locks.setdefault(key, threading.Lock())


def _err(msg: str, status: int) -> JSONResponse:
    return JSONResponse({"error": msg}, status_code=status)


class Controls(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ledger: bool = True
    preconditions: bool = True
    completion: bool = True
    retry: bool = True


class Faults(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pending_reservation: bool = True
    lost_response: bool = True
    supplier_cancel: bool = True


class ChatIn(BaseModel):
    sid: str = Field(min_length=1, max_length=64)
    side: Literal["good", "excellent"]
    model: Literal["gpt-4.1-mini", "gpt-6.1-sol"] = MODEL
    message: str = Field(min_length=1, max_length=4000)
    layers: Controls | None = None
    faults: Faults = Field(default_factory=Faults)
    run_id: str | None = None


class ResetIn(BaseModel):
    sid: str = Field(min_length=1, max_length=64)


class CompareIn(ResetIn):
    checkpoint_id: str = Field(min_length=6, max_length=64)


class StateIn(BaseModel):
    state: Literal["active", "blocked"]
    reason: str = Field(min_length=3, max_length=200)
    expected_version: int


class BudgetIn(BaseModel):
    tokens: int = Field(ge=0, le=5_000_000)
    expected_version: int


class ModeIn(BaseModel):
    mode: Literal["governed", "baseline"]


class ProbeIn(BaseModel):
    operation: str


class LabResetIn(BaseModel):
    confirm: Literal["REINICIAR"]


class DiagnoseIn(BaseModel):
    sid: str
    side: Literal["good", "excellent"]
    model: Literal["gpt-4.1-mini", "gpt-6.1-sol"] = MODEL
    turn: int | None = None


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/meta")
def meta():
    return {"model": MODEL, "models": {k: {"label": v["label"], "params": v["params"], "price": v["price"]} for k, v in MODELS.items()},
            "brand": data.BRAND, "layers": LAYERS, "good_layers": GOOD_LAYERS,
            "agent_id": AGENT_ID, "policy_version": governance.POLICY_VERSION, "systems": SYSTEMS,
            "mission": data.MISSION, "mission_id": data.MISSION_ID, "pressure": data.PRESSURE,
            "sectors": data.SECTORS, "items": data.ITEMS, "slots": data.SLOTS, "faults": data.DEFAULT_FAULTS,
            "initial_assessment": data.assess(data.new_world()), "limits": LIMITS,
            "tool_hash": data.digest(data.TOOLS), "prompt_hash": data.digest(PROMPT), "tools": data.TOOLS}


@app.get("/api/health")
def health():
    """Sin llamar al modelo: estado del almacén y del registro."""
    try:
        reg = governance.registry()
        agents = len(reg.list())
        return {"ok": True, "registry": reg.source, "agents": agents, "mode": governance.mode()}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=503)


@app.post("/api/chat")
def chat(body: ChatIn):
    if body.run_id is not None and not evidence.valid_run_id(body.run_id):
        return _err("run_id no válido", 422)
    key = (body.sid, body.side, body.model)
    with _lock(body.sid):
        try:
            layers = body.layers.model_dump() if body.layers else None
            s = SESSIONS.get(key) or new_session(body.side, layers, body.faults.model_dump(), sid=body.sid, model=body.model)
            if s.world["faults"] != body.faults.model_dump():
                return _err("Reinicia la misión para cambiar los fallos.", 409)
            if body.side == "excellent" and layers is not None and s.layers != layers:
                return _err("Reinicia la misión para cambiar sus controles.", 409)
            SESSIONS[key] = s
            return run_turn(s, body.message, body.run_id)
        except (data.ConfigurationConflict, evidence.DuplicateRun) as e:
            return _err(str(e), 409)
        except Exception as e:  # noqa: BLE001
            return _err(f"{type(e).__name__}: {str(e)[:400]}", 500)


@app.post("/api/compare")
def compare(body: CompareIn):
    try:
        return compare_checkpoint(body.sid, body.checkpoint_id)
    except KeyError as e:
        return _err(str(e), 404)
    except ValueError as e:
        return _err(str(e), 409)
    except GovernanceDenied as e:
        return _err(f"La plataforma deniega la comparación: {e}", 403)


@app.post("/api/reset")
def reset(body: ResetIn):
    """Reinicia la conversación. No toca el estado de los agentes: un agente bloqueado sigue bloqueado."""
    with _lock(body.sid):
        for key in [k for k in SESSIONS if k[0] == body.sid]:
            SESSIONS.pop(key, None)
        data.reset_mission(body.sid)
    return {"ok": True}


# ---------------------------------------------------------------- gobernanza
@app.get("/api/governance")
def governance_view(sid: str | None = None):
    try:
        return governance.overview(sid)
    except Exception as e:  # noqa: BLE001
        return _err(f"Registro no disponible: {str(e)[:200]}", 503)


@app.post("/api/governance/agents/{agent_id}/state")
def agent_state(agent_id: str, body: StateIn):
    try:
        a = governance.change_state(agent_id, body.state, body.reason, body.expected_version)
    except KeyError:
        return _err("agente desconocido", 404)
    except governance.VersionConflict as e:
        return _err(f"Conflicto: otro operador cambió el agente ({e}). Recarga y vuelve a intentarlo.", 409)
    except governance.RegistryError as e:
        return _err(str(e), 503)
    return {"agent": asdict(a)}


@app.post("/api/governance/agents/{agent_id}/budget")
def agent_budget(agent_id: str, body: BudgetIn):
    try:
        a = governance.registry().set_budget(agent_id, body.tokens, body.expected_version)
    except KeyError:
        return _err("agente desconocido", 404)
    except governance.VersionConflict as e:
        return _err(f"Conflicto: otro operador cambió el agente ({e}). Recarga y vuelve a intentarlo.", 409)
    except (governance.RegistryError, ValueError) as e:
        return _err(str(e), 400)
    run_id = evidence.new_run_id("ctl")
    evidence.start_run(run_id, agent_id, None, "control de plataforma", governance.mode(), f"presupuesto {body.tokens}")
    evidence.event(run_id, "agent.budget_changed", "", {"budget_tokens": a.budget_tokens, "version": a.version}, agent_id=agent_id)
    evidence.end_run(run_id, "presupuesto")
    return {"agent": asdict(a)}


@app.post("/api/governance/mode")
def lab_mode(body: ModeIn):
    m = governance.set_mode(body.mode)
    run_id = evidence.new_run_id("ctl")
    evidence.start_run(run_id, "laboratorio", None, "control de plataforma", m, f"modo {m}")
    evidence.event(run_id, "lab.mode_changed", m, {"mode": m})
    evidence.end_run(run_id, m)
    return {"mode": m}


@app.post("/api/governance/probe")
def probe(body: ProbeIn):
    try:
        return governance.run_probe(body.operation)
    except KeyError:
        return _err("operación desconocida", 404)


@app.post("/api/governance/lab/reset")
def lab_reset(body: LabResetIn):
    governance.lab_reset()
    SESSIONS.clear()
    return {"ok": True}


# ---------------------------------------------------------------- evidencia
@app.get("/api/events")
def events(run_id: str | None = None, after: int = 0, limit: int = 200, tail: bool = False):
    if run_id is not None and not evidence.valid_run_id(run_id):
        return _err("run_id no válido", 422)
    return {"events": evidence.events(run_id, after, limit, tail=tail)}


_END_TYPES = {"turn.end", "diagnosis.end", "probe.end", "comparison.end"}


@app.get("/api/events/stream")
def events_stream(run_id: str, request: Request, after: int = 0):
    """Eventos de una ejecución en directo (SSE). El cliente abre el canal antes de enviar el mensaje con ese run_id."""
    if not evidence.valid_run_id(run_id):
        return _err("run_id no válido", 422)
    last = request.headers.get("last-event-id")
    cursor = int(last) if last and last.isdigit() else max(0, after)

    def gen():
        nonlocal cursor
        t0 = idle = time.time()
        yield "retry: 1000\n\n"
        while time.time() - t0 < 900:
            evs = evidence.events(run_id, cursor, 200)
            for e in evs:
                cursor = e["seq"]
                yield f"id: {e['seq']}\nevent: ev\ndata: {json.dumps(e, ensure_ascii=False)}\n\n"
            if evs:
                idle = time.time()
                if evs[-1]["type"] in _END_TYPES:
                    yield "event: done\ndata: {}\n\n"
                    return
            elif time.time() - idle > 10:
                idle = time.time()
                yield ": keepalive\n\n"
            time.sleep(0.12)
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/bench")
def bench():
    """Última medición con el modelo real (scripts/bench.py). Sin medición, lo dice."""
    path = ROOT / "results" / "bench.json"
    if not path.exists():
        return {"available": False}
    return {"available": True, **json.loads(path.read_text())}


@app.get("/api/runs")
def runs(limit: int = 30):
    return {"runs": evidence.runs(limit)}


@app.get("/api/evidence/{run_id}")
def export(run_id: str):
    if not evidence.valid_run_id(run_id):
        return _err("run_id no válido", 422)
    e = evidence.export(run_id)
    if not e:
        return _err("ejecución desconocida", 404)
    return JSONResponse(e, headers={"Content-Disposition": f'attachment; filename="evidencia-{run_id}.json"'})


@app.post("/api/diagnose")
def diagnose(body: DiagnoseIn):
    key = (body.sid, body.side, body.model)
    s = SESSIONS.get(key)
    if not s:
        return _err("No hay conversación en esta columna", 404)
    with _lock(body.sid):
        try:
            r = diagnosis.diagnose(s, body.turn)
        except ValueError as e:
            return _err(str(e), 404)
        except Exception as e:  # noqa: BLE001
            return _err(f"{type(e).__name__}: {str(e)[:300]}", 500)
    return _err(r["error"], 403) if r.get("error") else r
