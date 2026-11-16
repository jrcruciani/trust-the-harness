"""Igualdad de condiciones, guardas, recuperación y comparación controlada de la misión larga."""

import copy
import httpx
import openai
import json
from unittest.mock import patch

from app import agent, data, diagnosis, evidence, server
from test_governance import Base, FakeCall, answer, resp

NO_FAULTS = {"pending_reservation": False, "lost_response": False, "supplier_cancel": False}
PENDING = {**NO_FAULTS, "pending_reservation": True}
CANCEL = {**NO_FAULTS, "supplier_cancel": True}
LOST = {**NO_FAULTS, "lost_response": True}
ONLY = lambda *ks: {k: k in ks for k in agent.LAYERS}  # noqa: E731
PLAN = {"S4": "M3", "S7": "M2", "S9": "T1"}


def tool(name, args=None, cid="c1"):
    return resp([FakeCall(name, args or {}, cid)])


def reserve_all(sector, slot):
    return resp([FakeCall("reserve_resource", {"sector": sector, "resource": r, "slot": slot}, f"r-{r}") for r in data.RESOURCES])


def build(faults=NO_FAULTS, notices=True):
    world = data.new_world(faults)
    for s, slot in PLAN.items():
        for res in data.RESOURCES:
            r = data.execute(world, "reserve_resource", {"sector": s, "resource": res, "slot": slot})
            for _ in range(2):
                data.execute(world, "check_reservation", {"reservation_id": r["id"]})
        data.execute(world, "create_work_order", {"sector": s, "slot": slot})
    if notices:
        for i, (s, slot) in enumerate(PLAN.items(), 1):
            data.execute(world, "send_notice", {"sector": s, "slot": slot, "order_id": f"OT-{i:03d}"})
    return world


class World(Base):
    def test_full_plan_is_ready_and_judge_has_no_side_effects(self):
        world = build()
        before = copy.deepcopy(world)
        a = data.assess(world)
        self.assertTrue(a["ready_to_close"])
        self.assertEqual((a["done"], a["total"]), (15, 16))
        self.assertEqual(world, before)

    def test_pending_is_never_confirmed_by_judging(self):
        world = data.new_world(PENDING)
        r = data.execute(world, "reserve_resource", {"sector": "S4", "resource": "water", "slot": "M3"})
        self.assertEqual(r["status"], "PENDING")
        for _ in range(3):
            self.assertEqual(data.assess(world)["sectors"][0]["items"][2]["status"], "pending")
        self.assertEqual(data.execute(world, "check_reservation", {"reservation_id": r["id"]})["status"], "PENDING")
        self.assertEqual(data.execute(world, "check_reservation", {"reservation_id": r["id"]})["status"], "CONFIRMED")

    def test_supplier_cancel_is_stale_in_register_until_checked(self):
        world = build(CANCEL)
        self.assertIn("supplier_cancel", world["faults_fired"])
        rec = data.execute(world, "list_records", {"sector": "S4"})
        water = next(r for r in rec["reservations"] if r["resource"] == "water")
        self.assertEqual(water["status"], "CONFIRMED")
        live = data.execute(world, "check_reservation", {"reservation_id": water["id"]})
        self.assertEqual(live["status"], "CANCELLED")
        self.assertIn("vuelve a reservar", live["message"])
        self.assertFalse(data.assess(world)["ready_to_close"])
        again = data.execute(world, "reserve_resource", {"sector": "S4", "resource": "water", "slot": "M3"})
        self.assertEqual(again["status"], "CONFIRMED")
        self.assertTrue(data.assess(world)["ready_to_close"])


