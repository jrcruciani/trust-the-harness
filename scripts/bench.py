"""Measure paired missions with the real model: same conditions, different harness.

    uv run python scripts/bench.py --runs 8 --parallel 4

Writes results/bench.json, which the interface shows as a previous measurement. Consumes real tokens.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import statistics
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DEMO_STATE_DIR", tempfile.mkdtemp(prefix="bench-"))
os.environ["DEMO_WARMUP"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

from app import agent, data, server  # noqa: E402

KINDS = [("premature notice", "sin los tres recursos"), ("duplicate order", "órdenes de trabajo"),
         ("duplicate notice", "avisos enviados"), ("premature closure", "Cierre prematuro")]


def kinds(row: dict) -> list[str]:
    text = " ".join(row["violations"])
    out = [k for k, needle in KINDS if needle in text]
    if not row["complete"] and not out:
        out.append("incomplete" if not row["closed"] else "closed without meeting requirements")
    return out


def one(api: TestClient, i: int, side: str, model: str, pressure: bool) -> dict:
    sid = f"bench-{i}"
    r = api.post("/api/chat", json={"sid": sid, "side": side, "model": model, "message": data.MISSION}).json()
    if "error" in r:
        return {"side": side, "model": model, "run": i, "error": r["error"][:200]}
    usage = dict(r["usage"])
    if pressure:
        r2 = api.post("/api/chat", json={"sid": sid, "side": side, "model": model, "message": data.PRESSURE}).json()
        if "error" not in r2:
            r = r2
            for k in ("charged_tokens", "model_calls", "tool_calls", "latency_ms", "cost_usd"):
                usage[k] += r2["usage"][k]
    a = r["assessment"]
    row = {"side": side, "model": model, "cost_usd": usage["cost_usd"], "run": i, "complete": a["complete"], "closed": a["closed"], "done": a["done"], "total": a["total"],
           "violations": a["violations"], "status": r["status"], "tokens": usage["charged_tokens"],
           "model_calls": usage["model_calls"], "tool_calls": usage["tool_calls"], "latency_ms": usage["latency_ms"],
           "harness_blocks": sum(1 for st in r["trace"] if st["k"] == "nudge" and st["checks"][0]["status"] in ("block", "flag"))}
    row["failure"] = kinds(row)
    return row


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--runs", type=int, default=6)
    p.add_argument("--parallel", type=int, default=4)
    p.add_argument("--pressure", action="store_true", help="add the shift manager's pressure turn")
    p.add_argument("--models", default=",".join(agent.MODELS), help="comma-separated models")
    p.add_argument("--out", default=str(ROOT / "results" / "bench.json"))
    args = p.parse_args()
    api = TestClient(server.app)
    models = args.models.split(",")
    combos = [(side, m) for side in ("good", "excellent") for m in models]
    jobs = [(i, side, m) for i in range(args.runs) for side, m in combos]
    rows = []
    with cf.ThreadPoolExecutor(args.parallel) as ex:
        for row in ex.map(lambda j: one(api, j[0], j[1], j[2], args.pressure), jobs):
            rows.append(row)
            print(row["side"].ljust(9), row["model"].ljust(13), "OK" if row.get("complete") else "KO", f'{row.get("done")}/{row.get("total")}',
                  row.get("failure") or row.get("error", ""), f'calls={row.get("model_calls")}/{row.get("tool_calls")}',
                  f'blocks={row.get("harness_blocks")}', f'{row.get("latency_ms", 0) / 1000:.0f}s', flush=True)
    summary = {}
    for side, model in combos:
        mine = [r for r in rows if r["side"] == side and r["model"] == model]
        ok = [r for r in mine if "error" not in r]
        summary[f"{side}|{model}"] = {
            "side": side, "model": model, "runs": len(ok), "errors": len(mine) - len(ok),
            "complete": sum(r["complete"] for r in ok),
            "failures": Counter(k for r in ok for k in r["failure"]).most_common(),
            "median_tokens": int(statistics.median([r["tokens"] for r in ok])) if ok else 0,
            "median_seconds": round(statistics.median([r["latency_ms"] for r in ok]) / 1000, 1) if ok else 0,
            "median_cost_usd": round(statistics.median([r["cost_usd"] for r in ok]), 4) if ok else 0,
        }
    out = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "models": {m: agent.MODELS[m]["label"] for m in models},
           "pressure": args.pressure, "runs_per_profile": args.runs, "faults": data.DEFAULT_FAULTS,
           "prompt_hash": data.digest(agent.PROMPT), "tool_hash": data.digest(data.TOOLS), "code_hash": agent.CODE_HASH,
           "summary": summary, "runs": rows,
           "note": "Paired missions with the same model, prompt, tools, faults, and limits. "
                   "Small sample: indicates a trend, not a certified reliability rate."}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
