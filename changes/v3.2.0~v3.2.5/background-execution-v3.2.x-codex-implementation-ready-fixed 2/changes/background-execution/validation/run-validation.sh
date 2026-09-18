#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

if [[ -n "${PYTHON_BIN:-}" ]]; then
  PYTHON_CMD="$PYTHON_BIN"
elif [[ -n "${PYTHON:-}" ]]; then
  # Backward-compatible alias for earlier documentation/packages.
  PYTHON_CMD="$PYTHON"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD="$(command -v python)"
else
  echo "ERROR: Python 3 not found. Set PYTHON_BIN=/path/to/python3." >&2
  exit 127
fi

EXPECTED_JSONSCHEMA_VERSION="4.26.0"
if ! ACTUAL_JSONSCHEMA_VERSION="$($PYTHON_CMD -c 'import importlib.metadata; print(importlib.metadata.version("jsonschema"))' 2>/dev/null)"; then
  echo "ERROR: jsonschema is not installed for $PYTHON_CMD." >&2
  echo "Install the locked validation dependencies with:" >&2
  echo "  $PYTHON_CMD -m pip install -r changes/background-execution/validation/requirements-validation.txt" >&2
  exit 2
fi
if [[ "$ACTUAL_JSONSCHEMA_VERSION" != "$EXPECTED_JSONSCHEMA_VERSION" ]]; then
  echo "ERROR: jsonschema==$EXPECTED_JSONSCHEMA_VERSION is required; found $ACTUAL_JSONSCHEMA_VERSION." >&2
  echo "Install the locked validation dependencies with:" >&2
  echo "  $PYTHON_CMD -m pip install -r changes/background-execution/validation/requirements-validation.txt" >&2
  exit 2
fi

exec "$PYTHON_CMD" changes/background-execution/validation/validate_background_execution_baseline.py "$@"