class Equality(Base):
    def test_identical_first_model_request(self):
        fc = self.fake(answer(), answer())
        a = self.chat(side="good")
        b = self.chat(side="excellent", layers=ONLY())
        self.assertEqual(fc.calls[0], fc.calls[1])
        for key in ("model", "model_params", "limits", "tool_hash", "prompt_hash", "code_hash", "request_hash",
                    "state_hash", "history_hash", "faults", "platform_mode", "platform_agent"):
            self.assertEqual(a["conditions"][key], b["conditions"][key], key)

    def test_changing_the_model_changes_only_model_settings(self):
        fc = self.fake(answer(), answer())
        a = self.chat(side="good")
        b = self.api.post("/api/chat", json={"sid": "t1", "side": "good", "model": "gpt-6.1-sol", "message": data.MISSION}).json()
        first, second = dict(fc.calls[0]), dict(fc.calls[1])
        for req in (first, second):
            for k in ("model", "temperature", "reasoning", "max_output_tokens"):
                req.pop(k, None)
        self.assertEqual(first, second)
        self.assertEqual((fc.calls[1]["model"], fc.calls[1]["reasoning"]), ("gpt-6.1-sol", {"effort": "medium"}))
        self.assertNotIn("temperature", fc.calls[1])
        diff = {k for k in a["conditions"] if a["conditions"][k] != b["conditions"][k]}
        self.assertEqual(diff, {"model", "model_params"})
        self.assertGreater(agent.cost("gpt-6.1-sol", 1000, 100), agent.cost("gpt-4.1-mini", 1000, 100))

    def test_faults_and_controls_are_locked(self):
        fc = self.fake(answer())
        self.chat(side="excellent", faults=NO_FAULTS, layers=ONLY("retry"))
        self.assertEqual(self.api.post("/api/chat", json={"sid": "t1", "side": "good", "message": "x", "faults": PENDING}).status_code, 409)
        server.SESSIONS.clear()
        r = self.api.post("/api/chat", json={"sid": "t1", "side": "excellent", "message": "x", "faults": NO_FAULTS,
                                           "layers": ONLY("ledger")})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(len(fc.calls), 1)

    def test_ledger_is_injected_only_after_observation_and_only_in_vnext(self):
        fc = self.fake(tool("reserve_resource", {"sector": "S4", "resource": "crew", "slot": "M3"}), answer(),
                       tool("reserve_resource", {"sector": "S4", "resource": "crew", "slot": "M3"}), answer())
        self.chat(side="excellent", sid="a", faults=NO_FAULTS, layers=ONLY("ledger"))
        self.chat(side="good", sid="b", faults=NO_FAULTS)
        roles = [[m.get("role") for m in c["input"]] for c in fc.calls]
        self.assertNotIn("developer", roles[0])
        self.assertEqual(roles[1][-1], "developer")
        self.assertIn("S4", fc.calls[1]["input"][-1]["content"])
        self.assertNotIn("developer", roles[3])


