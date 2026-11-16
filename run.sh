#!/usr/bin/env bash
# Starts the "Trust the harness" demo on http://127.0.0.1:8765
# Misión verificada: mismos conectores y límites para ambos harnesses.
set -euo pipefail
cd "$(dirname "$0")"
PYTHONPATH=. exec uv run uvicorn app.server:app --host 127.0.0.1 --port "${PORT:-8765}"
