"""Pruebas deterministas de gobernanza, evidencia y diagnóstico. Sin red: el modelo es un cliente falso.

    uv run python -m unittest discover -s tests -v
"""
from __future__ import annotations

import json
import copy
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

os.environ["DEMO_WARMUP"] = "0"
os.environ["DEMO_REGISTRY"] = "local"

import httpx  # noqa: E402
import openai  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import agent, data, evidence, governance, server, state  # noqa: E402


class FakeCall:
    def __init__(self, name, args, call_id):
        self.type, self.name, self.arguments, self.call_id = "function_call", name, json.dumps(args), call_id

    def model_dump(self, **_):
        return {"type": "function_call", "name": self.name, "arguments": self.arguments, "call_id": self.call_id}


class FakeText:
    type = "message"

    def __init__(self, text):
        self.text = text

    def model_dump(self, **_):
        return {"role": "assistant", "content": self.text}


def resp(output=None, text="", tin=100, tout=20):
    return SimpleNamespace(usage=SimpleNamespace(input_tokens=tin, output_tokens=tout), output=output or [FakeText(text)], output_text=text)


def answer(text="Recibido", status="needs_input"):
    return resp(text=json.dumps({"status": status, "reply": text}))


class FakeClient:
    """responses.create devuelve en orden lo guionizado: una respuesta, una excepción o una función que recibe la petición."""

    def __init__(self, script):
        self.script, self.calls = list(script), []
        self.responses = SimpleNamespace(create=self.create)

    def create(self, **kw):
        self.calls.append(copy.deepcopy(kw))
        item = self.script.pop(0)
        if callable(item):
            item = item(kw)
        if isinstance(item, Exception):
            raise item
        return item


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        state.configure(Path(self.tmp.name))
        governance.set_registry(None)
        governance.registry()
        server.SESSIONS.clear()
        self.api = TestClient(server.app)
        self._sleep = agent.time.sleep
        agent.time.sleep = lambda *_: None

    def tearDown(self):
        agent.time.sleep = self._sleep
        agent._client = None
        governance.set_registry(None)
        state.configure(None)
        self.tmp.cleanup()

    def fake(self, *script):
        agent._client = FakeClient(script)
        return agent._client

    def agent_rec(self, agent_id):
        return next(a for a in self.api.get("/api/governance").json()["agents"] if a["id"] == agent_id)

    def set_state(self, agent_id, st, reason="prueba de laboratorio"):
        v = self.agent_rec(agent_id)["version"]
        return self.api.post(f"/api/governance/agents/{agent_id}/state", json={"state": st, "reason": reason, "expected_version": v})

    def chat(self, msg=data.MISSION, side="good", sid="t1", **extra):
        return self.api.post("/api/chat", json={"sid": sid, "side": side, "message": msg, **extra}).json()


class ProbeAndRegistry(Base):
    def test_probe_block_restore_sequence(self):
        op = "consultar_estado_ot"
        r1 = self.api.post("/api/governance/probe", json={"operation": op}).json()
        self.assertTrue(r1["allowed"])
        self.assertEqual(r1["handler_count"], 1)
        self.assertEqual(self.set_state("ohc-contratista", "blocked").status_code, 200)
        r2 = self.api.post("/api/governance/probe", json={"operation": op}).json()
        self.assertFalse(r2["allowed"])
        self.assertEqual(r2["decision"]["code"], "AG-02")
        self.assertFalse(r2["handler_executed"])
        self.assertEqual(r2["handler_count"], 1)
        self.set_state("ohc-contratista", "active")
        r3 = self.api.post("/api/governance/probe", json={"operation": op}).json()
        self.assertTrue(r3["allowed"])
        self.assertEqual(r3["handler_count"], 2)

    def test_version_conflict(self):
        r = self.api.post("/api/governance/agents/ohc-contratista/state", json={"state": "blocked", "reason": "conflicto", "expected_version": 99})
        self.assertEqual(r.status_code, 409)

    def test_unknown_agent_and_registry_failure_deny(self):
        ctx = governance.ExecutionContext(agent_id="desconocido", run_id="test-run-1")
        self.assertEqual(governance.authorize(ctx, "inference").code, "AG-01")
        governance.set_registry(governance.Agent365Registry())
        d = governance.authorize(governance.ExecutionContext(agent_id=agent.AGENT_ID, run_id="test-run-2"), "inference")
        self.assertFalse(d.allowed)
        self.assertEqual(d.code, "AG-00")

    def test_scope_enforced(self):
        ctx = governance.ExecutionContext(agent_id="ohc-contratista", run_id="test-run-3")
        self.assertEqual(governance.authorize(ctx, "inference").code, "AG-03")


