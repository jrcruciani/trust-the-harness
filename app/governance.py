"""Control transversal de plataforma: registro de agentes, decisiones de política, presupuesto y pruebas de control.

El registro va detrás de una interfaz (`Registry`). Hoy se usa `LocalRegistry` (SQLite, identidades sintéticas de laboratorio).
`Agent365Registry` es el punto de enchufe para Microsoft Agent 365: mientras no esté implementado y configurado, deniega
todo (falla cerrado) en lugar de caer en silencio al registro local.
"""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import asdict, dataclass, field
from typing import Protocol

from . import evidence, state

POLICY_VERSION = "POL-DEMO-2026.11-1"
MODES = ("governed", "baseline")
STATES = ("active", "blocked")
LAB = "trust-harness-lab"
SYNTHETIC_ID = "ID sintético de laboratorio (no es Entra Agent ID)"

DEFAULT_AGENTS = [
    {"id": "ops-agent", "name": "Agente de operaciones del COI", "kind": "interno", "provider": "Empresa de aguas · interno",
     "role": "Coordina la intervención INT-2041 con las mismas herramientas: harness vCurrent y vNext",
     "scopes": ["inference", "tool:*"], "budget_tokens": 3_000_000},
    {"id": "ohc-contratista", "name": "Agente de obras", "kind": "externo", "provider": "Contratista ficticio",
     "role": "Consulta el estado de las órdenes de trabajo que afectan a sus obras", "scopes": ["probe:consultar_estado_ot"], "budget_tokens": 0},
    {"id": "thc-cisternas", "name": "Agente de cisternas", "kind": "externo", "provider": "Proveedor ficticio",
     "role": "Consulta sus reservas de cisternas", "scopes": ["probe:consultar_reserva_cisterna"], "budget_tokens": 0},
]

REASONS = {
    "OK": "Permitido: agente activo, dentro de su ámbito y con presupuesto",
    "BASE": "Modo baseline: el control transversal no se evalúa",
    "AG-00": "El control de gobernanza no respondió o devolvió algo inválido: se deniega por defecto",
    "AG-01": "Agente desconocido en el registro",
    "AG-02": "Agente bloqueado",
    "AG-03": "Acción fuera del ámbito autorizado del agente",
    "AG-04": "Presupuesto de inferencia insuficiente para esta llamada",
}


class RegistryError(Exception):
    pass


class VersionConflict(Exception):
    pass


@dataclass
class AgentRecord:
    id: str
    name: str
    role: str
    provider: str
    kind: str
    identity: str
    state: str
    version: int
    scopes: list
    budget_tokens: int
    reason: str | None = None
    updated_at: str = ""
    source: str = "local"


@dataclass
class ExecutionContext:
    agent_id: str
    run_id: str
    sid: str = ""
    profile: str | None = None
    turn: int = 0
    user: str = ""
    scenario: str | None = None
    mode: str = "governed"
    lab: str = LAB

    @property
    def budget_scope(self) -> str:
        return f"{self.sid}:{self.profile or '-'}"


@dataclass
class PolicyDecision:
    id: str
    allowed: bool
    code: str
    reason: str
    action: str
    resource: str
    agent_id: str
    agent_state: str | None = None
    agent_version: int | None = None
    policy_version: str = POLICY_VERSION
    source: str = "local"
    extra: dict = field(default_factory=dict)

    def public(self) -> dict:
        return {k: v for k, v in asdict(self).items() if k != "extra"} | self.extra


class Registry(Protocol):
    source: str

    def get(self, agent_id: str) -> AgentRecord | None: ...
    def list(self) -> list[AgentRecord]: ...
    def set_state(self, agent_id: str, new_state: str, reason: str, expected_version: int) -> AgentRecord: ...
    def set_budget(self, agent_id: str, tokens: int, expected_version: int) -> AgentRecord: ...
    def reset(self) -> None: ...