class Guards(Base):
    def test_write_guard_holds_order_until_confirmed_then_allows(self):
        self.fake(reserve_all("S4", "M3"),
                  tool("create_work_order", {"sector": "S4", "slot": "M3"}),
                  tool("check_reservation", {"reservation_id": "RES-S4-water-1"}),
                  tool("create_work_order", {"sector": "S4", "slot": "M3"}),
                  tool("send_notice", {"sector": "S4", "slot": "M3", "order_id": "OT-001"}),
                  answer("S4 hecho", "pending"))
        r = self.chat(side="excellent", faults=PENDING, layers=ONLY("preconditions"))
        world = server.SESSIONS[("t1", "excellent", agent.MODEL)].world
        self.assertEqual(r["assessment"]["violations"], [])
        self.assertEqual(len(world["orders"]), 1)
        self.assertTrue(world["notices"][0]["confirmed_at_send"])
        blocks = [st for st in r["trace"] if st["k"] == "nudge" and st["checks"][0]["status"] == "block"]
        self.assertEqual(len(blocks), 1)

    def test_without_guard_the_same_decisions_harm(self):
        self.fake(reserve_all("S4", "M3"),
                  tool("create_work_order", {"sector": "S4", "slot": "M3"}),
                  tool("send_notice", {"sector": "S4", "slot": "M3", "order_id": "OT-001"}), answer())
        r = self.chat(side="good", faults=PENDING)
        self.assertIn("sin los tres recursos", r["assessment"]["violations"][0])

    def test_close_guard_catches_silent_cancellation_and_model_repairs(self):
        for side, sid in (("excellent", "v"), ("good", "c")):
            s = agent.new_session(side, ONLY("completion", "retry"), CANCEL, sid=sid)
            s.world = build(CANCEL)
            server.SESSIONS[(sid, side, agent.MODEL)] = s
        self.fake(tool("close_mission"), tool("reserve_resource", {"sector": "S4", "resource": "water", "slot": "M3"}),
                  tool("close_mission"), answer("Cerrado", "completed"))
        r = self.chat(side="excellent", sid="v", faults=CANCEL)
        self.assertTrue(r["assessment"]["complete"], r["assessment"])
        detail = next(st["checks"][0]["detail"] for st in r["trace"] if st["k"] == "nudge" and st["checks"][0]["status"] == "block")
        self.assertIn("vuelve a reservar", detail)
        self.fake(tool("close_mission"), answer("Cerrado", "completed"))
        r = self.chat(side="good", sid="c", faults=CANCEL)
        self.assertIn("Cierre prematuro", r["assessment"]["violations"][0])

    def test_continuation_is_bounded_and_never_fakes_success(self):
        fc = self.fake(*[answer("Hecho", "completed") for _ in range(agent.MAX_CONTINUATIONS + 1)])
        r = self.chat(side="excellent", faults=NO_FAULTS, layers=ONLY("completion"))
        self.assertEqual(len(fc.calls), agent.MAX_CONTINUATIONS + 1)
        self.assertEqual(r["status"], "pending")

    def test_loop_detection_short_circuits_then_stops(self):
        bad = {"sector": "S4", "resource": "material", "slot": "M1"}
        fc = self.fake(*[tool("reserve_resource", bad) for _ in range(7)])
        r = self.chat(side="excellent", faults=NO_FAULTS, layers=ONLY("ledger"))
        executed = [st for st in r["trace"] if st["k"] == "tool" and st["name"] == "reserve_resource"]
        self.assertEqual(len(executed), 1)
        self.assertEqual(len(fc.calls), 6)
        hint = next(m for m in fc.calls[2]["input"] if m.get("type") == "function_call_output" and "repeated" in m["output"])
        self.assertIn("Franja común para los tres recursos del sector: M3", hint["output"])
        self.assertEqual(r["status"], "pending")
        self.assertIn("revisión humana", r["reply"])

    def test_harness_queries_count_toward_the_common_budget(self):
        self.fake(tool("close_mission"), answer("Hecho", "completed"))
        with patch.dict(agent.LIMITS, {"tool_calls": 2}):
            r = self.chat(side="excellent", faults=NO_FAULTS, layers=ONLY("completion"))
        self.assertEqual(r["usage"]["tool_calls"], 2)
        self.assertIn("Límite común", r["reply"])
        self.assertFalse(r["assessment"]["closed"])


class SafeRetry(Base):
    def test_uncertain_write_is_reconciled_not_repeated(self):
        fc = self.fake(tool("create_work_order", {"sector": "S7", "slot": "M2"}), answer())
        r = self.chat(side="excellent", faults=LOST, layers=ONLY("retry"))
        output = next(m for m in fc.calls[-1]["input"] if m.get("type") == "function_call_output")
        self.assertTrue(json.loads(output["output"])["reconciled"])
        self.assertEqual(len(server.SESSIONS[("t1", "excellent", agent.MODEL)].world["orders"]), 1)
        self.assertEqual([st["name"] for st in r["trace"] if st["k"] == "tool"], ["create_work_order", "lookup_operation"])

    def test_current_can_recover_with_the_same_tools(self):
        self.fake(tool("create_work_order", {"sector": "S7", "slot": "M2", "operation_key": "o1"}),
                  tool("lookup_operation", {"operation_key": "o1"}),
                  tool("create_work_order", {"sector": "S7", "slot": "M2", "operation_key": "o1"}), answer())
        self.chat(faults=LOST)
        self.assertEqual(len(server.SESSIONS[("t1", "good", agent.MODEL)].world["orders"]), 1)

    def test_no_receipt_stays_uncertain(self):
        journal, calls = {}, []

        def call(name, _args, _actor):
            calls.append(name)
            return {"status": "DELIVERY_UNKNOWN"} if name == "create_work_order" else {"status": "NOT_FOUND"}

        result = agent.execute_proposal({"tool": "create_work_order", "args": {"sector": "S7", "slot": "M2"}},
                                        {"retry": True}, journal, call, lambda *_: None, lambda: None)
        self.assertEqual(result["status"], "DELIVERY_UNKNOWN")
        self.assertEqual(calls, ["create_work_order", "lookup_operation"])

    def test_same_key_cannot_mean_a_different_write(self):
        world = data.new_world(NO_FAULTS)
        data.execute(world, "create_work_order", {"sector": "S7", "slot": "M2", "operation_key": "same"})
        before = copy.deepcopy(world)
        self.assertEqual(data.execute(world, "create_work_order", {"sector": "S7", "slot": "M1", "operation_key": "same"})["error"],
                         "IDEMPOTENCY_CONFLICT")
        self.assertEqual(world, before)

    def test_rebooking_after_cancellation_is_a_new_operation(self):
        s = agent.new_session("excellent", ONLY("retry"), CANCEL, sid="t1")
        s.world = build(CANCEL)
        s.journal[data.operation_key("reserve_resource", {"sector": "S4", "resource": "water", "slot": "M3"})] = {
            "status": "observed", "base": data.operation_key("reserve_resource", {"sector": "S4", "resource": "water", "slot": "M3"})}
        server.SESSIONS[("t1", "excellent", agent.MODEL)] = s
        self.fake(tool("reserve_resource", {"sector": "S4", "resource": "water", "slot": "M3"}), answer())
        self.chat(side="excellent", faults=CANCEL)
        self.assertTrue(data.assess(s.world)["ready_to_close"])


