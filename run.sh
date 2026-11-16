#!/usr/bin/env bash
# Starts the "Trust the harness" demo on http://127.0.0.1:8765
# Verified mission: the same connectors and limits for both harnesses.
set -euo pipefail
cd "$(dirname "$0")"
PYTHONPATH=. exec uv run uvicorn app.server:app --host 127.0.0.1 --port "${PORT:-8765}"