class InferenceBoundary(Base):
    def test_blocked_agent_never_calls_model(self):
        fc = self.fake()
        self.set_state(agent.AGENT_ID, "blocked")
        r = self.chat()
        self.assertEqual(fc.calls, [])
        self.assertEqual(r["stopped_by_platform"]["code"], "AG-02")
        self.assertIn("Detenido por la plataforma", r["reply"])

    def test_chat_reset_does_not_unblock(self):
        self.set_state(agent.AGENT_ID, "blocked")
        self.api.post("/api/reset", json={"sid": "t1"})
        self.assertEqual(self.agent_rec(agent.AGENT_ID)["state"], "blocked")

    def test_metadata_refresh_preserves_operator_state(self):
        self.set_state(agent.AGENT_ID, "blocked")
        before = self.agent_rec(agent.AGENT_ID)
        governance.registry().seed()
        after = self.agent_rec(agent.AGENT_ID)
        for key in ("state", "version", "reason", "budget_tokens", "scopes"):
            self.assertEqual(before[key], after[key])

    def test_block_mid_turn(self):
        def block_during_call(_kw):
            v = governance.registry().get(agent.AGENT_ID).version
            governance.change_state(agent.AGENT_ID, "blocked", "bloqueo durante la llamada", v)
            return resp([FakeCall("get_options", {}, "c1")])

        fc = self.fake(block_during_call)
        before = governance.handler_count(agent.AGENT_ID)
        r = self.chat(run_id="mid-turn-001")
        self.assertEqual(len(fc.calls), 1)
        tool = next(st for st in r["trace"] if st["k"] == "tool")
        self.assertEqual(tool["outcome"], "BLOCKED_BY_PLATFORM")
        self.assertEqual(governance.handler_count(agent.AGENT_ID), before)
        self.assertEqual(r["stopped_by_platform"]["code"], "AG-02")
        self.assertIn("inference.in_flight", [e["type"] for e in evidence.events("mid-turn-001")])

    def test_budget_denies_before_call(self):
        fc = self.fake()
        v = self.agent_rec(agent.AGENT_ID)["version"]
        self.api.post(f"/api/governance/agents/{agent.AGENT_ID}/budget", json={"tokens": 100, "expected_version": v})
        r = self.chat()
        self.assertEqual(fc.calls, [])
        self.assertEqual(r["stopped_by_platform"]["code"], "AG-04")

    def test_uncertain_usage_charges_reservation(self):
        req = httpx.Request("POST", "https://example.invalid")
        self.fake(*[openai.APITimeoutError(request=req) for _ in range(3)])
        r = self.api.post("/api/chat", json={"sid": "t1", "side": "good", "message": "hola"})
        self.assertEqual(r.status_code, 500)
        b = governance.budget_status(agent.AGENT_ID, "t1:good")
        self.assertEqual(b["reserved"], 0)
        self.assertGreater(b["used"], 3 * agent.MAX_OUT["executor"])

    def test_baseline_does_not_enforce(self):
        self.fake(answer("Hecho"))
        self.set_state(agent.AGENT_ID, "blocked")
        self.api.post("/api/governance/mode", json={"mode": "baseline"})
        r = self.chat(msg="hola")
        self.assertNotIn("stopped_by_platform", r)
        self.assertEqual(r["reply"], "Hecho")

class Evidence(Base):
    def test_timeline_starts_with_recent_events_then_uses_cursor(self):
        for i in range(5):
            evidence.event("recent-run-001", "note", "", {"n": i})
        r = self.api.get("/api/events", params={"tail": True, "limit": 2}).json()
        self.assertEqual([e["data"]["n"] for e in r["events"]], [3, 4])
        evidence.event("recent-run-001", "note", "", {"n": 5})
        more = self.api.get("/api/events", params={"after": r["events"][-1]["id"], "tail": True}).json()
        self.assertEqual([e["data"]["n"] for e in more["events"]], [5])

    def test_events_and_export_are_sanitized(self):
        self.fake(answer("El teléfono es +34 600 000 000 y el IBAN ES12 3456 7890 1234 5678 9012"))
        self.chat(msg="Llamad al +34 600 000 000, correo prueba@example.com", run_id="san-run-01")
        blob = json.dumps(self.api.get("/api/evidence/san-run-01").json(), ensure_ascii=False)
        self.assertNotIn("600 000 000", blob)
        self.assertNotIn("3456 7890 1234", blob)
        self.assertNotIn("prueba@", blob)
        self.assertIn("example.com", blob)

    def test_sanitizer_formats(self):
        for raw, leak in [("Llame al 600 234 567", "600 234"), ("(+34) 600 234 567", "600 234"), ("+34-600-234-567", "600-234"),
                          ("ES91-2100-0418-4502-0005-1332", "0418"), ("IBAN: ES91 2100 0418 4502 00", "0418")]:
            self.assertNotIn(leak, evidence.sanitize(raw), raw)
        for keep in ("198.51.100.16/28", "OT-77812", "3.870 €", "CLI-1001", "12.357 tokens"):
            self.assertEqual(evidence.sanitize(keep), keep)

    def test_invalid_run_id_rejected(self):
        self.assertEqual(self.api.get("/api/events", params={"run_id": "../x"}).status_code, 422)

    def test_duplicate_run_does_not_call_model_or_advance_turn(self):
        fc = self.fake(answer())
        self.chat(run_id="same-run-001")
        r = self.api.post("/api/chat", json={"sid": "t1", "side": "good", "message": "hola", "run_id": "same-run-001"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(len(fc.calls), 1)
        self.assertEqual(server.SESSIONS[("t1", "good", agent.MODEL)].turn, 1)


if __name__ == "__main__":
    unittest.main()