class LocalRegistry:
    """Registro de laboratorio en SQLite. Identidades sintéticas."""

    source = "local"

    def _rec(self, r) -> AgentRecord:
        d = dict(r)
        d["scopes"] = json.loads(d["scopes"])
        return AgentRecord(**d, source=self.source)

    def seed(self, force: bool = False) -> None:
        with state.tx() as c:
            if force:
                c.execute("DELETE FROM agents")
            for a in DEFAULT_AGENTS:
                c.execute("INSERT INTO agents (id, name, role, provider, kind, identity, state, version, scopes, budget_tokens, reason, updated_at) "
                          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                          "name=excluded.name, role=excluded.role, provider=excluded.provider, kind=excluded.kind",
                          (a["id"], a["name"], a["role"], a["provider"], a["kind"], SYNTHETIC_ID, "active", 1,
                           json.dumps(a["scopes"]), a["budget_tokens"], None, evidence.now()))

    def get(self, agent_id: str) -> AgentRecord | None:
        rows = state.query("SELECT * FROM agents WHERE id=?", (agent_id,))
        return self._rec(rows[0]) if rows else None

    def list(self) -> list[AgentRecord]:
        return [self._rec(r) for r in state.query("SELECT * FROM agents ORDER BY kind DESC, id")]

    def _update(self, agent_id: str, expected_version: int, sets: str, args: tuple) -> AgentRecord:
        with state.tx() as c:
            row = c.execute("SELECT version FROM agents WHERE id=?", (agent_id,)).fetchone()
            if not row:
                raise KeyError(agent_id)
            if row["version"] != expected_version:
                raise VersionConflict(f"versión esperada {expected_version}, actual {row['version']}")
            c.execute(f"UPDATE agents SET {sets}, version=version+1, updated_at=? WHERE id=?", (*args, evidence.now(), agent_id))
        return self.get(agent_id)

    def set_state(self, agent_id: str, new_state: str, reason: str, expected_version: int) -> AgentRecord:
        if new_state not in STATES:
            raise ValueError("estado no válido")
        return self._update(agent_id, expected_version, "state=?, reason=?", (new_state, reason))

    def set_budget(self, agent_id: str, tokens: int, expected_version: int) -> AgentRecord:
        if tokens < 0 or tokens > 5_000_000:
            raise ValueError("presupuesto fuera de rango")
        return self._update(agent_id, expected_version, "budget_tokens=?", (int(tokens),))

    def reset(self) -> None:
        self.seed(force=True)


class Agent365Registry:
    """Punto de enchufe para Microsoft Agent 365 (registro, ciclo de vida y bloqueo reales con Entra Agent ID).

    Pendiente: requiere licencia de Agent 365 en el tenant, registrar el agente y validar la API y el tiempo de propagación
    de un bloqueo. Hasta entonces cada operación lanza RegistryError y el control deniega (falla cerrado).
    """

    source = "agent365"

    def _unavailable(self, *_a, **_k):
        raise RegistryError("Registro Agent 365 no configurado en este laboratorio")

    get = list = set_state = set_budget = reset = _unavailable


_registry: Registry | None = None


def registry() -> Registry:
    global _registry
    if _registry is None:
        kind = os.getenv("DEMO_REGISTRY", "local").strip().lower()
        _registry = Agent365Registry() if kind == "agent365" else LocalRegistry()
        if isinstance(_registry, LocalRegistry):
            _registry.seed()
    return _registry


def set_registry(r: Registry | None) -> None:
    global _registry
    _registry = r


# ---------------------------------------------------------------- modo del laboratorio
def mode() -> str:
    rows = state.query("SELECT value FROM lab WHERE key='mode'")
    return rows[0]["value"] if rows and rows[0]["value"] in MODES else "governed"


def set_mode(m: str) -> str:
    if m not in MODES:
        raise ValueError("modo no válido")
    with state.tx() as c:
        c.execute("INSERT INTO lab (key, value) VALUES ('mode', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (m,))
    return m


# ---------------------------------------------------------------- decisiones
def _in_scope(scopes: list, action: str) -> bool:
    kind = action.split(":", 1)[0]
    return action in scopes or f"{kind}:*" in scopes


def _record(ctx: ExecutionContext, d: PolicyDecision) -> PolicyDecision:
    with state.tx() as c:
        c.execute("INSERT INTO decisions (id, ts, run_id, agent_id, action, resource, decision, code, reason, policy_version, agent_state, "
                  "agent_version, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (d.id, evidence.now(), ctx.run_id, d.agent_id, d.action, evidence.sanitize(d.resource),
                   "allow" if d.allowed else ("not_evaluated" if d.code == "BASE" else "deny"),
                   d.code, d.reason, d.policy_version, d.agent_state, d.agent_version, d.source))
    if not d.allowed:
        evidence.event(ctx.run_id, "governance.decision", "deny", d.public(), agent_id=ctx.agent_id, profile=ctx.profile)
    return d