class ControlledReplay(Base):
    def _premature_notice(self):
        self.fake(reserve_all("S4", "M3"), tool("create_work_order", {"sector": "S4", "slot": "M3"}),
                  tool("send_notice", {"sector": "S4", "slot": "M3", "order_id": "OT-001"}), answer())
        return self.chat(faults=PENDING)

    def test_real_premature_decision_replayed_on_identical_copies(self):
        r = self._premature_notice()
        cp = next(c for c in r["checkpoints"] if c["label"].startswith("Aviso"))
        self.assertTrue(cp["premature"] and cp["harmful"])
        retry = data.new_world(LOST)
        data.execute(retry, "create_work_order", {"sector": "S7", "slot": "M2", "operation_key": "k"})
        self.assertFalse(data.harmful(retry, {"tool": "create_work_order", "args": {"sector": "S7", "slot": "M2", "operation_key": "k"}}))
        world = copy.deepcopy(server.SESSIONS[("t1", "good", agent.MODEL)].world)
        compared = self.api.post("/api/compare", json={"sid": "t1", "checkpoint_id": cp["id"]}).json()
        off, on = compared["arms"]
        self.assertEqual(compared["control"], "preconditions")
        self.assertEqual(compared["source"], "model")
        self.assertEqual(off["initial_state_hash"], on["initial_state_hash"])
        self.assertEqual(off["result"]["status"], "SENT")
        self.assertTrue(off["assessment"]["violations"])
        self.assertEqual(on["result"]["status"], "BLOCKED_BY_HARNESS")
        self.assertEqual(on["assessment"]["violations"], [])
        self.assertEqual(server.SESSIONS[("t1", "good", agent.MODEL)].world, world)
        exported = evidence.export(compared["run_id"])
        self.assertEqual(exported["summary"]["inferences"], 0)
        self.assertEqual(len([e for e in exported["events"] if e["type"] == "comparison.arm"]), 2)

    def test_checkpoints_are_scoped_versioned_and_governed(self):
        cp = self._premature_notice()["checkpoints"][0]["id"]
        self.assertEqual(self.api.post("/api/compare", json={"sid": "other", "checkpoint_id": cp}).status_code, 404)
        with patch.object(agent, "CODE_HASH", "changed"):
            self.assertEqual(self.api.post("/api/compare", json={"sid": "t1", "checkpoint_id": cp}).status_code, 409)
        self.set_state(agent.AGENT_ID, "blocked")
        self.assertEqual(self.api.post("/api/compare", json={"sid": "t1", "checkpoint_id": cp}).status_code, 403)



