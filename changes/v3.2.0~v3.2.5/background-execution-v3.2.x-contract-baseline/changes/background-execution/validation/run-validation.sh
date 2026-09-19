#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REPOSITORY_ROOT="$(cd "$ROOT/../.." && pwd)"
cd "$ROOT"
export PYTHONDONTWRITEBYTECODE=1

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

EXPECTED_ESPREE_VERSION="10.4.0"
if ! command -v node >/dev/null 2>&1; then
  echo '{"status":"FAIL","failure":{"code":"VALIDATION_ESPREE_DEPENDENCY_INVALID"}}'
  echo "ERROR: Node.js is required to load the locked Espree parser." >&2
  exit 2
fi
if [[ -n "${BACKGROUND_EXECUTION_ESPREE_PATH:-}" ]]; then
  ESPREE_CANDIDATE="$BACKGROUND_EXECUTION_ESPREE_PATH"
  ESPREE_RESOLUTION_MODE="explicit-module-path"
else
  ESPREE_CANDIDATE="$REPOSITORY_ROOT/node_modules/espree/dist/espree.cjs"
  ESPREE_RESOLUTION_MODE="repository-node-modules"
fi
if ! ESPREE_METADATA="$(NODE_PATH="" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  try {
    const modulePath = fs.realpathSync(path.resolve(process.argv[1]));
    const packageJsonPath = fs.realpathSync(require.resolve("espree/package.json", {
      paths: [path.dirname(modulePath)]
    }));
    const packageRoot = path.dirname(packageJsonPath);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const parser = require(modulePath);
    const relativeModule = path.relative(packageRoot, modulePath);
    if (relativeModule === ".." || relativeModule.startsWith(`..${path.sep}`)) throw new Error();
    if (packageJson.version !== process.argv[2] || typeof parser.parse !== "function") throw new Error();
    if (process.argv[4] === "repository-node-modules") {
      const expectedRoot = fs.realpathSync(path.join(process.argv[3], "node_modules/espree"));
      if (packageRoot !== expectedRoot) throw new Error();
    }
    process.stdout.write(`${packageJson.version}\t${modulePath}`);
  } catch (_error) {
    process.stderr.write("VALIDATION_ESPREE_DEPENDENCY_INVALID\n");
    process.exitCode = 2;
  }
' "$ESPREE_CANDIDATE" "$EXPECTED_ESPREE_VERSION" "$REPOSITORY_ROOT" "$ESPREE_RESOLUTION_MODE")"; then
  echo '{"status":"FAIL","failure":{"code":"VALIDATION_ESPREE_DEPENDENCY_INVALID"}}'
  echo "ERROR: espree==$EXPECTED_ESPREE_VERSION could not be resolved from the declared parser path." >&2
  exit 2
fi
IFS=$'\t' read -r ACTUAL_ESPREE_VERSION RESOLVED_ESPREE_PATH <<< "$ESPREE_METADATA"
if [[ "$ACTUAL_ESPREE_VERSION" != "$EXPECTED_ESPREE_VERSION" || -z "$RESOLVED_ESPREE_PATH" ]]; then
  echo '{"status":"FAIL","failure":{"code":"VALIDATION_ESPREE_DEPENDENCY_INVALID"}}'
  echo "ERROR: espree==$EXPECTED_ESPREE_VERSION is required." >&2
  exit 2
fi
export BACKGROUND_EXECUTION_ESPREE_PATH="$RESOLVED_ESPREE_PATH"
export BACKGROUND_EXECUTION_ESPREE_RESOLUTION_MODE="$ESPREE_RESOLUTION_MODE"

AUTHORITY_SOURCE_DECLARED=false
for ARG in "$@"; do
  case "$ARG" in
    --authority-mode|--authority-mode=*|--previous-authority|--previous-authority=*)
      AUTHORITY_SOURCE_DECLARED=true
      ;;
  esac
done

if [[ "$AUTHORITY_SOURCE_DECLARED" == false ]]; then
  exec "$PYTHON_CMD" changes/background-execution/validation/validate_background_execution_baseline.py --authority-mode repo "$@"
fi

exec "$PYTHON_CMD" changes/background-execution/validation/validate_background_execution_baseline.py "$@"