def authorize(ctx: ExecutionContext, action: str, resource: str = "") -> PolicyDecision:
    """Se evalúa en el momento de cada acción (no solo al empezar el turno). Cualquier fallo deniega."""
    did = f"DEC-{secrets.token_hex(5)}"
    try:
        if mode() == "baseline":
            return _record(ctx, PolicyDecision(did, True, "BASE", REASONS["BASE"], action, resource, ctx.agent_id, source="baseline"))
        reg = registry()
        a = reg.get(ctx.agent_id)
        if a is None:
            return _record(ctx, PolicyDecision(did, False, "AG-01", REASONS["AG-01"], action, resource, ctx.agent_id, source=reg.source))
        base = dict(agent_state=a.state, agent_version=a.version, source=a.source)
        if a.state != "active":
            why = f"{REASONS['AG-02']}: {a.reason}" if a.reason else REASONS["AG-02"]
            return _record(ctx, PolicyDecision(did, False, "AG-02", why, action, resource, ctx.agent_id, **base))
        if not _in_scope(a.scopes, action):
            return _record(ctx, PolicyDecision(did, False, "AG-03", REASONS["AG-03"], action, resource, ctx.agent_id, **base))
        return _record(ctx, PolicyDecision(did, True, "OK", REASONS["OK"], action, resource, ctx.agent_id, **base))
    except Exception as e:  # noqa: BLE001 - falla cerrado
        d = PolicyDecision(did, False, "AG-00", f"{REASONS['AG-00']} ({str(e)[:80]})", action, resource, ctx.agent_id, source="error")
        try:
            return _record(ctx, d)
        except Exception:  # noqa: BLE001
            return d


# ---------------------------------------------------------------- presupuesto de inferencia
@dataclass
class Reservation:
    agent_id: str
    scope: str
    tokens: int
    enforced: bool


def budget_status(agent_id: str, scope: str) -> dict:
    a = registry().get(agent_id)
    rows = state.query("SELECT reserved, used FROM budget WHERE agent_id=? AND scope=?", (agent_id, scope))
    reserved, used = (rows[0]["reserved"], rows[0]["used"]) if rows else (0, 0)
    limit = a.budget_tokens if a else 0
    return {"agent_id": agent_id, "scope": scope, "limit": limit, "used": used, "reserved": reserved,
            "available": max(0, limit - used - reserved)}


def reserve(ctx: ExecutionContext, tokens: int) -> tuple[Reservation | None, PolicyDecision | None]:
    """Reserva antes de cada inferencia el máximo previsible de entrada + salida. En baseline solo se contabiliza."""
    tokens = max(1, int(tokens))
    enforced = mode() == "governed"
    try:
        a = registry().get(ctx.agent_id)
        limit = a.budget_tokens if a else 0
        with state.tx() as c:
            row = c.execute("SELECT reserved, used FROM budget WHERE agent_id=? AND scope=?", (ctx.agent_id, ctx.budget_scope)).fetchone()
            reserved, used = (row["reserved"], row["used"]) if row else (0, 0)
            if enforced and used + reserved + tokens > limit:
                deny = True
            else:
                deny = False
                c.execute("INSERT INTO budget (agent_id, scope, reserved, used) VALUES (?,?,?,0) "
                          "ON CONFLICT(agent_id, scope) DO UPDATE SET reserved=reserved+excluded.reserved",
                          (ctx.agent_id, ctx.budget_scope, tokens))
        if deny:
            d = PolicyDecision(f"DEC-{secrets.token_hex(5)}", False, "AG-04",
                               f"{REASONS['AG-04']}: usados {used:,} + reservados {reserved:,} + esta llamada {tokens:,} > límite {limit:,}".replace(",", "."),
                               "inference", "budget", ctx.agent_id, a.state if a else None, a.version if a else None, source=a.source if a else "local",
                               extra={"limit": limit, "used": used, "reserved": reserved, "requested": tokens})
            return None, _record(ctx, d)
        return Reservation(ctx.agent_id, ctx.budget_scope, tokens, enforced), None
    except Exception as e:  # noqa: BLE001 - falla cerrado
        d = PolicyDecision(f"DEC-{secrets.token_hex(5)}", False, "AG-00", f"{REASONS['AG-00']} ({str(e)[:80]})", "inference", "budget",
                           ctx.agent_id, source="error")
        return None, _record(ctx, d)


def settle(res: Reservation, used: int | None) -> None:
    """Liquida contra el uso real. Con uso incierto (timeout, conexión cortada) la reserva completa se da por consumida."""
    charged = res.tokens if used is None else max(0, int(used))
    with state.tx() as c:
        c.execute("UPDATE budget SET reserved=MAX(0, reserved-?), used=used+? WHERE agent_id=? AND scope=?",
                  (res.tokens, charged, res.agent_id, res.scope))


# ---------------------------------------------------------------- contadores de handlers (prueba de que no se ejecutó)
def count_handler(agent_id: str, handler: str) -> None:
    with state.tx() as c:
        c.execute("INSERT INTO counters (agent_id, handler, n) VALUES (?,?,1) ON CONFLICT(agent_id, handler) DO UPDATE SET n=n+1",
                  (agent_id, handler))