class Diagnosis(Base):
    def diag(self, side="good", sid="t1"):
        return self.api.post("/api/diagnose", json={"sid": sid, "side": side})

    def test_finds_where_a_known_pending_reservation_was_ignored(self):
        self.fake(reserve_all("S4", "M3"), tool("create_work_order", {"sector": "S4", "slot": "M3"}),
                  tool("send_notice", {"sector": "S4", "slot": "M3", "order_id": "OT-001"}),
                  tool("close_mission"), answer("Todo cerrado", "completed"))
        self.chat(faults=PENDING)
        r = self.diag().json()
        self.assertIn("dio la misión por cerrada", r["headline"])
        first = r["first_break"]
        self.assertEqual(first["tool"], "send_notice")
        self.assertRegex(first["step"], r"^T1\.S\d+$")
        kinds = {c["kind"] for c in first["causes"]}
        self.assertIn("ignorado", kinds)
        self.assertIn("PENDING", next(c for c in first["causes"] if c["kind"] == "ignorado")["believed"])
        self.assertEqual(r["breaks"][-1]["tool"], "close_mission")
        p = r["plain"]
        self.assertEqual(p["title"], "Dijo que había terminado, pero no era así.")
        self.assertEqual(p["story"][0]["text"], "Avisó a los vecinos del hospital aunque sabía que la cisterna seguía sin confirmar.")
        self.assertEqual(p["story"][-1]["text"], "Cerró el expediente sin volver a comprobar nada.")

    def test_explains_a_stale_belief_after_silent_cancellation(self):
        s = agent.new_session("good", None, CANCEL, sid="t1")
        s.world = build(CANCEL)
        rid = data._current(s.world, "S4", "water")["id"]
        s.journal["_observed"] = {"S4": {"water": {"id": rid, "slot": "M3", "status": "CONFIRMED", "src": "check_reservation", "at": "T0.S5"}}}
        server.SESSIONS[("t1", "good", agent.MODEL)] = s
        self.fake(tool("close_mission"), answer("Cerrado", "completed"))
        self.chat(faults=CANCEL)
        r = self.diag().json()
        cause = next(c for c in r["first_break"]["causes"] if c["kind"] == "creencia_obsoleta")
        self.assertIn("cancelado", cause["text"])
        self.assertIn("consulta al proveedor", cause["believed"])
        self.assertTrue(any("Cisterna de S4" in g for g in r["belief_gaps"]))
        self.assertIn("la cisterna del hospital (cancelada por el proveedor)", r["plain"]["gaps"])

    def test_vnext_interceptions_are_explained_without_breaks(self):
        self.fake(reserve_all("S4", "M3"), tool("send_notice", {"sector": "S4", "slot": "M3", "order_id": "OT-001"}),
                  answer("Pendiente", "pending"))
        self.chat(side="excellent", faults=PENDING, layers=ONLY("preconditions"))
        r = self.diag("excellent").json()
        self.assertEqual(r["breaks"], [])
        self.assertEqual(r["intercepted"][0]["tool"], "send_notice")
        self.assertEqual(r["intercepted"][0]["control"], "preconditions")
        self.assertEqual([x["kind"] for x in r["plain"]["story"]], ["held"])
        self.assertIn("vNext lo paró", r["plain"]["story"][0]["text"])

    def test_credits_who_detected_and_repaired_the_cancellation(self):
        s = agent.new_session("excellent", None, CANCEL, sid="t1")
        step = lambda name, outcome, actor="model", **kw: {"k": "tool", "name": name, "outcome": outcome, "actor": actor, **kw}
        s.turns = [{"turn": 1, "run_id": "r1", "status": "pending", "reply": "", "trace": [
            step("send_notice", "SENT", args={"sector": "S9"}, fault="supplier_cancel"),
            step("check_reservation", "CANCELLED", "harness", args={"reservation_id": "RES-S4-water-1"}),
            step("reserve_resource", "CONFIRMED", args={"sector": "S4", "resource": "water", "slot": "M3"})]}]
        event = diagnosis.analyze(s)["events"][0]
        self.assertEqual(event["followup"], "El proveedor canceló la cisterna del hospital. vNext lo descubrió al comprobar y el agente la volvió a reservar.")
        s.turns[0]["trace"] = s.turns[0]["trace"][:1]
        self.assertIn("el agente no se enteró", diagnosis.analyze(s)["events"][0]["followup"])

    def test_diagnosis_calls_no_model(self):
        fc = self.fake(tool("close_mission"), answer("Hecho", "completed"))
        self.chat(faults=NO_FAULTS)
        calls = len(fc.calls)
        r = self.diag()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(fc.calls), calls)
        self.assertEqual(r.json()["breaks"][0]["tool"], "close_mission")
        self.assertIn("Cerró el expediente", r.json()["summary"])

    def test_uses_the_session_of_the_requested_model(self):
        self.assertEqual(self.api.post("/api/diagnose", json={"sid": "t1", "side": "good", "model": "gpt-6.1-sol"}).status_code, 404)