def handler_count(agent_id: str, handler: str | None = None) -> int:
    if handler:
        rows = state.query("SELECT n FROM counters WHERE agent_id=? AND handler=?", (agent_id, handler))
    else:
        rows = state.query("SELECT COALESCE(SUM(n), 0) AS n FROM counters WHERE agent_id=?", (agent_id,))
    return int(rows[0]["n"]) if rows else 0


# ---------------------------------------------------------------- pruebas de control deterministas (sin modelo)
def _op_ot() -> dict:
    return {"order_id": "OT-58214", "status": "Asignada", "crew": "C-07", "location": "Avenida de la Constitución 44-58, Valdeaguas",
            "note": "Datos sintéticos de laboratorio"}


def _op_tanker() -> dict:
    return {"booking_id": "CIS-2207", "supply_point": "PS-H001 · Hospital Comarcal", "status": "Confirmada", "note": "Datos sintéticos de laboratorio"}


PROBES = {
    "consultar_estado_ot": {"agent": "ohc-contratista", "resource": "GMAO · OT-58214", "label": "Consultar el estado de la OT-58214", "handler": _op_ot},
    "consultar_reserva_cisterna": {"agent": "thc-cisternas", "resource": "Logística · CIS-2207", "label": "Consultar la reserva CIS-2207",
                                   "handler": _op_tanker},
}


def run_probe(operation: str) -> dict:
    """Ejecuta una operación predefinida de solo lectura. El cliente elige la operación, nunca la identidad."""
    p = PROBES.get(operation)
    if not p:
        raise KeyError(operation)
    run_id = evidence.new_run_id("probe")
    ctx = ExecutionContext(agent_id=p["agent"], run_id=run_id, user="Operador del COI (identidad de demo)", mode=mode())
    evidence.start_run(run_id, p["agent"], None, "prueba de control", ctx.mode, p["label"])
    evidence.event(run_id, "probe.start", "", {"operation": operation, "resource": p["resource"], "label": p["label"]}, agent_id=p["agent"])
    d = authorize(ctx, f"probe:{operation}", p["resource"])
    before = handler_count(p["agent"], operation)
    if not d.allowed:
        evidence.event(run_id, "probe.end", "deny", {"operation": operation, "handler_executed": False, "handler_count": before,
                                                     "decision": d.code}, agent_id=p["agent"])
        evidence.end_run(run_id, f"denegado {d.code}")
        return {"run_id": run_id, "operation": operation, "agent_id": p["agent"], "allowed": False, "decision": d.public(),
                "handler_executed": False, "handler_count": before}
    count_handler(p["agent"], operation)
    result = p["handler"]()
    after = handler_count(p["agent"], operation)
    evidence.event(run_id, "probe.end", "allow", {"operation": operation, "handler_executed": True, "handler_count": after,
                                                  "decision": d.code, "result": result}, agent_id=p["agent"])
    evidence.end_run(run_id, "permitido")
    return {"run_id": run_id, "operation": operation, "agent_id": p["agent"], "allowed": True, "decision": d.public(),
            "handler_executed": True, "handler_count": after, "result": result}


# ---------------------------------------------------------------- transiciones y vista
def change_state(agent_id: str, new_state: str, reason: str, expected_version: int) -> AgentRecord:
    a = registry().set_state(agent_id, new_state, reason, expected_version)
    run_id = evidence.new_run_id("ctl")
    evidence.start_run(run_id, agent_id, None, "control de plataforma", mode(), f"{new_state}: {reason}")
    evidence.event(run_id, "agent.state_changed", new_state, {"agent": a.name, "state": a.state, "version": a.version, "reason": reason,
                                                               "by": "Operador del COI (identidad de demo)", "registry": a.source},
                   agent_id=agent_id)
    evidence.end_run(run_id, new_state)
    return a


def overview(sid: str | None = None) -> dict:
    agents = []
    for a in registry().list():
        d = asdict(a)
        d["handler_count"] = handler_count(a.id)
        if sid and "inference" in a.scopes:
            d["budget"] = {p: budget_status(a.id, f"{sid}:{p}") for p in ("good", "excellent", "-")}
        d["probes"] = [{"operation": k, "label": v["label"], "resource": v["resource"]} for k, v in PROBES.items() if v["agent"] == a.id]
        agents.append(d)
    return {"lab": LAB, "mode": mode(), "policy_version": POLICY_VERSION, "registry": registry().source, "agents": agents}


def lab_reset() -> None:
    """Limpieza explícita del laboratorio: distinta del reinicio del chat."""
    registry().reset()
    with state.tx() as c:
        c.execute("DELETE FROM budget")
        c.execute("DELETE FROM counters")
        c.execute("DELETE FROM lab")
        c.execute("DELETE FROM missions")
        c.execute("DELETE FROM mission_checkpoints")
    evidence.clear()
