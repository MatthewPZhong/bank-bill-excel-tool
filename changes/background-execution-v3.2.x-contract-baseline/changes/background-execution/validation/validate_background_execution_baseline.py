#!/usr/bin/env python3
"""Reproducible contract validation for the v3.2.x background-execution baseline."""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.metadata
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import tempfile
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from jsonschema import Draft202012Validator, FormatChecker

HERE = Path(__file__).resolve().parent
CONTRACT_DIR = HERE.parent
PACKAGE_ROOT = CONTRACT_DIR.parent.parent
REPORT_PATH = PACKAGE_ROOT / "validation-report.json"
REPORT_VERSION = 17
FIXTURE_DIR = HERE / "fixtures"
POLICY_SCHEMA_PATH = CONTRACT_DIR / "platform-contract-v1.schema.json"
PROTOCOL_SCHEMA_PATH = CONTRACT_DIR / "platform-protocol-v1.schema.json"
RECOVERY_SOURCE_SCHEMA_PATH = CONTRACT_DIR / "platform-recovery-source-v1.schema.json"
RECOVERY_CONTROL_SCHEMA_PATH = CONTRACT_DIR / "platform-recovery-control-v1.schema.json"
CONTRACT_AUTHORITY_PATH = CONTRACT_DIR / "recovery-contract-authority.v1.json"
REGISTRY_FIXTURE_PATH = FIXTURE_DIR / "valid" / "policy-registry.v3.2.x.json"
STATIC_KEYS_PATH = FIXTURE_DIR / "valid" / "static-key-manifest.v3.2.x.json"
ACTION_MANIFEST_PATH = FIXTURE_DIR / "valid" / "action-manifest.v3.2.x.json"
VALID_PROTOCOL_PATH = FIXTURE_DIR / "valid" / "protocol-messages.v1.json"
VALID_PROTOCOL_SEQUENCE_PATH = FIXTURE_DIR / "valid" / "protocol-sequences.v1.json"
INVALID_PROTOCOL_SEQUENCE_PATH = FIXTURE_DIR / "invalid" / "protocol-sequences.invalid.v1.json"
VALID_RECOVERY_SOURCE_PATH = FIXTURE_DIR / "valid" / "recovery-sources.v1.json"
INVALID_RECOVERY_SOURCE_PATH = FIXTURE_DIR / "invalid" / "recovery-sources.invalid.v1.json"
VALID_RECOVERY_RESULT_PATH = FIXTURE_DIR / "valid" / "recovery-results.v1.json"
INVALID_RECOVERY_RESULT_PATH = FIXTURE_DIR / "invalid" / "recovery-results.invalid.v1.json"
VALID_RECOVERY_CONTROL_PATH = FIXTURE_DIR / "valid" / "recovery-control-requests.v1.json"
INVALID_RECOVERY_CONTROL_PATH = FIXTURE_DIR / "invalid" / "recovery-control-requests.invalid.v1.json"
JCS_VECTOR_PATH = FIXTURE_DIR / "valid" / "canonical-json-jcs-v1.json"
JCS_SCRIPT_PATH = HERE / "canonicalize-jcs.js"
REPOSITORY_ROOT = PACKAGE_ROOT.parent.parent
CONTRACT_AUTHORITY_REPOSITORY_PATH = str(CONTRACT_AUTHORITY_PATH.relative_to(REPOSITORY_ROOT))
TASK_POLICY_SOURCE_PATH = REPOSITORY_ROOT / "src/main-process/archive-center/task-policy-registry.js"
ACTION_BINDING_SOURCE_PATH = (
    REPOSITORY_ROOT
    / "src/main-process/background-execution/action-task-binding-registry.js"
)
ACTION_CALL_SITE_SOURCE_PATH = REPOSITORY_ROOT / "src/main.js"
CODEX_SPEC_PATH = PACKAGE_ROOT / "CODEX-SPEC.md"
CODEX_TECHDOC_PATH = PACKAGE_ROOT / "CODEX-TECHDOC.md"
PLATFORM_CONTRACT_PATH = CONTRACT_DIR / "platform-contract-v1.md"
E00_TECHDOC_PATH = CONTRACT_DIR / "E00-platform-contract-v1-techdoc.md"
E00_SPEC_PATH = CONTRACT_DIR / "E00-platform-contract-v1-spec.md"
LIFECYCLE_MAPPING_PATH = CONTRACT_DIR / "platform-lifecycle-mapping.md"
CODEX_READY_MANIFEST_PATH = PACKAGE_ROOT / "codex-ready-revision-manifest.json"
PACKAGE_README_PATH = PACKAGE_ROOT / "README.md"
VALIDATION_README_PATH = HERE / "README.md"
EXPECTED_JSONSCHEMA_VERSION = "4.26.0"
EXPECTED_ESPREE_VERSION = "10.4.0"
ESPREE_PATH_ENV = "BACKGROUND_EXECUTION_ESPREE_PATH"
ESPREE_RESOLUTION_MODE_ENV = "BACKGROUND_EXECUTION_ESPREE_RESOLUTION_MODE"
GIT_CLEAN_ENVIRONMENT_POLICY = {
    "ambientGitVariables": "remove-all-GIT_*",
    "gitNoReplaceObjects": "1",
    "systemConfig": "disabled",
    "globalConfig": "os.devnull",
    "terminalPrompt": "disabled",
}
CANONICAL_SHA256_PATTERN = "^[0-9a-f]{64}$"
EXPECTED_RECOVERY_LEAF_COUNTS = {
    "task-mark-interrupted": 17,
    "task-begin-recovery": 16,
    "task-complete-recovery-success": 16,
    "task-complete-recovery-failure": 18,
    "task-interrupt-recovery": 18,
    "batch-mark-interrupted": 17,
    "batch-begin-recovery": 16,
    "batch-resolve-success": 17,
    "batch-resolve-failure": 17,
    "intent-create-prepared": 19,
    "intent-mark-acked": 10,
    "intent-mark-committed": 10,
    "intent-mark-recovered": 10,
    "intent-close": 10,
    "hold-create-or-get": 19,
    "hold-resolve": 11,
    "inspection-completed-all-lineage-present": 16,
    "inspection-failed-transient-minimal-lineage": 12,
    "settlement-resumed": 13,
    "settlement-failed-transient": 13,
}
EXPECTED_RECOVERY_LEAF_TOTAL = 295
EXPECTED_REQUEST_KEY_BRANCHES = {
    "task-mark-interrupted": (
        "transitionWithRecoveryEvent",
        "recovery-control/v1/transition/task-run/mark-interrupted",
        ["/transition/actionKey", "/transition/expectedTaskKey", "/transition/operationKey", "/transition/taskRunId", "/transition/sourceKind", "/transition/sourceRef"],
    ),
    "task-begin-recovery": (
        "transitionWithRecoveryEvent",
        "recovery-control/v1/transition/task-run/begin-recovery",
        ["/transition/actionKey", "/transition/expectedTaskKey", "/transition/operationKey", "/transition/taskRunId", "/transition/sourceKind", "/transition/sourceRef", "/transition/recoveryAttemptId"],
    ),
    "task-complete-recovery-success": (
        "transitionWithRecoveryEvent",
        "recovery-control/v1/transition/task-run/complete-recovery-success",
        ["/transition/actionKey", "/transition/expectedTaskKey", "/transition/operationKey", "/transition/taskRunId", "/transition/sourceKind", "/transition/sourceRef", "/transition/recoveryAttemptId"],
    ),
    "task-complete-recovery-failure": (
        "transitionWithRecoveryEvent",
        "recovery-control/v1/transition/task-run/complete-recovery-failure",
        ["/transition/actionKey", "/transition/expectedTaskKey", "/transition/operationKey", "/transition/taskRunId", "/transition/sourceKind", "/transition/sourceRef", "/transition/recoveryAttemptId"],
    ),
    "task-interrupt-recovery": (
        "transitionWithRecoveryEvent",
        "recovery-control/v1/transition/task-run/interrupt-recovery",
        ["/transition/actionKey", "/transition/expectedTaskKey", "/transition/operationKey", "/transition/taskRunId", "/transition/sourceKind", "/transition/sourceRef", "/transition/recoveryAttemptId"],
    ),
    "batch-mark-interrupted": (
        "transitionWithRecoveryEvent",
        "recovery-control/v1/transition/batch-overlay/mark-interrupted",
        ["/transition/actionKey", "/transition/expectedTaskKey", "/transition/operationKey", "/transition/batchId", "/transition/taskRunId", "/transition/sourceKind", "/transition/sourceRef"],
    ),
    "batch-begin-recovery": (
        "transitionWithRecoveryEvent",
        "recovery-control/v1/transition/batch-overlay/begin-recovery",
        ["/transition/actionKey", "/transition/expectedTaskKey", "/transition/operationKey", "/transition/batchId", "/transition/taskRunId", "/transition/sourceKind", "/transition/sourceRef", "/transition/recoveryAttemptId"],
    ),
    "batch-resolve-success": (
        "transitionWithRecoveryEvent",
        "recovery-control/v1/transition/batch-overlay/resolve-success",
        ["/transition/actionKey", "/transition/expectedTaskKey", "/transition/operationKey", "/transition/batchId", "/transition/taskRunId", "/transition/sourceKind", "/transition/sourceRef", "/transition/recoveryAttemptId"],
    ),
    "batch-resolve-failure": (
        "transitionWithRecoveryEvent",
        "recovery-control/v1/transition/batch-overlay/resolve-failure",
        ["/transition/actionKey", "/transition/expectedTaskKey", "/transition/operationKey", "/transition/batchId", "/transition/taskRunId", "/transition/sourceKind", "/transition/sourceRef", "/transition/recoveryAttemptId"],
    ),
    "intent-create-prepared": ("transitionWithRecoveryEvent", "recovery-control/v1/transition/critical-intent/create-prepared", ["/transition/input/intentId"]),
    "intent-mark-acked": ("transitionWithRecoveryEvent", "recovery-control/v1/transition/critical-intent/mark-acked", ["/transition/intentId"]),
    "intent-mark-committed": ("transitionWithRecoveryEvent", "recovery-control/v1/transition/critical-intent/mark-committed", ["/transition/intentId"]),
    "intent-mark-recovered": ("transitionWithRecoveryEvent", "recovery-control/v1/transition/critical-intent/mark-recovered", ["/transition/intentId"]),
    "intent-close": ("transitionWithRecoveryEvent", "recovery-control/v1/transition/critical-intent/close", ["/transition/intentId"]),
    "hold-create-or-get": ("transitionWithRecoveryEvent", "recovery-control/v1/transition/recovery-hold/create-or-get", ["/transition/input/sourceKind", "/transition/input/sourceRef"]),
    "hold-resolve": ("transitionWithRecoveryEvent", "recovery-control/v1/transition/recovery-hold/resolve", ["/transition/holdId"]),
    "inspection-completed-all-lineage-present": (
        "appendObservationEvent",
        "recovery-control/v1/observation/inspection-completed",
        ["/event/actionKey", "/event/operationKey", "/event/taskRunId", "/event/sourceKind", "/event/sourceRef", "/event/observationAttemptId", "/event/batchId", "/event/intentId", "/event/holdId", "/event/recoveryAttemptId"],
    ),
    "inspection-failed-transient-minimal-lineage": (
        "appendObservationEvent",
        "recovery-control/v1/observation/inspection-failed-transient",
        ["/event/actionKey", "/event/operationKey", "/event/taskRunId", "/event/sourceKind", "/event/sourceRef", "/event/observationAttemptId", "/event/batchId", "/event/intentId", "/event/holdId", "/event/recoveryAttemptId"],
    ),
    "settlement-resumed": (
        "appendObservationEvent",
        "recovery-control/v1/observation/settlement-resumed",
        ["/event/actionKey", "/event/operationKey", "/event/taskRunId", "/event/sourceKind", "/event/sourceRef", "/event/observationAttemptId", "/event/batchId", "/event/intentId", "/event/holdId", "/event/recoveryAttemptId"],
    ),
    "settlement-failed-transient": (
        "appendObservationEvent",
        "recovery-control/v1/observation/settlement-failed-transient",
        ["/event/actionKey", "/event/operationKey", "/event/taskRunId", "/event/sourceKind", "/event/sourceRef", "/event/observationAttemptId", "/event/batchId", "/event/intentId", "/event/holdId", "/event/recoveryAttemptId"],
    ),
}
EXPECTED_PHYSICAL_SQL_HASHES = {
    "identity-join": "96c5b723b09ecd991c57bde208be10a82a21f7f6f2a240686726bda60e6663d4",
    "task-cas": "bc2c9cf3e603ac5d71347feadae54b33c9d43a2cb1d4359ded6a6ced966b3012",
    "batch-cas": "b3d826a951a6ef90339aa06b3369ca46508561445eb65c776fc33bdbb2cef01c",
    "overlay-cas": "87369c634a5e590ae1c185303680092a55fa75d769d817bf06a65c3dc602b514",
    "immutable-result": "25d9be11e12f0c98b539c3e98f8b0a206f66013155c60a2e6ec5965b1c116ff2",
}
EXPECTED_PHYSICAL_MAPPING_SENTENCE = (
    "PHYSICAL_BATCH_IDENTITY_V1: logical `batchId` maps exactly to column `id` of table "
    "`archive_batches`; `overlay.batch_id` names only the child foreign key in "
    "`background_execution_batch_recovery_states` and references that parent `id`."
)
PLATFORM_PROTOCOL_MAX_BYTES = 262144
JOB_OPERATIONS = {
    "job:start", "unit:start", "job:cancel", "unit:cancel",
    "critical:ack", "critical:reject", "job:progress", "unit:progress",
    "unit:done", "unit:error", "critical:ready", "commit:receipt",
    "job:done", "job:error", "cancel:ack",
}
JOB_PAYLOAD_WRAPPERS = {
    "job:start": "input", "unit:start": "input",
    "job:cancel": "cancel", "unit:cancel": "cancel",
    "critical:ack": "critical", "critical:reject": "critical",
    "job:progress": "progress", "unit:progress": "progress",
    "unit:done": "result", "unit:error": "error",
    "critical:ready": "critical", "commit:receipt": "receipt",
    "job:done": "result", "job:error": "error", "cancel:ack": "cancellation",
}
EXECUTION_TERMINAL_SOURCES = [
    "job:done", "job:error", "init-timeout", "execution-timeout",
    "cancel-timeout", "adapter-error", "spawn-error", "unexpected-exit",
    "protocol-error",
]
CANONICAL_SERVICE_DIRECTION_SEQ = (
    "Service reply 的 `seq` 属于发送方自身 direction 的独立 tracker，必须取该 direction 的 "
    "`last + 1`；不得复制或要求等于对向 request/event 的 `seq`。exchange 仅用 "
    "`controlId/requestId/grantId/reservationId` 关联。"
)

CANONICAL_DISPOSITIONS = {"managed", "legacy-preserved", "inline-excluded", "blocked"}
CANONICAL_MODES = {"inline-async", "thread-single", "thread-pool", "utility-process"}
CANONICAL_LIFETIMES = {"job", "service"}
CANONICAL_ADAPTERS = {"native", "existing-dispatch"}
CANONICAL_COMMITS = {"none", "main-settlement", "worker-durable", "existing-critical-protocol"}
FORBIDDEN_COMPOSITES = {
    "managed capability",
    "blocked → managed",
    "native或existing-dispatch",
    "native 或 existing-dispatch",
    "模块现有映射",
    "job/service",
    "thread-single / job 或 pool=1",
}

CANONICAL_RECOVERY_ATOMICITY = (
    "TaskRun 的恢复相关状态迁移，以及 Batch overlay、Recovery Hold、Critical Intent 的每次状态迁移，"
    "与对应 append-only recovery event **必须在同一个 Main-owned control DB transaction 内提交**。"
)
CANONICAL_OBSERVATION_EVENT_CONTRACT = (
    "无状态迁移的 `inspection-completed / inspection-failed-transient / settlement-resumed / "
    "settlement-failed-transient` "
    "只能通过同一事务作用域内的 `RecoveryControlTransactionV1.appendObservationEvent()` 追加；"
    "该方法不得修改任何控制状态，写入事件的 `previous_state / next_state` 必须均为 `NULL`。"
)
CANONICAL_MULTI_OBJECT_TRANSACTION = (
    "一次恢复动作更新多个控制对象时，Main 必须只调用一次 "
    "`RecoveryControlRepository.runInControlTransaction()`，并在同一个 "
    "`RecoveryControlTransactionV1` 上完成全部 transition 与 observation event；"
    "事务作用域内方法不得独立 BEGIN、COMMIT 或 ROLLBACK。"
)
OBSERVATION_EVENT_TYPES = {
    "inspection-completed",
    "inspection-failed-transient",
    "settlement-resumed",
    "settlement-failed-transient",
}
TASK_RECOVERY_COMMANDS = {
    "mark-interrupted",
    "begin-recovery",
    "complete-recovery-success",
    "complete-recovery-failure",
    "interrupt-recovery",
}
BATCH_RECOVERY_COMMANDS = {
    "mark-interrupted",
    "begin-recovery",
    "resolve-success",
    "resolve-failure",
}
CRITICAL_INTENT_COMMANDS = {
    "create-prepared",
    "mark-acked",
    "mark-committed",
    "mark-recovered",
    "close",
}
RECOVERY_HOLD_COMMANDS = {"create-or-get", "resolve"}
TRANSITION_EVENT_MAP_V1 = {
    "task-run.mark-interrupted": "interrupted-recorded",
    "task-run.begin-recovery": "recovery-started",
    "task-run.complete-recovery-success": "recovery-succeeded",
    "task-run.complete-recovery-failure": "recovery-failed",
    "task-run.interrupt-recovery": "recovery-interrupted",
    "batch-overlay.mark-interrupted": "batch-overlay-transitioned",
    "batch-overlay.begin-recovery": "batch-overlay-transitioned",
    "batch-overlay.resolve-success": "batch-overlay-transitioned",
    "batch-overlay.resolve-failure": "batch-overlay-transitioned",
    "critical-intent.create-prepared": "critical-intent-transitioned",
    "critical-intent.mark-acked": "critical-intent-transitioned",
    "critical-intent.mark-committed": "critical-intent-transitioned",
    "critical-intent.mark-recovered": "critical-intent-transitioned",
    "critical-intent.close": "critical-intent-transitioned",
    "recovery-hold.create-or-get": "hold-created",
    "recovery-hold.resolve": "hold-resolved",
}
LIFECYCLE_RECOVERY_EVENT_TYPES = {
    "interrupted-recorded",
    "inspection-completed",
    "inspection-failed-transient",
    "recovery-started",
    "settlement-resumed",
    "settlement-failed-transient",
    "recovery-succeeded",
    "recovery-failed",
    "recovery-interrupted",
    "batch-overlay-transitioned",
    "critical-intent-transitioned",
    "hold-created",
    "hold-resolved",
}
FROZEN_JCS_KAT_SHA256 = {
    "utf16-property-order-u10000-before-ue000": "54e85161e2d6b6cf9d28fe69dc97632a62f8b83e650fe54959e2f504f3dd5d41",
    "ecmascript-number-rendering": "4ea6ff4641234964079ea48a4720ae174cb391a03567b3775842cd524635190a",
    "ecmascript-string-escaping": "5552ef611529b828d90a14552f1b25a48fcfa66e6c67c022e87b8b4079cf387e",
    "transition-full-envelope": "788e3b7c8b8434a9cdc76b732424642795621764d6cfd288facc26b1d435ddaf",
    "observation-full-envelope": "428aeb87263bdd86dff2c5c225a7f57822f64b5744a6f72eecf34c68a19eed9d",
}

RESULT_PROJECTION_FIELDS = [
    "contractVersion", "requestKey", "writer", "eventId", "requestHash",
    "actionKey", "operationKey", "taskRunId", "sourceKind", "sourceRef",
    "batchId", "intentId", "holdId", "recoveryAttemptId",
    "observationAttemptId", "eventType", "previousState", "nextState",
    "safePayload", "createdAt",
]


@dataclass
class CheckResult:
    name: str
    passed: bool
    details: dict[str, Any]


class MachineJsonContractError(ValueError):
    """Stable fail-closed boundary for every machine-readable JSON input."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def duplicate_rejecting_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise MachineJsonContractError(
                "MACHINE_JSON_DUPLICATE_KEY",
                "machine JSON contains a duplicate object key",
            )
        value[key] = item
    return value


def parse_machine_json(text: str) -> Any:
    try:
        return json.loads(text, object_pairs_hook=duplicate_rejecting_object)
    except MachineJsonContractError:
        raise
    except json.JSONDecodeError as exc:
        raise MachineJsonContractError(
            "MACHINE_JSON_SYNTAX_INVALID",
            "machine JSON syntax is invalid",
        ) from exc


def load_json(path: Path) -> Any:
    return parse_machine_json(path.read_text(encoding="utf-8"))


_ESPREE_DEPENDENCY_CACHE: dict[str, Any] | None = None


def resolve_espree_dependency() -> dict[str, Any]:
    """Resolve one explicit Espree parser and reject ambient NODE_PATH drift."""
    global _ESPREE_DEPENDENCY_CACHE
    if _ESPREE_DEPENDENCY_CACHE is not None:
        return copy.deepcopy(_ESPREE_DEPENDENCY_CACHE)

    explicit_path = os.environ.get(ESPREE_PATH_ENV)
    requested_path = Path(explicit_path) if explicit_path else (
        REPOSITORY_ROOT / "node_modules/espree/dist/espree.cjs"
    )
    declared_mode = os.environ.get(ESPREE_RESOLUTION_MODE_ENV)
    resolution_mode = declared_mode or (
        "explicit-module-path" if explicit_path else "repository-node-modules"
    )
    if resolution_mode not in {"explicit-module-path", "repository-node-modules"}:
        raise MachineJsonContractError(
            "VALIDATION_ESPREE_DEPENDENCY_INVALID",
            "locked Espree resolution mode is invalid",
        )
    node_program = r"""
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const requested = path.resolve(process.argv[1]);
const expectedVersion = process.argv[2];
const repositoryRoot = fs.realpathSync(process.argv[3]);
const resolutionMode = process.argv[4];
try {
  const modulePath = fs.realpathSync(requested);
  const packageJsonPath = fs.realpathSync(require.resolve(
    'espree/package.json',
    { paths: [path.dirname(modulePath)] }
  ));
  const packageRoot = path.dirname(packageJsonPath);
  const relativeModule = path.relative(packageRoot, modulePath);
  if (relativeModule === '..' || relativeModule.startsWith(`..${path.sep}`)) {
    throw new Error('module is outside resolved Espree package');
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const parser = require(modulePath);
  if (packageJson.version !== expectedVersion || typeof parser.parse !== 'function') {
    throw new Error('Espree version/API mismatch');
  }
  if (resolutionMode === 'repository-node-modules') {
    const expectedRoot = fs.realpathSync(path.join(repositoryRoot, 'node_modules/espree'));
    if (packageRoot !== expectedRoot) {
      throw new Error('default Espree did not resolve from repository node_modules');
    }
  }
  process.stdout.write(JSON.stringify({
    version: packageJson.version,
    modulePath,
    packageJsonPath,
    resolutionMode
  }));
} catch (_error) {
  process.stderr.write('VALIDATION_ESPREE_DEPENDENCY_INVALID\n');
  process.exitCode = 2;
}
"""
    try:
        completed = subprocess.run(
            [
                "node", "-e", node_program, str(requested_path),
                EXPECTED_ESPREE_VERSION, str(REPOSITORY_ROOT), resolution_mode,
            ],
            text=True,
            capture_output=True,
            check=False,
            env={**os.environ, "NODE_PATH": ""},
        )
    except OSError as exc:
        raise MachineJsonContractError(
            "VALIDATION_ESPREE_DEPENDENCY_INVALID",
            "locked Espree parser is unavailable",
        ) from exc
    if completed.returncode != 0:
        raise MachineJsonContractError(
            "VALIDATION_ESPREE_DEPENDENCY_INVALID",
            "locked Espree parser is unavailable or invalid",
        )
    try:
        payload = parse_machine_json(completed.stdout)
    except MachineJsonContractError as exc:
        raise MachineJsonContractError(
            "VALIDATION_ESPREE_DEPENDENCY_INVALID",
            "locked Espree preflight returned invalid metadata",
        ) from exc
    if (
        not isinstance(payload, dict)
        or set(payload) != {"version", "modulePath", "packageJsonPath", "resolutionMode"}
        or payload.get("version") != EXPECTED_ESPREE_VERSION
        or payload.get("resolutionMode") != resolution_mode
    ):
        raise MachineJsonContractError(
            "VALIDATION_ESPREE_DEPENDENCY_INVALID",
            "locked Espree preflight metadata drifted",
        )
    module_path = Path(str(payload["modulePath"])).resolve()
    try:
        report_path = str(module_path.relative_to(REPOSITORY_ROOT.resolve()))
    except ValueError:
        report_path = str(module_path)
    _ESPREE_DEPENDENCY_CACHE = {
        **payload,
        "modulePath": str(module_path),
        "reportPath": report_path,
        "expectedVersion": EXPECTED_ESPREE_VERSION,
    }
    return copy.deepcopy(_ESPREE_DEPENDENCY_CACHE)


def clean_git_environment(source: dict[str, str] | None = None) -> dict[str, str]:
    """Remove every ambient Git control before adding the validator-owned policy."""
    inherited = os.environ if source is None else source
    environment = {
        key: value for key, value in inherited.items() if not key.startswith("GIT_")
    }
    environment.update({
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
    })
    return environment


def run_git(
    repository_root: Path,
    arguments: Iterable[str],
    *,
    text: bool = False,
) -> subprocess.CompletedProcess[Any]:
    """Run every Git command against one explicit root and one clean environment."""
    try:
        root = repository_root.resolve(strict=True)
        return subprocess.run(
            ["git", *arguments],
            cwd=root,
            text=text,
            capture_output=True,
            check=False,
            env=clean_git_environment(),
        )
    except (OSError, RuntimeError) as exc:
        raise MachineJsonContractError(
            "AUTHORITY_GIT_SUBPROCESS_UNAVAILABLE",
            "unable to execute the authority Git resolver",
        ) from exc


def nearest_physical_git_marker(repository_root: Path) -> tuple[Path, Path] | None:
    root = repository_root.resolve(strict=True)
    for candidate in (root, *root.parents):
        marker = candidate / ".git"
        if marker.exists() or marker.is_symlink():
            return candidate, marker
    return None


def read_single_physical_line(path: Path, label: str) -> str:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            f"unable to read physical Git {label}",
        ) from exc
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            f"physical Git {label} is not UTF-8",
        ) from exc
    lines = text.splitlines()
    if len(lines) != 1 or not lines[0]:
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            f"physical Git {label} must contain one non-empty line",
        )
    return lines[0]


def physical_git_directories(repository_root: Path) -> tuple[Path, Path]:
    root = repository_root.resolve(strict=True)
    marker = root / ".git"
    if marker.is_symlink():
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            "physical Git marker must not be a symlink",
        )
    if marker.is_dir():
        git_dir = marker.resolve(strict=True)
    elif marker.is_file():
        marker_line = read_single_physical_line(marker, "worktree marker")
        prefix = "gitdir: "
        if not marker_line.startswith(prefix) or not marker_line[len(prefix):]:
            raise MachineJsonContractError(
                "AUTHORITY_MERGE_BASE_UNAVAILABLE",
                "physical Git worktree marker is invalid",
            )
        raw_git_dir = Path(marker_line[len(prefix):])
        git_dir = (
            raw_git_dir if raw_git_dir.is_absolute() else root / raw_git_dir
        ).resolve(strict=True)
    else:
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            "physical Git marker is unavailable",
        )
    if not git_dir.is_dir():
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            "physical Git directory is unavailable",
        )
    common_marker = git_dir / "commondir"
    if common_marker.is_symlink():
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            "physical Git common-dir marker must not be a symlink",
        )
    if common_marker.is_file():
        raw_common_dir = Path(read_single_physical_line(common_marker, "common-dir marker"))
        common_dir = (
            raw_common_dir if raw_common_dir.is_absolute() else git_dir / raw_common_dir
        ).resolve(strict=True)
    else:
        common_dir = git_dir
    if not common_dir.is_dir():
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            "physical Git common directory is unavailable",
        )
    return git_dir, common_dir


def physical_git_head_oid(git_dir: Path, common_dir: Path) -> str:
    head = read_single_physical_line(git_dir / "HEAD", "HEAD")
    oid_pattern = r"[0-9a-f]{40}|[0-9a-f]{64}"
    if re.fullmatch(oid_pattern, head):
        return head
    prefix = "ref: "
    if not head.startswith(prefix):
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            "physical Git HEAD identity is invalid",
        )
    ref_name = head[len(prefix):]
    ref_parts = ref_name.split("/")
    if (
        not ref_name.startswith("refs/")
        or "\\" in ref_name
        or any(part in {"", ".", ".."} for part in ref_parts)
    ):
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            "physical Git HEAD ref is invalid",
        )
    ref_candidates = [git_dir / ref_name]
    if common_dir != git_dir:
        ref_candidates.append(common_dir / ref_name)
    for candidate in ref_candidates:
        if candidate.is_symlink():
            raise MachineJsonContractError(
                "AUTHORITY_MERGE_BASE_UNAVAILABLE",
                "physical Git HEAD ref must not be a symlink",
            )
        if candidate.is_file():
            oid = read_single_physical_line(candidate, "HEAD ref")
            if re.fullmatch(oid_pattern, oid):
                return oid
            raise MachineJsonContractError(
                "AUTHORITY_MERGE_BASE_UNAVAILABLE",
                "physical Git HEAD ref OID is invalid",
            )
    packed_refs = common_dir / "packed-refs"
    if packed_refs.is_symlink():
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            "physical Git packed-refs must not be a symlink",
        )
    if packed_refs.is_file():
        try:
            packed_text = packed_refs.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise MachineJsonContractError(
                "AUTHORITY_MERGE_BASE_UNAVAILABLE",
                "unable to read physical Git packed-refs",
            ) from exc
        matches = []
        for line in packed_text.splitlines():
            if not line or line.startswith(("#", "^")):
                continue
            fields = line.split(" ", 1)
            if len(fields) == 2 and fields[1] == ref_name:
                matches.append(fields[0])
        if len(matches) == 1 and re.fullmatch(oid_pattern, matches[0]):
            return matches[0]
    raise MachineJsonContractError(
        "AUTHORITY_MERGE_BASE_UNAVAILABLE",
        "physical Git HEAD ref cannot be resolved exactly",
    )


def resolve_git_workspace_identity(repository_root: Path) -> dict[str, Any]:
    """Bind Git output to the exact physical worktree marker and HEAD bytes."""
    root = repository_root.resolve(strict=True)
    git_dir, common_dir = physical_git_directories(root)
    expected_head_oid = physical_git_head_oid(git_dir, common_dir)
    completed = run_git(
        root,
        [
            "rev-parse", "--is-inside-work-tree", "--show-toplevel",
            "--absolute-git-dir", "--git-common-dir", "HEAD^{commit}",
        ],
        text=True,
    )
    if completed.returncode != 0:
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            "unable to resolve authority Git workspace identity",
        )
    lines = completed.stdout.splitlines()
    if len(lines) != 5 or lines[0] != "true":
        raise MachineJsonContractError(
            "AUTHORITY_GIT_WORKSPACE_IDENTITY_INVALID",
            "authority Git workspace identity output is invalid",
        )
    try:
        top_level = Path(lines[1]).resolve(strict=True)
        actual_git_dir = Path(lines[2]).resolve(strict=True)
        raw_common_dir = Path(lines[3])
        actual_common_dir = (
            raw_common_dir if raw_common_dir.is_absolute() else root / raw_common_dir
        ).resolve(strict=True)
    except OSError as exc:
        raise MachineJsonContractError(
            "AUTHORITY_GIT_WORKSPACE_IDENTITY_INVALID",
            "authority Git workspace paths are invalid",
        ) from exc
    actual_head_oid = lines[4]
    expected = {
        "topLevel": str(root),
        "gitDir": str(git_dir),
        "commonDir": str(common_dir),
        "headOid": expected_head_oid,
    }
    actual = {
        "topLevel": str(top_level),
        "gitDir": str(actual_git_dir),
        "commonDir": str(actual_common_dir),
        "headOid": actual_head_oid,
    }
    if actual != expected:
        raise MachineJsonContractError(
            "AUTHORITY_GIT_WORKSPACE_MISMATCH",
            "authority Git workspace does not match the expected physical repository",
        )
    return {
        "expected": expected,
        **actual,
        "identityMatched": True,
        "environmentPolicy": copy.deepcopy(GIT_CLEAN_ENVIRONMENT_POLICY),
    }


def is_positive_int(value: Any) -> bool:
    return type(value) is int and value > 0


def authority_metadata_errors(value: Any, label: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(value, dict):
        return [f"{label} must be an object"]
    for key in ("contractVersion", "revision"):
        if not is_positive_int(value.get(key)):
            errors.append(f"{label} {key} must be an exact positive integer")
    if type(value.get("genesis")) is not bool:
        errors.append(f"{label} genesis must be an exact boolean")
    if value.get("approvalStatus") != "PENDING_HUMAN_REVIEW":
        errors.append(f"{label} approvalStatus must remain PENDING_HUMAN_REVIEW")
    return errors


def authority_semantic_payload(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: copy.deepcopy(item)
        for key, item in value.items()
        if key not in {"contractVersion", "revision", "approvalStatus"}
    }


def evaluate_authority_transition(
    current: dict[str, Any],
    previous: dict[str, Any] | None,
) -> tuple[list[str], dict[str, Any]]:
    """Validate genesis or a one-step externally anchored authority transition."""
    errors = authority_metadata_errors(current, "current authority")
    payload_changed: bool | None = None
    revision_rule = "genesis-revision-1"
    if previous is None:
        if current.get("genesis") is not True:
            errors.append("authority without external previous must declare genesis=true")
        if current.get("contractVersion") != 1 or current.get("revision") != 1:
            errors.append("genesis authority must be contractVersion=1 revision=1")
    else:
        errors.extend(authority_metadata_errors(previous, "previous authority"))
        payload_changed = authority_semantic_payload(current) != authority_semantic_payload(previous)
        current_version = current.get("contractVersion")
        current_revision = current.get("revision")
        previous_version = previous.get("contractVersion")
        previous_revision = previous.get("revision")
        if current_version != 1 or previous_version != 1:
            errors.append("authority v1 transition requires contractVersion=1 on both anchors")
        if payload_changed:
            revision_rule = "v1-controlled-change-requires-exact-next-revision"
            same_version_next_revision = (
                is_positive_int(current_version)
                and is_positive_int(current_revision)
                and is_positive_int(previous_version)
                and is_positive_int(previous_revision)
                and current_version == previous_version
                and current_revision == previous_revision + 1
            )
            if not same_version_next_revision:
                errors.append(
                    "authority v1 controlled payload change requires exact revision +1"
                )
            if current.get("genesis") is not False:
                errors.append("a changed authority revision must leave genesis mode")
        else:
            revision_rule = "unchanged-full-payload-preserves-v1-revision-and-genesis"
            if current_version != previous_version or current_revision != previous_revision:
                errors.append("unchanged authority payload must preserve v1 revision")

    return errors, {
        "genesis": current.get("genesis"),
        "approvalStatus": current.get("approvalStatus"),
        "previousPresent": previous is not None,
        "semanticPayloadChanged": payload_changed,
        "revisionRule": revision_rule,
        "humanReviewGate": "PENDING",
        "mergeReady": False,
        "productionEnablementAllowed": False,
    }


def authority_report_trust_projection(details: dict[str, Any]) -> dict[str, Any]:
    """Project stable dispositions and require detached reports to remain non-merge."""
    fields = [
        "genesis",
        "approvalStatus",
        "humanReviewGate",
        "mergeReady",
        "productionEnablementAllowed",
    ]
    if details.get("evidenceClass") == "non-merge-evidence":
        fields.extend(("evidenceClass", "mergeEvidence", "previousAbsenceVerified"))
    return {key: details.get(key) for key in fields}


def authority_report_trust_matches(
    report_trust: Any,
    expected: dict[str, Any],
) -> bool:
    return isinstance(report_trust, dict) and all(
        report_trust.get(key) == value for key, value in expected.items()
    )


REPORT_PROVENANCE_PATH_KEYS = frozenset({
    "resolvedPath", "topLevel", "gitDir", "commonDir",
})


def normalize_report_absolute_path(value: Any) -> Any:
    """Normalize an absolute evidence path without erasing its physical identity."""
    if not isinstance(value, str) or not Path(value).is_absolute():
        return value
    return str(Path(value).resolve(strict=False))


def normalize_authority_report_provenance(value: Any) -> Any:
    """Canonicalize paths while retaining every reported provenance field."""
    if isinstance(value, dict):
        normalized = {
            key: (
                normalize_report_absolute_path(item)
                if key in REPORT_PROVENANCE_PATH_KEYS
                else normalize_authority_report_provenance(item)
            )
            for key, item in value.items()
        }
        if (
            normalized.get("mode") == "external-previous"
            and "source" in normalized
        ):
            normalized["source"] = normalize_report_absolute_path(
                normalized["source"]
            )
        return normalized
    if isinstance(value, list):
        return [normalize_authority_report_provenance(item) for item in value]
    return value


def authority_report_provenance_matches(
    report_trust: Any,
    expected: dict[str, Any],
) -> bool:
    """Require the complete normalized authorityTrust provenance to match exactly."""
    return (
        isinstance(report_trust, dict)
        and normalize_authority_report_provenance(report_trust)
        == normalize_authority_report_provenance(expected)
    )


def authority_report_payload(
    authority_context: dict[str, Any],
    transition_details: dict[str, Any],
) -> dict[str, Any]:
    """Build the exact report authorityTrust payload from one resolved source."""
    return {
        "source": {
            key: copy.deepcopy(item)
            for key, item in authority_context.items()
            if key != "authority"
        },
        **copy.deepcopy(transition_details),
    }


def validation_report_provenance_matches(
    report: Any,
    expected_trust: dict[str, Any],
    expected_command: str,
) -> bool:
    """Bind one report to both its full trust source and canonical generation command."""
    return (
        isinstance(report, dict)
        and authority_report_provenance_matches(
            report.get("authorityTrust"), expected_trust
        )
        and report.get("command") == expected_command
    )


def read_external_previous_authority(
    candidate: Path,
    expected_sha256: str | None = None,
    after_read_hook: Any = None,
) -> dict[str, Any]:
    """Read external authority once; parse and audit the exact same immutable bytes."""
    resolved = candidate.resolve(strict=True)
    try:
        resolved.relative_to(PACKAGE_ROOT.resolve())
    except ValueError:
        pass
    else:
        raise MachineJsonContractError(
            "AUTHORITY_PREVIOUS_SOURCE_INVALID",
            "previous authority path must be outside the current contract package",
        )
    try:
        with resolved.open("rb") as stream:
            raw = stream.read()
    except OSError as exc:
        raise MachineJsonContractError(
            "AUTHORITY_PREVIOUS_READ_FAILED",
            "unable to read external previous authority",
        ) from exc
    if after_read_hook is not None:
        after_read_hook(resolved)
    digest = hashlib.sha256(raw).hexdigest()
    if expected_sha256 is not None:
        if re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None:
            raise MachineJsonContractError(
                "AUTHORITY_PREVIOUS_EXPECTED_SHA256_INVALID",
                "expected previous authority digest must be lowercase SHA-256",
            )
        if digest != expected_sha256:
            raise MachineJsonContractError(
                "AUTHORITY_PREVIOUS_SHA256_MISMATCH",
                "external previous authority digest does not match expectation",
            )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MachineJsonContractError(
            "AUTHORITY_PREVIOUS_ENCODING_INVALID",
            "external previous authority must be UTF-8",
        ) from exc
    return {
        "mode": "external-previous",
        "requestedAuthorityMode": "external-previous",
        "evidenceClass": "external-previous",
        "mergeEvidence": False,
        "previousAbsenceVerified": False,
        "source": str(resolved),
        "resolvedPath": str(resolved),
        "byteSize": len(raw),
        "sha256": digest,
        "expectedSha256": expected_sha256,
        "expectedSha256Matched": expected_sha256 is None or digest == expected_sha256,
        "baseRef": None,
        "mergeBase": None,
        "authority": parse_machine_json(text),
    }


def resolve_repository_previous_authority(
    repository_root: Path,
    authority_repository_path: str,
    base_ref: str,
    explicit_genesis: bool,
) -> dict[str, Any]:
    """Resolve one Git merge-base authority, or label detached genesis as non-evidence."""
    root = repository_root.resolve(strict=True)
    physical_marker = nearest_physical_git_marker(root)
    if physical_marker is None:
        if explicit_genesis:
            return {
                "mode": "detached-genesis-non-merge-evidence",
                "requestedAuthorityMode": "genesis",
                "evidenceClass": "non-merge-evidence",
                "mergeEvidence": False,
                "previousAbsenceVerified": False,
                "source": None,
                "baseRef": base_ref,
                "mergeBase": None,
                "gitWorkspaceIdentity": None,
                "gitEnvironmentPolicy": copy.deepcopy(GIT_CLEAN_ENVIRONMENT_POLICY),
                "authority": None,
            }
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            "unable to resolve authority merge base",
        )
    marker_root, _marker = physical_marker
    if marker_root != root:
        raise MachineJsonContractError(
            "AUTHORITY_GIT_WORKSPACE_MISMATCH",
            "authority Git resolver root is nested inside a different physical worktree",
        )

    workspace_identity = resolve_git_workspace_identity(root)

    merge_base = run_git(
        root,
        ["merge-base", workspace_identity["headOid"], base_ref],
        text=True,
    )
    revision = merge_base.stdout.strip()
    if (
        merge_base.returncode != 0
        or re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision) is None
    ):
        raise MachineJsonContractError(
            "AUTHORITY_MERGE_BASE_UNAVAILABLE",
            "unable to resolve authority merge base",
        )
    object_name = f"{revision}:{authority_repository_path}"
    tree = run_git(
        root,
        [
            "ls-tree", "-z", "--full-tree", revision, "--",
            authority_repository_path,
        ],
    )
    if tree.returncode != 0:
        raise MachineJsonContractError(
            "AUTHORITY_PREVIOUS_LOOKUP_FAILED",
            "unable to prove whether merge-base authority exists",
        )
    tree_entries = [entry for entry in tree.stdout.split(b"\0") if entry]
    if not tree_entries:
        return {
            "mode": (
                "repo-explicit-genesis-previous-absent"
                if explicit_genesis
                else "repo-merge-base-genesis"
            ),
            "requestedAuthorityMode": "genesis" if explicit_genesis else "repo",
            "evidenceClass": "merge-base-verified-previous-absent",
            "mergeEvidence": True,
            "previousAbsenceVerified": True,
            "source": object_name,
            "baseRef": base_ref,
            "mergeBase": revision,
            "gitWorkspaceIdentity": workspace_identity,
            "gitEnvironmentPolicy": copy.deepcopy(GIT_CLEAN_ENVIRONMENT_POLICY),
            "authority": None,
        }
    try:
        tree_paths = [
            entry.split(b"\t", 1)[1].decode("utf-8") for entry in tree_entries
        ]
    except (IndexError, UnicodeDecodeError) as exc:
        raise MachineJsonContractError(
            "AUTHORITY_PREVIOUS_LOOKUP_FAILED",
            "merge-base authority lookup returned invalid identity",
        ) from exc
    if tree_paths != [authority_repository_path]:
        raise MachineJsonContractError(
            "AUTHORITY_PREVIOUS_LOOKUP_FAILED",
            "merge-base authority lookup returned ambiguous identity",
        )
    if explicit_genesis:
        raise MachineJsonContractError(
            "AUTHORITY_GENESIS_PREVIOUS_EXISTS",
            "explicit genesis is forbidden because merge-base authority exists",
        )
    shown = run_git(root, ["show", object_name])
    if shown.returncode != 0:
        raise MachineJsonContractError(
            "AUTHORITY_PREVIOUS_READ_FAILED",
            "unable to read previous authority from merge base",
        )
    raw = shown.stdout
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MachineJsonContractError(
            "AUTHORITY_PREVIOUS_ENCODING_INVALID",
            "merge-base previous authority must be UTF-8",
        ) from exc
    return {
        "mode": "repo-merge-base-previous",
        "requestedAuthorityMode": "repo",
        "evidenceClass": "merge-base-previous",
        "mergeEvidence": True,
        "previousAbsenceVerified": False,
        "source": object_name,
        "baseRef": base_ref,
        "mergeBase": revision,
        "gitWorkspaceIdentity": workspace_identity,
        "gitEnvironmentPolicy": copy.deepcopy(GIT_CLEAN_ENVIRONMENT_POLICY),
        "byteSize": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "authority": parse_machine_json(text),
    }


def resolve_previous_authority(args: argparse.Namespace) -> dict[str, Any]:
    """Read previous authority only from an external path or an actual Git merge base."""
    if args.previous_authority is not None:
        return read_external_previous_authority(
            args.previous_authority,
            getattr(args, "previous_authority_sha256", None),
        )

    if getattr(args, "previous_authority_sha256", None) is not None:
        raise MachineJsonContractError(
            "AUTHORITY_PREVIOUS_EXPECTED_SHA256_WITHOUT_SOURCE",
            "--previous-authority-sha256 requires --previous-authority",
        )

    return resolve_repository_previous_authority(
        REPOSITORY_ROOT,
        CONTRACT_AUTHORITY_REPOSITORY_PATH,
        args.base_ref,
        explicit_genesis=args.authority_mode == "genesis",
    )


def validation_command(args: argparse.Namespace, authority_context: dict[str, Any]) -> str:
    """Render the canonical report-generation command for the resolved trust source."""
    parts = ["changes/background-execution/validation/run-validation.sh"]
    mode = authority_context.get("mode")
    if mode == "external-previous":
        parts.extend(["--previous-authority", str(authority_context.get("resolvedPath"))])
        expected = getattr(args, "previous_authority_sha256", None)
        if expected is not None:
            parts.extend(["--previous-authority-sha256", expected])
    elif mode in {
        "repo-explicit-genesis-previous-absent",
        "detached-genesis-non-merge-evidence",
    }:
        parts.extend(["--authority-mode", "genesis", "--base-ref", str(args.base_ref)])
    else:
        parts.extend(["--authority-mode", "repo", "--base-ref", str(args.base_ref)])
    report_path = getattr(args, "report", REPORT_PATH)
    if Path(report_path).resolve() != REPORT_PATH.resolve():
        parts.extend(["--report", str(Path(report_path).resolve())])
    return f"PYTHON_BIN=<python3> {shlex.join(parts)}"


def machine_json_input_contract_errors() -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    duplicate_mutants = {
        "root-duplicate-revision": '{"revision":1,"revision":2}',
        "nested-duplicate-digest": (
            '{"actionTaskBinding":{"bindingMapSha256":"' + "0" * 64
            + '","bindingMapSha256":"' + "1" * 64 + '"}}'
        ),
        "nested-duplicate-count": (
            '{"recoveryResultProjection":{"expectedKnownAnswerCount":20,'
            '"expectedKnownAnswerCount":21}}'
        ),
    }
    duplicate_results: dict[str, bool] = {}
    for name, raw in duplicate_mutants.items():
        try:
            parse_machine_json(raw)
            duplicate_results[name] = False
        except MachineJsonContractError as exc:
            duplicate_results[name] = exc.code == "MACHINE_JSON_DUPLICATE_KEY"
        if not duplicate_results[name]:
            errors.append(f"machine JSON duplicate mutant passed: {name}")

    metadata_results: dict[str, bool] = {}
    current = contract_authority()
    for field in ("contractVersion", "revision"):
        for label, invalid in (
            ("bool", True), ("float", 1.0), ("zero", 0), ("negative", -1),
        ):
            mutant = copy.deepcopy(current)
            mutant[field] = invalid
            name = f"{field}-{label}-rejected"
            metadata_results[name] = bool(authority_metadata_errors(mutant, "mutant"))
            if not metadata_results[name]:
                errors.append(f"authority positive-integer mutant passed: {name}")
    return errors, {
        "loader": "recursive object_pairs_hook duplicate rejection",
        "duplicateMutationResults": duplicate_results,
        "positiveIntegerMutationResults": metadata_results,
        "errors": errors,
    }


def contract_authority() -> dict[str, Any]:
    """Load the independent, non-generated public authority on every validation run."""
    value = load_json(CONTRACT_AUTHORITY_PATH)
    if not isinstance(value, dict):
        raise ValueError("recovery contract authority must be an object")
    return value


def action_task_binding_authority() -> dict[str, Any]:
    value = contract_authority().get("actionTaskBinding")
    if not isinstance(value, dict):
        raise ValueError("recovery contract authority actionTaskBinding missing")
    return value


def recovery_result_projection_authority() -> dict[str, Any]:
    value = contract_authority().get("recoveryResultProjection")
    if not isinstance(value, dict):
        raise ValueError("recovery contract authority recoveryResultProjection missing")
    return value


def named_item(items: Any, name: str) -> dict[str, Any] | None:
    if not isinstance(items, list):
        return None
    for item in items:
        if isinstance(item, dict) and item.get("name") == name:
            return item
    return None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def json_errors(validator: Draft202012Validator, instance: Any) -> list[str]:
    errors = sorted(validator.iter_errors(instance), key=lambda e: [str(x) for x in e.absolute_path])
    return [f"/{'/'.join(str(x) for x in e.absolute_path)}: {e.message}" for e in errors]


def node_jcs_batch(values: list[Any]) -> list[dict[str, str]]:
    """Use the frozen Node RFC 8785/JCS implementation; JSON here is transport only."""
    completed = subprocess.run(
        ["node", str(JCS_SCRIPT_PATH), "--stdin"],
        input=json.dumps(values, ensure_ascii=False, separators=(",", ":")),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise ValueError(completed.stderr.strip() or "Node JCS process failed")
    result = json.loads(completed.stdout)
    if not isinstance(result, list) or len(result) != len(values):
        raise ValueError("Node JCS returned an invalid batch result")
    return result


def jcs_json_bytes(value: Any) -> bytes:
    return node_jcs_batch([value])[0]["canonical"].encode("utf-8")


def jcs_json_sha256(value: Any) -> str:
    return node_jcs_batch([value])[0]["sha256"]


def jcs_contract_errors() -> tuple[list[str], dict[str, Any]]:
    """Cross-runtime known-answer and JavaScript runtime-domain gate for RFC 8785/JCS."""
    errors: list[str] = []
    fixture = load_json(JCS_VECTOR_PATH)
    completed = subprocess.run(
        ["node", str(JCS_SCRIPT_PATH), "--vectors", str(JCS_VECTOR_PATH)],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        errors.append(f"Node JCS vector runner failed: {completed.stderr.strip()}")
        node_result: dict[str, Any] = {}
    else:
        try:
            node_result = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            node_result = {}
            errors.append(f"Node JCS vector output is invalid JSON: {exc}")

    if fixture.get("contractVersion") != 1 or fixture.get("algorithm") != "RFC8785-JCS":
        errors.append("JCS vector contractVersion/algorithm drift")
    canonical_cases = fixture.get("canonicalCases", [])
    case_by_name = {case.get("name"): case for case in canonical_cases}
    if set(case_by_name) != set(FROZEN_JCS_KAT_SHA256):
        errors.append(
            "JCS canonical KAT set drift: "
            f"expected={sorted(FROZEN_JCS_KAT_SHA256)} actual={sorted(case_by_name)}"
        )
    python_known_answer_results: list[dict[str, Any]] = []
    sha1_mutation_results: list[dict[str, Any]] = []
    for name, frozen_digest in FROZEN_JCS_KAT_SHA256.items():
        case = case_by_name.get(name, {})
        expected_canonical = case.get("expectedCanonical", "")
        expected_digest = case.get("expectedSha256", "")
        python_digest = hashlib.sha256(expected_canonical.encode("utf-8")).hexdigest()
        passed = (
            re.fullmatch(r"[0-9a-f]{64}", str(expected_digest)) is not None
            and expected_digest == frozen_digest
            and python_digest == frozen_digest
        )
        python_known_answer_results.append(
            {
                "name": name,
                "expectedSha256": frozen_digest,
                "pythonSha256": python_digest,
                "passed": passed,
            }
        )
        if not passed:
            errors.append(f"Python shared JCS known-answer failed: {name}")
        sha1_digest = hashlib.sha1(expected_canonical.encode("utf-8")).hexdigest()
        sha1_rejected = len(sha1_digest) == 40 and sha1_digest != frozen_digest
        sha1_mutation_results.append(
            {"name": name, "sha1Digest": sha1_digest, "rejected": sha1_rejected}
        )
        if not sha1_rejected:
            errors.append(f"SHA-1 mutant was not distinguished from SHA-256: {name}")

    node_canonical_results = node_result.get("canonicalCases", [])
    for item in node_canonical_results:
        if not item.get("canonicalMatched") or not item.get("sha256Matched"):
            errors.append(f"Node JCS known-answer failed: {item.get('name')}")
    if len(node_canonical_results) != len(FROZEN_JCS_KAT_SHA256):
        errors.append("Node JCS canonical result count drift")
    node_rejection_results = node_result.get("rejectionCases", [])
    for item in node_rejection_results:
        if not item.get("rejected"):
            errors.append(f"Node JCS runtime-domain rejection failed: {item.get('name')}")
    required_rejection_names = {
        "invalid-high-surrogate", "invalid-low-surrogate", "sparse-array",
        "array-extra-property", "accessor-object", "to-json", "non-plain-object",
        "cycle", "undefined", "non-finite", "bigint", "symbol-key",
        "non-enumerable", "function", "proxy",
    }
    if {item.get("name") for item in node_rejection_results} != required_rejection_names:
        errors.append("JCS runtime-domain rejection vector set drift")
    if not node_result.get("nullPrototypePlainObject", {}).get("passed"):
        errors.append("JCS null-prototype plain object positive vector failed")

    expected_raw_cases = {
        "safe-positive-integer-boundary": None,
        "safe-negative-integer-boundary": None,
        "unsafe-positive-integer-boundary": "JCS_UNSAFE_INTEGER",
        "unsafe-distinct-integer-must-not-converge": "JCS_UNSAFE_INTEGER",
        "unsafe-negative-integer-boundary": "JCS_UNSAFE_INTEGER",
        "unsafe-negative-distinct-integer-must-not-converge": "JCS_UNSAFE_INTEGER",
        "top-level-duplicate-key": "JCS_DUPLICATE_KEY",
        "nested-duplicate-key": "JCS_DUPLICATE_KEY",
        "escaped-equivalent-duplicate-key": "JCS_DUPLICATE_KEY",
    }
    fixture_raw_cases = {
        item.get("name"): item.get("expectedCode")
        for item in fixture.get("rawInputCases", [])
    }
    node_raw_results = node_result.get("rawInputCases", [])
    if fixture_raw_cases != expected_raw_cases:
        errors.append(
            f"JCS raw input vector set drift: expected={expected_raw_cases!r} "
            f"actual={fixture_raw_cases!r}"
        )
    if {item.get("name") for item in node_raw_results} != set(expected_raw_cases):
        errors.append("Node JCS raw input result set drift")
    for item in node_raw_results:
        if not item.get("passed"):
            errors.append(f"Node JCS raw duplicate/integer gate failed: {item.get('name')}")

    script_source = JCS_SCRIPT_PATH.read_text(encoding="utf-8")
    proxy_guard = (
        "  if (utilTypes.isProxy(value)) {\n"
        "    throw new JcsDomainError('JCS_PROXY_FORBIDDEN', path || '/', "
        "'Proxy values are outside the JCS input domain');\n"
        "  }\n"
    )
    runtime_guard_mutation = {
        "name": "delete-proxy-runtime-guard",
        "mutationApplied": script_source.count(proxy_guard) == 1,
        "detected": False,
    }
    if not runtime_guard_mutation["mutationApplied"]:
        errors.append("JCS Proxy runtime guard is not present exactly once")
    else:
        with tempfile.TemporaryDirectory(prefix="jcs-guard-mutant-") as temp_dir:
            mutant_path = Path(temp_dir) / "canonicalize-jcs-mutant.js"
            mutant_path.write_text(script_source.replace(proxy_guard, "", 1), encoding="utf-8")
            mutant_completed = subprocess.run(
                ["node", str(mutant_path), "--vectors", str(JCS_VECTOR_PATH)],
                text=True,
                capture_output=True,
                check=False,
            )
            try:
                mutant_result = json.loads(mutant_completed.stdout)
            except json.JSONDecodeError:
                mutant_result = {}
            proxy_result = next(
                (
                    item for item in mutant_result.get("rejectionCases", [])
                    if item.get("name") == "proxy"
                ),
                {},
            )
            runtime_guard_mutation["detected"] = (
                mutant_completed.returncode == 0 and proxy_result.get("rejected") is False
            )
            if not runtime_guard_mutation["detected"]:
                errors.append("JCS validator did not detect deleted Proxy runtime guard")

    safe_integer_guard = (
        "    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {\n"
        "      fail('JCS_UNSAFE_INTEGER', path, "
        "'Integer is outside the safe IEEE-754 range');\n"
        "    }\n"
    )
    unsafe_integer_predicate = "!Number.isSafeInteger(value)"
    positive_only_predicate = "value > Number.MAX_SAFE_INTEGER"
    negative_guard_mutation = {
        "name": "replace-lossless-integer-guard-with-positive-only-guard",
        "mutationApplied": (
            script_source.count(safe_integer_guard) == 1
            and script_source.count(unsafe_integer_predicate) == 2
        ),
        "detected": False,
    }
    if not negative_guard_mutation["mutationApplied"]:
        errors.append("JCS raw lossless safe-integer guard is not present exactly once")
    else:
        with tempfile.TemporaryDirectory(prefix="jcs-negative-guard-mutant-") as temp_dir:
            mutant_path = Path(temp_dir) / "canonicalize-jcs-mutant.js"
            mutant_path.write_text(
                script_source.replace(
                    unsafe_integer_predicate, positive_only_predicate
                ),
                encoding="utf-8",
            )
            mutant_completed = subprocess.run(
                ["node", str(mutant_path), "--vectors", str(JCS_VECTOR_PATH)],
                text=True,
                capture_output=True,
                check=False,
            )
            try:
                mutant_result = json.loads(mutant_completed.stdout)
            except json.JSONDecodeError:
                mutant_result = {}
            negative_results = {
                item.get("name"): item
                for item in mutant_result.get("rawInputCases", [])
                if str(item.get("name", "")).startswith("unsafe-negative-")
            }
            negative_guard_mutation["mutantReturnCode"] = mutant_completed.returncode
            negative_guard_mutation["negativeResultSummary"] = negative_results
            negative_guard_mutation["detected"] = (
                mutant_completed.returncode == 0
                and set(negative_results) == {
                    "unsafe-negative-integer-boundary",
                    "unsafe-negative-distinct-integer-must-not-converge",
                }
                and all(not item.get("passed") for item in negative_results.values())
            )
            if not negative_guard_mutation["detected"]:
                errors.append("JCS validator did not detect positive-only unsafe-integer guard")

    for raw_entry_rule in (
        "const fixture = parseJsonLossless(fs.readFileSync(path, 'utf8'));",
        "const input = parseJsonLossless(fs.readFileSync(0, 'utf8'));",
        "if (keys.has(key))",
        "Number.isSafeInteger(value)",
    ):
        if raw_entry_rule not in script_source:
            errors.append(f"JCS raw/runtime guard missing: {raw_entry_rule}")

    utf16_case = case_by_name.get("utf16-property-order-u10000-before-ue000", {})
    utf16_order_proved = utf16_case.get("expectedCanonical", "").startswith(
        '{"\U00010000":"supplementary","\ue000":"bmp"}'
    )
    if not utf16_order_proved:
        errors.append("JCS UTF-16 property ordering vector does not prove U+10000 before U+E000")

    for path, name in (
        (E00_TECHDOC_PATH, "E00 TechDoc"),
        (PLATFORM_CONTRACT_PATH, "platform contract"),
    ):
        body = path.read_text(encoding="utf-8")
        for phrase in (
            "RFC 8785", "UTF-16", "ECMAScript", "-0", "invalid surrogate",
            "accessor", "toJSON", "[0-9a-f]{64}",
        ):
            if phrase not in body:
                errors.append(f"{name} missing frozen JCS rule: {phrase}")

    return errors, {
        "algorithm": fixture.get("algorithm"),
        "canonicalCaseCount": len(canonical_cases),
        "runtimeRejectionCaseCount": len(node_rejection_results),
        "pythonKnownAnswerResults": python_known_answer_results,
        "nodeKnownAnswerResults": node_canonical_results,
        "nodeRuntimeDomainResults": node_rejection_results,
        "nodeRawInputResults": node_raw_results,
        "rawInputCaseCount": len(node_raw_results),
        "runtimeGuardMutationResults": [runtime_guard_mutation, negative_guard_mutation],
        "sha1MutationResults": sha1_mutation_results,
        "utf16OrderingProved": utf16_order_proved,
        "errors": errors,
    }


def policy_semantic_errors(registry: dict[str, Any], static_keys: dict[str, list[str]]) -> list[str]:
    errors: list[str] = []
    actions = registry.get("actions", {})
    static_sets = {k: set(v) for k, v in static_keys.items()}
    ref_map = {
        "entryKey": "entryKeys",
        "adapterKey": "adapterKeys",
    }
    nested_refs = [
        ("commit", "inspectorKey", "inspectorKeys"),
        ("commit", "conflictScopeResolverKey", "conflictScopeResolverKeys"),
        ("commit", "settlementKey", "settlementKeys"),
        ("artifacts", "publisherKey", "publisherKeys"),
        ("artifacts", "technicalValidatorKey", "technicalValidatorKeys"),
        ("artifacts", "businessValidatorKey", "businessValidatorKeys"),
        ("result", "validatorKey", "resultValidatorKeys"),
    ]
    for property_key, policy in actions.items():
        action_key = policy.get("actionKey")
        if property_key != action_key:
            errors.append(f"registry property {property_key!r} != actionKey {action_key!r}")
        for field, bucket in ref_map.items():
            value = policy.get(field)
            if value is not None and value not in static_sets.get(bucket, set()):
                errors.append(f"{property_key}: unresolved {field}={value}")
        for parent, field, bucket in nested_refs:
            value = policy.get(parent, {}).get(field)
            if value is not None and value not in static_sets.get(bucket, set()):
                errors.append(f"{property_key}: unresolved {parent}.{field}={value}")
        commit = policy.get("commit", {})
        commit_kind = commit.get("kind")
        artifacts = policy.get("artifacts", {})
        artifact_kind = artifacts.get("kind")
        if commit_kind == "none":
            if commit.get("criticalIntent") is not False or any(commit.get(k) is not None for k in ("receiptKind", "inspectorKey", "conflictScopeResolverKey", "settlementKey")):
                errors.append(f"{property_key}: commit.kind=none contains durable recovery fields")
        elif commit_kind == "main-settlement":
            receipt_kind = commit.get("receiptKind")
            if receipt_kind not in {"publisher-journal", "target-post-image"}:
                errors.append(f"{property_key}: main-settlement has invalid receiptKind={receipt_kind!r}")
            if receipt_kind == "publisher-journal" and commit.get("criticalIntent") is not False:
                errors.append(f"{property_key}: publisher-journal main-settlement must have criticalIntent=false")
            if receipt_kind == "target-post-image" and commit.get("criticalIntent") is not True:
                errors.append(f"{property_key}: target-post-image main-settlement must have criticalIntent=true")
            for field in ("inspectorKey", "conflictScopeResolverKey", "settlementKey"):
                if not commit.get(field):
                    errors.append(f"{property_key}: main-settlement missing {field}")
            if artifact_kind != "none" and receipt_kind != "publisher-journal":
                errors.append(f"{property_key}: artifact main-settlement must use publisher-journal")
            if receipt_kind == "target-post-image" and artifact_kind != "none":
                errors.append(f"{property_key}: target-post-image settlement cannot declare publish artifacts")
        elif commit_kind == "worker-durable":
            if commit.get("criticalIntent") is not True or commit.get("receiptKind") != "module-local":
                errors.append(f"{property_key}: worker-durable must use criticalIntent=true and module-local receipt")
            for field in ("inspectorKey", "conflictScopeResolverKey"):
                if not commit.get(field):
                    errors.append(f"{property_key}: worker-durable missing {field}")
            if commit.get("settlementKey") is not None:
                errors.append(f"{property_key}: worker-durable settlementKey must be null")
        elif commit_kind == "existing-critical-protocol":
            if commit.get("criticalIntent") is not False or commit.get("receiptKind") != "existing-protocol":
                errors.append(f"{property_key}: existing-critical-protocol recovery fields are inconsistent")
            for field in ("inspectorKey", "conflictScopeResolverKey", "settlementKey"):
                if not commit.get(field):
                    errors.append(f"{property_key}: existing-critical-protocol missing {field}")

        if artifact_kind == "none":
            if artifacts.get("publisherKey") is not None or artifacts.get("technicalValidatorKey") is not None or artifacts.get("businessValidatorKey") is not None or artifacts.get("maxArtifacts") != 0:
                errors.append(f"{property_key}: artifacts.kind=none contains publication fields")
        else:
            if artifacts.get("filePlanRequired") is not True:
                errors.append(f"{property_key}: artifact action must require FilePlan")
            for field in ("publisherKey", "technicalValidatorKey", "businessValidatorKey"):
                if not artifacts.get(field):
                    errors.append(f"{property_key}: artifact action missing {field}")

        service = policy.get("service")
        if service:
            value = service.get("serviceKey")
            if value not in static_sets.get("serviceKeys", set()):
                errors.append(f"{property_key}: unresolved service.serviceKey={value}")
            if service.get("controlProtocol") != "service-control-v1":
                errors.append(f"{property_key}: service controlProtocol is not service-control-v1")
            rc = service.get("resourceControl") or {}
            if rc.get("grantIdentityRequired") is not True or rc.get("releaseAckRequired") is not True:
                errors.append(f"{property_key}: resource grant/release identity safety disabled")
            adoption = service.get("stateAdoption") or {}
            if not all(adoption.get(k) is True for k in ("grantIdentityRequired", "atomicReplaceRequired", "adoptAckRequired")):
                errors.append(f"{property_key}: unsafe stateAdoption policy")
        compound = policy.get("resources", {}).get("compound")
        if compound:
            value = compound.get("topologyKey")
            if value not in static_sets.get("topologyKeys", set()):
                errors.append(f"{property_key}: unresolved topologyKey={value}")
            if "root" in compound:
                errors.append(f"{property_key}: compound must not duplicate resources.base as root")
            if not isinstance(compound.get("childResource"), dict):
                errors.append(f"{property_key}: compound missing childResource")
        limits = policy.get("protocolLimits", {})
        if limits != {
            "commandMaxBytes": PLATFORM_PROTOCOL_MAX_BYTES,
            "eventMaxBytes": PLATFORM_PROTOCOL_MAX_BYTES,
        }:
            errors.append(
                f"{property_key}: protocolLimits must use the frozen {PLATFORM_PROTOCOL_MAX_BYTES}-byte ceiling"
            )
        work = policy.get("workUnits")
        if work:
            for field, bucket in (("plannerKey", "plannerKeys"), ("reducerKey", "reducerKeys")):
                value = work.get(field)
                if value is not None and value not in static_sets.get(bucket, set()):
                    errors.append(f"{property_key}: unresolved workUnits.{field}={value}")
        prod = policy.get("production", {})
        if prod.get("enabled"):
            effective = prod.get("effectiveMode")
            mode = policy.get("mode")
            allowed = {mode}
            if mode == "thread-pool":
                allowed.add("thread-single")
            if effective not in allowed:
                errors.append(f"{property_key}: enabled effectiveMode={effective!r} incompatible with mode={mode!r}")
        else:
            if prod.get("effectiveMode") not in {"legacy", "thread-single", "inline-async", "utility-process"}:
                errors.append(f"{property_key}: disabled policy has unexplained effectiveMode")
        if policy.get("disposition") == "blocked" and prod.get("enabled"):
            errors.append(f"{property_key}: blocked policy cannot be production enabled")

    durable_canary = actions.get("background-execution:canary", {})
    if durable_canary.get("commit", {}).get("kind") != "worker-durable":
        errors.append("background-execution:canary must remain the E02-C2 durable recovery canary")
    pure_canary = actions.get("background-execution:pure-compute-canary", {})
    if (
        pure_canary.get("context") != {"kind": "none", "validatorKey": "platform-none"}
        or pure_canary.get("commit", {}).get("kind") != "none"
        or pure_canary.get("production", {}).get("enabled") is not False
    ):
        errors.append(
            "background-execution:pure-compute-canary must be none/platform-none, commit none and production disabled"
        )
    return errors


def table_cells(line: str) -> list[str]:
    return [c.strip().strip("`") for c in line.strip().strip("|").split("|")]


def action_table_errors() -> tuple[list[str], int]:
    errors: list[str] = []
    row_count = 0
    static_snapshots: dict[str, tuple[str, str, str, str]] = {}
    for path in sorted((PACKAGE_ROOT / "changes").glob("3.2.*/spec.md")):
        lines = path.read_text(encoding="utf-8").splitlines()
        header: list[str] | None = None
        for line_no, line in enumerate(lines, 1):
            if not line.startswith("|"):
                if line.strip():
                    header = None
                continue
            cells = table_cells(line)
            if cells and cells[0] == "actionKey":
                header = cells
                continue
            if not header or line.startswith("| ---") or len(cells) != len(header):
                continue
            action_key = cells[0]
            if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*", action_key):
                continue
            row = dict(zip(header, cells))
            row_count += 1
            for col, allowed in (
                ("currentDisposition", CANONICAL_DISPOSITIONS),
                ("targetDisposition", CANONICAL_DISPOSITIONS),
                ("mode", CANONICAL_MODES),
                ("lifetime", CANONICAL_LIFETIMES),
                ("adapterKind", CANONICAL_ADAPTERS),
                ("commit.kind", CANONICAL_COMMITS),
            ):
                if col in row and row[col] not in allowed:
                    errors.append(f"{path.relative_to(PACKAGE_ROOT)}:{line_no}: {col}={row[col]!r} is not canonical")
            production_col = next((c for c in header if c.startswith("production.enabled")), None)
            if production_col and row[production_col] not in {"true", "false"}:
                errors.append(f"{path.relative_to(PACKAGE_ROOT)}:{line_no}: {production_col} must be exact true/false, got {row[production_col]!r}")
            for value in cells:
                if value in FORBIDDEN_COMPOSITES:
                    errors.append(f"{path.relative_to(PACKAGE_ROOT)}:{line_no}: forbidden composite policy value {value!r}")
            if all(k in row for k in ("mode", "lifetime", "commit.kind")):
                snapshot = (row["mode"], row["lifetime"], row.get("adapterKind", "native"), row["commit.kind"])
                old = static_snapshots.get(action_key)
                if old and old != snapshot:
                    errors.append(f"{path.relative_to(PACKAGE_ROOT)}:{line_no}: {action_key} policy drift {old} -> {snapshot}")
                else:
                    static_snapshots[action_key] = snapshot
    return errors, row_count


def document_path_errors() -> tuple[list[str], int]:
    errors: list[str] = []
    refs = 0
    pattern = re.compile(r"`(changes/[^`\n]+)`")
    for path in sorted(PACKAGE_ROOT.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        for match in pattern.finditer(text):
            refs += 1
            raw = match.group(1).split("#", 1)[0]
            candidate = PACKAGE_ROOT / raw
            if not candidate.exists():
                line = text.count("\n", 0, match.start()) + 1
                errors.append(f"{path.relative_to(PACKAGE_ROOT)}:{line}: missing referenced path {raw}")
    return errors, refs


def required_file_errors() -> list[str]:
    required = [
        "README.md",
        "CODEX-SPEC.md",
        "CODEX-TECHDOC.md",
        "P0-targeted-closure-report.md",
        "P0-final-recovery-contract-closure-report.md",
        "P0-recovery-source-contract-final-alignment-report.md",
        "P0-codex-entry-contract-final-closure-report.md",
        "P0-recovery-audit-atomicity-final-closure-report.md",
        "P0-recovery-control-transaction-observation-final-closure-report.md",
        "P0-recovery-control-identity-replay-contract-errata-report.md",
        "P0-recovery-control-redline-human-review-checklist.md",
        "codex-ready-revision-manifest.json",
        "implementation-notes.md",
        "implementation-sequence.md",
        "changes/background-execution/platform-contract-v1.md",
        "changes/background-execution/platform-contract-v1.schema.json",
        "changes/background-execution/platform-protocol-v1.schema.json",
        "changes/background-execution/platform-recovery-source-v1.schema.json",
        "changes/background-execution/platform-recovery-control-v1.schema.json",
        "changes/background-execution/recovery-contract-authority.v1.json",
        "changes/background-execution/platform-lifecycle-mapping.md",
        "changes/background-execution/E00-platform-contract-v1-spec.md",
        "changes/background-execution/E00-platform-contract-v1-techdoc.md",
        "changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json",
        "changes/background-execution/validation/fixtures/valid/action-manifest.v3.2.x.json",
        "changes/background-execution/validation/fixtures/valid/recovery-sources.v1.json",
        "changes/background-execution/validation/fixtures/invalid/recovery-sources.invalid.v1.json",
        "changes/background-execution/validation/fixtures/valid/recovery-results.v1.json",
        "changes/background-execution/validation/fixtures/invalid/recovery-results.invalid.v1.json",
        "changes/background-execution/validation/fixtures/valid/recovery-control-requests.v1.json",
        "changes/background-execution/validation/fixtures/invalid/recovery-control-requests.invalid.v1.json",
        "changes/background-execution/validation/fixtures/valid/canonical-json-jcs-v1.json",
        "changes/background-execution/validation/canonicalize-jcs.js",
        "changes/background-execution/validation/README.md",
        "changes/background-execution/validation/validate_background_execution_baseline.py",
        "changes/background-execution/validation/run-validation.sh",
        "changes/background-execution/validation/requirements-validation.txt",
    ]
    for v in range(6):
        required.extend((f"changes/3.2.{v}/spec.md", f"changes/3.2.{v}/techdoc.md"))
    return [f"missing required file {rel}" for rel in required if not (PACKAGE_ROOT / rel).exists()]


def service_governor_boundary_errors() -> list[str]:
    errors: list[str] = []
    service_docs = [
        PACKAGE_ROOT / "changes/3.2.2/techdoc.md",
        PACKAGE_ROOT / "changes/3.2.3/techdoc.md",
        PACKAGE_ROOT / "changes/3.2.4/techdoc.md",
    ]
    for path in service_docs:
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if "governor.acquire" in line and "禁止" not in line and "不得" not in line:
                errors.append(f"{path.relative_to(PACKAGE_ROOT)}:{line_no}: Service directly calls Main Governor")
    return errors


def _extract_marked_json(text: str, begin_marker: str, end_marker: str) -> dict[str, Any]:
    pattern = re.compile(
        re.escape(begin_marker) + r"\s*```json\s*(?P<body>.*?)\s*```\s*" + re.escape(end_marker),
        re.DOTALL,
    )
    match = pattern.search(text)
    if not match:
        raise ValueError(f"missing marked JSON block {begin_marker}")
    return json.loads(match.group("body"))


def _extract_text_enum_after(text: str, heading: str) -> list[str]:
    start = text.find(heading)
    if start < 0:
        raise ValueError(f"missing heading marker {heading!r}")
    match = re.search(r"```text\s*(?P<body>.*?)\s*```", text[start:], re.DOTALL)
    if not match:
        raise ValueError(f"missing text enum after {heading!r}")
    return [line.strip() for line in match.group("body").splitlines() if line.strip()]


def _protocol_summary_from_schema(protocol_schema: dict[str, Any]) -> dict[str, Any]:
    defs = protocol_schema["$defs"]
    return {
        "summaryVersion": 1,
        "normativeSchema": "changes/background-execution/platform-protocol-v1.schema.json",
        "jobEnvelope": {
            "required": defs["jobEnvelope"]["required"],
            "operations": defs["jobEnvelope"]["properties"]["operation"]["enum"],
        },
        "serviceControlEnvelope": {
            "required": defs["serviceControlEnvelope"]["required"],
            "operations": defs["serviceControlEnvelope"]["properties"]["operation"]["enum"],
        },
        "jobRef": {
            "required": defs["jobRef"]["required"],
        },
        "sequenceScopes": {
            "job": ["jobId", "workerInstanceId", "direction"],
            "service-control": ["serviceKey", "serviceGeneration", "workerInstanceId", "direction"],
        },
    }


def codex_input_contract_errors(protocol_schema: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    spec_text = CODEX_SPEC_PATH.read_text(encoding="utf-8")
    tech_text = CODEX_TECHDOC_PATH.read_text(encoding="utf-8")
    lifecycle_text = LIFECYCLE_MAPPING_PATH.read_text(encoding="utf-8")
    contract_text = PLATFORM_CONTRACT_PATH.read_text(encoding="utf-8")
    e00_tech_text = E00_TECHDOC_PATH.read_text(encoding="utf-8")

    try:
        documented_summary = _extract_marked_json(
            tech_text,
            "<!-- BEGIN CODEX_PROTOCOL_SUMMARY_V1 -->",
            "<!-- END CODEX_PROTOCOL_SUMMARY_V1 -->",
        )
    except (ValueError, json.JSONDecodeError) as exc:
        errors.append(f"CODEX-TECHDOC protocol summary unreadable: {exc}")
        documented_summary = {}

    expected_summary = _protocol_summary_from_schema(protocol_schema)
    if documented_summary != expected_summary:
        errors.append(
            "CODEX-TECHDOC Protocol summary drifted from platform-protocol-v1.schema.json: "
            f"expected={expected_summary!r} actual={documented_summary!r}"
        )

    required_notes = (
        "Job Envelope 的 `context` 始终必填",
        "`unit:progress` 是合法 Job operation",
        "`actionKey`、`operationKey`、`jobId` 和 `unitId`",
        "`controlId` 只关联一次 control exchange",
        "(jobId, workerInstanceId, direction)",
        "(serviceKey, serviceGeneration, workerInstanceId, direction)",
    )
    for needle in required_notes:
        if needle not in tech_text:
            errors.append(f"CODEX-TECHDOC missing protocol invariant: {needle}")

    forbidden_seq_scope = "serviceKey + controlId + sender identity"
    if forbidden_seq_scope in tech_text:
        errors.append("CODEX-TECHDOC still scopes Service seq by controlId")
    for name, body in (
        ("platform-contract-v1", contract_text),
        ("E00-platform-contract-v1-techdoc", e00_tech_text),
        ("CODEX-TECHDOC", tech_text),
    ):
        if CANONICAL_SERVICE_DIRECTION_SEQ not in body:
            errors.append(f"{name} missing independent Service direction seq contract")
    validator_text = Path(__file__).read_text(encoding="utf-8")
    service_validator_start = validator_text.index(
        "\ndef _service_resource_sequence_errors"
    ) + 1
    service_validator_end = validator_text.index(
        "\ndef recovery_contract_errors", service_validator_start
    )
    service_validator_text = validator_text[service_validator_start:service_validator_end]
    for forbidden_guard in (
        "seq must echo request seq",
        "adopt-ack must echo adopted controlId/seq",
        "release-ack must echo release controlId/seq",
        "close-ack must echo close controlId/seq",
    ):
        if forbidden_guard in service_validator_text:
            errors.append(f"validator retains cross-direction seq equality guard: {forbidden_guard}")

    atomicity_docs = (
        ("platform-contract-v1", contract_text),
        ("E00-platform-contract-v1-techdoc", e00_tech_text),
        ("CODEX-SPEC", spec_text),
        ("CODEX-TECHDOC", tech_text),
    )
    forbidden_atomicity_patterns = (
        re.compile(r"(?:事务|transaction).{0,40}(?:或|或者).{0,64}(?:恢复顺序|确定性顺序)", re.IGNORECASE),
        re.compile(r"(?:或|或者)\s*具备(?:可证明|测试证明)的?(?:恢复|确定)顺序"),
        re.compile(r"异步补写\s*recovery event", re.IGNORECASE),
    )
    for name, body in atomicity_docs:
        if CANONICAL_RECOVERY_ATOMICITY not in body:
            errors.append(f"{name} missing canonical same-transaction recovery event requirement")
        for pattern in forbidden_atomicity_patterns:
            match = pattern.search(body)
            if match:
                errors.append(
                    f"{name} permits non-atomic recovery event ordering: {match.group(0)!r}"
                )

    # Guard the drift detector itself against future weakening.
    forbidden_atomicity_samples = (
        "同一主控事务或具备可证明的恢复顺序",
        "同一个 Main-owned control DB transaction 或经过测试证明的确定性顺序",
        "状态写入采用事务或恢复顺序",
        "允许异步补写 recovery event",
    )
    for sample in forbidden_atomicity_samples:
        if not any(pattern.search(sample) for pattern in forbidden_atomicity_patterns):
            errors.append(f"atomicity drift detector failed to reject sample: {sample}")

    if re.search(r"^\s{2,}appendRecoveryEvent\s*\(", e00_tech_text, re.MULTILINE):
        errors.append("E00 TechDoc still exposes appendRecoveryEvent() as an independent public API")
    if "transitionManyWithRecoveryEvents" in contract_text or "transitionManyWithRecoveryEvents" in e00_tech_text:
        errors.append("atomic repository API drift: uncontracted transitionManyWithRecoveryEvents detected")
    for required_name in (
        "RecoveryControlRepository",
        "RecoveryControlTransactionV1",
        "RecoveryControlReadRepository",
    ):
        if required_name not in e00_tech_text or required_name not in tech_text:
            errors.append(f"atomic repository name missing from E00/CODEX TechDoc: {required_name}")
    for forbidden_name in ("interface CriticalIntentRepository", "interface RecoveryHoldRepository", "interface RecoveryLifecycleRepository"):
        if forbidden_name in e00_tech_text or forbidden_name in tech_text:
            errors.append(f"split recovery mutation repository remains public: {forbidden_name}")

    try:
        lifecycle_renderer = _extract_text_enum_after(lifecycle_text, "Renderer 可见状态：")
        codex_renderer = _extract_text_enum_after(tech_text, "Renderer 的规范状态只能来自")
        if codex_renderer != lifecycle_renderer:
            errors.append(
                "CODEX-TECHDOC Renderer status set drifted from platform-lifecycle-mapping.md: "
                f"expected={lifecycle_renderer!r} actual={codex_renderer!r}"
            )
    except ValueError as exc:
        errors.append(f"Renderer status contract unreadable: {exc}")
        lifecycle_renderer = []
        codex_renderer = []

    for forbidden in ("success/recovered", "compensated failure"):
        if forbidden in tech_text:
            errors.append(f"CODEX-TECHDOC contains non-canonical Renderer status {forbidden!r}")
    for required in (
        "metadata 记录 `recovered=true`",
        "metadata 记录 `compensated=true`",
    ):
        if required not in tech_text:
            errors.append(f"CODEX-TECHDOC missing recovery metadata mapping: {required}")

    critical_mapping = (
        "仅 `worker-durable` 与 `main-settlement + target-post-image` 使用平台 Critical Intent"
    )
    no_intent_mapping = (
        "`publisher-journal` 与 `existing-critical-protocol` 不创建平台 Intent"
    )
    if critical_mapping not in contract_text or no_intent_mapping not in contract_text:
        errors.append("platform-contract-v1 production gate has ambiguous Critical Intent applicability")
    if "mutation action 的 critical intent、receipt、inspector" in contract_text:
        errors.append("platform-contract-v1 still says every mutation requires Critical Intent")

    details = {
        "protocolSummaryVersion": documented_summary.get("summaryVersion"),
        "jobRequiredFieldCount": len(expected_summary["jobEnvelope"]["required"]),
        "jobOperationCount": len(expected_summary["jobEnvelope"]["operations"]),
        "serviceRequiredFieldCount": len(expected_summary["serviceControlEnvelope"]["required"]),
        "serviceOperationCount": len(expected_summary["serviceControlEnvelope"]["operations"]),
        "jobRefRequiredFieldCount": len(expected_summary["jobRef"]["required"]),
        "rendererStatusCount": len(lifecycle_renderer),
        "atomicityDocumentCount": len(atomicity_docs),
        "atomicRepositoryApi": "runInControlTransaction / RecoveryControlTransactionV1",
        "errors": errors,
    }
    return errors, details


def _recovery_control_e00_api_errors(e00_text: str) -> list[str]:
    """Validate the implementable transaction-scoped recovery writer contract."""
    errors: list[str] = []

    repository_match = re.search(
        r"interface RecoveryControlRepository \{\s*(?P<body>.*?)\n\}\s*\n\s*"
        r"interface RecoveryControlTransactionV1",
        e00_text,
        re.DOTALL,
    )
    if not repository_match:
        errors.append("E00 TechDoc missing parseable RecoveryControlRepository interface")
    else:
        repository_body = repository_match.group("body")
        if "runInControlTransaction" not in repository_body:
            errors.append("RecoveryControlRepository missing runInControlTransaction()")
        if "work: (tx: RecoveryControlTransactionV1) => T" not in repository_body:
            errors.append("runInControlTransaction() does not expose an explicit transaction object")
        for forbidden_writer in ("transitionWithRecoveryEvent", "appendObservationEvent"):
            if forbidden_writer in repository_body:
                errors.append(
                    f"RecoveryControlRepository exposes scoped writer at top level: {forbidden_writer}"
                )

    transaction_match = re.search(
        r"interface RecoveryControlTransactionV1 \{\s*(?P<body>.*?)\n\}\s*```",
        e00_text,
        re.DOTALL,
    )
    if not transaction_match:
        errors.append("E00 TechDoc missing parseable RecoveryControlTransactionV1 interface")
    else:
        transaction_body = transaction_match.group("body")
        for required_writer in ("transitionWithRecoveryEvent", "appendObservationEvent"):
            if required_writer not in transaction_body:
                errors.append(
                    f"RecoveryControlTransactionV1 missing scoped writer: {required_writer}"
                )

    observation_input_match = re.search(
        r"interface RecoveryObservationEventInputV1 \{(?P<body>.*?)\n\}",
        e00_text,
        re.DOTALL,
    )
    if not observation_input_match:
        errors.append("E00 TechDoc missing RecoveryObservationEventInputV1")
    else:
        observation_input_body = observation_input_match.group("body")
        expected_observation_fields = {
            "eventId", "eventType", "observationAttemptId", "actionKey", "operationKey", "taskRunId",
            "sourceKind", "sourceRef", "batchId", "intentId", "holdId",
            "recoveryAttemptId", "createdAt", "safePayload",
        }
        actual_observation_fields = set(
            re.findall(
                r"^\s{2}([A-Za-z][A-Za-z0-9]*)\??:",
                observation_input_body,
                re.MULTILINE,
            )
        )
        if actual_observation_fields != expected_observation_fields:
            errors.append(
                "RecoveryObservationEventInputV1 exact fields drift: "
                f"expected={sorted(expected_observation_fields)} "
                f"actual={sorted(actual_observation_fields)}"
            )
        for required_identity_field in (
            "observationAttemptId", "actionKey", "operationKey", "taskRunId",
            "sourceKind", "sourceRef",
        ):
            if f"{required_identity_field}:" not in observation_input_body:
                errors.append(
                    "RecoveryObservationEventInputV1 missing lineage field: "
                    f"{required_identity_field}"
                )
        if "sourceKind: RecoverySourceV1['sourceKind']" not in observation_input_body:
            errors.append("RecoveryObservationEventInputV1 sourceKind must exclude manual holds")
        for forbidden_state_field in (
            "previousState", "nextState", "previous_state", "next_state",
        ):
            if forbidden_state_field in observation_input_body:
                errors.append(
                    "RecoveryObservationEventInputV1 exposes caller-controlled state field: "
                    f"{forbidden_state_field}"
                )
        if "requestHash" in observation_input_body or "request_hash" in observation_input_body:
            errors.append("RecoveryObservationEventInputV1 exposes caller-controlled request hash")

    transition_event_input_match = re.search(
        r"interface RecoveryTransitionEventInputV1 \{(?P<body>.*?)\n\}",
        e00_text,
        re.DOTALL,
    )
    if not transition_event_input_match:
        errors.append("E00 TechDoc missing RecoveryTransitionEventInputV1")
    else:
        transition_event_input_body = transition_event_input_match.group("body")
        actual_transition_event_fields = set(
            re.findall(
                r"^\s{2}([A-Za-z][A-Za-z0-9]*)\??:",
                transition_event_input_body,
                re.MULTILINE,
            )
        )
        if actual_transition_event_fields != {"eventId", "createdAt", "safePayload"}:
            errors.append(
                "RecoveryTransitionEventInputV1 exact fields drift: "
                f"actual={sorted(actual_transition_event_fields)}"
            )
        if "requestHash" in transition_event_input_body or "request_hash" in transition_event_input_body:
            errors.append("RecoveryTransitionEventInputV1 exposes caller-controlled request hash")

    projection_match = re.search(
        r"interface RecoveryEventProjectionV1 \{(?P<body>.*?)\n\}",
        e00_text,
        re.DOTALL,
    )
    expected_projection_fields = set(RESULT_PROJECTION_FIELDS)
    if not projection_match:
        errors.append("E00 TechDoc missing RecoveryEventProjectionV1")
    else:
        actual_projection_fields = set(
            re.findall(
                r"^\s{2}([A-Za-z][A-Za-z0-9]*):",
                projection_match.group("body"),
                re.MULTILINE,
            )
        )
        if actual_projection_fields != expected_projection_fields:
            errors.append(
                "RecoveryEventProjectionV1 exact fields drift: "
                f"expected={sorted(expected_projection_fields)} "
                f"actual={sorted(actual_projection_fields)}"
            )
    for exact_result_fragment in (
        "type RecoveryControlTransitionResultV1 = Readonly<",
        "writer: 'transitionWithRecoveryEvent';",
        "observationAttemptId: null;",
        "type RecoveryObservationEventResultV1 = Readonly<",
        "writer: 'appendObservationEvent';",
        "observationAttemptId: number;",
        "eventType: RecoveryObservationEventTypeV1;",
        "previousState: null;",
        "nextState: null;",
        "sourceKind: RecoverySourceV1['sourceKind'];",
    ):
        if exact_result_fragment not in e00_text:
            errors.append(
                f"E00 TechDoc missing immutable exact result constraint: {exact_result_fragment}"
            )
    if "RecoveryControlTransitionResultV1<T>" in e00_text:
        errors.append("transition result remains generic/current-state dependent")

    observation_union_match = re.search(
        r"type RecoveryObservationEventTypeV1 =(?P<body>.*?);",
        e00_text,
        re.DOTALL,
    )
    if not observation_union_match:
        errors.append("E00 TechDoc missing RecoveryObservationEventTypeV1 union")
        observation_types: set[str] = set()
    else:
        observation_types = set(re.findall(r"'([^']+)'", observation_union_match.group("body")))
        if observation_types != OBSERVATION_EVENT_TYPES:
            errors.append(
                "RecoveryObservationEventTypeV1 drift: "
                f"expected={sorted(OBSERVATION_EVENT_TYPES)} actual={sorted(observation_types)}"
            )

    task_union_match = re.search(
        r"type TaskRunTransitionV1 =(?P<body>.*?)\n\ntype BatchOverlayTransitionV1",
        e00_text,
        re.DOTALL,
    )
    if not task_union_match:
        errors.append("E00 TechDoc missing parseable TaskRunTransitionV1 union")
        task_commands: set[str] = set()
    else:
        task_union_body = task_union_match.group("body")
        if "requestHash:" in task_union_body:
            errors.append("TaskRunTransitionV1 exposes caller-controlled requestHash")
        task_commands = set(re.findall(r"command: '([^']+)'", task_union_body))
        if task_commands != TASK_RECOVERY_COMMANDS:
            errors.append(
                "TaskRunTransitionV1 must contain recovery-related commands only: "
                f"expected={sorted(TASK_RECOVERY_COMMANDS)} actual={sorted(task_commands)}"
            )
        for command in TASK_RECOVERY_COMMANDS:
            command_line = re.search(rf"command: '{re.escape(command)}';(?P<body>[^\n]+)", task_union_body)
            body = command_line.group("body") if command_line else ""
            for field in (
                "actionKey: string", "expectedTaskKey: string", "operationKey: string",
                "taskRunId: string", "sourceKind: RecoverySourceV1['sourceKind'] | null",
                "sourceRef: string | null",
            ):
                if field not in body:
                    errors.append(f"TaskRun {command} missing exact identity field {field}")
        for command in ("mark-interrupted", "complete-recovery-failure", "interrupt-recovery"):
            command_line = re.search(rf"command: '{re.escape(command)}';(?P<body>[^\n]+)", task_union_body)
            body = command_line.group("body") if command_line else ""
            for field in ("failureCode: BoundedFailureCodeV1", "failureMessage: BoundedFailureMessageV1", "metadataPatch: BoundedMetadataPatchV1"):
                if field not in body:
                    errors.append(f"TaskRun {command} missing {field}")
        success_line = re.search(
            r"command: 'complete-recovery-success';(?P<body>[^\n]+)", task_union_body
        )
        success_body = success_line.group("body") if success_line else ""
        if "metadataPatch: BoundedMetadataPatchV1" not in success_body:
            errors.append("complete-recovery-success missing metadataPatch")
        if "failureCode" in success_body or "failureMessage" in success_body:
            errors.append("complete-recovery-success must not accept failure fields")

    command_union_specs = (
        (
            "BatchOverlayTransitionV1",
            r"type BatchOverlayTransitionV1 =(?P<body>.*?)\n\ntype CriticalIntentTransitionV1",
            BATCH_RECOVERY_COMMANDS,
        ),
        (
            "CriticalIntentTransitionV1",
            r"type CriticalIntentTransitionV1 =(?P<body>.*?)\n\ntype RecoveryHoldTransitionV1",
            CRITICAL_INTENT_COMMANDS,
        ),
        (
            "RecoveryHoldTransitionV1",
            r"type RecoveryHoldTransitionV1 =(?P<body>.*?)\n```",
            RECOVERY_HOLD_COMMANDS,
        ),
    )
    for union_name, pattern, expected_commands in command_union_specs:
        union_match = re.search(pattern, e00_text, re.DOTALL)
        if not union_match:
            errors.append(f"E00 TechDoc missing parseable {union_name} union")
            continue
        union_body = union_match.group("body")
        if "requestHash:" in union_body:
            errors.append(f"{union_name} exposes caller-controlled requestHash")
        actual_commands = set(re.findall(r"command: '([^']+)'", union_body))
        if actual_commands != expected_commands:
            errors.append(
                f"{union_name} command drift: expected={sorted(expected_commands)} "
                f"actual={sorted(actual_commands)}"
            )

    exact_branch_fields = {
        "TaskRunTransitionV1": {
            "mark-interrupted": {
                "entityKind", "command", "actionKey", "expectedTaskKey", "operationKey",
                "taskRunId", "sourceKind", "sourceRef", "expectedState", "failureCode",
                "failureMessage", "metadataPatch",
            },
            "begin-recovery": {
                "entityKind", "command", "actionKey", "expectedTaskKey", "operationKey",
                "taskRunId", "sourceKind", "sourceRef", "expectedState",
                "recoveryAttemptId", "metadataPatch",
            },
            "complete-recovery-success": {
                "entityKind", "command", "actionKey", "expectedTaskKey", "operationKey",
                "taskRunId", "sourceKind", "sourceRef", "expectedState",
                "recoveryAttemptId", "metadataPatch",
            },
            "complete-recovery-failure": {
                "entityKind", "command", "actionKey", "expectedTaskKey", "operationKey",
                "taskRunId", "sourceKind", "sourceRef", "expectedState",
                "recoveryAttemptId", "failureCode", "failureMessage", "metadataPatch",
            },
            "interrupt-recovery": {
                "entityKind", "command", "actionKey", "expectedTaskKey", "operationKey",
                "taskRunId", "sourceKind", "sourceRef", "expectedState",
                "recoveryAttemptId", "failureCode", "failureMessage", "metadataPatch",
            },
        },
        "CriticalIntentTransitionV1": {
            "create-prepared": {"entityKind", "command", "input"},
            "mark-acked": {"entityKind", "command", "intentId", "expectedState", "patch"},
            "mark-committed": {"entityKind", "command", "intentId", "expectedState", "receiptRef"},
            "mark-recovered": {"entityKind", "command", "intentId", "expectedState", "inspection"},
            "close": {"entityKind", "command", "intentId", "expectedState", "result"},
        },
        "RecoveryHoldTransitionV1": {
            "create-or-get": {"entityKind", "command", "input"},
            "resolve": {"entityKind", "command", "holdId", "expectedState", "resolution", "evidence"},
        },
    }
    union_bodies = {
        "TaskRunTransitionV1": task_union_match.group("body") if task_union_match else "",
        "CriticalIntentTransitionV1": (
            re.search(
                r"type CriticalIntentTransitionV1 =(?P<body>.*?)\n\ntype RecoveryHoldTransitionV1",
                e00_text,
                re.DOTALL,
            ).group("body")
            if re.search(
                r"type CriticalIntentTransitionV1 =(?P<body>.*?)\n\ntype RecoveryHoldTransitionV1",
                e00_text,
                re.DOTALL,
            )
            else ""
        ),
        "RecoveryHoldTransitionV1": (
            re.search(
                r"type RecoveryHoldTransitionV1 =(?P<body>.*?)\n```",
                e00_text,
                re.DOTALL,
            ).group("body")
            if re.search(
                r"type RecoveryHoldTransitionV1 =(?P<body>.*?)\n```",
                e00_text,
                re.DOTALL,
            )
            else ""
        ),
    }
    for union_name, branches in exact_branch_fields.items():
        union_body = union_bodies[union_name]
        for command, expected_fields in branches.items():
            line = re.search(
                rf"\| \{{[^\n]*command: '{re.escape(command)}';(?P<body>[^\n]+)",
                union_body,
            )
            if not line:
                errors.append(f"{union_name}.{command} exact branch is not parseable")
                continue
            actual_fields = set(
                re.findall(r"\b([A-Za-z][A-Za-z0-9]*):", line.group(0))
            )
            if actual_fields != expected_fields:
                errors.append(
                    f"{union_name}.{command} exact fields drift: "
                    f"expected={sorted(expected_fields)} actual={sorted(actual_fields)}"
                )

    batch_union_match = re.search(
        r"type BatchOverlayTransitionV1 =(?P<body>.*?)\n\ntype CriticalIntentTransitionV1",
        e00_text,
        re.DOTALL,
    )
    if batch_union_match:
        batch_union_body = batch_union_match.group("body")
        expected_batch_fields = {
            "mark-interrupted": {
                "entityKind", "command", "actionKey", "expectedTaskKey", "operationKey",
                "batchId", "taskRunId", "expectedState", "failureCode", "failureMessage",
                "sourceKind", "sourceRef",
            },
            "begin-recovery": {
                "entityKind", "command", "actionKey", "expectedTaskKey", "operationKey",
                "batchId", "taskRunId", "expectedState", "recoveryAttemptId",
                "sourceKind", "sourceRef",
            },
            "resolve-success": {
                "entityKind", "command", "actionKey", "expectedTaskKey", "operationKey",
                "batchId", "taskRunId", "expectedState", "recoveryAttemptId",
                "finalOutcome", "sourceKind", "sourceRef",
            },
            "resolve-failure": {
                "entityKind", "command", "actionKey", "expectedTaskKey", "operationKey",
                "batchId", "taskRunId", "expectedState", "recoveryAttemptId",
                "finalOutcome", "sourceKind", "sourceRef",
            },
        }
        expected_batch_fragments = {
            "mark-interrupted": (
                "expectedState: null", "failureCode: BoundedFailureCodeV1",
                "failureMessage: BoundedFailureMessageV1",
            ),
            "begin-recovery": (
                "expectedState: 'interrupted'", "recoveryAttemptId: string",
            ),
            "resolve-success": (
                "expectedState: 'recovering'", "recoveryAttemptId: string",
                "finalOutcome: 'succeeded'",
            ),
            "resolve-failure": (
                "expectedState: 'recovering'", "recoveryAttemptId: string",
                "finalOutcome: 'failed'",
            ),
        }
        for command, expected_fields in expected_batch_fields.items():
            command_line = re.search(
                rf"\| \{{ entityKind: 'batch-overlay'; command: '{re.escape(command)}';(?P<body>[^\n]+)",
                batch_union_body,
            )
            if not command_line:
                errors.append(f"BatchOverlay {command} command is not parseable")
                continue
            full_command = command_line.group(0)
            actual_fields = set(re.findall(r"\b([A-Za-z][A-Za-z0-9]*):", full_command))
            if actual_fields != expected_fields:
                errors.append(
                    f"BatchOverlay {command} exact fields drift: "
                    f"expected={sorted(expected_fields)} actual={sorted(actual_fields)}"
                )
            for identity_fragment in (
                "actionKey: string", "expectedTaskKey: string", "operationKey: string",
                "batchId: number", "taskRunId: string",
                "sourceKind: RecoveryHoldSourceKindV1", "sourceRef: string",
            ):
                if identity_fragment not in full_command:
                    errors.append(
                        f"BatchOverlay {command} missing exact identity field {identity_fragment}"
                    )
            for command_fragment in expected_batch_fragments[command]:
                if command_fragment not in full_command:
                    errors.append(
                        f"BatchOverlay {command} command contract drift: {command_fragment}"
                    )

    for interface_name, expected_fields in (
        (
            "PreparedIntentInput",
            {
                "contractVersion", "intentId", "actionKey", "operationKey", "taskRunId",
                "jobId", "coordinationKind", "conflictScopeKey", "inspectorKey",
                "evidenceVersion", "evidenceHash", "boundedEvidence",
            },
        ),
        (
            "RecoveryHoldCreateInput",
            {
                "contractVersion", "holdId", "sourceKind", "sourceRef", "intentId",
                "actionKey", "operationKey", "taskRunId", "conflictScopeKey",
                "reasonCode", "safeSummary", "evidenceHash",
            },
        ),
    ):
        match = re.search(
            rf"interface {interface_name} \{{(?P<body>.*?)\n\}}", e00_text, re.DOTALL
        )
        if not match:
            errors.append(f"E00 TechDoc missing {interface_name}")
            continue
        actual_fields = set(
            re.findall(r"^\s{2}([A-Za-z][A-Za-z0-9]*):", match.group("body"), re.MULTILINE)
        )
        if actual_fields != expected_fields:
            errors.append(
                f"{interface_name} exact fields drift: expected={sorted(expected_fields)} "
                f"actual={sorted(actual_fields)}"
            )
        if interface_name == "PreparedIntentInput":
            expected_coordination = (
                "coordinationKind: 'worker-critical' | 'main-owned-settlement';"
            )
            if expected_coordination not in match.group("body"):
                errors.append(
                    "PreparedIntentInput coordinationKind must be exactly "
                    "worker-critical | main-owned-settlement"
                )

    coordination_sql = (
        "coordination_kind IN ('worker-critical', 'main-owned-settlement')"
    )
    coordination_policy = (
        "`coordination_kind` 由 policy 推导：`worker-durable` 使用 `worker-critical`；"
        "`main-settlement + target-post-image` 使用 `main-owned-settlement`。"
    )
    if coordination_sql not in e00_text:
        errors.append("Critical Intent SQL coordination_kind CHECK drift")
    if coordination_policy not in e00_text:
        errors.append("coordinationKind policy derivation table drift")

    for explicit_type in (
        "patch: BoundedIntentPatchV1",
        "receiptRef: BoundedReceiptRefV1",
        "inspection: RecoveryInspectionResultV1",
        "result: BoundedRecoveryResultV1",
        "resolution: Resolution; evidence: BoundedRecoveryEvidenceV1",
    ):
        if explicit_type not in e00_text:
            errors.append(f"recovery transition still has undefined/unbounded field: {explicit_type}")
    if "type Resolution = 'committed' | 'not-committed' | 'compensated' | 'manual-override';" not in e00_text:
        errors.append("Resolution enum drift")

    try:
        documented_transition_event_map = _extract_marked_json(
            e00_text,
            "<!-- BEGIN RECOVERY_TRANSITION_EVENT_MAP_V1 -->",
            "<!-- END RECOVERY_TRANSITION_EVENT_MAP_V1 -->",
        )
    except (ValueError, json.JSONDecodeError) as exc:
        errors.append(f"E00 transition event map unreadable: {exc}")
        documented_transition_event_map = {}
    if documented_transition_event_map != TRANSITION_EVENT_MAP_V1:
        errors.append(
            "RECOVERY_TRANSITION_EVENT_MAP_V1 drift: "
            f"expected={TRANSITION_EVENT_MAP_V1!r} actual={documented_transition_event_map!r}"
        )

    mark_recovered_match = re.search(
        r"command: 'mark-recovered';(?P<body>[^\n]+)",
        e00_text,
    )
    if not mark_recovered_match:
        errors.append("E00 TechDoc missing critical-intent mark-recovered command")
    else:
        mark_recovered_body = mark_recovered_match.group("body")
        if "expectedState: 'prepared' | 'acked'" not in mark_recovered_body:
            errors.append("mark-recovered expectedState must be exactly prepared | acked")
        if "'committed'" in mark_recovered_body:
            errors.append("mark-recovered must reject committed Critical Intent")

    attempt_ddl_match = re.search(
        r"CREATE TABLE IF NOT EXISTS background_execution_recovery_observation_attempts \("
        r"(?P<body>.*?)\n\);",
        e00_text,
        re.DOTALL,
    )
    if not attempt_ddl_match:
        errors.append("E00 TechDoc missing durable observation attempt DDL")
    else:
        attempt_ddl = attempt_ddl_match.group("body")
        for required_attempt_fragment in (
            "observation_scope_key TEXT NOT NULL",
            "observation_attempt_id INTEGER NOT NULL CHECK",
            "request_key TEXT UNIQUE",
            "status TEXT NOT NULL CHECK (status IN ('prepared', 'committed'))",
            "PRIMARY KEY(observation_scope_key, observation_attempt_id)",
            "UNIQUE(observation_scope_key, observation_attempt_id, request_key)",
            "observation_attempt_id <= 9007199254740991",
        ):
            if required_attempt_fragment not in attempt_ddl:
                errors.append(
                    f"observation attempt DDL missing: {required_attempt_fragment}"
                )

    owner_ddl_match = re.search(
        r"CREATE TABLE IF NOT EXISTS background_execution_recovery_request_owners \("
        r"(?P<body>.*?)\n\);",
        e00_text,
        re.DOTALL,
    )
    if not owner_ddl_match:
        errors.append("E00 TechDoc missing persistent recovery request owner DDL")
    else:
        owner_ddl = owner_ddl_match.group("body")
        for required_owner_fragment in (
            "request_key TEXT NOT NULL UNIQUE",
            "event_id TEXT NOT NULL UNIQUE",
            "request_hash TEXT NOT NULL CHECK",
            "request_jcs TEXT NOT NULL",
            "status TEXT NOT NULL CHECK (status IN ('prepared', 'committed'))",
            "created_at TEXT NOT NULL",
            "committed_at TEXT",
            "UNIQUE(request_key, writer, event_id, request_hash, created_at)",
            "length(request_hash) = 64",
            "request_hash NOT GLOB '*[^0-9a-f]*'",
        ):
            if required_owner_fragment not in owner_ddl:
                errors.append(
                    f"recovery request owner DDL missing: {required_owner_fragment}"
                )

    recovery_event_ddl_match = re.search(
        r"CREATE TABLE IF NOT EXISTS background_execution_recovery_events \("
        r"(?P<body>.*?)\n\);",
        e00_text,
        re.DOTALL,
    )
    if not recovery_event_ddl_match:
        errors.append("E00 TechDoc missing parseable recovery event DDL")
    else:
        recovery_event_ddl = recovery_event_ddl_match.group("body")
        if "OR (previous_state IS NULL AND next_state IS NULL)" not in recovery_event_ddl:
            errors.append("recovery event DDL does not enforce NULL states for observation events")
        for lineage_column in (
            "request_key TEXT NOT NULL UNIQUE",
            "writer TEXT NOT NULL CHECK",
            "request_hash TEXT NOT NULL",
            "action_key TEXT NOT NULL",
            "operation_key TEXT NOT NULL",
            "task_run_id TEXT NOT NULL",
            "source_kind TEXT",
            "source_ref TEXT",
            "observation_scope_key TEXT",
            "observation_attempt_id INTEGER",
        ):
            if lineage_column not in recovery_event_ddl:
                errors.append(f"recovery event DDL missing audit lineage column: {lineage_column}")
        if "(source_kind IS NULL AND source_ref IS NULL)" not in recovery_event_ddl:
            errors.append("recovery event DDL does not enforce paired source identity")
        if "source_kind IS NULL OR source_kind IN" not in recovery_event_ddl:
            errors.append("recovery event DDL does not constrain source kind")
        for event_type in OBSERVATION_EVENT_TYPES:
            if f"'{event_type}'" not in recovery_event_ddl:
                errors.append(f"recovery event DDL missing observation event type {event_type}")
        for hash_constraint in (
            "length(request_hash) = 64",
            "request_hash NOT GLOB '*[^0-9a-f]*'",
            "FOREIGN KEY(request_key, writer, event_id, request_hash, created_at)",
            "request_key, writer, event_id, request_hash, created_at",
            "FOREIGN KEY(observation_scope_key, observation_attempt_id, request_key)",
            "observation_scope_key, observation_attempt_id, request_key",
        ):
            if hash_constraint not in recovery_event_ddl:
                errors.append(f"recovery event DDL missing request integrity gate: {hash_constraint}")
    for required_runtime_rule in (
        "回调不得返回 Promise",
        "不得嵌套调用另一个 `runInControlTransaction()`",
        "不得跨 `await inspector()` 或 `await provider.recover()` 持有 SQLite control transaction",
        "Batch overlay 只允许 `absent → interrupted → recovering → resolved`",
        "基础 `task_status` 写为兼容值 `failed`、创建 overlay `interrupted` 并追加 `batch-overlay-transitioned`",
        "Hold 扫描必须以 Hold 表的 durable UNIQUE `(sourceKind, sourceRef)` 先重算 requestKey",
        "同 source pair 但 owner tuple 任一项不同必须裁决为 `unknown`",
        "Inspector/Provider 调用数均为 0",
        "allocateNextObservationAttempt(scope)",
        "resumePreparedObservationAttempt(scope)",
        "owner reserve 前已持久的 attempt row",
        "同 scope 的下一次真实 observation 必须先分配下一 ordinal",
        "RecoveryRequestOwnerRepositoryV1",
        "prepared → committed",
        "RECOVERY_REQUEST_KEY_CONFLICT",
        "`recover(source, inspection)` 必须按 `(sourceKind, sourceRef, operationKey)` 幂等",
        "`archive_task_runs.task_key === expectedTaskKey`",
        "`archive_task_runs.operation_key === operationKey`",
        "event.action_key 记录经 adapter 验证的 canonical actionKey",
        "每个 Batch overlay command 同样必须显式携带 canonical `actionKey`",
        "目标 Batch 的 `archive_batches.id/task_run_id/task_key/operation_key` identity",
        "`archive_batches.id === batchId`",
        "只有 recovery overlay 表使用 `overlay.batch_id`",
        "`event.action_key` 只能取 command 中已验证的 canonical `actionKey`",
        "`transitionWithRecoveryEvent()` 的 envelope exact 为 `{ contractVersion: 1, writer: 'transitionWithRecoveryEvent', input: { transition, event } }`",
        "`appendObservationEvent()` 的 envelope exact 为 `{ contractVersion: 1, writer: 'appendObservationEvent', input: { event } }`",
        "RFC 8785/JCS UTF-8 bytes 计算 lowercase `[0-9a-f]{64}` SHA-256",
        "公共输入不得接受 caller-controlled `requestHash`",
        "Repository 必须在任何 state CAS 之前按 `requestKey` 读取已持久 owner",
        "owner 为 committed 时再按 requestKey/eventId/hash 读取 event 并返回已提交结果",
        "逐字段返回首次调用的 immutable projection A",
        "不得附加 `replayed=true`",
        "platform-recovery-control-v1.schema.json",
        "additionalProperties: false",
        "source 只有一项为 null 均 fail closed",
        "真实持久枚举始终写 `interrupted → running`",
        "`safePayload` 只记录 writer 完成后的 bounded 审计结果",
        "`toStatus='succeeded'` 时 API 必须拒绝 `failureCode/failureMessage`",
        "RFC 8785/JCS canonical JSON",
        "JCS([namespace, ...identityValues])",
        "recovery-control/v1/transition/task-run/mark-interrupted",
        "recovery-control/v1/observation/settlement-failed-transient",
        "[-9007199254740991, 9007199254740991]",
        "最大 16384 bytes",
        "不含完整业务行或账号",
        "status 固定由 Repository 写为 `active`",
        "`Resolution` 精确为 `committed | not-committed | compensated | manual-override`",
        "not-committed + cancelled → cancelled（仅限 live execution 在进入 critical/protected 前，由 normal TaskLifecycle 完成）",
        "上述 cancelled 映射不适用于 startup/transport-loss recovery",
        "SELECT changes(); -- MUST equal 1",
        "WHERE batch.id = :batchId",
        "AND batch.task_key = :expectedTaskKey",
        "AND batch.operation_key = :operationKey",
        "AND task.task_key = :expectedTaskKey",
        "AND task.operation_key = :operationKey",
        "WHERE id = :batchId",
        "AND task_status IN ('reserved', 'running')",
        "WHERE overlay.batch_id = :batchId",
        "AND overlay.recovery_attempt_id = :recoveryAttemptId",
        "event.request_hash AS requestHash",
        "event.observation_attempt_id AS observationAttemptId",
        "WHERE event.request_key = :requestKey",
    ):
        if required_runtime_rule not in e00_text:
            errors.append(f"E00 TechDoc missing transaction runtime rule: {required_runtime_rule}")

    return errors


def validator_for_definition(
    schema: dict[str, Any], definition: str
) -> Draft202012Validator:
    return Draft202012Validator(
        {
            "$schema": schema["$schema"],
            "$ref": f"#/$defs/{definition}",
            "$defs": schema["$defs"],
        },
        format_checker=FormatChecker(),
    )


def _leaf_paths(value: Any, prefix: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    if isinstance(value, dict):
        if not value:
            return [prefix]
        return [path for key, child in value.items() for path in _leaf_paths(child, prefix + (key,))]
    if isinstance(value, list):
        if not value:
            return [prefix]
        return [path for index, child in enumerate(value) for path in _leaf_paths(child, prefix + (index,))]
    return [prefix]


def _mutate_leaf(value: Any, path: tuple[Any, ...]) -> Any:
    mutated = copy.deepcopy(value)
    if not path:
        return {"mutation": True}
    parent = mutated
    for component in path[:-1]:
        parent = parent[component]
    key = path[-1]
    current = parent[key]
    if current is None:
        replacement: Any = "present-after-null"
    elif isinstance(current, bool):
        replacement = not current
    elif isinstance(current, int):
        replacement = current + 1
    elif isinstance(current, float):
        replacement = current + 1.0
    elif isinstance(current, str):
        replacement = current + "~"
    elif isinstance(current, dict):
        replacement = {"mutation": True}
    elif isinstance(current, list):
        replacement = current + ["mutation"]
    else:  # pragma: no cover - fixtures remain JSON-domain values
        raise TypeError(f"unsupported leaf type: {type(current).__name__}")
    parent[key] = replacement
    return mutated


def _json_pointer_get(value: Any, pointer_value: str) -> Any:
    current = value
    for raw_component in pointer_value.split("/")[1:]:
        component = raw_component.replace("~1", "/").replace("~0", "~")
        if not isinstance(current, dict) or component not in current:
            return None
        current = current[component]
    return current


def _derive_request_key(
    request: dict[str, Any], branch_contract: dict[str, Any], prefix: str
) -> str:
    identity_values = [
        _json_pointer_get(request, pointer_value)
        for pointer_value in branch_contract["identityPaths"]
    ]
    return prefix + jcs_json_sha256([branch_contract["namespace"], *identity_values])


def _expected_result_projection(
    item: dict[str, Any],
    writer: str,
    branch: dict[str, Any],
    cas: dict[str, Any] | None,
    request_key_prefix: str,
) -> tuple[dict[str, Any] | None, list[str]]:
    """Derive the immutable event result from exact request + persisted CAS evidence."""
    errors: list[str] = []
    request = item.get("request")
    if not isinstance(request, dict) or not isinstance(request.get("event"), dict):
        return None, ["request/event missing"]
    event = request["event"]
    if not isinstance(branch, dict) or "namespace" not in branch:
        return None, ["requestKey branch missing"]
    try:
        request_key = _derive_request_key(request, branch, request_key_prefix)
        request_hash = jcs_json_sha256({
            "contractVersion": 1,
            "writer": writer,
            "input": request,
        })
    except (KeyError, TypeError, ValueError) as exc:
        return None, [f"cannot derive owner identity: {exc}"]

    if item.get("requestKey") != request_key:
        errors.append("fixture requestKey does not equal derived owner key")

    if writer == "appendObservationEvent":
        lineage = {
            field: event.get(field)
            for field in (
                "actionKey", "operationKey", "taskRunId", "sourceKind", "sourceRef",
                "batchId", "intentId", "holdId", "recoveryAttemptId",
                "observationAttemptId",
            )
        }
        event_type = event.get("eventType")
        previous_state = None
        next_state = None
    else:
        if not isinstance(cas, dict):
            return None, ["persisted CAS projection missing"]
        expected_cas_fields = {
            "casChanges", "expectedTaskKey", "actionKey", "operationKey", "taskRunId",
            "sourceKind", "sourceRef", "batchId", "intentId", "holdId",
            "recoveryAttemptId", "previousState", "nextState",
        }
        if set(cas) != expected_cas_fields:
            errors.append("persisted CAS projection exact fields drift")
        if cas.get("casChanges") != 1:
            errors.append("persisted CAS must report changes=1")
        transition = request.get("transition")
        if not isinstance(transition, dict):
            return None, errors + ["transition missing"]
        entity_kind = transition.get("entityKind")
        command = transition.get("command")
        request_owner: dict[str, Any] = {}
        if entity_kind in {"task-run", "batch-overlay"}:
            request_owner = {
                "actionKey": transition.get("actionKey"),
                "operationKey": transition.get("operationKey"),
                "taskRunId": transition.get("taskRunId"),
                "sourceKind": transition.get("sourceKind"),
                "sourceRef": transition.get("sourceRef"),
                "batchId": transition.get("batchId"),
                "recoveryAttemptId": transition.get("recoveryAttemptId"),
                "expectedTaskKey": transition.get("expectedTaskKey"),
            }
        elif entity_kind == "critical-intent":
            input_value = transition.get("input")
            if isinstance(input_value, dict):
                request_owner = {
                    "actionKey": input_value.get("actionKey"),
                    "operationKey": input_value.get("operationKey"),
                    "taskRunId": input_value.get("taskRunId"),
                    "intentId": input_value.get("intentId"),
                }
            else:
                request_owner = {"intentId": transition.get("intentId")}
        elif entity_kind == "recovery-hold":
            input_value = transition.get("input")
            if isinstance(input_value, dict):
                request_owner = {
                    "actionKey": input_value.get("actionKey"),
                    "operationKey": input_value.get("operationKey"),
                    "taskRunId": input_value.get("taskRunId"),
                    "sourceKind": input_value.get("sourceKind"),
                    "sourceRef": input_value.get("sourceRef"),
                    "intentId": input_value.get("intentId"),
                    "holdId": input_value.get("holdId"),
                }
            else:
                request_owner = {"holdId": transition.get("holdId")}
        for field, value in request_owner.items():
            if value != cas.get(field):
                errors.append(f"request/CAS owner mismatch: {field}")
        lineage = {
            field: cas.get(field)
            for field in (
                "actionKey", "operationKey", "taskRunId", "sourceKind", "sourceRef",
                "batchId", "intentId", "holdId", "recoveryAttemptId",
            )
        }
        lineage["observationAttemptId"] = None
        event_type = TRANSITION_EVENT_MAP_V1.get(f"{entity_kind}.{command}")
        previous_state = cas.get("previousState")
        next_state = cas.get("nextState")

    projection = {
        "contractVersion": 1,
        "requestKey": request_key,
        "writer": writer,
        "eventId": event.get("eventId"),
        "requestHash": request_hash,
        "actionKey": lineage.get("actionKey"),
        "operationKey": lineage.get("operationKey"),
        "taskRunId": lineage.get("taskRunId"),
        "sourceKind": lineage.get("sourceKind"),
        "sourceRef": lineage.get("sourceRef"),
        "batchId": lineage.get("batchId"),
        "intentId": lineage.get("intentId"),
        "holdId": lineage.get("holdId"),
        "recoveryAttemptId": lineage.get("recoveryAttemptId"),
        "observationAttemptId": lineage.get("observationAttemptId"),
        "eventType": event_type,
        "previousState": previous_state,
        "nextState": next_state,
        "safePayload": event.get("safePayload"),
        "createdAt": event.get("createdAt"),
    }
    if list(projection) != RESULT_PROJECTION_FIELDS:
        errors.append("derived projection field order/inventory drift")
    return projection, errors


def _result_projection_known_answers(
    fixtures: dict[str, Any],
) -> tuple[list[str], dict[str, dict[str, Any]], dict[str, Any]]:
    """Load the manually frozen 20-result authority without deriving its values."""
    errors: list[str] = []
    authority = contract_authority()
    result_authority = recovery_result_projection_authority()
    authority_ref = {
        "path": "changes/background-execution/recovery-contract-authority.v1.json",
        "contractVersion": authority.get("contractVersion"),
        "revision": authority.get("revision"),
        "genesis": authority.get("genesis"),
        "approvalStatus": authority.get("approvalStatus"),
        "gitGenesisRequiresVerifiedPreviousAbsence": authority.get(
            "changeControl", {}
        ).get("gitGenesisRequiresVerifiedPreviousAbsence"),
    }
    contract = fixtures.get("resultProjectionKnownAnswerContract", {})
    answers = fixtures.get("resultProjectionKnownAnswers", [])
    expected_contract = {
        "contractVersion": result_authority.get("sourceContractVersion"),
        "contractAuthority": authority_ref,
        "canonicalization": authority.get("canonicalization"),
        "preimage": result_authority.get("knownAnswerPreimage"),
        "knownAnswerCount": result_authority.get("expectedKnownAnswerCount"),
        "projectionFieldCount": result_authority.get("expectedProjectionFieldCount"),
        "sha256": result_authority.get("knownAnswerSha256"),
    }
    if contract != expected_contract:
        errors.append("result projection KAT contract version/count/digest drift")
    if not isinstance(answers, list):
        return errors + ["result projection known answers must be an array"], {}, {
            "contract": contract,
            "errors": errors + ["result projection known answers must be an array"],
        }
    try:
        actual_digest = jcs_json_sha256(answers)
    except (TypeError, ValueError) as exc:
        actual_digest = ""
        errors.append(f"result projection KAT JCS failed: {exc}")
    if actual_digest != result_authority.get("knownAnswerSha256"):
        errors.append(
            "result projection KAT digest drift: "
            f"expected={result_authority.get('knownAnswerSha256')} actual={actual_digest}"
        )

    answer_by_name: dict[str, dict[str, Any]] = {}
    ordered_names: list[str] = []
    for index, answer in enumerate(answers):
        if not isinstance(answer, dict) or set(answer) != {
            "requestName", "writer", "projection",
        }:
            errors.append(f"result projection KAT[{index}] exact shape drift")
            continue
        request_name = answer.get("requestName")
        writer = answer.get("writer")
        projection = answer.get("projection")
        if not isinstance(request_name, str) or request_name in answer_by_name:
            errors.append(f"result projection KAT[{index}] duplicate/invalid requestName")
            continue
        if writer not in {"transitionWithRecoveryEvent", "appendObservationEvent"}:
            errors.append(f"result projection KAT[{index}] writer drift")
        if not isinstance(projection, dict) or list(projection) != RESULT_PROJECTION_FIELDS:
            errors.append(f"result projection KAT[{index}] exact 20-field order drift")
            continue
        if projection.get("writer") != writer:
            errors.append(f"result projection KAT[{index}] writer/projection mismatch")
        ordered_names.append(request_name)
        answer_by_name[request_name] = projection

    expected_names = [
        item.get("name")
        for item in fixtures.get("transitionRequests", [])
        + fixtures.get("observationRequests", [])
        if isinstance(item, dict)
    ]
    if ordered_names != expected_names or len(answer_by_name) != 20:
        errors.append("result projection KAT exact 20-branch inventory/order drift")
    return errors, answer_by_name, {
        "contractVersion": contract.get("contractVersion"),
        "knownAnswerCount": len(answer_by_name),
        "projectionFieldCount": contract.get("projectionFieldCount"),
        "sha256": actual_digest,
        "errors": errors,
    }


def _mutated_projection_value(field: str, current: Any, writer: str) -> Any:
    if field == "contractVersion":
        return 2
    if field == "requestKey":
        return "recovery-control:v1:" + ("e" if current != "recovery-control:v1:" + "e" * 64 else "d") * 64
    if field == "writer":
        return (
            "appendObservationEvent"
            if writer == "transitionWithRecoveryEvent"
            else "transitionWithRecoveryEvent"
        )
    if field == "requestHash":
        return ("e" if current != "e" * 64 else "d") * 64
    if field == "sourceKind":
        return "existing-protocol" if current != "existing-protocol" else "module-recovery"
    if field == "eventType" and writer == "appendObservationEvent":
        return (
            "inspection-completed"
            if current != "inspection-completed"
            else "inspection-failed-transient"
        )
    if field == "safePayload":
        return {"resultProjectionMutation": field}
    if field in {"batchId", "observationAttemptId"}:
        return 1 if current is None else current + 1
    if current is None:
        return f"wrong-{field}"
    if isinstance(current, str):
        return current + "~wrong"
    if isinstance(current, int):
        return current + 1
    raise TypeError(f"unsupported result projection mutation: {field}/{type(current).__name__}")


def _mutated_projection_from_sources(
    item: dict[str, Any],
    writer: str,
    branch: dict[str, Any],
    cas: dict[str, Any] | None,
    request_key_prefix: str,
    field: str,
    known_answer: dict[str, Any],
) -> tuple[dict[str, Any] | None, str, list[str]]:
    """Mutate a real request/CAS source where possible; otherwise mutate mapper output."""
    mutated_item = copy.deepcopy(item)
    mutated_cas = copy.deepcopy(cas)
    request = mutated_item.get("request", {})
    event = request.get("event", {})
    next_value = _mutated_projection_value(field, known_answer.get(field), writer)
    mutation_source = "result-mapper"

    common_event_fields = {"eventId", "safePayload", "createdAt"}
    lineage_fields = {
        "actionKey", "operationKey", "taskRunId", "sourceKind", "sourceRef",
        "batchId", "intentId", "holdId", "recoveryAttemptId",
        "observationAttemptId",
    }
    if field in common_event_fields:
        event[field] = next_value
        mutation_source = "request.event"
    elif writer == "appendObservationEvent" and field in lineage_fields | {"eventType"}:
        event[field] = next_value
        mutation_source = "request.event"
    elif writer == "transitionWithRecoveryEvent" and field in {
        "previousState", "nextState",
    }:
        if isinstance(mutated_cas, dict):
            mutated_cas[field] = next_value
            mutation_source = "persisted-cas"
    elif writer == "transitionWithRecoveryEvent" and field in lineage_fields - {
        "observationAttemptId",
    }:
        if isinstance(mutated_cas, dict):
            mutated_cas[field] = next_value
        transition = request.get("transition", {})
        transition_input = transition.get("input")
        if field in transition:
            transition[field] = next_value
            mutation_source = "request.transition+persisted-cas"
        elif isinstance(transition_input, dict) and field in transition_input:
            transition_input[field] = next_value
            mutation_source = "request.transition.input+persisted-cas"
        else:
            mutation_source = "persisted-cas"

    if mutation_source != "result-mapper":
        try:
            mutated_item["requestKey"] = _derive_request_key(
                request, branch, request_key_prefix
            )
        except (KeyError, TypeError, ValueError) as exc:
            return None, mutation_source, [f"mutated requestKey derivation failed: {exc}"]
    projection, mapper_errors = _expected_result_projection(
        mutated_item,
        writer,
        branch,
        mutated_cas,
        request_key_prefix,
    )
    if projection is not None and mutation_source == "result-mapper":
        projection[field] = next_value
    return projection, mutation_source, mapper_errors


def _result_projection_sql_bundle() -> tuple[str, str]:
    e00_text = E00_TECHDOC_PATH.read_text(encoding="utf-8")
    ddl_parts: list[str] = []
    for table_name in (
        "background_execution_recovery_observation_attempts",
        "background_execution_recovery_request_owners",
        "background_execution_recovery_events",
    ):
        match = re.search(
            rf"CREATE TABLE IF NOT EXISTS {table_name} \([\s\S]*?\n\);",
            e00_text,
        )
        if not match:
            raise ValueError(f"result KAT missing executable DDL: {table_name}")
        ddl_parts.append(match.group(0))
    return "\n".join(ddl_parts), _marked_body(
        e00_text, "PHYSICAL_SQL_IMMUTABLE_RESULT_V1", fenced_sql=True
    )


def _sqlite_round_trip_result_projection(
    stored_projection: dict[str, Any],
    request_name: str,
    ddl: str,
    immutable_result_sql: str,
    result_mapper_override: tuple[str, Any] | None = None,
) -> tuple[dict[str, Any] | None, list[str]]:
    """Persist through the normative owner/event DDL and read through immutable SQL."""
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    errors: list[str] = []
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(ddl)
        connection.execute(
            """
            INSERT INTO background_execution_recovery_request_owners (
              request_key, writer, event_id, request_hash, request_jcs,
              status, created_at, committed_at
            ) VALUES (?, ?, ?, ?, '{}', 'committed', ?, ?)
            """,
            (
                stored_projection["requestKey"], stored_projection["writer"],
                stored_projection["eventId"], stored_projection["requestHash"],
                stored_projection["createdAt"], stored_projection["createdAt"],
            ),
        )
        observation_scope_key = None
        if stored_projection["writer"] == "appendObservationEvent":
            observation_scope_key = "result-kat:v1:" + hashlib.sha256(
                request_name.encode("utf-8")
            ).hexdigest()
            connection.execute(
                """
                INSERT INTO background_execution_recovery_observation_attempts (
                  observation_scope_key, observation_attempt_id, event_type,
                  action_key, operation_key, task_run_id, source_kind, source_ref,
                  batch_id, intent_id, hold_id, recovery_attempt_id,
                  request_key, status, prepared_at, committed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?)
                """,
                (
                    observation_scope_key, stored_projection["observationAttemptId"],
                    stored_projection["eventType"], stored_projection["actionKey"],
                    stored_projection["operationKey"], stored_projection["taskRunId"],
                    stored_projection["sourceKind"], stored_projection["sourceRef"],
                    stored_projection["batchId"], stored_projection["intentId"],
                    stored_projection["holdId"], stored_projection["recoveryAttemptId"],
                    stored_projection["requestKey"], stored_projection["createdAt"],
                    stored_projection["createdAt"],
                ),
            )
        connection.execute(
            """
            INSERT INTO background_execution_recovery_events (
              request_key, writer, event_id, request_hash, action_key, operation_key,
              task_run_id, source_kind, source_ref, batch_id, intent_id, hold_id,
              recovery_attempt_id, observation_scope_key, observation_attempt_id,
              event_type, previous_state, next_state, safe_payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                stored_projection["requestKey"], stored_projection["writer"],
                stored_projection["eventId"], stored_projection["requestHash"],
                stored_projection["actionKey"], stored_projection["operationKey"],
                stored_projection["taskRunId"], stored_projection["sourceKind"],
                stored_projection["sourceRef"], stored_projection["batchId"],
                stored_projection["intentId"], stored_projection["holdId"],
                stored_projection["recoveryAttemptId"], observation_scope_key,
                stored_projection["observationAttemptId"], stored_projection["eventType"],
                stored_projection["previousState"], stored_projection["nextState"],
                json.dumps(
                    stored_projection["safePayload"],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                stored_projection["createdAt"],
            ),
        )
        result_sql = immutable_result_sql
        parameters = {
            "requestKey": stored_projection["requestKey"],
            "eventId": stored_projection["eventId"],
            "requestHash": stored_projection["requestHash"],
        }
        if result_mapper_override is not None:
            field, value = result_mapper_override
            if field not in RESULT_PROJECTION_FIELDS:
                raise KeyError(f"unknown result mapper override: {field}")
            select_fields = [
                f':resultMapperOverride AS "{name}"'
                if name == field else f'"{name}"'
                for name in RESULT_PROJECTION_FIELDS
            ]
            result_sql = (
                "WITH immutable_result AS ("
                + immutable_result_sql.rstrip().removesuffix(";")
                + ") SELECT "
                + ", ".join(select_fields)
                + " FROM immutable_result"
            )
            parameters["resultMapperOverride"] = value
        row = connection.execute(result_sql, parameters).fetchone()
        if row is None:
            return None, ["immutable result query returned no row"]
        actual = dict(row)
        actual["safePayload"] = json.loads(actual["safePayload"])
        if list(actual) != RESULT_PROJECTION_FIELDS:
            errors.append("immutable result SQL exact field order/inventory drift")
        return actual, errors
    except (KeyError, TypeError, json.JSONDecodeError, sqlite3.DatabaseError) as exc:
        return None, [f"result projection SQLite round trip failed: {type(exc).__name__}"]
    finally:
        connection.close()


def _result_projection_contract_errors(
    schema: dict[str, Any], fixtures: dict[str, Any], *, run_mutations: bool = True
) -> tuple[list[str], dict[str, Any], dict[str, dict[str, Any]]]:
    errors: list[str] = []
    kat_errors, known_answers, kat_details = _result_projection_known_answers(fixtures)
    errors.extend(kat_errors)
    kat_mutants: dict[str, dict[str, Any]] = {}
    deleted_entry = copy.deepcopy(fixtures)
    deleted_entry.get("resultProjectionKnownAnswers", []).pop()
    kat_mutants["delete-known-answer-entry"] = deleted_entry
    deleted_field = copy.deepcopy(fixtures)
    deleted_field.get("resultProjectionKnownAnswers", [])[0].get("projection", {}).pop(
        "actionKey", None
    )
    kat_mutants["delete-known-answer-actionKey"] = deleted_field
    changed_version = copy.deepcopy(fixtures)
    changed_version.get("resultProjectionKnownAnswerContract", {})["contractVersion"] = 2
    kat_mutants["change-known-answer-version"] = changed_version
    changed_digest = copy.deepcopy(fixtures)
    changed_digest.get("resultProjectionKnownAnswerContract", {})["sha256"] = "e" * 64
    kat_mutants["change-known-answer-digest"] = changed_digest
    kat_mutation_results = {
        name: bool(_result_projection_known_answers(mutant)[0])
        for name, mutant in kat_mutants.items()
    }
    for name, rejected in kat_mutation_results.items():
        if not rejected:
            errors.append(f"result projection KAT mutation passed: {name}")
    try:
        result_ddl, immutable_result_sql = _result_projection_sql_bundle()
    except (OSError, ValueError) as exc:
        result_ddl, immutable_result_sql = "", ""
        errors.append(f"result projection KAT SQL authority unavailable: {exc}")
    contract = fixtures.get("resultProjectionContract", {})
    expected_common_sources = {
        "contractVersion": "constant:1",
        "requestKey": "derived:JCS([namespace,...identityValues])",
        "writer": "branch.writer",
        "eventId": "/request/event/eventId",
        "requestHash": "derived:sha256(JCS(fullExactEnvelope))",
        "safePayload": "/request/event/safePayload",
        "createdAt": "/request/event/createdAt",
    }
    expected_transition_sources = {
        "actionKey": "request-transition-owner-or-cas-owner",
        "operationKey": "request-transition-owner-or-cas-owner",
        "taskRunId": "request-transition-owner-or-cas-owner",
        "sourceKind": "request-transition-owner-or-cas-owner",
        "sourceRef": "request-transition-owner-or-cas-owner",
        "batchId": "request-transition-owner-or-cas-owner-or-null",
        "intentId": "request-transition-owner-or-cas-owner-or-null",
        "holdId": "request-transition-owner-or-cas-owner-or-null",
        "recoveryAttemptId": "request-transition-owner-or-cas-owner-or-null",
        "observationAttemptId": "constant:null",
        "eventType": "TRANSITION_EVENT_MAP_V1[entityKind.command]",
        "previousState": "cas.previousState",
        "nextState": "cas.nextState",
    }
    expected_observation_sources = {
        "actionKey": "/request/event/actionKey",
        "operationKey": "/request/event/operationKey",
        "taskRunId": "/request/event/taskRunId",
        "sourceKind": "/request/event/sourceKind",
        "sourceRef": "/request/event/sourceRef",
        "batchId": "/request/event/batchId-or-null",
        "intentId": "/request/event/intentId-or-null",
        "holdId": "/request/event/holdId-or-null",
        "recoveryAttemptId": "/request/event/recoveryAttemptId-or-null",
        "observationAttemptId": "/request/event/observationAttemptId",
        "eventType": "/request/event/eventType",
        "previousState": "constant:null",
        "nextState": "constant:null",
    }
    expected_branch_types = {
        item.get("name"): TRANSITION_EVENT_MAP_V1.get(
            f"{item.get('request', {}).get('transition', {}).get('entityKind')}."
            f"{item.get('request', {}).get('transition', {}).get('command')}"
        )
        for item in fixtures.get("transitionRequests", [])
        if isinstance(item, dict)
    }
    expected_contract = {
        "contractVersion": 1,
        "fieldOrder": RESULT_PROJECTION_FIELDS,
        "commonFieldSources": expected_common_sources,
        "transitionFieldSources": expected_transition_sources,
        "observationFieldSources": expected_observation_sources,
        "transitionBranchEventTypes": expected_branch_types,
    }
    if contract != expected_contract:
        errors.append("result projection machine field-source mapping drift")

    transition_items = fixtures.get("transitionRequests", [])
    observation_items = fixtures.get("observationRequests", [])
    branch_by_name = {
        branch.get("name"): branch
        for branch in fixtures.get("requestKeyContract", {}).get("branches", [])
        if isinstance(branch, dict)
    }
    cas_by_name = fixtures.get("resultProjectionCasByRequest", {})
    transition_names = {
        item.get("name") for item in transition_items if isinstance(item, dict)
    }
    if set(cas_by_name) != transition_names or len(cas_by_name) != 16:
        errors.append("result projection CAS inventory must equal exact 16 transitions")

    projections: dict[str, dict[str, Any]] = {}
    derivation_results: list[dict[str, Any]] = []
    known_answer_comparisons: list[dict[str, Any]] = []
    sqlite_round_trip_results: list[dict[str, Any]] = []
    validators = {
        "transitionWithRecoveryEvent": validator_for_definition(
            schema, "RecoveryControlTransitionResultV1"
        ),
        "appendObservationEvent": validator_for_definition(
            schema, "RecoveryObservationEventResultV1"
        ),
    }
    request_prefix = fixtures.get("requestKeyContract", {}).get("prefix", "")
    for writer, items in (
        ("transitionWithRecoveryEvent", transition_items),
        ("appendObservationEvent", observation_items),
    ):
        for item in items:
            if not isinstance(item, dict):
                errors.append("result projection request fixture must be an object")
                continue
            name = item.get("name")
            projection, item_errors = _expected_result_projection(
                item,
                writer,
                branch_by_name.get(name, {}),
                cas_by_name.get(name) if writer == "transitionWithRecoveryEvent" else None,
                request_prefix,
            )
            if projection is not None:
                schema_errors = json_errors(validators[writer], projection)
                item_errors.extend(schema_errors)
                projections[str(name)] = projection
                known_answer = known_answers.get(str(name))
                mismatch_fields = [
                    field for field in RESULT_PROJECTION_FIELDS
                    if not isinstance(known_answer, dict)
                    or projection.get(field) != known_answer.get(field)
                ]
                known_answer_comparisons.append({
                    "requestName": name,
                    "writer": writer,
                    "comparedFieldCount": len(RESULT_PROJECTION_FIELDS),
                    "mismatchFields": mismatch_fields,
                    "passed": not mismatch_fields,
                })
                if mismatch_fields:
                    item_errors.append(
                        "independent result KAT mismatch: " + ",".join(mismatch_fields)
                    )
                if isinstance(known_answer, dict):
                    kat_schema_errors = json_errors(validators[writer], known_answer)
                    item_errors.extend(
                        f"independent result KAT schema: {error}"
                        for error in kat_schema_errors
                    )
                if result_ddl and immutable_result_sql:
                    actual_sql_projection, sql_errors = _sqlite_round_trip_result_projection(
                        projection,
                        str(name),
                        result_ddl,
                        immutable_result_sql,
                    )
                    sqlite_mismatch_fields = [
                        field for field in RESULT_PROJECTION_FIELDS
                        if not isinstance(known_answer, dict)
                        or not isinstance(actual_sql_projection, dict)
                        or actual_sql_projection.get(field) != known_answer.get(field)
                    ]
                    sqlite_round_trip_results.append({
                        "requestName": name,
                        "writer": writer,
                        "comparedFieldCount": len(RESULT_PROJECTION_FIELDS),
                        "mismatchFields": sqlite_mismatch_fields,
                        "passed": not sql_errors and not sqlite_mismatch_fields,
                        "errors": sql_errors,
                    })
                    item_errors.extend(sql_errors)
                    if sqlite_mismatch_fields:
                        item_errors.append(
                            "SQLite result/KAT mismatch: "
                            + ",".join(sqlite_mismatch_fields)
                        )
            derivation_results.append({
                "name": name,
                "writer": writer,
                "fieldCount": len(projection or {}),
                "passed": not item_errors,
                "errors": item_errors,
            })
            errors.extend(f"result projection {name}: {error}" for error in item_errors)

    fixture_result_comparisons: list[dict[str, Any]] = []
    projection_by_event_id = {
        value.get("eventId"): (name, value) for name, value in known_answers.items()
    }
    seen_result_events: set[str] = set()
    for result_item in fixtures.get("results", []):
        if not isinstance(result_item, dict) or not isinstance(result_item.get("value"), dict):
            errors.append("immutable result example fixture shape invalid")
            continue
        value = result_item["value"]
        event_id = value.get("eventId")
        expected_entry = projection_by_event_id.get(event_id)
        passed = expected_entry is not None and value == expected_entry[1]
        fixture_result_comparisons.append({
            "name": result_item.get("name"),
            "requestName": expected_entry[0] if expected_entry else None,
            "comparedFieldCount": len(RESULT_PROJECTION_FIELDS) if passed else 0,
            "passed": passed,
        })
        if not passed:
            errors.append(f"immutable result example differs from independent KAT: {event_id}")
        if event_id in seen_result_events:
            errors.append(f"duplicate immutable result example eventId: {event_id}")
        seen_result_events.add(str(event_id))

    field_mutations: list[dict[str, Any]] = []
    owner_mutations: list[dict[str, Any]] = []
    item_by_name = {
        item.get("name"): ("transitionWithRecoveryEvent", item)
        for item in transition_items if isinstance(item, dict)
    }
    item_by_name.update({
        item.get("name"): ("appendObservationEvent", item)
        for item in observation_items if isinstance(item, dict)
    })
    if run_mutations and result_ddl and immutable_result_sql:
        for request_name, known_answer in known_answers.items():
            writer, item = item_by_name.get(request_name, (None, None))
            if writer is None or not isinstance(item, dict):
                errors.append(f"result mutation request fixture missing: {request_name}")
                continue
            branch = branch_by_name.get(request_name, {})
            cas = cas_by_name.get(request_name) if writer == "transitionWithRecoveryEvent" else None
            for field in RESULT_PROJECTION_FIELDS:
                candidate, mutation_source, mapper_errors = _mutated_projection_from_sources(
                    item,
                    writer,
                    branch,
                    cas,
                    request_prefix,
                    field,
                    known_answer,
                )
                if candidate is None:
                    actual_mutant, sql_errors = None, mapper_errors
                else:
                    result_mapper_override = None
                    stored_projection = candidate
                    if mutation_source == "result-mapper":
                        stored_projection = projections.get(request_name)
                        result_mapper_override = (field, candidate.get(field))
                    if not isinstance(stored_projection, dict):
                        actual_mutant, sql_errors = None, [
                            "baseline mapper projection missing"
                        ]
                        field_mutations.append({
                            "requestName": request_name,
                            "field": field,
                            "mutationSource": mutation_source,
                            "sqliteRoundTrip": False,
                            "katMismatchFields": [],
                            "katRejected": False,
                            "errors": sql_errors,
                        })
                        errors.append(
                            f"result mapper/source/CAS mutation baseline missing: "
                            f"{request_name}/{field}"
                        )
                        continue
                    actual_mutant, sql_errors = _sqlite_round_trip_result_projection(
                        stored_projection,
                        f"{request_name}:field:{field}",
                        result_ddl,
                        immutable_result_sql,
                        result_mapper_override,
                    )
                mismatch_fields = [
                    key for key in RESULT_PROJECTION_FIELDS
                    if isinstance(actual_mutant, dict)
                    and actual_mutant.get(key) != known_answer.get(key)
                ]
                detected = (
                    isinstance(actual_mutant, dict)
                    and field in mismatch_fields
                    and actual_mutant.get(field) != known_answer.get(field)
                )
                field_mutations.append({
                    "requestName": request_name,
                    "field": field,
                    "mutationSource": mutation_source,
                    "sqliteRoundTrip": isinstance(actual_mutant, dict),
                    "katMismatchFields": mismatch_fields,
                    "katRejected": detected,
                    "errors": sql_errors,
                })
                if not detected:
                    errors.append(
                        f"result mapper/source/CAS mutation not rejected by KAT: "
                        f"{request_name}/{field} ({mutation_source}; "
                        f"mapperErrors={mapper_errors}; sqlErrors={sql_errors})"
                    )
            for field in ("actionKey", "operationKey", "taskRunId"):
                candidate, mutation_source, mapper_errors = _mutated_projection_from_sources(
                    item,
                    writer,
                    branch,
                    cas,
                    request_prefix,
                    field,
                    known_answer,
                )
                if candidate is None:
                    actual_mutant, sql_errors = None, mapper_errors
                else:
                    actual_mutant, sql_errors = _sqlite_round_trip_result_projection(
                        candidate,
                        f"{request_name}:wrong-owner:{field}",
                        result_ddl,
                        immutable_result_sql,
                    )
                detected = (
                    isinstance(actual_mutant, dict)
                    and actual_mutant.get(field) != known_answer.get(field)
                )
                owner_mutations.append({
                    "requestName": request_name,
                    "field": field,
                    "mutationSource": mutation_source,
                    "sqliteRoundTrip": isinstance(actual_mutant, dict),
                    "katRejected": detected,
                    "errors": sql_errors,
                })
                if not detected:
                    errors.append(
                        f"result wrong-owner mutation not rejected by KAT: "
                        f"{request_name}/{field} ({mutation_source}; "
                        f"mapperErrors={mapper_errors}; sqlErrors={sql_errors})"
                    )

    return errors, {
        "projectionFieldCount": len(RESULT_PROJECTION_FIELDS),
        "requestProjectionCount": len(projections),
        "knownAnswerContract": kat_details,
        "knownAnswerMutationResults": kat_mutation_results,
        "knownAnswerComparisonCount": len(known_answer_comparisons),
        "knownAnswerComparisons": known_answer_comparisons,
        "sqliteRoundTripCount": len(sqlite_round_trip_results),
        "sqliteRoundTripResults": sqlite_round_trip_results,
        "derivationResults": derivation_results,
        "fixtureResultComparisons": fixture_result_comparisons,
        "fieldMutationCount": len(field_mutations),
        "fieldMutationResults": field_mutations,
        "ownerMutationCount": len(owner_mutations),
        "ownerMutationResults": owner_mutations,
        "errors": errors,
    }, projections


def _request_key_contract_errors(fixtures: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    contract = fixtures.get("requestKeyContract", {})
    expected_header = {
        "contractVersion": 1,
        "format": "recovery-control:v1:<lowercase-sha256>",
        "prefix": "recovery-control:v1:",
        "canonicalization": "RFC8785-JCS",
        "preimage": "JCS([namespace, ...identityValues])",
        "tupleEncoding": "RFC8785-JCS-array",
        "identityPathEncoding": "RFC6901-JSON-Pointer",
        "delimiterConcatenation": False,
        "missingOptionalIdentityValue": None,
        "forbiddenIdentityLeafNames": [
            "eventId", "requestHash", "request_hash", "createdAt", "safePayload",
            "failureCode", "failureMessage", "metadataPatch", "expectedState",
        ],
    }
    for key, expected in expected_header.items():
        if contract.get(key) != expected:
            errors.append(f"requestKeyContract {key} drift")
    if set(contract) != set(expected_header) | {"branches"}:
        errors.append("requestKeyContract exact top-level shape drift")
    branches = contract.get("branches", [])
    branch_by_name = {
        item.get("name"): item for item in branches if isinstance(item, dict)
    }
    expected_branch_objects = {
        name: {
            "name": name,
            "writer": writer,
            "namespace": namespace,
            "identityPaths": paths,
        }
        for name, (writer, namespace, paths) in EXPECTED_REQUEST_KEY_BRANCHES.items()
    }
    if branch_by_name != expected_branch_objects or len(branches) != 20:
        errors.append("requestKeyContract exact 20-branch namespace/tuple inventory drift")

    request_items = [
        (item, "transitionWithRecoveryEvent") for item in fixtures.get("transitionRequests", [])
    ] + [
        (item, "appendObservationEvent") for item in fixtures.get("observationRequests", [])
    ]
    derived_results: list[dict[str, Any]] = []
    for item, expected_writer in request_items:
        name = item.get("name")
        request = item.get("request", {})
        branch = branch_by_name.get(name)
        item_errors: list[str] = []
        if branch is None:
            item_errors.append("missing branch contract")
        else:
            if branch.get("writer") != expected_writer:
                item_errors.append("writer drift")
            expected_namespace = (
                f"recovery-control/v1/transition/"
                f"{request.get('transition', {}).get('entityKind')}/"
                f"{request.get('transition', {}).get('command')}"
                if expected_writer == "transitionWithRecoveryEvent"
                else f"recovery-control/v1/observation/{request.get('event', {}).get('eventType')}"
            )
            if branch.get("namespace") != expected_namespace:
                item_errors.append("namespace discriminator drift")
            forbidden_names = set(expected_header["forbiddenIdentityLeafNames"])
            identity_leaf_names = {
                pointer_value.rsplit("/", 1)[-1]
                for pointer_value in branch.get("identityPaths", [])
            }
            if identity_leaf_names & forbidden_names:
                item_errors.append("volatile/request body leaf entered identity tuple")
            derived = _derive_request_key(request, branch, contract.get("prefix", ""))
            if item.get("requestKey") != derived:
                item_errors.append("derived requestKey mismatch")
            if not re.fullmatch(r"recovery-control:v1:[0-9a-f]{64}", str(derived)):
                item_errors.append("requestKey format mismatch")
            volatile_mutant = copy.deepcopy(request)
            volatile_mutant["event"]["createdAt"] = "2099-01-01T00:00:00.000Z"
            same_key = _derive_request_key(
                volatile_mutant, branch, contract.get("prefix", "")
            ) == derived
            base_envelope = {
                "contractVersion": 1,
                "writer": expected_writer,
                "input": request,
            }
            mutant_envelope = {
                "contractVersion": 1,
                "writer": expected_writer,
                "input": volatile_mutant,
            }
            changed_hash = jcs_json_sha256(base_envelope) != jcs_json_sha256(mutant_envelope)
            if not same_key or not changed_hash:
                item_errors.append("changed exact request must keep key and change request hash")
            if name == "hold-create-or-get":
                hold_id_mutant = copy.deepcopy(request)
                hold_id_mutant["transition"]["input"]["holdId"] += "~"
                hold_id_same_key = _derive_request_key(
                    hold_id_mutant, branch, contract.get("prefix", "")
                ) == derived
                hold_id_changed_hash = jcs_json_sha256({
                    "contractVersion": 1,
                    "writer": expected_writer,
                    "input": hold_id_mutant,
                }) != jcs_json_sha256(base_envelope)
                if not hold_id_same_key or not hold_id_changed_hash:
                    item_errors.append(
                        "Hold rescan must key by durable source pair while changed holdId conflicts"
                    )
        derived_results.append({"name": name, "passed": not item_errors, "errors": item_errors})
        errors.extend(f"requestKey {name}: {error}" for error in item_errors)

    owner_results: list[dict[str, Any]] = []
    transition_by_name = {
        item["name"]: item for item in fixtures.get("transitionRequests", [])
    }
    for lifecycle in fixtures.get("ownerLifecycleFixtures", []):
        item_errors: list[str] = []
        request_item = transition_by_name.get(lifecycle.get("requestName"))
        prepared = lifecycle.get("preparedOwner", {})
        committed = lifecycle.get("committedOwner", {})
        if request_item is None:
            item_errors.append("owner fixture references missing request")
        else:
            envelope = {
                "contractVersion": 1,
                "writer": "transitionWithRecoveryEvent",
                "input": request_item["request"],
            }
            canonical = node_jcs_batch([envelope])[0]
            immutable_owner_fields = {
                "requestKey", "writer", "eventId", "requestHash", "requestJcs", "createdAt",
            }
            if prepared.get("requestKey") != request_item.get("requestKey"):
                item_errors.append("prepared owner requestKey drift")
            if prepared.get("requestJcs") != canonical["canonical"]:
                item_errors.append("prepared owner requestJcs drift")
            if prepared.get("requestHash") != canonical["sha256"]:
                item_errors.append("prepared owner requestHash drift")
            if prepared.get("status") != "prepared" or prepared.get("committedAt") is not None:
                item_errors.append("prepared owner lifecycle shape drift")
            if committed.get("status") != "committed" or not committed.get("committedAt"):
                item_errors.append("committed owner lifecycle shape drift")
            if any(prepared.get(key) != committed.get(key) for key in immutable_owner_fields):
                item_errors.append("owner immutable fields changed across commit")
            if lifecycle.get("eventOwnerEqualityFields") != [
                "requestKey", "writer", "eventId", "requestHash", "createdAt",
            ]:
                item_errors.append("owner/event equality field inventory drift")
        owner_results.append(
            {"name": lifecycle.get("name"), "passed": not item_errors, "errors": item_errors}
        )
        errors.extend(
            f"owner lifecycle {lifecycle.get('name')}: {error}" for error in item_errors
        )

    return errors, {
        "branchCount": len(branches),
        "derivedRequestKeyResults": derived_results,
        "ownerLifecycleResults": owner_results,
        "errors": errors,
    }


def _schema_inventory_errors(
    schema: dict[str, Any], fixtures: dict[str, Any]
) -> list[str]:
    """Hard gate schema discriminants, exact properties and fixture inventory."""
    errors: list[str] = []
    defs = schema.get("$defs", {})
    expected_union_defs = {
        "TaskRunTransitionV1", "BatchOverlayTransitionV1",
        "CriticalIntentTransitionV1", "RecoveryHoldTransitionV1",
    }
    union = defs.get("RecoveryControlTransitionV1", {}).get("oneOf", [])
    union_defs = {
        str(item.get("$ref", "")).rsplit("/", 1)[-1]
        for item in union if isinstance(item, dict)
    }
    if union_defs != expected_union_defs or len(union) != 4:
        errors.append("RecoveryControlTransitionV1 exact four-union inventory drift")

    schema_branches: dict[tuple[str, str], dict[str, Any]] = {}
    for definition in expected_union_defs:
        for branch in defs.get(definition, {}).get("oneOf", []):
            properties = branch.get("properties", {})
            entity_kind = properties.get("entityKind", {}).get("const")
            command = properties.get("command", {}).get("const")
            if entity_kind and command:
                schema_branches[(entity_kind, command)] = branch
    expected_discriminants = {
        tuple(key.split(".", 1)) for key in TRANSITION_EVENT_MAP_V1
    }
    if set(schema_branches) != expected_discriminants or len(schema_branches) != 16:
        errors.append("recovery transition exact 16 discriminants drift")

    transition_items = fixtures.get("transitionRequests", [])
    observation_items = fixtures.get("observationRequests", [])
    result_items = fixtures.get("results", [])
    if len(transition_items) != 16 or len(observation_items) != 4:
        errors.append("recovery request fixture 16/4 inventory drift")
    if len(result_items) != 2:
        errors.append("recovery result fixture count drift")
    all_names = [item.get("name") for item in transition_items + observation_items]
    if len(all_names) != len(set(all_names)) or set(all_names) != set(EXPECTED_REQUEST_KEY_BRANCHES):
        errors.append("recovery fixture names are missing/duplicated")

    for item in transition_items:
        transition = item.get("request", {}).get("transition", {})
        discriminant = (transition.get("entityKind"), transition.get("command"))
        branch = schema_branches.get(discriminant, {})
        if set(branch.get("properties", {})) != set(transition):
            errors.append(f"schema exact properties drift for {item.get('name')}")
        if set(branch.get("required", [])) != set(transition):
            errors.append(f"schema required fields drift for {item.get('name')}")
        input_value = transition.get("input")
        input_ref = branch.get("properties", {}).get("input", {}).get("$ref")
        if isinstance(input_value, dict) and input_ref:
            input_def = defs.get(input_ref.rsplit("/", 1)[-1], {})
            if set(input_def.get("properties", {})) != set(input_value):
                errors.append(f"nested exact properties drift for {item.get('name')}")
            if set(input_def.get("required", [])) != set(input_value):
                errors.append(f"nested required fields drift for {item.get('name')}")

    observation_event = defs.get("RecoveryObservationEventInputV1", {})
    observation_enum = set(
        observation_event.get("properties", {}).get("eventType", {}).get("enum", [])
    )
    if observation_enum != OBSERVATION_EVENT_TYPES or len(observation_enum) != 4:
        errors.append("recovery observation exact four discriminants drift")
    full_observation_keys = {
        "eventId", "eventType", "observationAttemptId", "actionKey", "operationKey", "taskRunId",
        "sourceKind", "sourceRef", "batchId", "intentId", "holdId",
        "recoveryAttemptId", "createdAt", "safePayload",
    }
    optional_observation_keys = {"batchId", "intentId", "holdId", "recoveryAttemptId"}
    if set(observation_event.get("properties", {})) != full_observation_keys:
        errors.append("observation event exact property inventory drift")
    if set(observation_event.get("required", [])) != (
        full_observation_keys - optional_observation_keys
    ):
        errors.append("observation event required/optional inventory drift")
    if {item.get("request", {}).get("event", {}).get("eventType") for item in observation_items} != OBSERVATION_EVENT_TYPES:
        errors.append("observation fixture discriminants drift")

    transition_event = defs.get("RecoveryTransitionEventInputV1", {})
    if set(transition_event.get("properties", {})) != {"eventId", "createdAt", "safePayload"}:
        errors.append("transition event exact properties drift")
    if set(transition_event.get("required", [])) != {"eventId", "createdAt", "safePayload"}:
        errors.append("transition event required fields drift")
    for definition, property_name in (
        ("RecoveryTransitionRequestV1", "transition"),
        ("RecoveryObservationRequestV1", "event"),
    ):
        request_def = defs.get(definition, {})
        expected_request_properties = (
            {"transition", "event"} if property_name == "transition" else {"event"}
        )
        if set(request_def.get("properties", {})) != expected_request_properties:
            errors.append(f"{definition} exact top-level properties drift")
        if set(request_def.get("required", [])) != set(request_def.get("properties", {})):
            errors.append(f"{definition} required top-level fields drift")

    projection = defs.get("RecoveryEventProjectionV1", {})
    projection_fields = set(RESULT_PROJECTION_FIELDS)
    if set(projection.get("properties", {})) != projection_fields:
        errors.append("RecoveryEventProjectionV1 exact 20 properties drift")
    if set(projection.get("required", [])) != projection_fields:
        errors.append("RecoveryEventProjectionV1 exact 20 required fields drift")
    for definition in (
        "RecoveryControlTransitionResultV1", "RecoveryObservationEventResultV1",
    ):
        if definition not in defs:
            errors.append(f"missing result definition {definition}")
    transition_result = defs.get("RecoveryControlTransitionResultV1", {}).get("allOf", [])
    observation_result = defs.get("RecoveryObservationEventResultV1", {}).get("allOf", [])
    transition_constraints = transition_result[-1].get("properties", {}) if len(transition_result) == 2 else {}
    if (
        len(transition_result) != 2
        or transition_constraints.get("writer", {}).get("const") != "transitionWithRecoveryEvent"
        or transition_constraints.get("observationAttemptId") != {"type": "null"}
    ):
        errors.append("transition result writer const drift")
    observation_constraints = observation_result[-1].get("properties", {}) if len(observation_result) == 2 else {}
    if (
        len(observation_result) != 2
        or observation_constraints.get("writer", {}).get("const") != "appendObservationEvent"
        or set(observation_constraints.get("eventType", {}).get("enum", [])) != OBSERVATION_EVENT_TYPES
        or observation_constraints.get("previousState") != {"type": "null"}
        or observation_constraints.get("nextState") != {"type": "null"}
        or observation_constraints.get("sourceKind", {}).get("$ref") != "#/$defs/RecoverySourceKind"
        or observation_constraints.get("observationAttemptId", {}).get("$ref")
        != "#/$defs/ObservationAttemptIdV1"
    ):
        errors.append("observation result writer/event/state/source constraints drift")

    if defs.get("CanonicalSha256", {}).get("pattern") != CANONICAL_SHA256_PATTERN:
        errors.append("CanonicalSha256 exact lowercase SHA-256 pattern drift")
    canonical_json_value = defs.get("CanonicalJsonValue", {})
    number_domain = next(
        (item for item in canonical_json_value.get("oneOf", []) if item.get("type") == "number"),
        {},
    )
    if number_domain != {
        "type": "number", "minimum": -9007199254740991, "maximum": 9007199254740991,
    }:
        errors.append("CanonicalJsonValue safe-number schema domain drift")
    return errors


def _required_deletion_results(
    schema: dict[str, Any], fixtures: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[str]]:
    results: list[dict[str, Any]] = []
    failures: list[str] = []
    transition_validator = validator_for_definition(schema, "RecoveryTransitionRequestV1")
    observation_validator = validator_for_definition(schema, "RecoveryObservationRequestV1")
    optional_observation = {"batchId", "intentId", "holdId", "recoveryAttemptId"}

    def delete_path(value: dict[str, Any], path: tuple[str, ...]) -> dict[str, Any]:
        candidate = copy.deepcopy(value)
        parent: Any = candidate
        for component in path[:-1]:
            parent = parent[component]
        del parent[path[-1]]
        return candidate

    for item in fixtures.get("transitionRequests", []):
        request = item["request"]
        paths = [(key,) for key in request]
        paths.extend(("transition", key) for key in request["transition"])
        if isinstance(request["transition"].get("input"), dict):
            paths.extend(
                ("transition", "input", key) for key in request["transition"]["input"]
            )
        paths.extend(("event", key) for key in request["event"])
        for path in paths:
            rejected = bool(json_errors(transition_validator, delete_path(request, path)))
            results.append({"fixture": item["name"], "path": "/".join(path), "rejected": rejected})
            if not rejected:
                failures.append(f"{item['name']} required deletion passed: {'/'.join(path)}")
    for item in fixtures.get("observationRequests", []):
        request = item["request"]
        paths = [("event", key) for key in request["event"] if key not in optional_observation]
        paths.append(("event",))
        for path in paths:
            rejected = bool(json_errors(observation_validator, delete_path(request, path)))
            results.append({"fixture": item["name"], "path": "/".join(path), "rejected": rejected})
            if not rejected:
                failures.append(f"{item['name']} required deletion passed: {'/'.join(path)}")
    for item in fixtures.get("results", []):
        definition = item["definition"]
        validator = validator_for_definition(schema, definition)
        for key in item["value"]:
            rejected = bool(json_errors(validator, delete_path(item["value"], (key,))))
            results.append({"fixture": item["name"], "path": key, "rejected": rejected})
            if not rejected:
                failures.append(f"{item['name']} required deletion passed: {key}")
    return results, failures


def recovery_control_schema_contract_errors(
    recovery_control_schema: dict[str, Any],
) -> tuple[list[str], dict[str, Any]]:
    """Validate exact request/result shapes, branch mutations and JCS leaf sensitivity."""
    errors: list[str] = []
    fixtures = load_json(VALID_RECOVERY_CONTROL_PATH)
    transition_validator = validator_for_definition(
        recovery_control_schema, "RecoveryTransitionRequestV1"
    )
    observation_validator = validator_for_definition(
        recovery_control_schema, "RecoveryObservationRequestV1"
    )
    result_validators = {
        name: validator_for_definition(recovery_control_schema, name)
        for name in (
            "RecoveryControlTransitionResultV1",
            "RecoveryObservationEventResultV1",
        )
    }
    binding_authority = action_binding_authority_from_source()
    bindings = binding_authority["bindings"]

    inventory_errors = _schema_inventory_errors(recovery_control_schema, fixtures)
    errors.extend(inventory_errors)
    request_key_errors, request_key_details = _request_key_contract_errors(fixtures)
    errors.extend(request_key_errors)
    projection_errors, projection_details, expected_projections = (
        _result_projection_contract_errors(recovery_control_schema, fixtures)
    )
    errors.extend(projection_errors)
    required_deletion_results, required_deletion_errors = _required_deletion_results(
        recovery_control_schema, fixtures
    )
    errors.extend(required_deletion_errors)

    def request_semantic_errors(request: dict[str, Any]) -> list[str]:
        found: list[str] = []
        transition = request.get("transition")
        if isinstance(transition, dict) and transition.get("entityKind") in {
            "task-run", "batch-overlay",
        }:
            action_key = transition.get("actionKey")
            expected_task_key = transition.get("expectedTaskKey")
            if expected_task_key not in bindings.get(action_key, []):
                found.append(
                    f"actionKey/expectedTaskKey binding mismatch: {action_key}/{expected_task_key}"
                )
        if isinstance(transition, dict) and transition.get("entityKind") == "task-run":
            source_kind = transition.get("sourceKind")
            source_ref = transition.get("sourceRef")
            if (source_kind is None) != (source_ref is None):
                found.append("Task transition sourceKind/sourceRef must be a nullable pair")
        return found

    valid_details: list[dict[str, Any]] = []
    for item in fixtures["transitionRequests"]:
        fixture_errors = json_errors(transition_validator, item["request"])
        fixture_errors.extend(request_semantic_errors(item["request"]))
        valid_details.append(
            {"name": item["name"], "definition": "RecoveryTransitionRequestV1", "errors": fixture_errors}
        )
        errors.extend(f"valid {item['name']}: {err}" for err in fixture_errors)
    for item in fixtures["observationRequests"]:
        fixture_errors = json_errors(observation_validator, item["request"])
        valid_details.append(
            {"name": item["name"], "definition": "RecoveryObservationRequestV1", "errors": fixture_errors}
        )
        errors.extend(f"valid {item['name']}: {err}" for err in fixture_errors)
    for item in fixtures["results"]:
        fixture_errors = json_errors(result_validators[item["definition"]], item["value"])
        valid_details.append(
            {"name": item["name"], "definition": item["definition"], "errors": fixture_errors}
        )
        errors.extend(f"valid {item['name']}: {err}" for err in fixture_errors)

    result_by_definition = {
        item.get("definition"): item.get("value")
        for item in fixtures.get("results", [])
        if isinstance(item, dict) and isinstance(item.get("value"), dict)
    }
    transition_result_value = result_by_definition.get(
        "RecoveryControlTransitionResultV1", {}
    )
    observation_result_value = result_by_definition.get(
        "RecoveryObservationEventResultV1", {}
    )
    if not transition_result_value or not observation_result_value:
        errors.append("recovery result example fixture missing exact transition/observation DTO")
    cross_result_mutations = {
        "transition-rejected-by-observation-dto": bool(
            json_errors(
                result_validators["RecoveryObservationEventResultV1"],
                transition_result_value,
            )
        ),
        "observation-rejected-by-transition-dto": bool(
            json_errors(
                result_validators["RecoveryControlTransitionResultV1"],
                observation_result_value,
            )
        ),
    }
    for name, mutate in (
        ("observation-non-null-previous-state", lambda value: value.update(previousState="running")),
        ("observation-non-null-next-state", lambda value: value.update(nextState="running")),
        ("observation-manual-source", lambda value: value.update(sourceKind="manual")),
        ("observation-transition-event-type", lambda value: value.update(eventType="recovery-started")),
    ):
        candidate = copy.deepcopy(observation_result_value)
        mutate(candidate)
        cross_result_mutations[name] = bool(
            json_errors(result_validators["RecoveryObservationEventResultV1"], candidate)
        )
    for name, rejected in cross_result_mutations.items():
        if not rejected:
            errors.append(f"cross/result DTO mutation passed: {name}")

    sha1_digest = hashlib.sha1(b"recovery-control-canonical-sha256-mutant").hexdigest()
    sha1_schema_mutations: list[dict[str, Any]] = []
    sha1_cases: list[tuple[str, dict[str, Any], Draft202012Validator]] = []
    intent_item = named_item(fixtures.get("transitionRequests"), "intent-create-prepared")
    if intent_item is None:
        errors.append("SHA-1 mutation fixture intent-create-prepared missing")
    else:
        intent_sha1 = copy.deepcopy(intent_item.get("request", {}))
        intent_sha1.get("transition", {}).get("input", {})["evidenceHash"] = sha1_digest
        sha1_cases.append(("PreparedIntentInput.evidenceHash", intent_sha1, transition_validator))
    hold_item = named_item(fixtures.get("transitionRequests"), "hold-create-or-get")
    if hold_item is None:
        errors.append("SHA-1 mutation fixture hold-create-or-get missing")
    else:
        hold_sha1 = copy.deepcopy(hold_item.get("request", {}))
        hold_sha1.get("transition", {}).get("input", {})["evidenceHash"] = sha1_digest
        sha1_cases.append(("RecoveryHoldCreateInput.evidenceHash", hold_sha1, transition_validator))
    for result_item in fixtures["results"]:
        result_sha1 = copy.deepcopy(result_item["value"])
        result_sha1["requestHash"] = sha1_digest
        sha1_cases.append(
            (
                f"{result_item['definition']}.requestHash",
                result_sha1,
                result_validators[result_item["definition"]],
            )
        )
    for name, candidate, validator in sha1_cases:
        rejected = bool(json_errors(validator, candidate))
        sha1_schema_mutations.append(
            {"name": name, "sha1Digest": sha1_digest, "rejected": rejected}
        )
        if not rejected:
            errors.append(f"actual SHA-1 schema injection passed: {name}")

    request_by_event_id = {
        item["request"]["event"]["eventId"]: (
            "transitionWithRecoveryEvent", item["request"]
        )
        for item in fixtures["transitionRequests"]
    }
    request_by_event_id.update({
        item["request"]["event"]["eventId"]: ("appendObservationEvent", item["request"])
        for item in fixtures["observationRequests"]
    })
    result_hash_results: list[dict[str, Any]] = []
    for item in fixtures["results"]:
        value = item["value"]
        writer, request = request_by_event_id[value["eventId"]]
        actual = jcs_json_sha256(
            {"contractVersion": 1, "writer": writer, "input": request}
        )
        passed = value["writer"] == writer and value["requestHash"] == actual
        result_hash_results.append(
            {"name": item["name"], "expected": value["requestHash"], "actual": actual, "passed": passed}
        )
        if not passed:
            errors.append(f"immutable result requestHash drift: {item['name']}")

    transition_item_by_name = {
        item["name"]: item for item in fixtures["transitionRequests"]
    }
    transition_by_name = {
        name: item["request"] for name, item in transition_item_by_name.items()
    }
    request_key_branch_by_name = {
        item["name"]: item
        for item in fixtures["requestKeyContract"]["branches"]
    }
    restart_replay_results: list[dict[str, Any]] = []
    for scenario in fixtures.get("restartReplayScenarios", []):
        scenario_errors: list[str] = []
        request_a = transition_by_name.get(scenario.get("requestA"))
        request_b = transition_by_name.get(scenario.get("requestB"))
        result_a = scenario.get("expectedReplayResultA")
        derived_result_a = expected_projections.get(str(scenario.get("requestA")))
        if request_a is None or request_b is None or not isinstance(result_a, dict):
            scenario_errors.append("scenario references missing request/result")
        else:
            scenario_errors.extend(
                json_errors(
                    result_validators["RecoveryControlTransitionResultV1"], result_a
                )
            )
            if result_a != derived_result_a:
                scenario_errors.append(
                    "result A does not equal independently derived request/CAS projection"
                )
            hash_a = jcs_json_sha256({
                "contractVersion": 1,
                "writer": "transitionWithRecoveryEvent",
                "input": request_a,
            })
            hash_b = jcs_json_sha256({
                "contractVersion": 1,
                "writer": "transitionWithRecoveryEvent",
                "input": request_b,
            })
            if result_a.get("requestHash") != hash_a:
                scenario_errors.append("result A requestHash does not match request A")
            request_key_a = transition_item_by_name[scenario["requestA"]]["requestKey"]
            request_key_b = transition_item_by_name[scenario["requestB"]]["requestKey"]
            if result_a.get("requestKey") != request_key_a:
                scenario_errors.append("result A requestKey does not match request A owner")
            if result_a.get("eventId") != request_a["event"]["eventId"]:
                scenario_errors.append("result A eventId does not match request A")
            if result_a.get("createdAt") != request_a["event"]["createdAt"]:
                scenario_errors.append("result A createdAt does not match request A")
            if result_a.get("safePayload") != request_a["event"]["safePayload"]:
                scenario_errors.append("result A safePayload does not match request A")
            if scenario.get("stateSequence") != [
                "interrupted", "recovering", "resolved", "restart", "replay-A",
            ]:
                scenario_errors.append("restart scenario state sequence drift")
            if request_a["transition"].get("expectedState") != "interrupted":
                scenario_errors.append("request A must begin at interrupted")
            if request_b["transition"].get("expectedState") != "recovering":
                scenario_errors.append("request B must advance from recovering")

            result_b = expected_projections.get(str(scenario.get("requestB")))
            if result_b is None:
                scenario_errors.append("scenario missing immutable result B fixture")
            else:
                ledger: dict[str, tuple[str, str, dict[str, Any]]] = {}
                event_index: dict[str, str] = {}
                cas_count = 0
                event_count = 0

                def submit(
                    request_name: str,
                    request: dict[str, Any],
                    supplied_request_key: str,
                    result: dict[str, Any],
                ) -> tuple[str, dict[str, Any] | None]:
                    nonlocal cas_count, event_count
                    event_id = request["event"]["eventId"]
                    expected_request_key = _derive_request_key(
                        request,
                        request_key_branch_by_name[request_name],
                        fixtures["requestKeyContract"]["prefix"],
                    )
                    if supplied_request_key != expected_request_key:
                        return "invalid-request-key", None
                    digest = jcs_json_sha256({
                        "contractVersion": 1,
                        "writer": "transitionWithRecoveryEvent",
                        "input": request,
                    })
                    existing = ledger.get(supplied_request_key)
                    if existing:
                        if existing[0] != digest or existing[1] != event_id:
                            return "conflict", None
                        return "replay", copy.deepcopy(existing[2])
                    if event_id in event_index and event_index[event_id] != supplied_request_key:
                        return "conflict", None
                    cas_count += 1
                    event_count += 1
                    ledger[supplied_request_key] = (
                        digest, event_id, copy.deepcopy(result)
                    )
                    event_index[event_id] = supplied_request_key
                    return "committed", copy.deepcopy(result)

                first_status, first_result = submit(
                    scenario["requestA"], request_a, request_key_a, result_a
                )
                second_status, _second_result = submit(
                    scenario["requestB"], request_b, request_key_b, result_b
                )
                ledger = copy.deepcopy(ledger)  # restart: only durable state survives
                event_index = copy.deepcopy(event_index)
                before_replay = (cas_count, event_count)
                replay_status, replay_result = submit(
                    scenario["requestA"], request_a, request_key_a, result_a
                )
                after_replay = (cas_count, event_count)
                changed_a = copy.deepcopy(request_a)
                changed_a["event"]["createdAt"] = "2026-08-23T00:00:06.001Z"
                conflict_status, _conflict_result = submit(
                    scenario["requestA"], changed_a, request_key_a, result_a
                )
                wrong_key_status, _wrong_key_result = submit(
                    scenario["requestA"],
                    request_a,
                    "recovery-control:v1:" + "0" * 64,
                    result_a,
                )
                projection_fields = list(result_a)
                immutable_field_count = sum(
                    replay_result is not None
                    and replay_result.get(field) == first_result.get(field) == result_a.get(field)
                    for field in projection_fields
                )
                expected = scenario.get("expected", {})
                observed = {
                    "replayResultEqualsFirstResult": replay_result == first_result == result_a,
                    "replayAdditionalCasCount": after_replay[0] - before_replay[0],
                    "replayAdditionalEventCount": after_replay[1] - before_replay[1],
                    "changedLeafConflicts": conflict_status == "conflict",
                    "wrongRequestKeyRejected": wrong_key_status == "invalid-request-key",
                    "immutableProjectionFieldComparisonCount": immutable_field_count,
                }
                if first_status != "committed" or second_status != "committed":
                    scenario_errors.append("A/B initial commits did not commit once")
                if replay_status != "replay":
                    scenario_errors.append("request A did not replay after restart")
                if observed != expected:
                    scenario_errors.append(
                        f"restart replay observed={observed!r} expected={expected!r}"
                    )
                if hash_b != result_b.get("requestHash"):
                    scenario_errors.append("result B requestHash does not match request B")
                if request_key_b != result_b.get("requestKey"):
                    scenario_errors.append("result B requestKey does not match request B owner")
        restart_replay_results.append(
            {"name": scenario.get("name"), "passed": not scenario_errors, "errors": scenario_errors}
        )
        errors.extend(
            f"restart replay {scenario.get('name')}: {error}" for error in scenario_errors
        )

    observation_attempt_contract = fixtures.get("observationAttemptContract", {})
    expected_attempt_contract = {
        "contractVersion": 1,
        "idType": "positive-safe-integer",
        "allocation": (
            "allocateNextObservationAttempt(scope) persists prepared before request owner reserve"
        ),
        "restart": "resumePreparedObservationAttempt(scope) returns the same durable ordinal",
        "newAttempt": (
            "only allocateNextObservationAttempt(scope) may create the next ordinal after commit"
        ),
        "scopeNamespace": "recovery-control/v1/observation-attempt-scope",
        "scopeKeyFormat": "observation-attempt:v1:<lowercase-sha256>",
        "scopeIdentityPaths": [
            "/event/eventType", "/event/actionKey", "/event/operationKey",
            "/event/taskRunId", "/event/sourceKind", "/event/sourceRef",
            "/event/batchId", "/event/intentId", "/event/holdId",
            "/event/recoveryAttemptId",
        ],
        "forbiddenScopeLeafNames": [
            "observationAttemptId", "eventId", "requestHash", "request_hash",
            "createdAt", "safePayload",
        ],
        "statuses": ["prepared", "committed"],
    }
    if observation_attempt_contract != expected_attempt_contract:
        errors.append("observation attempt allocation/scope contract drift")

    def observation_scope_key(request: dict[str, Any]) -> str:
        values = [
            _json_pointer_get(request, pointer_value)
            for pointer_value in observation_attempt_contract.get("scopeIdentityPaths", [])
        ]
        return "observation-attempt:v1:" + jcs_json_sha256([
            observation_attempt_contract.get("scopeNamespace"), *values,
        ])

    observation_by_name = {
        item.get("name"): item
        for item in fixtures.get("observationRequests", [])
        if isinstance(item, dict)
    }
    attempt_lifecycle_results: list[dict[str, Any]] = []
    for lifecycle in fixtures.get("observationAttemptLifecycleFixtures", []):
        lifecycle_errors: list[str] = []
        request_item = observation_by_name.get(lifecycle.get("requestName"))
        if request_item is None:
            lifecycle_errors.append("attempt lifecycle request missing")
        else:
            request = request_item.get("request", {})
            event = request.get("event", {})
            allocated = lifecycle.get("allocatedBeforeOwner", {})
            prepared = lifecycle.get("boundPrepared", {})
            committed = lifecycle.get("committed", {})
            derived_scope = observation_scope_key(request)
            expected_attempt_id = event.get("observationAttemptId")
            expected_request_key = request_item.get("requestKey")
            if lifecycle.get("scopeKey") != derived_scope:
                lifecycle_errors.append("attempt lifecycle scopeKey drift")
            if allocated != {
                "observationAttemptId": expected_attempt_id,
                "requestKey": None,
                "status": "prepared",
            }:
                lifecycle_errors.append("attempt must persist prepared before owner reserve")
            if prepared != {
                "observationAttemptId": expected_attempt_id,
                "requestKey": expected_request_key,
                "status": "prepared",
            }:
                lifecycle_errors.append("attempt prepared owner binding drift")
            if committed != {
                "observationAttemptId": expected_attempt_id,
                "requestKey": expected_request_key,
                "status": "committed",
            }:
                lifecycle_errors.append("attempt committed binding drift")
            if lifecycle.get("restartPreparedLookup") != "same-scope-and-observationAttemptId":
                lifecycle_errors.append("attempt restart lookup drift")
            if lifecycle.get("exactReplayAfterCommit") != "same-requestKey-and-full-request-hash":
                lifecycle_errors.append("attempt committed replay rule drift")
        attempt_lifecycle_results.append({
            "name": lifecycle.get("name"),
            "passed": not lifecycle_errors,
            "errors": lifecycle_errors,
        })
        errors.extend(
            f"observation attempt lifecycle {lifecycle.get('name')}: {error}"
            for error in lifecycle_errors
        )

    observation_retry_results: list[dict[str, Any]] = []
    for scenario in fixtures.get("observationRetryScenarios", []):
        scenario_errors: list[str] = []
        first_item = observation_by_name.get(scenario.get("attempt1RequestName"))
        second_item = scenario.get("attempt2")
        if first_item is None or not isinstance(second_item, dict):
            scenario_errors.append("retry attempt fixture missing")
        else:
            first_request = first_item.get("request", {})
            second_request = second_item.get("request", {})
            second_schema_errors = json_errors(observation_validator, second_request)
            scenario_errors.extend(second_schema_errors)
            first_branch = request_key_branch_by_name.get(first_item.get("name"), {})
            derived_second_key = _derive_request_key(
                second_request,
                first_branch,
                fixtures.get("requestKeyContract", {}).get("prefix", ""),
            )
            if second_item.get("requestKey") != derived_second_key:
                scenario_errors.append("retry attempt 2 requestKey drift")
            first_scope = observation_scope_key(first_request)
            second_scope = observation_scope_key(second_request)
            first_id = first_request.get("event", {}).get("observationAttemptId")
            second_id = second_request.get("event", {}).get("observationAttemptId")
            ledger: dict[str, tuple[str, dict[str, Any]]] = {}
            event_count = 0

            def append_observation(
                request_key: str, request: dict[str, Any]
            ) -> tuple[str, dict[str, Any] | None]:
                nonlocal event_count
                digest = jcs_json_sha256({
                    "contractVersion": 1,
                    "writer": "appendObservationEvent",
                    "input": request,
                })
                existing = ledger.get(request_key)
                if existing:
                    if existing[0] != digest:
                        return "conflict", None
                    return "replay", copy.deepcopy(existing[1])
                synthetic_item = {"requestKey": request_key, "request": request}
                result, projection_item_errors = _expected_result_projection(
                    synthetic_item,
                    "appendObservationEvent",
                    first_branch,
                    None,
                    fixtures.get("requestKeyContract", {}).get("prefix", ""),
                )
                if projection_item_errors or result is None:
                    return "invalid", None
                ledger[request_key] = (digest, copy.deepcopy(result))
                event_count += 1
                return "committed", result

            first_status, first_result = append_observation(
                str(first_item.get("requestKey")), first_request
            )
            durable_ledger = copy.deepcopy(ledger)
            ledger = durable_ledger
            before_replay_count = event_count
            replay_status, replay_result = append_observation(
                str(first_item.get("requestKey")), first_request
            )
            after_replay_count = event_count
            second_status, _second_result = append_observation(
                str(second_item.get("requestKey")), second_request
            )
            observed = {
                "sameScopeKey": first_scope == second_scope,
                "sameOrdinalRestartExactReplay": (
                    replay_status == "replay"
                    and replay_result == first_result
                    and after_replay_count == before_replay_count
                ),
                "nextOrdinalAppendsNewEvent": (
                    first_status == "committed"
                    and second_status == "committed"
                    and second_id == first_id + 1
                    and event_count - after_replay_count == 1
                ),
                "committedEventCount": event_count,
                "transientThresholdAttemptAuditable": (
                    second_request.get("event", {}).get("safePayload", {}).get(
                        "thresholdReached"
                    ) is True
                ),
            }
            if observed != scenario.get("expected"):
                scenario_errors.append(
                    f"observation retry observed={observed!r} "
                    f"expected={scenario.get('expected')!r}"
                )
        observation_retry_results.append({
            "name": scenario.get("name"),
            "passed": not scenario_errors,
            "errors": scenario_errors,
        })
        errors.extend(
            f"observation retry {scenario.get('name')}: {error}"
            for error in scenario_errors
        )

    hold_collision_results: list[dict[str, Any]] = []
    first_row_mutation_detected = False
    for scenario in fixtures.get("holdSourceCollisionScenarios", []):
        rows = scenario.get("rows", [])
        expected = scenario.get("expected", {})
        source_pairs = {
            (row.get("sourceKind"), row.get("sourceRef"))
            for row in rows if isinstance(row, dict)
        }
        owner_tuples = {
            (row.get("actionKey"), row.get("operationKey"), row.get("taskRunId"))
            for row in rows if isinstance(row, dict)
        }
        if len(source_pairs) != 1 or not rows:
            observed = {
                "decision": "invalid",
                "unknown": True,
                "holdCreated": True,
                "inspectorCalls": 0,
                "providerCalls": 0,
            }
        elif len(owner_tuples) == 1:
            observed = {
                "decision": "inspect-once",
                "unknown": False,
                "holdCreated": False,
                "inspectorCalls": 1,
                "providerCalls": 1,
            }
        else:
            observed = {
                "decision": "unknown-and-hold",
                "unknown": True,
                "holdCreated": True,
                "inspectorCalls": 0,
                "providerCalls": 0,
            }
        passed = observed == expected
        if not passed:
            errors.append(f"Hold source collision simulation drift: {scenario.get('name')}")
        first_row_mutant = {
            "decision": "inspect-once",
            "unknown": False,
            "holdCreated": False,
            "inspectorCalls": 1,
            "providerCalls": 1,
        }
        if len(owner_tuples) > 1 and first_row_mutant != expected:
            first_row_mutation_detected = True
        hold_collision_results.append({
            "name": scenario.get("name"),
            "observed": observed,
            "passed": passed,
        })
    if not first_row_mutation_detected:
        errors.append("Hold collision first-row-continue mutation was not detected")

    transition_base = copy.deepcopy(
        fixtures.get("transitionRequests", [{}])[0].get("request", {})
        if fixtures.get("transitionRequests") else {}
    )
    observation_base = copy.deepcopy(
        fixtures.get("observationRequests", [{}])[0].get("request", {})
        if fixtures.get("observationRequests") else {}
    )
    result_base = copy.deepcopy(transition_result_value)
    mutation_results: list[dict[str, Any]] = []

    def record_mutation(name: str, rejected: bool, assertion_count: int = 1) -> None:
        mutation_results.append(
            {"name": name, "rejected": rejected, "assertionCount": assertion_count}
        )
        if not rejected:
            errors.append(f"recovery-control schema/semantic mutation passed: {name}")

    for fixture in load_json(INVALID_RECOVERY_CONTROL_PATH):
        mutation = fixture["mutation"]
        name = fixture["name"]
        if mutation.startswith("each-transition-"):
            branch_rejections: list[bool] = []
            for valid_item in fixtures["transitionRequests"]:
                candidate = copy.deepcopy(valid_item["request"])
                transition = candidate["transition"]
                if mutation == "each-transition-add-state":
                    transition["state"] = "running"
                elif mutation == "each-transition-add-eventType":
                    transition["eventType"] = "recovery-started"
                elif mutation == "each-transition-add-requestHash":
                    transition["requestHash"] = "0" * 64
                elif mutation == "each-transition-add-request_hash":
                    transition["request_hash"] = "0" * 64
                elif mutation == "each-transition-delete-required-leaf":
                    removable = [
                        key for key in transition if key not in {"entityKind", "command"}
                    ]
                    if removable:
                        del transition[removable[0]]
                    else:
                        errors.append(
                            f"each-transition mutation has no removable leaf: {valid_item.get('name')}"
                        )
                else:
                    errors.append(f"unknown each-transition mutation: {mutation}")
                branch_rejections.append(
                    bool(json_errors(transition_validator, candidate) or request_semantic_errors(candidate))
                )
            record_mutation(name, all(branch_rejections), len(branch_rejections))
            continue

        if mutation.startswith("transition-event-"):
            candidate = copy.deepcopy(transition_base)
            event = candidate["event"]
            if mutation == "transition-event-delete-eventId":
                del event["eventId"]
            elif mutation == "transition-event-add-requestHash":
                event["requestHash"] = "0" * 64
            elif mutation == "transition-event-add-request_hash":
                event["request_hash"] = "0" * 64
            elif mutation == "transition-event-add-eventType":
                event["eventType"] = "recovery-started"
            record_mutation(name, bool(json_errors(transition_validator, candidate)))
            continue

        if mutation.startswith("observation-event-"):
            candidates: list[dict[str, Any]] = []
            for valid_item in fixtures["observationRequests"]:
                candidate = copy.deepcopy(valid_item["request"])
                event = candidate["event"]
                if mutation == "observation-event-delete-eventId":
                    del event["eventId"]
                elif mutation == "observation-event-delete-observationAttemptId":
                    del event["observationAttemptId"]
                elif mutation == "observation-event-add-requestHash":
                    event["requestHash"] = "0" * 64
                elif mutation == "observation-event-add-request_hash":
                    event["request_hash"] = "0" * 64
                elif mutation == "observation-event-add-state":
                    event["state"] = "running"
                elif mutation == "observation-event-add-previousState":
                    event["previousState"] = "running"
                elif mutation == "observation-event-add-expectedTaskKey":
                    event["expectedTaskKey"] = "monthly-balance:export"
                candidates.append(candidate)
            rejected = all(bool(json_errors(observation_validator, value)) for value in candidates)
            record_mutation(name, rejected, len(candidates))
            continue

        if mutation.startswith("result-"):
            candidate = copy.deepcopy(result_base)
            if mutation == "result-add-replayed":
                candidate["replayed"] = True
            elif mutation == "result-add-currentState":
                candidate["currentState"] = "resolved"
            elif mutation == "result-uppercase-requestHash":
                candidate["requestHash"] = candidate["requestHash"].upper()
            record_mutation(
                name,
                bool(json_errors(result_validators["RecoveryControlTransitionResultV1"], candidate)),
            )
            continue
        errors.append(f"unknown recovery-control invalid mutation: {mutation}")

    generated_mutations: list[tuple[str, dict[str, Any], Draft202012Validator]] = []
    top_extra = copy.deepcopy(transition_base)
    top_extra["requestHash"] = "0" * 64
    generated_mutations.append(("transition-request-top-level-extra", top_extra, transition_validator))
    if intent_item is not None:
        nested_extra = copy.deepcopy(intent_item.get("request", {}))
        nested_extra.get("transition", {}).get("input", {})["state"] = "prepared"
        generated_mutations.append(("prepared-intent-nested-extra", nested_extra, transition_validator))
    if hold_item is not None:
        hold_extra = copy.deepcopy(hold_item.get("request", {}))
        hold_extra.get("transition", {}).get("input", {})["eventType"] = "hold-created"
        generated_mutations.append(("hold-input-nested-extra", hold_extra, transition_validator))
    mismatch = copy.deepcopy(transition_base)
    mismatch["transition"]["expectedTaskKey"] = "file:import"
    record_mutation(
        "verified-binding-mismatch",
        bool(json_errors(transition_validator, mismatch) or request_semantic_errors(mismatch)),
    )
    nullable_pair = copy.deepcopy(transition_base)
    nullable_pair["transition"]["sourceRef"] = None
    record_mutation(
        "task-source-nullable-pair-mismatch",
        bool(json_errors(transition_validator, nullable_pair) or request_semantic_errors(nullable_pair)),
    )
    for name, candidate, validator in generated_mutations:
        record_mutation(name, bool(json_errors(validator, candidate)))

    schema_inventory_mutants: dict[str, dict[str, Any]] = {}
    intent_close_removed = copy.deepcopy(recovery_control_schema)
    intent_branches = intent_close_removed["$defs"]["CriticalIntentTransitionV1"]["oneOf"]
    intent_close_removed["$defs"]["CriticalIntentTransitionV1"]["oneOf"] = [
        branch for branch in intent_branches
        if branch["properties"]["command"]["const"] != "close"
    ]
    schema_inventory_mutants["schema-delete-intent-close-branch"] = intent_close_removed

    operation_required_removed = copy.deepcopy(recovery_control_schema)
    operation_required = operation_required_removed["$defs"]["TaskRunTransitionV1"]["oneOf"][0]["required"]
    if "operationKey" in operation_required:
        operation_required.remove("operationKey")
    schema_inventory_mutants["schema-delete-operationKey-required"] = operation_required_removed

    result_request_key_removed = copy.deepcopy(recovery_control_schema)
    result_required = result_request_key_removed["$defs"]["RecoveryEventProjectionV1"]["required"]
    if "requestKey" in result_required:
        result_required.remove("requestKey")
    schema_inventory_mutants["schema-delete-result-requestKey-required"] = result_request_key_removed

    settlement_resumed_removed = copy.deepcopy(recovery_control_schema)
    settlement_event_types = settlement_resumed_removed["$defs"]["RecoveryObservationEventInputV1"]["properties"][
        "eventType"
    ]["enum"]
    if "settlement-resumed" in settlement_event_types:
        settlement_event_types.remove("settlement-resumed")
    schema_inventory_mutants["schema-delete-settlement-resumed"] = settlement_resumed_removed

    optional_property_removed = copy.deepcopy(recovery_control_schema)
    del optional_property_removed["$defs"]["RecoveryObservationEventInputV1"]["properties"][
        "batchId"
    ]
    schema_inventory_mutants["schema-delete-observation-optional-batchId"] = optional_property_removed

    observation_attempt_required_removed = copy.deepcopy(recovery_control_schema)
    observation_required = observation_attempt_required_removed["$defs"][
        "RecoveryObservationEventInputV1"
    ]["required"]
    if "observationAttemptId" in observation_required:
        observation_required.remove("observationAttemptId")
    schema_inventory_mutants[
        "schema-delete-observationAttemptId-required"
    ] = observation_attempt_required_removed

    result_attempt_property_removed = copy.deepcopy(recovery_control_schema)
    result_attempt_properties = result_attempt_property_removed["$defs"][
        "RecoveryEventProjectionV1"
    ]["properties"]
    result_attempt_properties.pop("observationAttemptId", None)
    schema_inventory_mutants[
        "schema-delete-result-observationAttemptId"
    ] = result_attempt_property_removed

    result_definition_removed = copy.deepcopy(recovery_control_schema)
    del result_definition_removed["$defs"]["RecoveryObservationEventResultV1"]
    schema_inventory_mutants["schema-delete-observation-result-definition"] = result_definition_removed

    for name, mutant_schema in schema_inventory_mutants.items():
        record_mutation(name, bool(_schema_inventory_errors(mutant_schema, fixtures)))

    sensitivity_payloads: list[Any] = []
    sensitivity_specs: list[tuple[str, int, list[tuple[str, int]]]] = []
    branch_requests = [
        (item["name"], "transitionWithRecoveryEvent", item["request"])
        for item in fixtures["transitionRequests"]
    ] + [
        (item["name"], "appendObservationEvent", item["request"])
        for item in fixtures["observationRequests"]
    ]
    for name, writer, request in branch_requests:
        envelope = {"contractVersion": 1, "writer": writer, "input": request}
        baseline_index = len(sensitivity_payloads)
        sensitivity_payloads.append(envelope)
        mutant_indexes: list[tuple[str, int]] = []
        for path in _leaf_paths(envelope):
            mutant_indexes.append(("/".join(map(str, path)), len(sensitivity_payloads)))
            sensitivity_payloads.append(_mutate_leaf(envelope, path))
        sensitivity_specs.append((name, baseline_index, mutant_indexes))
    sensitivity_digests = [item["sha256"] for item in node_jcs_batch(sensitivity_payloads)]
    sensitivity_results: list[dict[str, Any]] = []
    sensitivity_assertion_count = 0
    for name, baseline_index, mutant_indexes in sensitivity_specs:
        failures = [
            path for path, index in mutant_indexes
            if sensitivity_digests[index] == sensitivity_digests[baseline_index]
        ]
        sensitivity_assertion_count += len(mutant_indexes)
        sensitivity_results.append(
            {"branch": name, "leafCount": len(mutant_indexes), "failedPaths": failures}
        )
        if failures:
            errors.append(f"full-envelope leaf hash sensitivity failed for {name}: {failures}")
    actual_leaf_counts = {
        item["branch"]: item["leafCount"] for item in sensitivity_results
    }
    if actual_leaf_counts != EXPECTED_RECOVERY_LEAF_COUNTS:
        errors.append(
            f"per-branch full-envelope leaf map drift: {actual_leaf_counts!r}"
        )
    if sensitivity_assertion_count != EXPECTED_RECOVERY_LEAF_TOTAL:
        errors.append(
            "full-envelope leaf sensitivity total drift: "
            f"expected={EXPECTED_RECOVERY_LEAF_TOTAL} actual={sensitivity_assertion_count}"
        )

    optional_fields = ("batchId", "intentId", "holdId", "recoveryAttemptId")
    full_observation = copy.deepcopy(fixtures["observationRequests"][0]["request"])
    optional_state_payloads: list[Any] = []
    optional_specs: list[tuple[str, str, list[int]]] = []
    for event_type in sorted(OBSERVATION_EVENT_TYPES):
        for field in optional_fields:
            values: list[dict[str, Any]] = []
            present = copy.deepcopy(full_observation)
            present["event"]["eventType"] = event_type
            present["event"]["eventId"] = f"optional-{event_type}-{field}"
            values.append(present)
            absent = copy.deepcopy(present)
            del absent["event"][field]
            values.append(absent)
            explicit_null = copy.deepcopy(present)
            explicit_null["event"][field] = None
            values.append(explicit_null)
            changed = copy.deepcopy(present)
            changed["event"][field] = (
                present["event"][field] + "~"
                if isinstance(present["event"][field], str)
                else present["event"][field] + 1
            )
            values.append(changed)
            schema_passed = all(not json_errors(observation_validator, value) for value in values)
            if not schema_passed:
                errors.append(f"observation optional state fixture invalid: {event_type}/{field}")
            indexes = list(range(len(optional_state_payloads), len(optional_state_payloads) + 4))
            optional_state_payloads.extend(
                {"contractVersion": 1, "writer": "appendObservationEvent", "input": value}
                for value in values
            )
            optional_specs.append((event_type, field, indexes))
    optional_digests = [item["sha256"] for item in node_jcs_batch(optional_state_payloads)]
    optional_results: list[dict[str, Any]] = []
    for event_type, field, indexes in optional_specs:
        digests = [optional_digests[index] for index in indexes]
        passed = len(set(digests)) == 4
        optional_results.append(
            {"eventType": event_type, "field": field, "stateCount": 4, "passed": passed}
        )
        if not passed:
            errors.append(f"observation optional leaf hash sensitivity failed: {event_type}/{field}")

    return errors, {
        "validTransitionBranchCount": len(fixtures["transitionRequests"]),
        "validObservationBranchCount": len(fixtures["observationRequests"]),
        "validResultCount": len(fixtures["results"]),
        "schemaInventoryErrors": inventory_errors,
        "requestKeyContract": request_key_details,
        "resultProjectionContract": projection_details,
        "requiredDeletionAssertionCount": len(required_deletion_results),
        "requiredDeletionResults": required_deletion_results,
        "crossResultDtoMutationResults": cross_result_mutations,
        "sha1SchemaMutationResults": sha1_schema_mutations,
        "validFixtures": valid_details,
        "invalidMutationClassCount": len(load_json(INVALID_RECOVERY_CONTROL_PATH)),
        "mutationAssertionCount": sum(item["assertionCount"] for item in mutation_results),
        "mutationResults": mutation_results,
        "fullEnvelopeLeafSensitivityBranchCount": len(sensitivity_results),
        "fullEnvelopeLeafSensitivityAssertionCount": sensitivity_assertion_count,
        "expectedFullEnvelopeLeafSensitivityAssertionCount": EXPECTED_RECOVERY_LEAF_TOTAL,
        "expectedFullEnvelopeLeafSensitivityMap": EXPECTED_RECOVERY_LEAF_COUNTS,
        "fullEnvelopeLeafSensitivityResults": sensitivity_results,
        "observationOptionalStateAssertionCount": len(optional_results),
        "observationOptionalStateResults": optional_results,
        "immutableResultHashResults": result_hash_results,
        "restartReplayScenarioCount": len(restart_replay_results),
        "restartReplayScenarioResults": restart_replay_results,
        "observationAttemptLifecycleResults": attempt_lifecycle_results,
        "observationRetryScenarioResults": observation_retry_results,
        "holdSourceCollisionScenarioResults": hold_collision_results,
        "holdFirstRowContinueMutationDetected": first_row_mutation_detected,
        "errors": errors,
    }


def _marked_body(text: str, marker: str, fenced_sql: bool = False) -> str:
    begin = f"<!-- BEGIN {marker} -->"
    end = f"<!-- END {marker} -->"
    if text.count(begin) != 1 or text.count(end) != 1:
        raise ValueError(f"marker {marker} must occur exactly once")
    body = text.split(begin, 1)[1].split(end, 1)[0].strip()
    if fenced_sql:
        match = re.fullmatch(r"```sql\n(?P<sql>[\s\S]*?)\n```", body)
        if not match:
            raise ValueError(f"marker {marker} must contain one exact sql fence")
        return match.group("sql")
    return body


def _physical_sql_contract_errors(
    e00_text: str, fixtures: dict[str, Any]
) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    contract = fixtures.get("physicalSqlContract", {})
    if contract.get("contractVersion") != 1:
        errors.append("physical SQL contractVersion drift")
    if contract.get("mappingMarker") != "PHYSICAL_BATCH_IDENTITY_MAPPING_V1":
        errors.append("physical mapping marker drift")
    if contract.get("mappingSentence") != EXPECTED_PHYSICAL_MAPPING_SENTENCE:
        errors.append("physical mapping machine sentence drift")
    try:
        documented_mapping = _marked_body(e00_text, "PHYSICAL_BATCH_IDENTITY_MAPPING_V1")
    except ValueError as exc:
        documented_mapping = ""
        errors.append(str(exc))
    if documented_mapping != EXPECTED_PHYSICAL_MAPPING_SENTENCE:
        errors.append("dedicated physical batch identity mapping drift")

    statements = contract.get("statements", [])
    expected_names = list(EXPECTED_PHYSICAL_SQL_HASHES)
    if [item.get("name") for item in statements] != expected_names:
        errors.append("physical SQL statement inventory/order drift")
    statement_results: list[dict[str, Any]] = []
    for statement in statements:
        name = statement.get("name")
        marker = statement.get("marker")
        item_errors: list[str] = []
        if marker != f"PHYSICAL_SQL_{str(name).replace('-', '_').upper()}_V1":
            item_errors.append("marker/name drift")
        try:
            sql = _marked_body(e00_text, str(marker), fenced_sql=True)
        except ValueError as exc:
            sql = ""
            item_errors.append(str(exc))
        actual_hash = hashlib.sha256(sql.encode("utf-8")).hexdigest()
        expected_hash = EXPECTED_PHYSICAL_SQL_HASHES.get(str(name))
        if statement.get("exactSqlSha256") != expected_hash or actual_hash != expected_hash:
            item_errors.append(
                f"exact SQL hash drift expected={expected_hash} actual={actual_hash}"
            )
        actual_kinds = [
            "SELECT changes" if token.upper().startswith("SELECT CHANGES") else token.upper()
            for token in re.findall(r"^(SELECT changes\(\)|SELECT|UPDATE|INSERT)", sql, re.MULTILINE | re.IGNORECASE)
        ]
        if actual_kinds != statement.get("statementKinds"):
            item_errors.append(f"statement kind sequence drift: {actual_kinds!r}")
        for field_name in (
            "tables", "selectedColumns", "updatedColumns", "predicates", "projectionAliases",
        ):
            for fragment in statement.get(field_name, []):
                if fragment not in sql:
                    item_errors.append(f"missing {field_name} fragment: {fragment}")
        identity_column = statement.get("identityColumn")
        if identity_column and identity_column not in sql:
            item_errors.append(f"missing identityColumn: {identity_column}")
        changes_count = len(
            re.findall(r"^SELECT changes\(\); -- .*MUST equal 1$", sql, re.MULTILINE)
        )
        if changes_count != statement.get("expectedChangesOneCount"):
            item_errors.append(
                f"changes=1 gate count drift expected={statement.get('expectedChangesOneCount')} "
                f"actual={changes_count}"
            )
        statement_results.append(
            {"name": name, "actualSha256": actual_hash, "passed": not item_errors, "errors": item_errors}
        )
        errors.extend(f"physical SQL {name}: {error}" for error in item_errors)

    forbidden_physical_name = "archive_batches." + "batch_id"
    forbidden_paths: list[str] = []
    for path in PACKAGE_ROOT.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".md", ".json", ".py", ".js", ".txt", ".sh"}:
            if forbidden_physical_name in path.read_text(encoding="utf-8"):
                forbidden_paths.append(str(path.relative_to(PACKAGE_ROOT)))
    if forbidden_paths:
        errors.append(f"forbidden physical column spelling present: {forbidden_paths}")

    mapping_mutant = e00_text.replace(
        EXPECTED_PHYSICAL_MAPPING_SENTENCE,
        EXPECTED_PHYSICAL_MAPPING_SENTENCE.replace("column `id`", "column `legacy_id`"),
        1,
    )
    batch_sql_mutant = e00_text.replace("WHERE id = :batchId", "WHERE legacy_id = :batchId", 1)

    def dedicated_mapping_rejected(text: str) -> bool:
        try:
            return _marked_body(text, "PHYSICAL_BATCH_IDENTITY_MAPPING_V1") != EXPECTED_PHYSICAL_MAPPING_SENTENCE
        except ValueError:
            return True

    def dedicated_batch_sql_rejected(text: str) -> bool:
        try:
            sql = _marked_body(text, "PHYSICAL_SQL_BATCH_CAS_V1", fenced_sql=True)
        except ValueError:
            return True
        return hashlib.sha256(sql.encode("utf-8")).hexdigest() != EXPECTED_PHYSICAL_SQL_HASHES["batch-cas"]

    mutation_results = {
        "dedicated-mapping-sentence-mutation": dedicated_mapping_rejected(mapping_mutant),
        "dedicated-batch-sql-mutation": dedicated_batch_sql_rejected(batch_sql_mutant),
    }
    for name, rejected in mutation_results.items():
        if not rejected:
            errors.append(f"physical SQL dedicated mutation passed: {name}")
    return errors, {
        "statementCount": len(statements),
        "statementResults": statement_results,
        "forbiddenPhysicalNamePaths": forbidden_paths,
        "mutationResults": mutation_results,
        "errors": errors,
    }


def _owner_ddl_execution_errors(
    e00_text: str, fixtures: dict[str, Any]
) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    attempt_match = re.search(
        r"CREATE TABLE IF NOT EXISTS background_execution_recovery_observation_attempts \("
        r"[\s\S]*?\n\);",
        e00_text,
    )
    owner_match = re.search(
        r"CREATE TABLE IF NOT EXISTS background_execution_recovery_request_owners \("
        r"[\s\S]*?\n\);",
        e00_text,
    )
    event_match = re.search(
        r"CREATE TABLE IF NOT EXISTS background_execution_recovery_events \("
        r"[\s\S]*?\n\);",
        e00_text,
    )
    if not attempt_match or not owner_match or not event_match:
        return ["cannot execute missing attempt/owner/event DDL"], {
            "errors": ["missing attempt/owner/event DDL"]
        }
    try:
        immutable_result_sql = _marked_body(
            e00_text, "PHYSICAL_SQL_IMMUTABLE_RESULT_V1", fenced_sql=True
        )
    except ValueError as exc:
        return [str(exc)], {"errors": [str(exc)]}

    projection_errors, _, projections = _result_projection_contract_errors(
        load_json(RECOVERY_CONTROL_SCHEMA_PATH), fixtures, run_mutations=False
    )
    errors.extend(
        f"owner DDL prerequisite projection: {error}" for error in projection_errors
    )
    lifecycle = named_item(
        fixtures.get("ownerLifecycleFixtures", []),
        "batch-begin-recovery-prepared-to-committed",
    )
    if lifecycle is None:
        return errors + ["owner lifecycle fixture missing"], {
            "errors": errors + ["owner lifecycle fixture missing"]
        }
    owner = lifecycle.get("preparedOwner", {})
    transition_projection = projections.get("batch-begin-recovery")
    observation_projection = projections.get("inspection-failed-transient-minimal-lineage")
    observation_item = named_item(
        fixtures.get("observationRequests", []),
        "inspection-failed-transient-minimal-lineage",
    )
    attempt_lifecycle = named_item(
        fixtures.get("observationAttemptLifecycleFixtures", []),
        "inspection-transient-attempt-1-prepared-committed-restart",
    )
    if transition_projection is None or observation_projection is None:
        errors.append("owner DDL derived transition/observation projection missing")
    if observation_item is None or attempt_lifecycle is None:
        errors.append("owner DDL observation request/attempt lifecycle fixture missing")
    equality_columns = {
        "requestKey": "request_key",
        "writer": "writer",
        "eventId": "event_id",
        "requestHash": "request_hash",
        "createdAt": "created_at",
    }

    def new_connection() -> sqlite3.Connection:
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(
            attempt_match.group(0)
            + "\n"
            + owner_match.group(0)
            + "\n"
            + event_match.group(0)
        )
        return connection

    def insert_owner(
        connection: sqlite3.Connection, owner_value: dict[str, Any]
    ) -> None:
        connection.execute(
            """
            INSERT INTO background_execution_recovery_request_owners (
              request_key, writer, event_id, request_hash, request_jcs,
              status, created_at, committed_at
            ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, NULL)
            """,
            (
                owner_value["requestKey"], owner_value["writer"],
                owner_value["eventId"], owner_value["requestHash"],
                owner_value["requestJcs"], owner_value["createdAt"],
            ),
        )

    def insert_event(
        connection: sqlite3.Connection,
        projection: dict[str, Any],
        overrides: dict[str, Any],
        observation_scope_key: str | None = None,
    ) -> None:
        row = {
            **projection,
            **overrides,
        }
        connection.execute(
            """
            INSERT INTO background_execution_recovery_events (
              request_key, writer, event_id, request_hash, action_key, operation_key,
              task_run_id, source_kind, source_ref, batch_id, intent_id, hold_id,
              recovery_attempt_id, observation_scope_key, observation_attempt_id,
              event_type, previous_state, next_state, safe_payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["requestKey"], row["writer"], row["eventId"], row["requestHash"],
                row["actionKey"], row["operationKey"], row["taskRunId"],
                row["sourceKind"], row["sourceRef"], row["batchId"],
                row["intentId"], row["holdId"], row["recoveryAttemptId"],
                observation_scope_key, row["observationAttemptId"], row["eventType"],
                row["previousState"], row["nextState"],
                json.dumps(row["safePayload"], ensure_ascii=False, separators=(",", ":")),
                row["createdAt"],
            ),
        )

    def query_projection(
        connection: sqlite3.Connection, expected: dict[str, Any]
    ) -> tuple[dict[str, Any] | None, list[str]]:
        row = connection.execute(
            immutable_result_sql,
            {
                "requestKey": expected["requestKey"],
                "eventId": expected["eventId"],
                "requestHash": expected["requestHash"],
            },
        ).fetchone()
        if row is None:
            return None, ["immutable result query returned no row"]
        actual = dict(row)
        try:
            actual["safePayload"] = json.loads(actual["safePayload"])
        except (TypeError, json.JSONDecodeError):
            return actual, ["immutable result safePayload was not lossless JSON"]
        comparison_errors = [
            f"immutable result field mismatch: {field}"
            for field in RESULT_PROJECTION_FIELDS
            if actual.get(field) != expected.get(field)
        ]
        if list(actual) != RESULT_PROJECTION_FIELDS:
            comparison_errors.append("immutable result exact field order/inventory drift")
        return actual, comparison_errors

    mismatch_values = {
        "requestKey": "recovery-control:v1:" + "f" * 64,
        "writer": "appendObservationEvent",
        "eventId": "event-mismatch",
        "requestHash": "f" * 64,
        "createdAt": "2099-01-01T00:00:00.000Z",
    }
    equality_results: list[dict[str, Any]] = []
    for field, column in equality_columns.items():
        connection = new_connection()
        try:
            insert_owner(connection, owner)
            try:
                insert_event(
                    connection,
                    transition_projection or {},
                    {field: mismatch_values[field]},
                )
                rejected = False
            except sqlite3.IntegrityError:
                rejected = True
            equality_results.append({"field": field, "column": column, "rejected": rejected})
            if not rejected:
                errors.append(f"owner/event DDL accepted mismatched {field}")
        finally:
            connection.close()

    lifecycle_result = {
        "eventInserted": False,
        "preparedToCommittedChanges": 0,
        "projectionComparedFieldCount": 0,
        "projectionErrors": [],
    }
    connection = new_connection()
    try:
        insert_owner(connection, owner)
        connection.commit()
        connection.execute("BEGIN")
        insert_event(connection, transition_projection or {}, {})
        lifecycle_result["eventInserted"] = True
        cursor = connection.execute(
            """
            UPDATE background_execution_recovery_request_owners
            SET status = 'committed', committed_at = ?
            WHERE request_key = ? AND status = 'prepared'
            """,
            (lifecycle["committedOwner"]["committedAt"], owner["requestKey"]),
        )
        lifecycle_result["preparedToCommittedChanges"] = cursor.rowcount
        if cursor.rowcount != 1:
            errors.append("owner prepared-to-committed CAS changes != 1")
        stored = connection.execute(
            "SELECT status, committed_at FROM background_execution_recovery_request_owners"
        ).fetchone()
        if stored is None or tuple(stored) != (
            "committed", lifecycle["committedOwner"]["committedAt"]
        ):
            errors.append("owner committed lifecycle row drift")
        actual_projection, comparison_errors = query_projection(
            connection, transition_projection or {}
        )
        lifecycle_result["projectionComparedFieldCount"] = len(actual_projection or {})
        lifecycle_result["projectionErrors"] = comparison_errors
        errors.extend(comparison_errors)
        connection.commit()
    except sqlite3.DatabaseError as exc:
        errors.append(f"owner/event DDL executable lifecycle failed: {exc}")
    finally:
        connection.close()

    observation_result = {
        "attemptInsertedBeforeOwner": False,
        "attemptBoundChanges": 0,
        "eventInserted": False,
        "attemptCommittedChanges": 0,
        "ownerCommittedChanges": 0,
        "projectionComparedFieldCount": 0,
        "projectionErrors": [],
        "attemptMismatchRejected": False,
    }
    if observation_item is not None and attempt_lifecycle is not None:
        event = observation_item.get("request", {}).get("event", {})
        scope_key = attempt_lifecycle.get("scopeKey")
        canonical_envelope = {
            "contractVersion": 1,
            "writer": "appendObservationEvent",
            "input": observation_item.get("request"),
        }
        canonical_result = node_jcs_batch([canonical_envelope])[0]
        observation_owner = {
            "requestKey": observation_projection.get("requestKey")
            if observation_projection else None,
            "writer": "appendObservationEvent",
            "eventId": observation_projection.get("eventId")
            if observation_projection else None,
            "requestHash": canonical_result["sha256"],
            "requestJcs": canonical_result["canonical"],
            "createdAt": observation_projection.get("createdAt")
            if observation_projection else None,
        }
        connection = new_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT INTO background_execution_recovery_observation_attempts (
                  observation_scope_key, observation_attempt_id, event_type,
                  action_key, operation_key, task_run_id, source_kind, source_ref,
                  batch_id, intent_id, hold_id, recovery_attempt_id,
                  request_key, status, prepared_at, committed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'prepared', ?, NULL)
                """,
                (
                    scope_key, event["observationAttemptId"], event["eventType"],
                    event["actionKey"], event["operationKey"], event["taskRunId"],
                    event["sourceKind"], event["sourceRef"], event.get("batchId"),
                    event.get("intentId"), event.get("holdId"),
                    event.get("recoveryAttemptId"), event["createdAt"],
                ),
            )
            observation_result["attemptInsertedBeforeOwner"] = True
            bind_cursor = connection.execute(
                """
                UPDATE background_execution_recovery_observation_attempts
                SET request_key = ?
                WHERE observation_scope_key = ?
                  AND observation_attempt_id = ?
                  AND status = 'prepared'
                  AND (request_key IS NULL OR request_key = ?)
                """,
                (
                    observation_owner["requestKey"], scope_key,
                    event["observationAttemptId"], observation_owner["requestKey"],
                ),
            )
            observation_result["attemptBoundChanges"] = bind_cursor.rowcount
            insert_owner(connection, observation_owner)
            connection.commit()

            connection.execute("BEGIN")
            insert_event(
                connection,
                observation_projection or {},
                {},
                observation_scope_key=str(scope_key),
            )
            observation_result["eventInserted"] = True
            attempt_cursor = connection.execute(
                """
                UPDATE background_execution_recovery_observation_attempts
                SET status = 'committed', committed_at = ?
                WHERE observation_scope_key = ?
                  AND observation_attempt_id = ?
                  AND request_key = ?
                  AND status = 'prepared'
                """,
                (
                    event["createdAt"], scope_key, event["observationAttemptId"],
                    observation_owner["requestKey"],
                ),
            )
            observation_result["attemptCommittedChanges"] = attempt_cursor.rowcount
            owner_cursor = connection.execute(
                """
                UPDATE background_execution_recovery_request_owners
                SET status = 'committed', committed_at = ?
                WHERE request_key = ? AND status = 'prepared'
                """,
                (event["createdAt"], observation_owner["requestKey"]),
            )
            observation_result["ownerCommittedChanges"] = owner_cursor.rowcount
            actual_projection, comparison_errors = query_projection(
                connection, observation_projection or {}
            )
            observation_result["projectionComparedFieldCount"] = len(actual_projection or {})
            observation_result["projectionErrors"] = comparison_errors
            errors.extend(comparison_errors)
            if bind_cursor.rowcount != 1:
                errors.append("observation attempt bind changes != 1")
            if attempt_cursor.rowcount != 1:
                errors.append("observation attempt prepared-to-committed changes != 1")
            if owner_cursor.rowcount != 1:
                errors.append("observation owner prepared-to-committed changes != 1")
            connection.commit()
        except (KeyError, sqlite3.DatabaseError) as exc:
            errors.append(f"observation attempt/owner/event executable lifecycle failed: {exc}")
        finally:
            connection.close()

        mismatch_connection = new_connection()
        try:
            mismatch_connection.execute(
                """
                INSERT INTO background_execution_recovery_observation_attempts (
                  observation_scope_key, observation_attempt_id, event_type,
                  action_key, operation_key, task_run_id, source_kind, source_ref,
                  request_key, status, prepared_at, committed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?)
                """,
                (
                    scope_key, event["observationAttemptId"], event["eventType"],
                    event["actionKey"], event["operationKey"], event["taskRunId"],
                    event["sourceKind"], event["sourceRef"],
                    observation_owner["requestKey"], event["createdAt"],
                    event["createdAt"],
                ),
            )
            insert_owner(mismatch_connection, observation_owner)
            try:
                insert_event(
                    mismatch_connection,
                    observation_projection or {},
                    {"observationAttemptId": event["observationAttemptId"] + 1},
                    observation_scope_key=str(scope_key),
                )
            except sqlite3.IntegrityError:
                observation_result["attemptMismatchRejected"] = True
        except (KeyError, sqlite3.DatabaseError) as exc:
            errors.append(f"observation attempt mismatch executable gate failed: {exc}")
        finally:
            mismatch_connection.close()
        if not observation_result["attemptMismatchRejected"]:
            errors.append("observation attempt composite FK accepted mismatched ordinal")
    return errors, {
        "eventOwnerEqualityFields": list(equality_columns),
        "equalityMismatchResults": equality_results,
        "lifecycle": lifecycle_result,
        "observationLifecycle": observation_result,
        "errors": errors,
    }


def recovery_control_contract_errors() -> tuple[list[str], dict[str, Any]]:
    """Cross-check recovery control API, event-only audit, state scope and transactions."""
    errors: list[str] = []
    contract_text = PLATFORM_CONTRACT_PATH.read_text(encoding="utf-8")
    e00_tech_text = E00_TECHDOC_PATH.read_text(encoding="utf-8")
    e00_spec_text = E00_SPEC_PATH.read_text(encoding="utf-8")
    codex_spec_text = CODEX_SPEC_PATH.read_text(encoding="utf-8")
    codex_tech_text = CODEX_TECHDOC_PATH.read_text(encoding="utf-8")
    lifecycle_text = LIFECYCLE_MAPPING_PATH.read_text(encoding="utf-8")

    transaction_docs = (
        ("platform-contract-v1", contract_text),
        ("E00-platform-contract-v1-techdoc", e00_tech_text),
        ("CODEX-SPEC", codex_spec_text),
        ("CODEX-TECHDOC", codex_tech_text),
    )
    for name, body in transaction_docs:
        for canonical, description in (
            (CANONICAL_RECOVERY_ATOMICITY, "recovery atomicity"),
            (CANONICAL_OBSERVATION_EVENT_CONTRACT, "observation-only event"),
            (CANONICAL_MULTI_OBJECT_TRANSACTION, "multi-object outer transaction"),
        ):
            if canonical not in body:
                errors.append(f"{name} missing canonical {description} contract")

    errors.extend(_recovery_control_e00_api_errors(e00_tech_text))
    recovery_control_fixtures = load_json(VALID_RECOVERY_CONTROL_PATH)
    physical_sql_errors, physical_sql_details = _physical_sql_contract_errors(
        e00_tech_text, recovery_control_fixtures
    )
    errors.extend(physical_sql_errors)
    owner_ddl_errors, owner_ddl_details = _owner_ddl_execution_errors(
        e00_tech_text, recovery_control_fixtures
    )
    errors.extend(owner_ddl_errors)

    canonical_boundary_tests: list[dict[str, Any]] = []
    boundary_values = [
        {"v": "a" * 16376},
        {"v": "汉" * 5458 + "aa"},
    ]
    boundary_results = node_jcs_batch(boundary_values)
    for name, result, expected_size in zip(
        ("ascii-exact-16384", "multibyte-exact-16384"),
        boundary_results,
        (16384, 16384),
    ):
        actual_size = len(result["canonical"].encode("utf-8"))
        passed = actual_size == expected_size
        canonical_boundary_tests.append(
            {"name": name, "expectedBytes": expected_size, "actualBytes": actual_size, "passed": passed}
        )
        if not passed:
            errors.append(f"RFC8785-JCS byte boundary self-test failed: {name}")

    request_fixture = load_json(VALID_RECOVERY_CONTROL_PATH)["transitionRequests"][0]["request"]
    envelope = {
        "contractVersion": 1,
        "writer": "transitionWithRecoveryEvent",
        "input": request_fixture,
    }
    reordered = {
        "input": {
            "event": dict(reversed(list(request_fixture["event"].items()))),
            "transition": dict(reversed(list(request_fixture["transition"].items()))),
        },
        "writer": "transitionWithRecoveryEvent",
        "contractVersion": 1,
    }
    baseline_hash, reordered_hash, other_writer_hash = [
        result["sha256"] for result in node_jcs_batch(
            [envelope, reordered, {**envelope, "writer": "appendObservationEvent"}]
        )
    ]
    canonical_request_hash_tests = [
        {
            "name": "exact-replay-key-order-independent",
            "passed": baseline_hash == reordered_hash,
        },
        {
            "name": "writer-domain-separated",
            "passed": baseline_hash != other_writer_hash,
        },
    ]
    for item in canonical_request_hash_tests:
        if not item["passed"]:
            errors.append(f"canonical recovery request hash self-test failed: {item['name']}")

    try:
        lifecycle_start = lifecycle_text.index("### 7.3 Append-only recovery events（MUST）")
        lifecycle_event_types = set(
            _extract_text_enum_after(lifecycle_text[lifecycle_start:], "至少记录：")
        )
    except ValueError as exc:
        errors.append(f"lifecycle recovery event list unreadable: {exc}")
        lifecycle_event_types = set()
    if lifecycle_event_types != LIFECYCLE_RECOVERY_EVENT_TYPES:
        errors.append(
            "lifecycle recovery event list drift: "
            f"expected={sorted(LIFECYCLE_RECOVERY_EVENT_TYPES)} "
            f"actual={sorted(lifecycle_event_types)}"
        )
    for required_lifecycle_rule in (
        "RecoveryControlTransactionV1.transitionWithRecoveryEvent()",
        "RecoveryControlTransactionV1.appendObservationEvent()",
        "不得修改控制状态",
        "Inspector/Provider 调用本身不得在 SQLite transaction 内执行",
        "RECOVERY_TRANSITION_EVENT_MAP_V1",
        "不得混记",
    ):
        if required_lifecycle_rule not in lifecycle_text:
            errors.append(f"lifecycle mapping missing recovery control rule: {required_lifecycle_rule}")

    critical_state_docs = (
        ("platform-contract-v1", contract_text),
        ("E00-platform-contract-v1-spec", e00_spec_text),
        ("E00-platform-contract-v1-techdoc", e00_tech_text),
        ("CODEX-SPEC", codex_spec_text),
        ("CODEX-TECHDOC", codex_tech_text),
    )
    critical_edges = (
        "prepared → acked → committed → closed",
        "prepared → recovered → closed",
        "acked → recovered → closed",
    )
    for name, body in critical_state_docs:
        for edge in critical_edges:
            if edge not in body:
                errors.append(f"{name} missing Critical Intent edge: {edge}")
    if "prepared → acked → committed/recovered → closed" in codex_tech_text:
        errors.append("CODEX-TECHDOC still contains ambiguous committed/recovered Critical Intent edge")

    task_scope_docs = (
        ("platform-contract-v1", contract_text),
        ("E00-platform-contract-v1-spec", e00_spec_text),
        ("E00-platform-contract-v1-techdoc", e00_tech_text),
        ("CODEX-SPEC", codex_spec_text),
        ("CODEX-TECHDOC", codex_tech_text),
    )
    for name, body in task_scope_docs:
        if "常规 `prepared → running`" not in body:
            errors.append(f"{name} does not preserve normal TaskLifecycle ownership")

    # Mutation tests prove that the checker rejects each newly closed drift class.
    mutant_e00_documents = {
        "missing-outer-transaction-entry": e00_tech_text.replace(
            "runInControlTransaction<T>", "removedControlTransaction<T>", 1
        ),
        "top-level-state-writer": e00_tech_text.replace(
            "interface RecoveryControlRepository {",
            "interface RecoveryControlRepository {\n"
            "  transitionWithRecoveryEvent(input: object): object;",
            1,
        ),
        "missing-observation-writer": e00_tech_text.replace(
            "  appendObservationEvent(\n", "  removedObservationEvent(\n", 1
        ),
        "broadened-observation-enum": e00_tech_text.replace(
            "  | 'settlement-failed-transient';",
            "  | 'settlement-failed-transient'\n  | 'hold-created';",
            1,
        ),
        "committed-to-recovered": e00_tech_text.replace(
            "expectedState: 'prepared' | 'acked'; inspection",
            "expectedState: 'prepared' | 'acked' | 'committed'; inspection",
            1,
        ),
        "normal-task-command-in-recovery-union": e00_tech_text.replace(
            "\ntype BatchOverlayTransitionV1 =",
            "\n  | { entityKind: 'task-run'; command: 'start-normal'; taskRunId: string };"
            "\n\ntype BatchOverlayTransitionV1 =",
            1,
        ),
        "observation-state-check-removed": e00_tech_text.replace(
            "OR (previous_state IS NULL AND next_state IS NULL)", "OR 1 = 1", 1
        ),
        "transition-event-map-drift": e00_tech_text.replace(
            '"task-run.mark-interrupted": "interrupted-recorded"',
            '"task-run.mark-interrupted": "recovery-started"',
            1,
        ),
        "audit-lineage-column-removed": e00_tech_text.replace(
            "request_hash TEXT NOT NULL CHECK", "request_hash TEXT CHECK"
        ),
        "manual-observation-source-enabled": e00_tech_text.replace(
            "sourceKind: RecoverySourceV1['sourceKind'];",
            "sourceKind: RecoveryHoldSourceKindV1;",
            1,
        ),
        "task-action-key-removed": e00_tech_text.replace(
            "command: 'mark-interrupted'; actionKey: string;",
            "command: 'mark-interrupted';",
            1,
        ),
        "success-allows-failure-fields": e00_tech_text.replace(
            "recoveryAttemptId: string; metadataPatch: BoundedMetadataPatchV1 }\n  | { entityKind: 'task-run'; command: 'complete-recovery-failure'",
            "recoveryAttemptId: string; failureCode: BoundedFailureCodeV1; metadataPatch: BoundedMetadataPatchV1 }\n  | { entityKind: 'task-run'; command: 'complete-recovery-failure'",
            1,
        ),
        "persistent-task-key-cas-removed": e00_tech_text.replace(
            "`archive_task_runs.task_key === expectedTaskKey`",
            "`taskRunId === taskRunId`",
        ),
        "operation-key-cas-removed": e00_tech_text.replace(
            "`archive_task_runs.operation_key === operationKey`",
            "`operationKey === operationKey`",
        ),
        "task-source-pair-removed": e00_tech_text.replace(
            "sourceRef: string | null; expectedState: 'prepared' | 'running'",
            "expectedState: 'prepared' | 'running'",
            1,
        ),
        "batch-action-key-removed": e00_tech_text.replace(
            "entityKind: 'batch-overlay'; command: 'mark-interrupted'; actionKey: string;",
            "entityKind: 'batch-overlay'; command: 'mark-interrupted';",
            1,
        ),
        "batch-expected-task-key-removed": e00_tech_text.replace(
            "entityKind: 'batch-overlay'; command: 'begin-recovery'; actionKey: string; expectedTaskKey: string;",
            "entityKind: 'batch-overlay'; command: 'begin-recovery'; actionKey: string;",
            1,
        ),
        "batch-operation-key-removed": e00_tech_text.replace(
            "entityKind: 'batch-overlay'; command: 'resolve-success'; actionKey: string; expectedTaskKey: string; operationKey: string;",
            "entityKind: 'batch-overlay'; command: 'resolve-success'; actionKey: string; expectedTaskKey: string;",
            1,
        ),
        "batch-caller-event-type-added": e00_tech_text.replace(
            "entityKind: 'batch-overlay'; command: 'resolve-failure'; actionKey: string;",
            "entityKind: 'batch-overlay'; command: 'resolve-failure'; eventType: string; actionKey: string;",
            1,
        ),
        "recovery-event-request-hash-removed": e00_tech_text.replace(
            "request_hash TEXT NOT NULL CHECK", "request_hash TEXT CHECK"
        ),
        "request-hash-safe-payload-only": e00_tech_text.replace(
            "input: { transition, event }",
            "input: { safePayload: event.safePayload }",
            1,
        ),
        "event-id-only-replay": e00_tech_text.replace(
            "Repository 必须在任何 state CAS 之前按 `requestKey` 读取已持久 owner",
            "Repository 在 state CAS 后按 `eventId` 读取已持久事件",
            1,
        ),
        "immutable-result-request-key-predicate-removed": e00_tech_text.replace(
            "WHERE event.request_key = :requestKey",
            "WHERE event.event_id = :eventId",
            1,
        ),
        "safe-payload-used-as-state-patch": e00_tech_text.replace(
            "`safePayload` 只记录 writer 完成后的 bounded 审计结果",
            "`safePayload` 用于反向回填 TaskRun 业务列",
            1,
        ),
        "cancelled-recovery-scope-broadened": e00_tech_text.replace(
            "not-committed + cancelled → cancelled（仅限 live execution 在进入 critical/protected 前，由 normal TaskLifecycle 完成）",
            "not-committed + cancelled → cancelled",
            1,
        ),
        "prepared-intent-coordination-enum-drift": e00_tech_text.replace(
            "coordinationKind: 'worker-critical' | 'main-owned-settlement';",
            "coordinationKind: 'worker-handshake' | 'main-owned';",
            1,
        ),
        "coordination-sql-check-drift": e00_tech_text.replace(
            "coordination_kind IN ('worker-critical', 'main-owned-settlement')",
            "coordination_kind IN ('worker-handshake', 'main-owned')",
            1,
        ),
        "coordination-policy-derivation-drift": e00_tech_text.replace(
            "`coordination_kind` 由 policy 推导：`worker-durable` 使用 `worker-critical`；`main-settlement + target-post-image` 使用 `main-owned-settlement`。",
            "`coordination_kind` 由 policy 推导：`worker-durable` 使用 `worker-handshake`；`main-settlement + target-post-image` 使用 `main-owned`。",
            1,
        ),
        "transition-event-extra-state": e00_tech_text.replace(
            "interface RecoveryTransitionEventInputV1 {\n  eventId: string;",
            "interface RecoveryTransitionEventInputV1 {\n  state: string;\n  eventId: string;",
            1,
        ),
        "observation-extra-expected-task-key": e00_tech_text.replace(
            "interface RecoveryObservationEventInputV1 {\n  eventId: string;",
            "interface RecoveryObservationEventInputV1 {\n  expectedTaskKey: string;\n  eventId: string;",
            1,
        ),
        "result-extra-replayed": e00_tech_text.replace(
            "interface RecoveryEventProjectionV1 {\n  contractVersion: 1;",
            "interface RecoveryEventProjectionV1 {\n  replayed: boolean;\n  contractVersion: 1;",
            1,
        ),
        "result-generic-current-state": e00_tech_text.replace(
            "type RecoveryControlTransitionResultV1 = Readonly<",
            "type RecoveryControlTransitionResultV1<T> = { currentState: T };\n"
            "type RemovedTransitionResultV1 = Readonly<",
            1,
        ),
        "owner-request-jcs-removed": e00_tech_text.replace(
            "  request_jcs TEXT NOT NULL,", "  request_jcs TEXT,", 1
        ),
        "stable-hold-owner-removed": e00_tech_text.replace(
            "Hold 扫描必须以 Hold 表的 durable UNIQUE `(sourceKind, sourceRef)` 先重算 requestKey",
            "Hold 扫描可以用每次新建的 holdId 重算 requestKey",
            1,
        ),
        "owner-event-composite-equality-removed": e00_tech_text.replace(
            "FOREIGN KEY(request_key, writer, event_id, request_hash, created_at)",
            "FOREIGN KEY(request_key)",
            1,
        ),
        "batch-mark-failure-fields-removed": e00_tech_text.replace(
            "expectedState: null; failureCode: BoundedFailureCodeV1; failureMessage: BoundedFailureMessageV1;",
            "expectedState: null;",
            1,
        ),
        "schema-authority-removed": e00_tech_text.replace(
            "`platform-recovery-control-v1.schema.json` 是上述两个 event input",
            "`platform-recovery-control-v1.schema.json` 仅供参考；上述两个 event input",
            1,
        ).replace("additionalProperties: false", "additionalProperties: true", 1),
        "archive-batch-primary-key-confused": e00_tech_text.replace(
            "WHERE batch.id = :batchId", "WHERE batch.batch_id = :batchId", 1
        ),
        "archive-task-join-task-key-removed": e00_tech_text.replace(
            "  AND task.task_key = :expectedTaskKey",
            "  AND task.task_run_id = :taskRunId",
            1,
        ),
        "archive-batch-operation-predicate-removed": e00_tech_text.replace(
            "  AND batch.operation_key = :operationKey",
            "  AND batch.operation_key IS NOT NULL",
            1,
        ),
        "archive-batch-base-id-confused": e00_tech_text.replace(
            "WHERE id = :batchId", "WHERE batch_id = :batchId", 1
        ),
        "overlay-batch-id-confused": e00_tech_text.replace(
            "overlay.batch_id", "batch.batch_id"
        ),
        "changes-one-gate-removed": e00_tech_text.replace(
            "SELECT changes(); -- MUST equal 1", "SELECT changes();"
        ),
    }
    negative_self_test_results: list[dict[str, Any]] = []
    for name, mutant in mutant_e00_documents.items():
        rejected = bool(_recovery_control_e00_api_errors(mutant))
        negative_self_test_results.append({"name": name, "rejected": rejected})
        if not rejected:
            errors.append(f"recovery control drift detector failed to reject mutant: {name}")

    details = {
        "transactionDocumentCount": len(transaction_docs),
        "criticalStateDocumentCount": len(critical_state_docs),
        "observationEventTypes": sorted(OBSERVATION_EVENT_TYPES),
        "taskRecoveryCommands": sorted(TASK_RECOVERY_COMMANDS),
        "batchRecoveryCommands": sorted(BATCH_RECOVERY_COMMANDS),
        "transitionEventMappingCount": len(TRANSITION_EVENT_MAP_V1),
        "lifecycleRecoveryEventTypes": sorted(lifecycle_event_types),
        "negativeSelfTests": negative_self_test_results,
        "canonicalJsonBoundaryTests": canonical_boundary_tests,
        "canonicalRequestHashTests": canonical_request_hash_tests,
        "physicalSqlContract": physical_sql_details,
        "ownerDdlExecution": owner_ddl_details,
        "errors": errors,
    }
    return errors, details


def package_hygiene_errors() -> list[str]:
    errors: list[str] = []
    for path in PACKAGE_ROOT.rglob("*"):
        if path.is_dir() and path.name == "__pycache__":
            errors.append(f"package contains __pycache__: {path.relative_to(PACKAGE_ROOT)}")
        elif path.is_file() and path.suffix == ".pyc":
            errors.append(f"package contains compiled Python artifact: {path.relative_to(PACKAGE_ROOT)}")
    return errors


def documented_action_keys() -> set[str]:
    keys: set[str] = set()
    for path in sorted((PACKAGE_ROOT / "changes").glob("3.2.*/spec.md")):
        lines = path.read_text(encoding="utf-8").splitlines()
        header: list[str] | None = None
        for line in lines:
            if not line.startswith("|"):
                if line.strip():
                    header = None
                continue
            cells = table_cells(line)
            if cells and cells[0] == "actionKey" and "adapterKind" in cells and "targetDisposition" in cells:
                header = cells
                continue
            if not header or line.startswith("| ---") or len(cells) != len(header):
                continue
            row = dict(zip(header, cells))
            action_key = row.get("actionKey", "")
            if re.fullmatch(r"[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*", action_key):
                keys.add(action_key)
    return keys


def action_manifest_errors(registry: dict[str, Any]) -> list[str]:
    manifest = load_json(ACTION_MANIFEST_PATH)
    registry_actions = set(registry.get("actions", {}))
    manifest_actions = set(manifest.get("actions", []))
    documented_actions = documented_action_keys()
    errors: list[str] = []
    if registry_actions != manifest_actions:
        errors.append(
            f"action manifest mismatch: missing={sorted(registry_actions - manifest_actions)}, "
            f"extra={sorted(manifest_actions - registry_actions)}"
        )
    if registry_actions != documented_actions:
        errors.append(
            f"version Spec action coverage mismatch: registryMissing={sorted(documented_actions - registry_actions)}, "
            f"registryExtra={sorted(registry_actions - documented_actions)}"
        )
    return errors


def task_policy_inventory_from_source() -> tuple[list[str], list[str]]:
    """Load the production TaskPolicy inventory without copying its literals here."""
    node_program = """
const sourcePath = process.argv[1];
const { createTaskPolicyRegistry } = require(sourcePath);
const listed = createTaskPolicyRegistry().list();
const selected = listed
  .filter((policy) => policy.batchPolicy === 'reserve' || policy.batchPolicy === 'no-file');
const identityErrors = selected
  .filter((policy) => policy.taskKey !== policy.channel)
  .map((policy) => `${policy.channel}:${policy.taskKey}`);
const taskKeys = selected.map((policy) => policy.taskKey).sort();
process.stdout.write(JSON.stringify({ taskKeys, identityErrors }));
"""
    completed = subprocess.run(
        ["node", "-e", node_program, str(TASK_POLICY_SOURCE_PATH)],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise ValueError(completed.stderr.strip() or "TaskPolicy inventory process failed")
    payload = json.loads(completed.stdout)
    return payload["taskKeys"], payload["identityErrors"]


def action_binding_authority_from_source() -> dict[str, Any]:
    """Execute the production startup registry; package snapshots never authorize pairs."""
    node_program = r"""
'use strict';
const fs = require('node:fs');
const { createHash: createProbeHash } = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const bindingPath = process.argv[1];
const taskPolicyPath = process.argv[2];
const barrelPath = process.argv[3];
const mainPath = process.argv[4];
const espree = require(process.argv[5]);
const binding = require(bindingPath);
const { createTaskPolicyRegistry } = require(taskPolicyPath);
const barrel = require(barrelPath);
async function runProbe() {
const mutablePolicies = () => createTaskPolicyRegistry().list().map((policy) => ({ ...policy }));
const fakeRegistry = (policies, onList = () => {}) => Object.freeze({
  list() {
    onList();
    return policies;
  }
});
const realHost = () => {
  const registry = createTaskPolicyRegistry();
  return Object.freeze({ list: registry.list.bind(registry) });
};
const rejects = (callback, code) => {
  try {
    callback();
    return false;
  } catch (error) {
    return error instanceof binding.ActionTaskBindingRegistryError && error.code === code;
  }
};
const replaceIdentity = (policies, from, to) => {
  const policy = policies.find((item) => item.channel === from);
  policy.channel = to;
  policy.taskKey = to;
};

let listCalls = 0;
const ownedPolicies = mutablePolicies();
const registry = binding.createActionTaskBindingRegistry({
  taskPolicyRegistry: fakeRegistry(ownedPolicies, () => { listCalls += 1; })
});
ownedPolicies.find((policy) => policy.channel === 'monthly-balance:export').taskKey = 'post-construction';
ownedPolicies.length = 0;
const returnedA = registry.allowedTaskKeys('statement:generate-all');
const returnedB = registry.allowedTaskKeys('statement:generate-all');
let returnedMutationRejected = false;
try { returnedA.push('bankBuRecon:run'); } catch (_error) { returnedMutationRejected = true; }

const hiddenOptions = { taskPolicyRegistry: createTaskPolicyRegistry() };
Object.defineProperty(hiddenOptions, 'bindings', {
  value: { 'hidden:action': ['hidden:task'] },
  enumerable: false
});

let accessorReads = 0;
const accessorPolicies = mutablePolicies();
const accessorPolicy = accessorPolicies.find((policy) => policy.channel === 'monthly-balance:export');
const stableTaskKey = accessorPolicy.taskKey;
Object.defineProperty(accessorPolicy, 'taskKey', {
  enumerable: true,
  configurable: true,
  get() {
    accessorReads += 1;
    return accessorReads < 4 ? stableTaskKey : 'wrong-on-fourth-read';
  }
});

const mismatchPolicies = mutablePolicies();
mismatchPolicies.find((policy) => policy.channel === 'account-mapping:save').taskKey = 'wrong:key';
const substitutedPolicies = mutablePolicies();
replaceIdentity(
  substitutedPolicies,
  'account-mapping:save',
  'account-mapping:equal-size-unbound-substitution'
);
const boundAbsentPolicies = mutablePolicies();
replaceIdentity(boundAbsentPolicies, 'monthly-balance:export', 'monthly-balance:unbound-replacement');
const duplicatePolicies = mutablePolicies();
replaceIdentity(duplicatePolicies, 'balance-adjustment:save', 'account-mapping:save');

const mapHost = Object.freeze(new Map([['list', () => mutablePolicies()]]));
const prototypeArrayHost = { list: () => mutablePolicies() };
Object.setPrototypeOf(prototypeArrayHost, []);
Object.freeze(prototypeArrayHost);
let hostileMessageReads = 0;
const hostileCause = {};
Object.defineProperty(hostileCause, 'message', {
  get() {
    hostileMessageReads += 1;
    throw new Error('message getter must not run');
  }
});
let causeSafeListFailure = false;
try {
  binding.initializeActionTaskBindingRegistry(Object.freeze({
    list() { throw hostileCause; }
  }));
} catch (error) {
  causeSafeListFailure = error instanceof binding.ActionTaskBindingRegistryError
    && error.code === 'ACTION_TASK_BINDING_TASK_POLICY_LIST_FAILED'
    && error.message === 'TaskPolicyRegistry.list() 执行失败'
    && error.details
    && error.details.cause === 'UNTRUSTED_CAUSE_SUPPRESSED'
    && hostileMessageReads === 0;
}

const bindingModulePath = './main-process/background-execution/action-task-binding-registry';
const bindingImportSource = `const { initializeActionTaskBindingStartup } = require('${bindingModulePath}');`;
const mainStartupAstErrors = (source) => {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true });
  const nodes = [];
  const parents = new Map();
  const visit = (node, parent = null) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (typeof node.type === 'string') {
      nodes.push(node);
      if (parent) parents.set(node, parent);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'range') visit(value, node);
    }
  };
  visit(ast);
  const errors = [];
  const identifier = (node, name) => node && node.type === 'Identifier' && node.name === name;
  const member = (node, objectName, propertyName) => node
    && node.type === 'MemberExpression'
    && !node.computed
    && identifier(node.object, objectName)
    && identifier(node.property, propertyName);
  const calls = (name) => nodes.filter((node) => node.type === 'CallExpression'
    && identifier(node.callee, name));
  const patternNames = (pattern, found = []) => {
    if (!pattern) return found;
    if (pattern.type === 'Identifier') found.push(pattern.name);
    else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        patternNames(property.type === 'RestElement' ? property.argument : property.value, found);
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const item of pattern.elements) patternNames(item, found);
    } else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, found);
    else if (pattern.type === 'RestElement') patternNames(pattern.argument, found);
    return found;
  };
  const declaredNames = [];
  for (const node of nodes) {
    if (node.type === 'VariableDeclarator') patternNames(node.id, declaredNames);
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      if (node.id) patternNames(node.id, declaredNames);
      for (const parameter of node.params) patternNames(parameter, declaredNames);
    }
    if (node.type === 'CatchClause') patternNames(node.param, declaredNames);
    if (node.type === 'ClassDeclaration' && node.id) patternNames(node.id, declaredNames);
  }
  const reassigned = (name) => nodes.some((node) => (
    node.type === 'AssignmentExpression' && patternNames(node.left, []).includes(name)
  ) || (
    node.type === 'UpdateExpression' && identifier(node.argument, name)
  ));
  const declarations = (name) => ast.body.flatMap((statement) => (
    statement.type === 'VariableDeclaration' ? statement.declarations : []
  )).filter((declaration) => identifier(declaration.id, name));
  const directCall = (name, callee) => {
    const found = declarations(name);
    if (found.length !== 1) return null;
    const init = found[0].init;
    return init && init.type === 'CallExpression' && identifier(init.callee, callee) ? init : null;
  };
  const bindingRequireCalls = nodes.filter((node) => node.type === 'CallExpression'
    && identifier(node.callee, 'require')
    && node.arguments.length === 1
    && node.arguments[0].type === 'Literal'
    && node.arguments[0].value === bindingModulePath);
  const bindingRequireDeclarations = ast.body.filter((statement) => (
    statement.type === 'VariableDeclaration'
    && statement.kind === 'const'
    && statement.declarations.length === 1
  )).flatMap((statement) => statement.declarations).filter((declaration) => (
    declaration.id.type === 'ObjectPattern'
    && declaration.id.properties.length === 1
    && declaration.id.properties[0].type === 'Property'
    && identifier(declaration.id.properties[0].key, 'initializeActionTaskBindingStartup')
    && identifier(declaration.id.properties[0].value, 'initializeActionTaskBindingStartup')
    && declaration.init
    && bindingRequireCalls.includes(declaration.init)
  ));
  const bindingImportStatement = bindingRequireDeclarations.length === 1
    ? parents.get(bindingRequireDeclarations[0])
    : null;
  if (bindingRequireCalls.length !== 1 || bindingRequireDeclarations.length !== 1) {
    errors.push('production-binding-exact-top-level-require');
  }
  const firstNonDirectiveStatement = ast.body.find((statement) => (
    statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string'
  ));
  if (bindingImportStatement?.type !== 'VariableDeclaration'
      || firstNonDirectiveStatement !== bindingImportStatement
      || source.slice(bindingImportStatement.range[0], bindingImportStatement.range[1])
        !== bindingImportSource) {
    errors.push('production-binding-first-nondirective-exact-require');
  }
  const programDeclaredNames = ast.body.flatMap((statement) => {
    if (statement.type === 'VariableDeclaration') {
      return statement.declarations.flatMap((declaration) => patternNames(declaration.id, []));
    }
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(statement.type) && statement.id) {
      return [statement.id.name];
    }
    return [];
  });
  if (['require', 'module', 'arguments'].some((name) => programDeclaredNames.includes(name))) {
    errors.push('commonjs-wrapper-loader-bindings-unshadowed');
  }
  if (declaredNames.filter((name) => name === 'initializeActionTaskBindingStartup').length !== 1
      || declaredNames.filter((name) => name === 'runActionTaskBindingStartup').length !== 1
      || reassigned('initializeActionTaskBindingStartup')
      || reassigned('runActionTaskBindingStartup')) {
    errors.push('production-binding-identifiers-unshadowed-immutable');
  }
  const policyCall = directCall('taskPolicyRegistry', 'createTaskPolicyRegistry');
  const startupDeclarations = ast.body.flatMap((statement) => (
    statement.type === 'VariableDeclaration' ? statement.declarations : []
  )).filter((declaration) => declaration.id.type === 'ObjectPattern'
    && declaration.id.properties.length === 2
    && declaration.id.properties.some((property) => identifier(property.key, 'actionTaskBindingRegistry')
      && identifier(property.value, 'actionTaskBindingRegistry'))
    && declaration.id.properties.some((property) => identifier(property.key, 'run')
      && identifier(property.value, 'runActionTaskBindingStartup')));
  const startupCall = startupDeclarations.length === 1
    && startupDeclarations[0].init.type === 'CallExpression'
    && identifier(startupDeclarations[0].init.callee, 'initializeActionTaskBindingStartup')
    ? startupDeclarations[0].init
    : null;
  const host = declarations('taskPolicyBindingHost');
  const startupOptions = startupCall && startupCall.arguments[1];
  const optionProperties = startupOptions
    && startupOptions.type === 'CallExpression'
    && startupOptions.callee.type === 'MemberExpression'
    && identifier(startupOptions.callee.object, 'Object')
    && identifier(startupOptions.callee.property, 'freeze')
    && startupOptions.arguments.length === 1
    && startupOptions.arguments[0].type === 'ObjectExpression'
    ? startupOptions.arguments[0].properties
    : [];
  const optionsExact = optionProperties.length === 2
    && optionProperties.some((property) => identifier(property.key, 'initializeDatabase')
      && identifier(property.value, 'initializeApplication'))
    && optionProperties.some((property) => identifier(property.key, 'registerIpc')
      && identifier(property.value, 'registerAllIpcHandlers'));
  const hostSource = host.length === 1 ? source.slice(host[0].init.range[0], host[0].init.range[1]) : '';
  if (!policyCall || policyCall.arguments.length !== 0) errors.push('policy-program-direct');
  if (host.length !== 1
      || hostSource !== 'Object.freeze({\n  list: taskPolicyRegistry.list.bind(taskPolicyRegistry)\n})') {
    errors.push('host-program-direct-exact');
  }
  if (!startupCall || startupCall.arguments.length !== 2
      || !identifier(startupCall.arguments[0], 'taskPolicyBindingHost') || !optionsExact) {
    errors.push('startup-program-direct-exact');
  }
  if (startupDeclarations.length !== 1) errors.push('startup-registry-retained');
  if (calls('createTaskPolicyRegistry').length !== 1
      || calls('initializeActionTaskBindingStartup').length !== 1
      || calls('initializeActionTaskBindingRegistry').length !== 0) errors.push('initializer-unique');
  const runCalls = calls('runActionTaskBindingStartup');
  if (runCalls.length !== 1 || parents.get(runCalls[0])?.type !== 'AwaitExpression') {
    errors.push('startup-run-unique-awaited');
  }
  const readyIfStatements = ast.body.filter((statement) => statement.type === 'IfStatement'
    && identifier(statement.test, 'hasSingleInstanceLock'));
  let successCallback = null;
  if (readyIfStatements.length === 1
      && readyIfStatements[0].consequent.type === 'ExpressionStatement') {
    const catchCall = readyIfStatements[0].consequent.expression;
    const thenCall = catchCall?.type === 'CallExpression'
      && catchCall.callee.type === 'MemberExpression'
      && !catchCall.callee.computed
      && identifier(catchCall.callee.property, 'catch')
      ? catchCall.callee.object
      : null;
    const readyCall = thenCall?.type === 'CallExpression'
      && thenCall.callee.type === 'MemberExpression'
      && !thenCall.callee.computed
      && identifier(thenCall.callee.property, 'then')
      ? thenCall.callee.object
      : null;
    const callback = thenCall?.arguments?.[0];
    if (catchCall?.arguments?.length === 1
        && thenCall?.arguments?.length === 1
        && readyCall?.type === 'CallExpression'
        && member(readyCall.callee, 'app', 'whenReady')
        && readyCall.arguments.length === 0
        && callback?.type === 'ArrowFunctionExpression'
        && callback.async
        && callback.params.length === 0
        && callback.body.type === 'BlockStatement') successCallback = callback;
  }
  if (!successCallback || nodes.filter((node) => node.type === 'CallExpression'
    && member(node.callee, 'app', 'whenReady')).length !== 1) {
    errors.push('unique-top-level-app-when-ready-success-callback');
  }
  const runCall = runCalls.length === 1 ? runCalls[0] : null;
  const runAwait = runCall ? parents.get(runCall) : null;
  const runStatement = runAwait ? parents.get(runAwait) : null;
  const runBlock = runStatement ? parents.get(runStatement) : null;
  const startupTry = runBlock ? parents.get(runBlock) : null;
  const callbackBlock = startupTry ? parents.get(startupTry) : null;
  const rethrowsStartupError = startupTry?.type === 'TryStatement'
    && startupTry.finalizer === null
    && startupTry.handler?.param?.type === 'Identifier'
    && startupTry.handler.body.body.at(-1)?.type === 'ThrowStatement'
    && identifier(startupTry.handler.body.body.at(-1).argument, startupTry.handler.param.name);
  if (!runCall
      || runStatement?.type !== 'ExpressionStatement'
      || runBlock?.type !== 'BlockStatement'
      || startupTry?.type !== 'TryStatement'
      || startupTry.block !== runBlock
      || callbackBlock !== successCallback?.body
      || !rethrowsStartupError) {
    errors.push('startup-run-direct-rethrowing-when-ready-success-path');
  }
  const nearestFunction = (node) => {
    let current = parents.get(node);
    while (current && ![
      'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'
    ].includes(current.type)) current = parents.get(current);
    return current;
  };
  if (runCall && successCallback && nodes.some((node) => node.type === 'ReturnStatement'
    && node.range[0] < runCall.range[0]
    && nearestFunction(node) === successCallback)) errors.push('startup-run-follows-early-return');
  const databases = nodes.filter((node) => node.type === 'NewExpression'
    && identifier(node.callee, 'AppDatabase'));
  if (databases.length !== 1 || calls('registerAllIpcHandlers').length !== 0) {
    errors.push('continuation-owned-db-ipc');
  }
  if (startupCall && databases[0] && startupCall.range[1] >= databases[0].range[0]) {
    errors.push('binding-before-db-source-order');
  }
  const createWindowCalls = calls('createWindow').filter((call) => call.arguments.length === 1
    && call.arguments[0].type === 'ObjectExpression'
    && call.arguments[0].properties.some((property) => identifier(property.key, 'instrumentation')
      && property.value.type === 'Literal'
      && property.value.value === 'initial'));
  const createWindowStatement = createWindowCalls.length === 1
    ? parents.get(parents.get(createWindowCalls[0]))
    : null;
  if (runCall && (createWindowCalls.length !== 1
      || createWindowStatement?.type !== 'ExpressionStatement'
      || parents.get(createWindowStatement) !== runBlock
      || runCall.range[0] >= createWindowCalls[0].range[0])) {
    errors.push('startup-run-before-window');
  }
  return errors;
};

const mainSource = fs.readFileSync(mainPath, 'utf8');
const bindingImportPattern = /^const \{ initializeActionTaskBindingStartup \} = require\('\.\/main-process\/background-execution\/action-task-binding-registry'\);$/gm;
const bindingImportStatements = [...mainSource.matchAll(bindingImportPattern)].map((match) => match[0]);
const mainStartupErrors = mainStartupAstErrors(mainSource);
const startupBootstrapProof = {
  sourceStartOffset: 0,
  sourceEndOffset: null,
  prefixSha256: null,
  loadedRequests: [],
  resolvedTargetPath: null,
  freshModuleLoaded: false,
  exportIdentityMatched: false,
  passed: false
};
if (bindingImportStatements.length === 1 && mainStartupErrors.length === 0) {
  try {
    const mainAst = espree.parse(mainSource, {
      ecmaVersion: 'latest', sourceType: 'script', range: true
    });
    const firstNonDirectiveStatement = mainAst.body.find((statement) => (
      statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string'
    ));
    const proofFilename = `${mainPath}.action-task-binding-loader-proof.cjs`;
    const proofModule = new Module(proofFilename, module);
    proofModule.filename = proofFilename;
    proofModule.paths = Module._nodeModulePaths(path.dirname(mainPath));
    const loadedRequests = [];
    const loadedResolvedPaths = [];
    let loadedBindingModule = null;
    const realRequire = proofModule.require.bind(proofModule);
    proofModule.require = (request) => {
      loadedRequests.push(request);
      loadedResolvedPaths.push(Module._resolveFilename(request, proofModule));
      loadedBindingModule = realRequire(request);
      return loadedBindingModule;
    };
    const resolvedTargetPath = Module._resolveFilename(bindingModulePath, proofModule);
    const originalCacheEntry = require.cache[resolvedTargetPath];
    delete require.cache[resolvedTargetPath];
    try {
      const bootstrapPrefix = mainSource.slice(0, firstNonDirectiveStatement.range[1]);
      proofModule._compile(
        `${bootstrapPrefix}\nmodule.exports = initializeActionTaskBindingStartup;`,
        proofFilename
      );
      startupBootstrapProof.sourceEndOffset = firstNonDirectiveStatement.range[1];
      startupBootstrapProof.prefixSha256 = createProbeHash('sha256')
        .update(bootstrapPrefix, 'utf8').digest('hex');
      startupBootstrapProof.loadedRequests = loadedRequests;
      startupBootstrapProof.resolvedTargetPath = resolvedTargetPath;
      startupBootstrapProof.freshModuleLoaded = loadedBindingModule !== binding;
      startupBootstrapProof.exportIdentityMatched = loadedBindingModule !== null
        && proofModule.exports === loadedBindingModule.initializeActionTaskBindingStartup;
      startupBootstrapProof.passed = loadedRequests.length === 1
        && loadedRequests[0] === bindingModulePath
        && loadedResolvedPaths.length === 1
        && loadedResolvedPaths[0] === resolvedTargetPath
        && startupBootstrapProof.freshModuleLoaded
        && startupBootstrapProof.exportIdentityMatched;
    } finally {
      delete require.cache[resolvedTargetPath];
      if (originalCacheEntry) require.cache[resolvedTargetPath] = originalCacheEntry;
    }
  } catch (_error) {
    startupBootstrapProof.passed = false;
  }
}
const startupBlock = mainSource.match(
  /const \{ actionTaskBindingRegistry, run: runActionTaskBindingStartup \} = initializeActionTaskBindingStartup\([^\n]+\);/
);
const startupAstMutationResults = {};
if (startupBlock) {
  const bindingImport = bindingImportSource;
  const fakeBindingLoader = "(modulePath) => modulePath === './main-process/background-execution/action-task-binding-registry' ? { initializeActionTaskBindingStartup: () => ({ actionTaskBindingRegistry: Object.freeze({}), run: async () => {} }) } : originalBindingRequire(modulePath)";
  const fakeBindingExport = "{ exports: { initializeActionTaskBindingStartup: () => ({ actionTaskBindingRegistry: Object.freeze({}), run: async () => {} }) } }";
  const mutants = {
    'conditional-initializer': mainSource.replace(startupBlock[0], `if (false) {\n${startupBlock[0]}\n}`),
    'initializer-in-early-return-function': mainSource.replace(startupBlock[0], `function unreachableStartup() {\n  return;\n${startupBlock[0]}\n}`),
    'initializer-in-swallowed-try-catch': mainSource.replace(startupBlock[0], `try {\n${startupBlock[0]}\n} catch (_error) {}`),
    'duplicate-initializer': mainSource.replace(startupBlock[0], `${startupBlock[0]}\ninitializeActionTaskBindingStartup(taskPolicyBindingHost, Object.freeze({ initializeDatabase: initializeApplication, registerIpc: registerAllIpcHandlers }));`),
    'unused-run': mainSource.replace('await runActionTaskBindingStartup();', 'await Promise.resolve();'),
    'conditional-run': mainSource.replace('await runActionTaskBindingStartup();', 'if (false) { await runActionTaskBindingStartup(); }'),
    'swallowed-run-error': mainSource.replace('await runActionTaskBindingStartup();', 'try { await runActionTaskBindingStartup(); } catch (_bindingError) {}'),
    'run-after-early-return': mainSource.replace('await runActionTaskBindingStartup();', 'return;\n      await runActionTaskBindingStartup();'),
    'fake-production-import': mainSource.replace("require('./main-process/background-execution/action-task-binding-registry')", "require('./main-process/background-execution/fake-action-task-binding-registry')"),
    'shadowed-run-identifier': mainSource.replace('await runActionTaskBindingStartup();', 'const runActionTaskBindingStartup = async () => {};\n      await runActionTaskBindingStartup();'),
    'reassigned-import-identifier': mainSource.replace(bindingImport, `${bindingImport}\ninitializeActionTaskBindingStartup = () => ({ actionTaskBindingRegistry: {}, run: async () => {} });`),
    'rebound-commonjs-require': mainSource.replace(bindingImport, `const originalBindingRequire = require;\nrequire = ${fakeBindingLoader};\n${bindingImport}`),
    'destructured-commonjs-require-rebind': mainSource.replace(bindingImport, `const originalBindingRequire = require;\n[require] = [${fakeBindingLoader}];\n${bindingImport}`),
    'arguments-loader-rebind': mainSource.replace(bindingImport, `const originalBindingRequire = require;\narguments[1] = ${fakeBindingLoader};\n${bindingImport}`),
    'arguments-alias-loader-rebind': mainSource.replace(bindingImport, `const originalBindingRequire = require;\nconst commonJsArguments = arguments;\ncommonJsArguments[1] = ${fakeBindingLoader};\n${bindingImport}`),
    'target-require-cache-replacement': mainSource.replace(bindingImport, `require.cache[require.resolve('./main-process/background-execution/action-task-binding-registry')] = ${fakeBindingExport};\n${bindingImport}`),
    'target-require-cache-alias-replacement': mainSource.replace(bindingImport, `const commonJsCache = require.cache;\ncommonJsCache[require.resolve('./main-process/background-execution/action-task-binding-registry')] = ${fakeBindingExport};\n${bindingImport}`),
    'module-loader-replacement': mainSource.replace(bindingImport, `const originalModuleLoad = module.constructor._load;\nmodule.constructor._load = (request, parent, isMain) => request === './main-process/background-execution/action-task-binding-registry' ? ${fakeBindingExport}.exports : originalModuleLoad(request, parent, isMain);\n${bindingImport}`),
    'helper-mediated-wrapper-alias': mainSource.replace(bindingImport, `const selectBindingLoader = (loader) => loader;\nconst selectedBindingLoader = selectBindingLoader(require);\n${bindingImport.replace('require(', 'selectedBindingLoader(')}`),
    'preceding-module-side-effect': mainSource.replace(bindingImport, `require('./main-process/startup-window');\n${bindingImport}`),
    'reviewer-equivalent-inline-loader-wrapper': mainSource.replace(bindingImport, `const originalBindingRequire = require;\nrequire = ((loader) => loader)(${fakeBindingLoader});\n${bindingImport}`)
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    startupAstMutationResults[name] = mainStartupAstErrors(mutant).length > 0;
  }
}
const strictStartupReachability = mainStartupErrors.length === 0
  && startupBlock
  && Object.values(startupAstMutationResults).length === 21
  && Object.values(startupAstMutationResults).every(Boolean);

const startupEvents = [];
const startupPolicyRegistry = createTaskPolicyRegistry();
const startup = binding.initializeActionTaskBindingStartup(Object.freeze({
  list() {
    startupEvents.push('task-policy');
    return startupPolicyRegistry.list();
  }
}), Object.freeze({
  async initializeDatabase() { startupEvents.push('database'); },
  registerIpc() { startupEvents.push('ipc'); }
}));
startupEvents.push('binding');
await startup.run();
const startupSuccessOrder = startupEvents.join('>') === 'task-policy>binding>database>ipc';
let databaseCallCount = 0;
let ipcCallCount = 0;
const startupFailureStopsContinuations = rejects(
  () => binding.initializeActionTaskBindingStartup(
    fakeRegistry(boundAbsentPolicies),
    Object.freeze({
      async initializeDatabase() { databaseCallCount += 1; },
      registerIpc() { ipcCallCount += 1; }
    })
  ),
  'ACTION_TASK_BINDING_TASK_POLICY_MISSING'
) && databaseCallCount === 0 && ipcCallCount === 0;

let hostileIdentityReads = 0;
const hostileIdentity = new Proxy({}, {
  get() {
    hostileIdentityReads += 1;
    throw new Error('identity read forbidden');
  }
});
const hostileAssertPairSafe = rejects(
  () => registry.assertPair(hostileIdentity, 'monthly-balance:export'),
  'ACTION_TASK_BINDING_ACTION_TYPE_INVALID'
) && rejects(
  () => registry.assertPair('statement:generate-all', hostileIdentity),
  'ACTION_TASK_BINDING_TASK_KEY_TYPE_INVALID'
) && hostileIdentityReads === 0;

const hostileApiResults = {
  'single-list-read-owned-snapshot': listCalls === 1
    && registry.assertPair('statement:generate-all', 'monthly-balance:export').expectedTaskKey
      === 'monthly-balance:export',
  'caller-binding-hidden-action-rejected': rejects(
    () => binding.createActionTaskBindingRegistry(hiddenOptions),
    'ACTION_TASK_BINDING_OPTIONS_INVALID'
  ),
  'fourth-read-accessor-rejected': rejects(
    () => binding.initializeActionTaskBindingRegistry(fakeRegistry(accessorPolicies)),
    'ACTION_TASK_BINDING_TASK_POLICY_DESCRIPTOR_INVALID'
  ) && accessorReads === 0,
  'proxy-rejected': rejects(
    () => binding.createActionTaskBindingRegistry(new Proxy({
      taskPolicyRegistry: realHost()
    }, {})),
    'ACTION_TASK_BINDING_OPTIONS_INVALID'
  ),
  'registry-host-map-rejected': rejects(
    () => binding.initializeActionTaskBindingRegistry(mapHost),
    'ACTION_TASK_BINDING_TASK_POLICY_REGISTRY_HOST_INVALID'
  ),
  'registry-host-prototype-array-rejected': rejects(
    () => binding.initializeActionTaskBindingRegistry(prototypeArrayHost),
    'ACTION_TASK_BINDING_TASK_POLICY_REGISTRY_HOST_INVALID'
  ),
  'list-throwing-message-accessor-cause-safe': causeSafeListFailure,
  'returned-array-owned-frozen': returnedA !== returnedB
    && Object.isFrozen(returnedA)
    && returnedMutationRejected
    && returnedB.length === 2,
  'taskkey-channel-mismatch-rejected': rejects(
    () => binding.initializeActionTaskBindingRegistry(fakeRegistry(mismatchPolicies)),
    'ACTION_TASK_BINDING_TASK_POLICY_IDENTITY_MISMATCH'
  ),
  'equal-size-unbound-substitution-rejected': rejects(
    () => binding.initializeActionTaskBindingRegistry(fakeRegistry(substitutedPolicies)),
    'ACTION_TASK_BINDING_TASK_POLICY_INVENTORY_DIGEST_MISMATCH'
  ),
  'bound-key-absent-rejected': rejects(
    () => binding.initializeActionTaskBindingRegistry(fakeRegistry(boundAbsentPolicies)),
    'ACTION_TASK_BINDING_TASK_POLICY_MISSING'
  ),
  'duplicate-policy-rejected': rejects(
    () => binding.initializeActionTaskBindingRegistry(fakeRegistry(duplicatePolicies)),
    'ACTION_TASK_BINDING_TASK_POLICY_DUPLICATE'
  ),
  'barrel-export-live': barrel.initializeActionTaskBindingRegistry
    === binding.initializeActionTaskBindingRegistry
    && barrel.initializeActionTaskBindingStartup
      === binding.initializeActionTaskBindingStartup
    && typeof barrel.bindingSnapshot === 'function'
    && !Object.prototype.hasOwnProperty.call(barrel, 'ACTION_TASK_BINDINGS'),
  'assert-pair-hostile-nonstring-no-read': hostileAssertPairSafe,
  'main-program-direct-reachability-and-mutants': strictStartupReachability,
  'main-full-bootstrap-prefix-real-loader-export': startupBootstrapProof.passed,
  'startup-seam-success-task-policy-binding-db-ipc': startupSuccessOrder,
  'startup-seam-binding-failure-db-ipc-zero': startupFailureStopsContinuations
};
process.stdout.write(JSON.stringify({
  bindings: binding.bindingSnapshot(),
  contract: binding.ACTION_TASK_BINDING_CONTRACT,
  summary: registry.summary,
  hostileApiResults,
  startupBootstrapProof,
  startupAstMutationResults
}));
}
runProbe().catch((error) => {
  process.stderr.write('production binding probe failed\n');
  process.exitCode = 1;
});
"""
    completed = subprocess.run(
        [
            "node", "-e", node_program, str(ACTION_BINDING_SOURCE_PATH),
            str(TASK_POLICY_SOURCE_PATH),
            str(ACTION_BINDING_SOURCE_PATH.parent / "index.js"),
            str(ACTION_CALL_SITE_SOURCE_PATH),
            str(resolve_espree_dependency()["modulePath"]),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise MachineJsonContractError(
            "PRODUCTION_BINDING_AUTHORITY_PROBE_FAILED",
            "production action/task binding registry probe failed",
        )
    try:
        payload = parse_machine_json(completed.stdout)
    except MachineJsonContractError as exc:
        raise MachineJsonContractError(
            "PRODUCTION_BINDING_AUTHORITY_OUTPUT_INVALID",
            "production action/task binding registry probe returned invalid JSON",
        ) from exc
    if not isinstance(payload, dict) or set(payload) != {
        "bindings", "contract", "summary", "hostileApiResults",
        "startupBootstrapProof", "startupAstMutationResults",
    }:
        raise MachineJsonContractError(
            "PRODUCTION_BINDING_AUTHORITY_OUTPUT_INVALID",
            "production action/task binding authority output shape drift",
        )
    return payload


def action_binding_contract_errors(
    registry: dict[str, Any],
) -> tuple[list[str], dict[str, Any]]:
    """Validate the frozen map against independent production/spec pair provenance."""
    errors: list[str] = []
    authority = contract_authority()
    binding_authority = action_task_binding_authority()
    frozen_binding_digest = binding_authority.get("bindingMapSha256")
    frozen_inventory_digest_authority = binding_authority.get(
        "taskPolicyInventorySha256"
    )
    expected_binding_counts = {
        key: binding_authority.get(key)
        for key in (
            "expectedActionCount",
            "expectedTaskPolicyInventoryCount",
            "expectedPairCount",
            "expectedForwardBoundTaskKeyCount",
            "expectedUnboundTaskPolicyCount",
            "expectedProvenanceCount",
        )
    }
    manifest = load_json(ACTION_MANIFEST_PATH)
    binding_source = manifest.get("bindingAuthoritySource", {})
    source = manifest.get("taskPolicyInventorySource", {})
    call_source = manifest.get("callSiteSource", {})
    contract = manifest.get("bindingContract", {})
    actions = manifest.get("actions", [])
    binding_snapshot = manifest.get("allowedLegacyTaskKeysByActionKeySnapshot", {})
    provenance = manifest.get("pairProvenance", [])
    frozen_inventory = manifest.get("taskPolicyInventory", [])

    production_authority = action_binding_authority_from_source()
    bindings = production_authority.get("bindings", {})
    production_contract = production_authority.get("contract", {})
    production_summary = production_authority.get("summary", {})
    hostile_api_results = production_authority.get("hostileApiResults", {})
    startup_bootstrap_proof = production_authority.get("startupBootstrapProof", {})
    startup_ast_mutation_results = production_authority.get(
        "startupAstMutationResults", {}
    )

    if manifest.get("manifestVersion") != 3:
        errors.append("action manifest source snapshot must use manifestVersion=3")
    if contract != {
        "version": binding_authority.get("sourceContractVersion"),
        "contractAuthority": {
            "path": "changes/background-execution/recovery-contract-authority.v1.json",
            "contractVersion": authority.get("contractVersion"),
            "revision": authority.get("revision"),
            "genesis": authority.get("genesis"),
            "approvalStatus": authority.get("approvalStatus"),
            "gitGenesisRequiresVerifiedPreviousAbsence": authority.get(
                "changeControl", {}
            ).get("gitGenesisRequiresVerifiedPreviousAbsence"),
        },
        "canonicalization": authority.get("canonicalization"),
        "sourceBindingMapSha256": frozen_binding_digest,
        "taskPolicyInventoryCanonicalization": authority.get("canonicalization"),
        "taskPolicyInventorySha256": frozen_inventory_digest_authority,
        **expected_binding_counts,
    }:
        errors.append(f"bindingContract exact fields/counts drift: {contract!r}")
    expected_binding_source = {
        "path": "src/main-process/background-execution/action-task-binding-registry.js",
        "sha256": sha256_file(ACTION_BINDING_SOURCE_PATH),
        "export": "bindingSnapshot",
        "factory": "createActionTaskBindingRegistry",
        "startupConsumer": (
            "src/main.js#initializeActionTaskBindingStartup(taskPolicyBindingHost,Object.freeze({initializeDatabase,registerIpc}))"
        ),
    }
    if binding_source != expected_binding_source:
        errors.append("production binding authority source/API/hash drift")
    expected_production_contract = {
        "version": binding_authority.get("sourceContractVersion"),
        "canonicalization": authority.get("canonicalization"),
        "sha256": frozen_binding_digest,
        "actionCount": binding_authority.get("expectedActionCount"),
        "taskPolicyInventoryCount": binding_authority.get(
            "expectedTaskPolicyInventoryCount"
        ),
        "taskPolicyInventoryCanonicalization": authority.get("canonicalization"),
        "taskPolicyInventorySha256": frozen_inventory_digest_authority,
        "pairCount": binding_authority.get("expectedPairCount"),
        "boundTaskKeyCount": binding_authority.get("expectedForwardBoundTaskKeyCount"),
        "unboundTaskPolicyCount": binding_authority.get("expectedUnboundTaskPolicyCount"),
    }
    if production_contract != expected_production_contract:
        errors.append("production binding contract/counts drift")
    if binding_snapshot != bindings:
        errors.append("package binding snapshot differs from production source authority")
    if source.get("path") != "src/main-process/archive-center/task-policy-registry.js":
        errors.append("TaskPolicy inventory source path drift")
    if source.get("selection") != (
        "single taskPolicyRegistry.list() owned snapshot; "
        "batchPolicy in {reserve,no-file}; taskKey === channel"
    ):
        errors.append("TaskPolicy inventory selection drift")
    if not re.fullmatch(r"[0-9a-f]{64}", str(source.get("sha256", ""))):
        errors.append("TaskPolicy inventory source SHA-256 is not lowercase hex")
    elif sha256_file(TASK_POLICY_SOURCE_PATH) != source["sha256"]:
        errors.append("TaskPolicy inventory source SHA-256 does not match production source")
    if call_source != {
        "path": "src/main.js",
        "sha256": sha256_file(ACTION_CALL_SITE_SOURCE_PATH),
        "selection": "real trackedIpcHandle/businessIpcHandle registration literal",
    }:
        errors.append("real call-site source contract/hash drift")

    binding_import_source = (
        "const { initializeActionTaskBindingStartup } = "
        "require('./main-process/background-execution/action-task-binding-registry');"
    )
    main_source_text = ACTION_CALL_SITE_SOURCE_PATH.read_text(encoding="utf-8")
    binding_import_offset = main_source_text.find(binding_import_source)
    expected_bootstrap_prefix = (
        main_source_text[: binding_import_offset + len(binding_import_source)]
        if binding_import_offset >= 0
        else ""
    )
    expected_bootstrap_proof = {
        "sourceStartOffset": 0,
        "sourceEndOffset": len(expected_bootstrap_prefix),
        "prefixSha256": hashlib.sha256(
            expected_bootstrap_prefix.encode("utf-8")
        ).hexdigest(),
        "loadedRequests": [
            "./main-process/background-execution/action-task-binding-registry"
        ],
        "resolvedTargetPath": str(ACTION_BINDING_SOURCE_PATH.resolve()),
        "freshModuleLoaded": True,
        "exportIdentityMatched": True,
        "passed": True,
    }
    if (
        binding_import_offset < 0
        or startup_bootstrap_proof != expected_bootstrap_proof
    ):
        errors.append("production Main full bootstrap-prefix loader proof drift")

    try:
        actual_inventory, identity_errors = task_policy_inventory_from_source()
    except (ValueError, json.JSONDecodeError) as exc:
        actual_inventory, identity_errors = [], []
        errors.append(f"cannot load production TaskPolicy inventory: {exc}")
    if identity_errors:
        errors.append(f"selected TaskPolicy taskKey/channel identity drift: {identity_errors}")
    if actual_inventory != frozen_inventory:
        errors.append(
            "frozen TaskPolicy inventory drift: "
            f"missing={sorted(set(actual_inventory) - set(frozen_inventory))}, "
            f"extra={sorted(set(frozen_inventory) - set(actual_inventory))}"
        )
    if frozen_inventory != sorted(set(frozen_inventory)):
        errors.append("frozen TaskPolicy inventory must be sorted and unique")
    frozen_inventory_digest = jcs_json_sha256(frozen_inventory)
    if frozen_inventory_digest != frozen_inventory_digest_authority:
        errors.append(
            "frozen TaskPolicy inventory JCS digest drift: "
            f"expected={frozen_inventory_digest_authority} "
            f"actual={frozen_inventory_digest}"
        )
    if actions != sorted(set(actions)):
        errors.append("binding action inventory must be sorted and unique")
    if set(bindings) != set(actions):
        errors.append(
            "binding map must have exact action keys: "
            f"missing={sorted(set(actions) - set(bindings))}, "
            f"extra={sorted(set(bindings) - set(actions))}"
        )
    if set(actions) != set(registry.get("actions", {})):
        errors.append("binding map action set does not equal Policy Registry")

    inventory_set = set(actual_inventory)
    map_pairs: set[tuple[str, str]] = set()
    for action_key in actions:
        allowed = bindings.get(action_key)
        if not isinstance(allowed, list):
            errors.append(f"binding {action_key} must be an array")
            continue
        if allowed != sorted(set(allowed)):
            errors.append(f"binding {action_key} must be sorted and unique")
        for task_key in allowed:
            map_pairs.add((action_key, task_key))
            if task_key not in inventory_set:
                errors.append(f"binding {action_key} references absent TaskPolicy key {task_key}")

    map_digest = jcs_json_sha256(bindings)
    if map_digest != frozen_binding_digest:
        errors.append(
            f"binding map JCS digest drift: expected={frozen_binding_digest} actual={map_digest}"
        )
    actual_one_to_many = {
        key: value for key, value in bindings.items()
        if isinstance(value, list) and len(value) > 1
    }
    if len(actual_one_to_many) != 9:
        errors.append("production source all one-to-many binding inventory drift")
    if production_summary.get("actionKeys") != actions:
        errors.append("production startup summary action inventory drift")
    if production_summary.get("taskPolicyInventory") != actual_inventory:
        errors.append("production startup summary TaskPolicy inventory drift")
    if production_summary.get("taskPolicyInventorySha256") != frozen_inventory_digest_authority:
        errors.append("production startup summary TaskPolicy inventory digest drift")

    expected_hostile_api_cases = {
        "single-list-read-owned-snapshot",
        "caller-binding-hidden-action-rejected",
        "fourth-read-accessor-rejected",
        "proxy-rejected",
        "registry-host-map-rejected",
        "registry-host-prototype-array-rejected",
        "list-throwing-message-accessor-cause-safe",
        "returned-array-owned-frozen",
        "taskkey-channel-mismatch-rejected",
        "equal-size-unbound-substitution-rejected",
        "bound-key-absent-rejected",
        "duplicate-policy-rejected",
        "barrel-export-live",
        "assert-pair-hostile-nonstring-no-read",
        "main-program-direct-reachability-and-mutants",
        "main-full-bootstrap-prefix-real-loader-export",
        "startup-seam-success-task-policy-binding-db-ipc",
        "startup-seam-binding-failure-db-ipc-zero",
    }
    if set(hostile_api_results) != expected_hostile_api_cases:
        errors.append("production binding hostile API case inventory drift")
    for name in sorted(expected_hostile_api_cases):
        if hostile_api_results.get(name) is not True:
            errors.append(f"production binding hostile API case failed: {name}")

    expected_startup_ast_mutations = {
        "conditional-initializer",
        "initializer-in-early-return-function",
        "initializer-in-swallowed-try-catch",
        "duplicate-initializer",
        "unused-run",
        "conditional-run",
        "swallowed-run-error",
        "run-after-early-return",
        "fake-production-import",
        "shadowed-run-identifier",
        "reassigned-import-identifier",
        "rebound-commonjs-require",
        "destructured-commonjs-require-rebind",
        "arguments-loader-rebind",
        "arguments-alias-loader-rebind",
        "target-require-cache-replacement",
        "target-require-cache-alias-replacement",
        "module-loader-replacement",
        "helper-mediated-wrapper-alias",
        "preceding-module-side-effect",
        "reviewer-equivalent-inline-loader-wrapper",
    }
    if set(startup_ast_mutation_results) != expected_startup_ast_mutations:
        errors.append("production Main startup AST mutation inventory drift")
    for name in sorted(expected_startup_ast_mutations):
        if startup_ast_mutation_results.get(name) is not True:
            errors.append(f"production Main startup AST mutation passed: {name}")

    task_lines = TASK_POLICY_SOURCE_PATH.read_text(encoding="utf-8").splitlines()
    call_lines = ACTION_CALL_SITE_SOURCE_PATH.read_text(encoding="utf-8").splitlines()
    provenance_pairs: set[tuple[str, str]] = set()
    provenance_shape = {
        "actionKey", "legacyTaskKey", "canonicalActionSpec", "callSite", "taskPolicy",
    }
    for index, item in enumerate(provenance):
        if not isinstance(item, dict) or set(item) != provenance_shape:
            errors.append(f"pair provenance[{index}] exact shape drift")
            continue
        action_key = item.get("actionKey")
        task_key = item.get("legacyTaskKey")
        pair = (action_key, task_key)
        if pair in provenance_pairs:
            errors.append(f"duplicate pair provenance: {pair!r}")
        provenance_pairs.add(pair)
        spec_ref = item.get("canonicalActionSpec", {})
        call_ref = item.get("callSite", {})
        policy_ref = item.get("taskPolicy", {})
        if set(spec_ref) != {"path", "line"}:
            errors.append(f"pair provenance[{index}] canonicalActionSpec shape drift")
        else:
            spec_path = PACKAGE_ROOT / str(spec_ref.get("path", ""))
            try:
                spec_line = spec_path.read_text(encoding="utf-8").splitlines()[
                    int(spec_ref.get("line")) - 1
                ]
            except (OSError, IndexError, TypeError, ValueError):
                spec_line = ""
            if not spec_line or str(action_key) not in spec_line:
                errors.append(f"pair provenance[{index}] canonical action source line drift")
        if set(call_ref) != {"path", "line", "kind"} or call_ref.get("path") != "src/main.js":
            errors.append(f"pair provenance[{index}] callSite shape/path drift")
        else:
            try:
                call_line_no = int(call_ref.get("line"))
                call_line = call_lines[call_line_no - 1]
            except (IndexError, TypeError, ValueError):
                call_line_no, call_line = 0, ""
            if str(task_key) not in call_line:
                errors.append(f"pair provenance[{index}] legacy task call-site line drift")
            kind = call_ref.get("kind")
            if kind == "direct-registration":
                if not re.search(r"(?:trackedIpcHandle|businessIpcHandle)\s*\(", call_line):
                    errors.append(f"pair provenance[{index}] is not a direct real registration")
            elif kind == "multiline-registration":
                nearby = "\n".join(call_lines[max(0, call_line_no - 4):call_line_no])
                if not re.search(r"(?:trackedIpcHandle|businessIpcHandle)\s*\(", nearby):
                    errors.append(f"pair provenance[{index}] is not within a real registration")
            else:
                errors.append(f"pair provenance[{index}] unsupported call-site kind {kind!r}")
        if (
            set(policy_ref) != {"path", "line"}
            or policy_ref.get("path") != "src/main-process/archive-center/task-policy-registry.js"
        ):
            errors.append(f"pair provenance[{index}] taskPolicy shape/path drift")
        else:
            try:
                policy_line = task_lines[int(policy_ref.get("line")) - 1]
            except (IndexError, TypeError, ValueError):
                policy_line = ""
            if str(task_key) not in policy_line:
                errors.append(f"pair provenance[{index}] TaskPolicy source line drift")

    if provenance_pairs != map_pairs:
        errors.append(
            "independent provenance pair set differs from forward binding map: "
            f"missing={sorted(map_pairs - provenance_pairs)} "
            f"extra={sorted(provenance_pairs - map_pairs)}"
        )
    reverse_index: dict[str, list[str]] = {}
    for action_key, task_key in sorted(provenance_pairs):
        reverse_index.setdefault(task_key, []).append(action_key)

    actual_counts = {
        "expectedActionCount": len(actions),
        "expectedTaskPolicyInventoryCount": len(actual_inventory),
        "expectedPairCount": len(map_pairs),
        "expectedForwardBoundTaskKeyCount": len({task for _action, task in map_pairs}),
        "expectedUnboundTaskPolicyCount": len(inventory_set - set(reverse_index)),
        "expectedProvenanceCount": len(provenance),
    }
    if actual_counts != expected_binding_counts:
        errors.append(f"binding hard counts drift: {actual_counts!r}")

    def snapshot_rejected(candidate: dict[str, list[str]]) -> bool:
        candidate_pairs = {
            (action, task) for action, task_keys in candidate.items() for task in task_keys
        }
        candidate_one_to_many = {
            key: value for key, value in candidate.items() if len(value) > 1
        }
        return bool(
            jcs_json_sha256(candidate) != frozen_binding_digest
            or len(candidate_pairs) != expected_binding_counts["expectedPairCount"]
            or candidate_pairs != provenance_pairs
            or candidate_one_to_many != actual_one_to_many
        )

    swapped = copy.deepcopy(bindings)
    swapped["bank-bu:export-aggregate"], swapped["bank-bu:export-single"] = (
        swapped["bank-bu:export-single"], swapped["bank-bu:export-aggregate"]
    )
    deleted = copy.deepcopy(bindings)
    acquiring_tasks = deleted.get("acquiring:import", [])
    if "acquiringBillCurrency:importFlow" in acquiring_tasks:
        acquiring_tasks.remove("acquiringBillCurrency:importFlow")
    authority_mutations = {
        "swap-bank-bu-export-pair": snapshot_rejected(swapped),
        "delete-acquiring-second-pair": snapshot_rejected(deleted),
    }
    for name, rejected in authority_mutations.items():
        if not rejected:
            errors.append(f"binding authority mutation passed: {name}")

    authority_verified = not errors

    def adapter_accepts(action_key: str, task_key: str) -> bool:
        allowed = bindings.get(action_key)
        return authority_verified and isinstance(allowed, list) and task_key in allowed

    mismatch_key = next(
        (
            key for key in actual_inventory
            if key not in bindings.get("statement:generate-all", [])
        ),
        "nonexistent:legacy-task",
    )
    adapter_mutations = {
        "missing-action": not adapter_accepts("missing:action", "monthly-balance:export"),
        "missing-task-key": not adapter_accepts(
            "statement:generate-all", "nonexistent:legacy-task"
        ),
        "binding-mismatch": not adapter_accepts("statement:generate-all", mismatch_key),
        "empty-binding-fails-closed": not adapter_accepts(
            "background-execution:canary", "monthly-balance:export"
        ),
        "every-one-to-many-pair-accepted": all(
            adapter_accepts(action, task)
            for action, task_keys in actual_one_to_many.items()
            for task in task_keys
        ),
        "every-one-to-many-unlisted-rejected": all(
            not adapter_accepts(action, mismatch_key)
            for action in actual_one_to_many
            if mismatch_key not in bindings[action]
        ),
    }
    for name, passed in adapter_mutations.items():
        if not passed:
            errors.append(f"binding adapter self-test failed: {name}")

    details = {
        "authority": str(ACTION_BINDING_SOURCE_PATH.relative_to(REPOSITORY_ROOT)),
        "authoritySourceSha256": sha256_file(ACTION_BINDING_SOURCE_PATH),
        "packageSnapshot": str(ACTION_MANIFEST_PATH.relative_to(PACKAGE_ROOT)),
        "productionInventorySource": str(TASK_POLICY_SOURCE_PATH.relative_to(REPOSITORY_ROOT)),
        "productionInventorySha256": sha256_file(TASK_POLICY_SOURCE_PATH),
        "callSiteSource": str(ACTION_CALL_SITE_SOURCE_PATH.relative_to(REPOSITORY_ROOT)),
        "callSiteSourceSha256": sha256_file(ACTION_CALL_SITE_SOURCE_PATH),
        "bindingMapJcsSha256": map_digest,
        "taskPolicyInventoryJcsSha256": frozen_inventory_digest,
        "sourceContract": production_contract,
        "hardCounts": actual_counts,
        "oneToManyBindings": actual_one_to_many,
        "reverseIndexSource": "pairProvenance",
        "reverseBoundTaskKeyCount": len(reverse_index),
        "authorityMutationResults": authority_mutations,
        "adapterMutationResults": adapter_mutations,
        "hostileApiResults": hostile_api_results,
        "startupBootstrapProof": startup_bootstrap_proof,
        "startupAstMutationResults": startup_ast_mutation_results,
        "errors": errors,
    }
    return errors, details


def contract_authority_anchor_errors(
    binding_details: dict[str, Any],
    recovery_control_schema_details: dict[str, Any],
    recovery_control_schema: dict[str, Any],
    previous_report: dict[str, Any],
    allow_report_bootstrap: bool,
    previous_authority_context: dict[str, Any],
    expected_report_command: str,
) -> tuple[list[str], dict[str, Any]]:
    """Cross-bind every mutable source/evidence layer to one non-generated anchor."""
    errors: list[str] = []
    anchor = contract_authority()
    binding = action_task_binding_authority()
    result = recovery_result_projection_authority()
    transition_errors, transition_details = evaluate_authority_transition(
        anchor,
        previous_authority_context.get("authority"),
    )
    transition_details = {
        **transition_details,
        "requestedAuthorityMode": previous_authority_context.get(
            "requestedAuthorityMode"
        ),
        "evidenceClass": previous_authority_context.get("evidenceClass"),
        "mergeEvidence": previous_authority_context.get("mergeEvidence"),
        "previousAbsenceVerified": previous_authority_context.get(
            "previousAbsenceVerified"
        ),
    }
    expected_report_provenance = authority_report_payload(
        previous_authority_context,
        transition_details,
    )
    errors.extend(transition_errors)
    expected_root_keys = {
        "authorityKind", "contractVersion", "revision", "canonicalization",
        "genesis", "approvalStatus", "changeControl", "actionTaskBinding",
        "recoveryResultProjection",
    }
    expected_binding_keys = {
        "sourceContractVersion", "bindingMapSha256", "taskPolicyInventorySha256",
        "expectedActionCount", "expectedTaskPolicyInventoryCount", "expectedPairCount",
        "expectedForwardBoundTaskKeyCount", "expectedUnboundTaskPolicyCount",
        "expectedProvenanceCount",
    }
    expected_result_keys = {
        "sourceContractVersion", "knownAnswerPreimage", "knownAnswerSha256",
        "expectedKnownAnswerCount", "expectedProjectionFieldCount",
        "expectedRequestCount", "expectedWriterCount",
    }
    if set(anchor) != expected_root_keys:
        errors.append("contract authority exact root shape drift")
    if set(binding) != expected_binding_keys:
        errors.append("contract authority actionTaskBinding exact shape drift")
    if set(result) != expected_result_keys:
        errors.append("contract authority recoveryResultProjection exact shape drift")
    if anchor.get("authorityKind") != "background-execution-recovery-contract-authority":
        errors.append("contract authority kind drift")
    if anchor.get("contractVersion") != 1:
        errors.append("contract authority v1 filename/contractVersion drift")
    if not is_positive_int(anchor.get("revision")):
        errors.append("contract authority revision must be an exact positive integer")
    if anchor.get("approvalStatus") != "PENDING_HUMAN_REVIEW":
        errors.append("contract authority approvalStatus must remain PENDING_HUMAN_REVIEW")
    if anchor.get("canonicalization") != "RFC8785-JCS":
        errors.append("contract authority canonicalization drift")
    if anchor.get("changeControl") != {
        "authorityValueChangeRequiresExactNextRevisionWithinV1": True,
        "gitGenesisRequiresVerifiedPreviousAbsence": True,
        "humanRedlineReviewRequired": True,
        "humanRedlineReviewStatus": "PENDING_HUMAN_REVIEW",
    }:
        errors.append("contract authority change-control/redline status drift")
    for label, digest in (
        ("binding map", binding.get("bindingMapSha256")),
        ("TaskPolicy inventory", binding.get("taskPolicyInventorySha256")),
        ("result KAT", result.get("knownAnswerSha256")),
    ):
        if not re.fullmatch(r"[0-9a-f]{64}", str(digest or "")):
            errors.append(f"contract authority {label} digest is not lowercase SHA-256")
    for key in expected_binding_keys - {
        "bindingMapSha256", "taskPolicyInventorySha256",
    }:
        if not is_positive_int(binding.get(key)):
            errors.append(f"contract authority binding positive integer field drift: {key}")
    for key in expected_result_keys - {"knownAnswerPreimage", "knownAnswerSha256"}:
        if not is_positive_int(result.get(key)):
            errors.append(f"contract authority result positive integer field drift: {key}")
    if result.get("knownAnswerPreimage") != "JCS(resultProjectionKnownAnswers)":
        errors.append("contract authority result KAT preimage drift")

    binding_counts = {
        key: binding.get(key)
        for key in (
            "expectedActionCount", "expectedTaskPolicyInventoryCount",
            "expectedPairCount", "expectedForwardBoundTaskKeyCount",
            "expectedUnboundTaskPolicyCount", "expectedProvenanceCount",
        )
    }
    if binding_details.get("bindingMapJcsSha256") != binding.get("bindingMapSha256"):
        errors.append("production binding digest is not anchored")
    if binding_details.get("taskPolicyInventoryJcsSha256") != binding.get(
        "taskPolicyInventorySha256"
    ):
        errors.append("production TaskPolicy inventory digest is not anchored")
    if binding_details.get("hardCounts") != binding_counts:
        errors.append("production binding counts are not anchored")
    if binding_details.get("sourceContract", {}).get("version") != binding.get(
        "sourceContractVersion"
    ):
        errors.append("production binding source contract version is not anchored")

    result_contract = (
        recovery_control_schema_details.get("resultProjectionContract", {})
        .get("knownAnswerContract", {})
    )
    if result_contract.get("sha256") != result.get("knownAnswerSha256"):
        errors.append("result KAT digest is not anchored")
    if result_contract.get("knownAnswerCount") != result.get("expectedKnownAnswerCount"):
        errors.append("result KAT count is not anchored")
    result_projection = recovery_control_schema_details.get("resultProjectionContract", {})
    if result_projection.get("projectionFieldCount") != result.get(
        "expectedProjectionFieldCount"
    ):
        errors.append("result projection field count is not anchored")
    if result_projection.get("requestProjectionCount") != result.get("expectedRequestCount"):
        errors.append("result request count is not anchored")
    result_fixture = load_json(VALID_RECOVERY_CONTROL_PATH)
    result_answers = result_fixture.get("resultProjectionKnownAnswers", [])
    result_writers = {
        item.get("writer") for item in result_answers if isinstance(item, dict)
    }
    if len(result_answers) != result.get("expectedRequestCount"):
        errors.append("result authority expected request count drift")
    if len(result_writers) != result.get("expectedWriterCount"):
        errors.append("result authority expected writer count drift")
    schema_version = (
        recovery_control_schema.get("$defs", {}).get("RecoveryEventProjectionV1", {})
        .get("properties", {}).get("contractVersion", {}).get("const")
    )
    if schema_version != result.get("sourceContractVersion"):
        errors.append("RecoveryEventProjectionV1 source contract version is not anchored")

    authority_ref = {
        "path": "changes/background-execution/recovery-contract-authority.v1.json",
        "contractVersion": anchor.get("contractVersion"),
        "revision": anchor.get("revision"),
        "genesis": anchor.get("genesis"),
        "approvalStatus": anchor.get("approvalStatus"),
        "gitGenesisRequiresVerifiedPreviousAbsence": anchor.get(
            "changeControl", {}
        ).get("gitGenesisRequiresVerifiedPreviousAbsence"),
    }
    expected_schema_anchor = {
        **authority_ref,
        "bindingSourceContractVersion": binding.get("sourceContractVersion"),
        "bindingMapSha256": binding.get("bindingMapSha256"),
        "taskPolicyInventorySha256": binding.get("taskPolicyInventorySha256"),
        "resultSourceContractVersion": result.get("sourceContractVersion"),
        "resultKnownAnswerSha256": result.get("knownAnswerSha256"),
    }
    if recovery_control_schema.get("x-contract-authority") != expected_schema_anchor:
        errors.append("RecoveryControl Schema authority anchor projection drift")

    action_manifest = load_json(ACTION_MANIFEST_PATH)
    if action_manifest.get("bindingContract", {}).get("contractAuthority") != authority_ref:
        errors.append("Action Manifest contract authority reference drift")
    if result_fixture.get("resultProjectionKnownAnswerContract", {}).get(
        "contractAuthority"
    ) != authority_ref:
        errors.append("result KAT fixture contract authority reference drift")
    codex_manifest = load_json(CODEX_READY_MANIFEST_PATH)
    expected_manifest_anchor = {
        **authority_ref,
        "bindingMapSha256": binding.get("bindingMapSha256"),
        "taskPolicyInventorySha256": binding.get("taskPolicyInventorySha256"),
        "resultKnownAnswerSha256": result.get("knownAnswerSha256"),
        "approvalStatus": anchor.get("approvalStatus"),
        "humanRedlineReviewStatus": "PENDING_HUMAN_REVIEW",
    }
    if codex_manifest.get("contractAuthority") != expected_manifest_anchor:
        errors.append("codex-ready manifest contract authority projection drift")

    document_paths = (
        CODEX_SPEC_PATH,
        CODEX_TECHDOC_PATH,
        E00_SPEC_PATH,
        E00_TECHDOC_PATH,
        PLATFORM_CONTRACT_PATH,
        PACKAGE_README_PATH,
        VALIDATION_README_PATH,
        PACKAGE_ROOT / "P0-recovery-control-identity-replay-contract-errata-report.md",
        PACKAGE_ROOT / "P0-recovery-control-redline-human-review-checklist.md",
    )
    authority_needles = (
        "changes/background-execution/recovery-contract-authority.v1.json",
        f"Contract Authority v{anchor.get('contractVersion')} revision {anchor.get('revision')}",
        str(binding.get("bindingMapSha256")),
        str(binding.get("taskPolicyInventorySha256")),
        str(result.get("knownAnswerSha256")),
        "genesis=true",
        "PENDING_HUMAN_REVIEW",
        "complete normalized authority provenance",
        "canonical generation command",
        "exact input hashes",
    )
    document_results: dict[str, bool] = {}
    for path in document_paths:
        text = path.read_text(encoding="utf-8")
        relative = str(path.relative_to(PACKAGE_ROOT))
        document_results[relative] = all(needle in text for needle in authority_needles)
        if not document_results[relative]:
            errors.append(f"document contract authority projection drift: {relative}")

    expected_report_anchor = {
        **expected_manifest_anchor,
        "authorityKind": anchor.get("authorityKind"),
    }
    report_anchor_matched = previous_report.get("contractAuthority") == expected_report_anchor
    if not report_anchor_matched and not allow_report_bootstrap:
        errors.append("published validation report contract authority projection drift")
    expected_report_disposition = authority_report_trust_projection(transition_details)
    previous_report_trust = previous_report.get("authorityTrust", {})
    report_disposition_matched = authority_report_trust_matches(
        previous_report_trust,
        expected_report_disposition,
    )
    report_provenance_matched = authority_report_provenance_matches(
        previous_report_trust,
        expected_report_provenance,
    )
    report_command_matched = previous_report.get("command") == expected_report_command
    report_version_matched = previous_report.get("reportVersion") == REPORT_VERSION
    if not report_provenance_matched and not allow_report_bootstrap:
        errors.append("validation report complete authority provenance drift")
    if not report_command_matched and not allow_report_bootstrap:
        errors.append("validation report canonical generation command drift")
    if not report_version_matched and not allow_report_bootstrap:
        errors.append("validation report version drift")

    # This is an independent, manually authored rev1 test snapshot. It is never
    # populated from the current anchor and exercises the same external-file loader.
    external_previous_v1 = {
        "authorityKind": "background-execution-recovery-contract-authority",
        "contractVersion": 1,
        "revision": 1,
        "genesis": True,
        "approvalStatus": "PENDING_HUMAN_REVIEW",
        "canonicalization": "RFC8785-JCS",
        "changeControl": {
            "authorityValueChangeRequiresExactNextRevisionWithinV1": True,
            "gitGenesisRequiresVerifiedPreviousAbsence": True,
            "humanRedlineReviewRequired": True,
            "humanRedlineReviewStatus": "PENDING_HUMAN_REVIEW",
        },
        "actionTaskBinding": {
            "sourceContractVersion": 1,
            "bindingMapSha256": "c217253cea4ccc377f030ff5119191a98e8e9c965853c9d9419fdedef9eef0ba",
            "taskPolicyInventorySha256": "9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368",
            "expectedActionCount": 52,
            "expectedTaskPolicyInventoryCount": 122,
            "expectedPairCount": 60,
            "expectedForwardBoundTaskKeyCount": 52,
            "expectedUnboundTaskPolicyCount": 70,
            "expectedProvenanceCount": 60,
        },
        "recoveryResultProjection": {
            "sourceContractVersion": 1,
            "knownAnswerPreimage": "JCS(resultProjectionKnownAnswers)",
            "knownAnswerSha256": "1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039",
            "expectedKnownAnswerCount": 20,
            "expectedProjectionFieldCount": 20,
            "expectedRequestCount": 20,
            "expectedWriterCount": 2,
        },
    }
    external_previous_bytes = (
        json.dumps(external_previous_v1, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")
    external_previous_digest = hashlib.sha256(external_previous_bytes).hexdigest()
    with tempfile.TemporaryDirectory(prefix="recovery-authority-previous-") as temp_dir:
        previous_path = Path(temp_dir) / "previous-authority.rev1.json"
        previous_path.write_bytes(external_previous_bytes)
        external_previous_context = read_external_previous_authority(
            previous_path,
            external_previous_digest,
            after_read_hook=lambda resolved: resolved.write_text(
                '{"pathWasReplacedAfterRead":true}\n', encoding="utf-8"
            ),
        )
        external_previous_loaded = external_previous_context["authority"]
        external_command = validation_command(argparse.Namespace(
            previous_authority=previous_path,
            previous_authority_sha256=external_previous_digest,
            authority_mode=None,
            base_ref=None,
            no_write_report=False,
            report=REPORT_PATH,
        ), external_previous_context)
        external_command_tokens = shlex.split(external_command)
        external_audit_results = {
            "single-read-path-replacement-keeps-original-bytes-identity": (
                external_previous_loaded == external_previous_v1
                and external_previous_context.get("byteSize") == len(external_previous_bytes)
                and external_previous_context.get("sha256") == external_previous_digest
                and load_json(previous_path) == {"pathWasReplacedAfterRead": True}
            ),
            "external-expected-digest-binds-read-bytes": (
                external_previous_context.get("expectedSha256") == external_previous_digest
                and external_previous_context.get("expectedSha256Matched") is True
            ),
            "external-report-command-reflects-mode-path-and-digest": (
                external_command_tokens[0] == "PYTHON_BIN=<python3>"
                and "--authority-mode" not in external_command_tokens
                and "--base-ref" not in external_command_tokens
                and external_command_tokens[
                    external_command_tokens.index("--previous-authority") + 1
                ] == str(previous_path.resolve())
                and external_command_tokens[
                    external_command_tokens.index("--previous-authority-sha256") + 1
                ] == external_previous_digest
            ),
        }

    def initialize_authority_git_fixture(
        root: Path,
        base_authority: dict[str, Any] | None,
    ) -> None:
        root.mkdir(parents=True, exist_ok=True)
        commands = (
            ("init", "--quiet"),
            ("config", "user.email", "recovery-contract-validator@example.invalid"),
            ("config", "user.name", "Recovery Contract Validator"),
        )
        for command in commands:
            completed = run_git(root, command)
            if completed.returncode != 0:
                raise MachineJsonContractError(
                    "AUTHORITY_GIT_KAT_SETUP_FAILED",
                    "unable to initialize authority Git known-answer fixture",
                )
        if base_authority is None:
            marker = root / "genesis-baseline-marker.txt"
            marker.write_text("authority absent at baseline\n", encoding="utf-8")
        else:
            authority_file = root / CONTRACT_AUTHORITY_REPOSITORY_PATH
            authority_file.parent.mkdir(parents=True, exist_ok=True)
            authority_file.write_text(
                json.dumps(base_authority, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        for command in (("add", "."), ("commit", "--quiet", "-m", "baseline"),
                        ("branch", "authority-baseline")):
            completed = run_git(root, command)
            if completed.returncode != 0:
                raise MachineJsonContractError(
                    "AUTHORITY_GIT_KAT_SETUP_FAILED",
                    "unable to commit authority Git known-answer fixture",
                )

    def resolve_with_ambient_git_environment(
        root: Path,
        overrides: dict[str, str],
    ) -> dict[str, Any]:
        missing = object()
        original = {key: os.environ.get(key, missing) for key in overrides}
        try:
            os.environ.update(overrides)
            return resolve_repository_previous_authority(
                root,
                CONTRACT_AUTHORITY_REPOSITORY_PATH,
                "authority-baseline",
                explicit_genesis=False,
            )
        finally:
            for key, value in original.items():
                if value is missing:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    genesis_cli_mutations: dict[str, bool] = {}
    report_provenance_mutations: dict[str, bool] = {}
    with tempfile.TemporaryDirectory(prefix="recovery-authority-git-kat-") as temp_dir:
        temp_root = Path(temp_dir)
        post_merge_root = temp_root / "post-merge"
        initialize_authority_git_fixture(post_merge_root, external_previous_v1)
        post_merge_mutant = copy.deepcopy(external_previous_v1)
        post_merge_mutant["actionTaskBinding"]["bindingMapSha256"] = "0" * 64
        post_merge_authority_path = post_merge_root / CONTRACT_AUTHORITY_REPOSITORY_PATH
        post_merge_authority_path.write_text(
            json.dumps(post_merge_mutant, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        for command in (("add", CONTRACT_AUTHORITY_REPOSITORY_PATH),
                        ("commit", "--quiet", "-m", "same revision semantic mutant")):
            completed = run_git(post_merge_root, command)
            if completed.returncode != 0:
                raise MachineJsonContractError(
                    "AUTHORITY_GIT_KAT_SETUP_FAILED",
                    "unable to commit post-merge authority mutant",
                )
        try:
            resolve_repository_previous_authority(
                post_merge_root,
                CONTRACT_AUTHORITY_REPOSITORY_PATH,
                "authority-baseline",
                explicit_genesis=True,
            )
            explicit_genesis_error_code = None
        except MachineJsonContractError as exc:
            explicit_genesis_error_code = exc.code
        post_merge_repo_context = resolve_repository_previous_authority(
            post_merge_root,
            CONTRACT_AUTHORITY_REPOSITORY_PATH,
            "authority-baseline",
            explicit_genesis=False,
        )
        post_merge_repo_errors, _ = evaluate_authority_transition(
            post_merge_mutant,
            post_merge_repo_context.get("authority"),
        )

        linked_worktree_root = temp_root / "linked-worktree"
        linked_worktree_setup = run_git(
            post_merge_root,
            ("worktree", "add", "--quiet", "--detach", str(linked_worktree_root), "HEAD"),
        )
        if linked_worktree_setup.returncode != 0:
            raise MachineJsonContractError(
                "AUTHORITY_GIT_KAT_SETUP_FAILED",
                "unable to initialize linked-worktree authority fixture",
            )
        linked_worktree_context = resolve_repository_previous_authority(
            linked_worktree_root,
            CONTRACT_AUTHORITY_REPOSITORY_PATH,
            "authority-baseline",
            explicit_genesis=False,
        )

        first_introduction_root = temp_root / "first-introduction"
        initialize_authority_git_fixture(first_introduction_root, None)
        first_authority_path = first_introduction_root / CONTRACT_AUTHORITY_REPOSITORY_PATH
        first_authority_path.parent.mkdir(parents=True, exist_ok=True)
        first_authority_path.write_text(
            json.dumps(anchor, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        for command in (("add", CONTRACT_AUTHORITY_REPOSITORY_PATH),
                        ("commit", "--quiet", "-m", "first authority introduction")):
            completed = run_git(first_introduction_root, command)
            if completed.returncode != 0:
                raise MachineJsonContractError(
                    "AUTHORITY_GIT_KAT_SETUP_FAILED",
                    "unable to commit first-introduction authority fixture",
                )
        first_context = resolve_repository_previous_authority(
            first_introduction_root,
            CONTRACT_AUTHORITY_REPOSITORY_PATH,
            "authority-baseline",
            explicit_genesis=True,
        )
        first_repo_context = resolve_repository_previous_authority(
            first_introduction_root,
            CONTRACT_AUTHORITY_REPOSITORY_PATH,
            "authority-baseline",
            explicit_genesis=False,
        )
        first_errors, _ = evaluate_authority_transition(
            anchor,
            first_context.get("authority"),
        )

        ambient_repository_context = resolve_with_ambient_git_environment(
            post_merge_root,
            {
                "GIT_DIR": str((first_introduction_root / ".git").resolve()),
                "GIT_WORK_TREE": str(first_introduction_root.resolve()),
            },
        )
        ambient_object_context = resolve_with_ambient_git_environment(
            post_merge_root,
            {
                "GIT_OBJECT_DIRECTORY": str(
                    (first_introduction_root / ".git" / "objects").resolve()
                ),
                "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(
                    (first_introduction_root / ".git" / "objects").resolve()
                ),
                "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": "core.worktree",
                "GIT_CONFIG_VALUE_0": str(first_introduction_root.resolve()),
            },
        )
        nested_other_worktree_root = post_merge_root / "nested-other-worktree"
        nested_other_worktree_root.mkdir()
        try:
            resolve_repository_previous_authority(
                nested_other_worktree_root,
                CONTRACT_AUTHORITY_REPOSITORY_PATH,
                "authority-baseline",
                explicit_genesis=True,
            )
            nested_worktree_error_code = None
        except MachineJsonContractError as exc:
            nested_worktree_error_code = exc.code

        hostile_environment = clean_git_environment({
            "PATH": os.environ.get("PATH", ""),
            "GIT_DIR": "/ambient/repository",
            "GIT_WORK_TREE": "/ambient/worktree",
            "GIT_COMMON_DIR": "/ambient/common",
            "GIT_OBJECT_DIRECTORY": "/ambient/objects",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES": "/ambient/alternate",
            "GIT_CONFIG": "/ambient/config",
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "core.worktree",
            "GIT_CONFIG_VALUE_0": "/ambient/worktree",
        })
        clean_environment_git_values = {
            key: value
            for key, value in hostile_environment.items()
            if key.startswith("GIT_")
        }

        detached_root = temp_root / "detached-export"
        detached_root.mkdir()
        detached_context = resolve_repository_previous_authority(
            detached_root,
            CONTRACT_AUTHORITY_REPOSITORY_PATH,
            "origin/v3.2.0",
            explicit_genesis=True,
        )
        detached_command = validation_command(argparse.Namespace(
            previous_authority=None,
            previous_authority_sha256=None,
            authority_mode="genesis",
            base_ref="origin/v3.2.0",
            no_write_report=False,
            report=REPORT_PATH,
        ), detached_context)
        _, detached_transition_details = evaluate_authority_transition(anchor, None)
        detached_transition_details = {
            **detached_transition_details,
            "requestedAuthorityMode": detached_context.get("requestedAuthorityMode"),
            "evidenceClass": detached_context.get("evidenceClass"),
            "mergeEvidence": detached_context.get("mergeEvidence"),
            "previousAbsenceVerified": detached_context.get(
                "previousAbsenceVerified"
            ),
        }
        detached_expected_trust = authority_report_trust_projection(
            detached_transition_details
        )
        detached_masquerading_trust = {
            **detached_expected_trust,
            "evidenceClass": "merge-base-verified-previous-absent",
            "mergeEvidence": True,
            "previousAbsenceVerified": True,
        }
        broken_git_root = temp_root / "broken-git-marker"
        broken_git_root.mkdir()
        (broken_git_root / ".git").write_text(
            "not a usable Git directory\n",
            encoding="utf-8",
        )
        try:
            resolve_repository_previous_authority(
                broken_git_root,
                CONTRACT_AUTHORITY_REPOSITORY_PATH,
                "origin/v3.2.0",
                explicit_genesis=True,
            )
            broken_git_error_code = None
        except MachineJsonContractError as exc:
            broken_git_error_code = exc.code

        def report_trust_for(context: dict[str, Any]) -> dict[str, Any]:
            _, details = evaluate_authority_transition(
                anchor,
                context.get("authority"),
            )
            details = {
                **details,
                "requestedAuthorityMode": context.get("requestedAuthorityMode"),
                "evidenceClass": context.get("evidenceClass"),
                "mergeEvidence": context.get("mergeEvidence"),
                "previousAbsenceVerified": context.get(
                    "previousAbsenceVerified"
                ),
            }
            return authority_report_payload(context, details)

        repo_report_args = argparse.Namespace(
            previous_authority=None,
            previous_authority_sha256=None,
            authority_mode="repo",
            base_ref="authority-baseline",
            no_write_report=False,
            report=REPORT_PATH,
        )
        external_report_args = argparse.Namespace(
            previous_authority=previous_path,
            previous_authority_sha256=external_previous_digest,
            authority_mode=None,
            base_ref=None,
            no_write_report=False,
            report=REPORT_PATH,
        )
        repo_report_trust = report_trust_for(first_repo_context)
        external_report_trust = report_trust_for(external_previous_context)
        repo_report_command = validation_command(
            repo_report_args,
            first_repo_context,
        )
        external_report_command = validation_command(
            external_report_args,
            external_previous_context,
        )
        repo_report_candidate = {
            "authorityTrust": repo_report_trust,
            "command": repo_report_command,
        }
        external_report_candidate = {
            "authorityTrust": external_report_trust,
            "command": external_report_command,
        }
        different_base_oid = "f" * 40
        if first_repo_context.get("mergeBase") == different_base_oid:
            different_base_oid = "e" * 40
        different_base_report = copy.deepcopy(repo_report_candidate)
        different_base_source = different_base_report["authorityTrust"]["source"]
        different_base_source["baseRef"] = "different-authority-baseline"
        different_base_source["mergeBase"] = different_base_oid
        different_base_source["source"] = (
            f"{different_base_oid}:{CONTRACT_AUTHORITY_REPOSITORY_PATH}"
        )
        different_base_report["command"] = validation_command(
            argparse.Namespace(
                **{
                    **vars(repo_report_args),
                    "base_ref": "different-authority-baseline",
                }
            ),
            first_repo_context,
        )
        different_head_oid = "d" * 40
        if (
            first_repo_context.get("gitWorkspaceIdentity", {}).get("headOid")
            == different_head_oid
        ):
            different_head_oid = "c" * 40
        different_head_report = copy.deepcopy(repo_report_candidate)
        different_head_identity = (
            different_head_report["authorityTrust"]["source"]
            ["gitWorkspaceIdentity"]
        )
        different_head_identity["headOid"] = different_head_oid
        different_head_identity["expected"]["headOid"] = different_head_oid
        report_provenance_mutations = {
            "same-repo-provenance-and-canonical-command-passes": (
                validation_report_provenance_matches(
                    repo_report_candidate,
                    repo_report_trust,
                    repo_report_command,
                )
            ),
            "repo-report-to-external-identical-authority-rejected": (
                not validation_report_provenance_matches(
                    repo_report_candidate,
                    external_report_trust,
                    external_report_command,
                )
            ),
            "external-report-to-repo-rejected": (
                not validation_report_provenance_matches(
                    external_report_candidate,
                    repo_report_trust,
                    repo_report_command,
                )
            ),
            "coordinated-different-base-and-merge-base-rejected": (
                not validation_report_provenance_matches(
                    different_base_report,
                    repo_report_trust,
                    repo_report_command,
                )
            ),
            "coordinated-different-head-and-physical-identity-rejected": (
                not validation_report_provenance_matches(
                    different_head_report,
                    repo_report_trust,
                    repo_report_command,
                )
            ),
        }
        genesis_cli_mutations = {
            "post-merge-explicit-genesis-rejected-stable-code": (
                explicit_genesis_error_code == "AUTHORITY_GENESIS_PREVIOUS_EXISTS"
            ),
            "post-merge-repo-same-revision-change-controlled": (
                post_merge_repo_context.get("authority") == external_previous_v1
                and "authority v1 controlled payload change requires exact revision +1"
                in post_merge_repo_errors
            ),
            "true-first-introduction-explicit-genesis-passes": (
                not first_errors
                and first_context.get("mode")
                  == "repo-explicit-genesis-previous-absent"
                and first_context.get("previousAbsenceVerified") is True
                and first_context.get("mergeEvidence") is True
            ),
            "detached-genesis-is-explicit-non-merge-evidence": (
                detached_context.get("mode")
                  == "detached-genesis-non-merge-evidence"
                and detached_context.get("evidenceClass") == "non-merge-evidence"
                and detached_context.get("mergeEvidence") is False
                and detached_context.get("previousAbsenceVerified") is False
                and "--authority-mode genesis" in detached_command
                and "--base-ref origin/v3.2.0" in detached_command
            ),
            "detached-merge-evidence-masquerade-rejected": (
                not authority_report_trust_matches(
                    detached_masquerading_trust,
                    detached_expected_trust,
                )
            ),
            "git-marker-resolution-error-never-becomes-genesis": (
                broken_git_error_code == "AUTHORITY_MERGE_BASE_UNAVAILABLE"
            ),
            "ambient-git-dir-work-tree-read-exact-current-repository": (
                ambient_repository_context.get("authority") == external_previous_v1
                and ambient_repository_context.get("gitWorkspaceIdentity", {}).get(
                    "topLevel"
                ) == str(post_merge_root.resolve())
            ),
            "ambient-object-alternate-config-read-exact-current-repository": (
                ambient_object_context.get("authority") == external_previous_v1
                and ambient_object_context.get("gitWorkspaceIdentity", {}).get(
                    "topLevel"
                ) == str(post_merge_root.resolve())
            ),
            "nested-other-worktree-root-rejected-stable-code": (
                nested_worktree_error_code == "AUTHORITY_GIT_WORKSPACE_MISMATCH"
            ),
            "repo-report-binds-exact-physical-workspace-and-head": (
                isinstance(post_merge_repo_context.get("gitWorkspaceIdentity"), dict)
                and post_merge_repo_context["gitWorkspaceIdentity"].get(
                    "identityMatched"
                ) is True
                and post_merge_repo_context["gitWorkspaceIdentity"].get("expected")
                == {
                    key: post_merge_repo_context["gitWorkspaceIdentity"].get(key)
                    for key in ("topLevel", "gitDir", "commonDir", "headOid")
                }
                and re.fullmatch(
                    r"[0-9a-f]{40}|[0-9a-f]{64}",
                    str(post_merge_repo_context["gitWorkspaceIdentity"].get("headOid")),
                ) is not None
            ),
            "linked-worktree-preserves-distinct-gitdir-and-common-dir": (
                linked_worktree_context.get("authority") == external_previous_v1
                and linked_worktree_context.get("gitWorkspaceIdentity", {}).get(
                    "topLevel"
                ) == str(linked_worktree_root.resolve())
                and linked_worktree_context.get("gitWorkspaceIdentity", {}).get(
                    "gitDir"
                ) != linked_worktree_context.get("gitWorkspaceIdentity", {}).get(
                    "commonDir"
                )
                and linked_worktree_context.get("gitWorkspaceIdentity", {}).get(
                    "expected"
                ) == {
                    key: linked_worktree_context["gitWorkspaceIdentity"].get(key)
                    for key in ("topLevel", "gitDir", "commonDir", "headOid")
                }
            ),
            "all-ambient-git-controls-removed-before-owned-policy": (
                clean_environment_git_values == {
                    "GIT_NO_REPLACE_OBJECTS": "1",
                    "GIT_CONFIG_NOSYSTEM": "1",
                    "GIT_CONFIG_GLOBAL": os.devnull,
                    "GIT_TERMINAL_PROMPT": "0",
                }
            ),
        }

    post_merge_unchanged = copy.deepcopy(external_previous_loaded)
    post_merge_errors, post_merge_details = evaluate_authority_transition(
        post_merge_unchanged,
        external_previous_loaded,
    )
    same_revision_genesis_flip = copy.deepcopy(external_previous_loaded)
    same_revision_genesis_flip["genesis"] = False
    genesis_flip_errors, _ = evaluate_authority_transition(
        same_revision_genesis_flip,
        external_previous_loaded,
    )
    next_revision_pending = copy.deepcopy(same_revision_genesis_flip)
    next_revision_pending["revision"] = 2
    next_revision_pending["actionTaskBinding"]["bindingMapSha256"] = "0" * 64
    next_revision_errors, next_revision_details = evaluate_authority_transition(
        next_revision_pending,
        external_previous_loaded,
    )
    unchanged_revision_bump = copy.deepcopy(external_previous_loaded)
    unchanged_revision_bump["revision"] = 2
    unchanged_bump_errors, _ = evaluate_authority_transition(
        unchanged_revision_bump,
        external_previous_loaded,
    )
    future_revision_mutations = {
        "full-authority-post-merge-unchanged-genesis-rev1-passes": (
            not post_merge_errors
            and post_merge_details.get("genesis") is True
            and post_merge_details.get("previousPresent") is True
            and post_merge_details.get("semanticPayloadChanged") is False
        ),
        "full-authority-same-revision-genesis-flip-rejected": bool(
            genesis_flip_errors
        ),
        "full-authority-rev1-to-rev2-semantic-change-pending-passes": (
            not next_revision_errors
            and next_revision_details.get("humanReviewGate") == "PENDING"
            and next_revision_details.get("mergeReady") is False
            and next_revision_details.get("productionEnablementAllowed") is False
        ),
        "full-authority-unchanged-revision-bump-rejected": bool(
            unchanged_bump_errors
        ),
    }

    swapped = copy.deepcopy(
        action_manifest.get("allowedLegacyTaskKeysByActionKeySnapshot", {})
    )
    swapped["bank-bu:export-aggregate"], swapped["bank-bu:export-single"] = (
        swapped["bank-bu:export-single"], swapped["bank-bu:export-aggregate"]
    )
    synchronized_binding_digest = jcs_json_sha256(swapped)
    answers = copy.deepcopy(result_fixture.get("resultProjectionKnownAnswers", []))
    mapper_answer = next(
        (item for item in answers if item.get("requestName") == "task-mark-interrupted"),
        None,
    )
    if isinstance(mapper_answer, dict) and isinstance(mapper_answer.get("projection"), dict):
        mapper_answer["projection"]["actionKey"] = "bank-bu:run"
    synchronized_result_digest = jcs_json_sha256(answers)
    coordinated_mutations = {
        "source-local-unit-manifest-provenance-digest-synchronized-anchor-unchanged": (
            synchronized_binding_digest != binding.get("bindingMapSha256")
        ),
        "branch-mapper-kat-local-manifest-report-synchronized-anchor-unchanged": (
            synchronized_result_digest != result.get("knownAnswerSha256")
        ),
    }
    for name, passed in {
        **future_revision_mutations,
        **coordinated_mutations,
        **external_audit_results,
        **genesis_cli_mutations,
        **report_provenance_mutations,
    }.items():
        if not passed:
            errors.append(f"contract authority coordinated mutation passed: {name}")

    details = {
        "authorityPath": str(CONTRACT_AUTHORITY_PATH.relative_to(PACKAGE_ROOT)),
        "authorityKind": anchor.get("authorityKind"),
        "contractVersion": anchor.get("contractVersion"),
        "revision": anchor.get("revision"),
        "genesis": anchor.get("genesis"),
        "approvalStatus": anchor.get("approvalStatus"),
        "canonicalization": anchor.get("canonicalization"),
        "actionTaskBinding": binding,
        "recoveryResultProjection": result,
        "validatorValueSource": "independent contract authority JSON",
        "schemaProjection": expected_schema_anchor,
        "manifestProjection": expected_manifest_anchor,
        "reportProjection": expected_report_anchor,
        "reportDispositionProjection": expected_report_disposition,
        "reportProvenanceProjection": expected_report_provenance,
        "reportCanonicalCommand": expected_report_command,
        "reportBootstrapAllowed": allow_report_bootstrap,
        "reportAnchorMatched": report_anchor_matched or allow_report_bootstrap,
        "reportDispositionMatched": (
            report_disposition_matched or allow_report_bootstrap
        ),
        "reportProvenanceMatched": (
            report_provenance_matched or allow_report_bootstrap
        ),
        "reportCanonicalCommandMatched": (
            report_command_matched or allow_report_bootstrap
        ),
        "reportVersionMatched": report_version_matched or allow_report_bootstrap,
        "documentResults": document_results,
        "previousAuthoritySource": {
            key: value
            for key, value in previous_authority_context.items()
            if key != "authority"
        },
        "trustModel": transition_details,
        "futureRevisionMutationResults": future_revision_mutations,
        "externalPreviousAuditResults": external_audit_results,
        "genesisCliMutationResults": genesis_cli_mutations,
        "reportProvenanceMutationResults": report_provenance_mutations,
        "externalPreviousAuditExpectedSha256": external_previous_digest,
        "externalPreviousAuditByteSize": len(external_previous_bytes),
        "coordinatedMutationResults": coordinated_mutations,
        "coordinatedMutationDigests": {
            "binding": synchronized_binding_digest,
            "result": synchronized_result_digest,
        },
        "errors": errors,
    }
    return errors, details


def action_table_registry_alignment_errors(registry: dict[str, Any]) -> tuple[list[str], int]:
    """Cross-check canonical static fields in every version Spec against the Registry fixture."""
    errors: list[str] = []
    compared = 0
    actions = registry.get("actions", {})
    field_map: dict[str, tuple[str, ...]] = {
        "targetDisposition": ("disposition",),
        "mode": ("mode",),
        "lifetime": ("lifetime",),
        "adapterKind": ("adapterKind",),
        "commit.kind": ("commit", "kind"),
    }
    for path in sorted((PACKAGE_ROOT / "changes").glob("3.2.*/spec.md")):
        lines = path.read_text(encoding="utf-8").splitlines()
        header: list[str] | None = None
        for line_no, line in enumerate(lines, 1):
            if not line.startswith("|"):
                if line.strip():
                    header = None
                continue
            cells = table_cells(line)
            if cells and cells[0] == "actionKey":
                header = cells
                continue
            if not header or line.startswith("| ---") or len(cells) != len(header):
                continue
            action_key = cells[0]
            if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*", action_key):
                continue
            policy = actions.get(action_key)
            if policy is None:
                continue
            row = dict(zip(header, cells))
            for column, path_parts in field_map.items():
                if column not in row:
                    continue
                expected: Any = policy
                for part in path_parts:
                    expected = expected.get(part) if isinstance(expected, dict) else None
                compared += 1
                if row[column] != expected:
                    errors.append(
                        f"{path.relative_to(PACKAGE_ROOT)}:{line_no} {action_key} "
                        f"{column}={row[column]!r} != registry {expected!r}"
                    )
    return errors, compared


def json_utf8_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def protocol_message_semantic_errors(
    message: dict[str, Any], registry: dict[str, Any]
) -> list[str]:
    """Validate cross-field context identity and the policy-owned wire byte ceiling."""
    errors: list[str] = []
    actions = registry.get("actions", {})
    action_key: str | None = None
    if message.get("channel") == "job":
        action_key = message.get("actionKey")
        context = message.get("context", {})
        value = context.get("value", {}) if isinstance(context, dict) else {}
        if isinstance(value, dict) and "operationKey" in value:
            if value.get("operationKey") != message.get("operationKey"):
                errors.append("context.operationKey must equal envelope.operationKey")
        policy = actions.get(action_key, {})
        expected_kind = policy.get("context", {}).get("kind")
        if expected_kind is not None and context.get("kind") != expected_kind:
            errors.append(
                f"{action_key}: context kind {context.get('kind')!r} != policy {expected_kind!r}"
            )
    elif isinstance(message.get("jobRef"), dict):
        action_key = message["jobRef"].get("actionKey")

    policy = actions.get(action_key, {}) if action_key else {}
    limits = policy.get("protocolLimits", {})
    direction = message.get("direction")
    limit_key = "commandMaxBytes" if direction == "command" else "eventMaxBytes"
    ceiling = limits.get(limit_key, PLATFORM_PROTOCOL_MAX_BYTES)
    if not isinstance(ceiling, int) or ceiling < 1:
        errors.append(f"invalid protocol byte ceiling for {action_key or 'platform-control'}")
    elif json_utf8_size(message) > ceiling:
        errors.append(
            f"UTF-8 JSON envelope exceeds {direction} ceiling {ceiling}: {json_utf8_size(message)}"
        )
    return errors


def protocol_policy_contract_errors(
    policy_schema: dict[str, Any],
    protocol_schema: dict[str, Any],
    policy_validator: Draft202012Validator,
    registry: dict[str, Any],
    valid_messages: list[dict[str, Any]],
) -> tuple[list[str], dict[str, Any]]:
    """Freeze reviewed context, payload, byte-limit, canary and resource-vector contracts."""
    errors: list[str] = []
    defs = protocol_schema.get("$defs", {})
    job_envelope = defs.get("jobEnvelope", {})
    operations = set(job_envelope.get("properties", {}).get("operation", {}).get("enum", []))
    if operations != JOB_OPERATIONS:
        errors.append(f"Job operation set drift: {sorted(operations)}")

    payload_map: dict[str, str] = {}
    for branch in job_envelope.get("allOf", []):
        operation = branch.get("if", {}).get("properties", {}).get("operation", {}).get("const")
        ref = branch.get("then", {}).get("properties", {}).get("payload", {}).get("$ref")
        if operation and ref:
            wrapper_def = defs.get(ref.rsplit("/", 1)[-1], {})
            required = wrapper_def.get("required", [])
            if wrapper_def.get("additionalProperties") is not False or len(required) != 1:
                errors.append(f"{operation}: payload outer wrapper is not exact-one")
            else:
                payload_map[operation] = required[0]
    if payload_map != JOB_PAYLOAD_WRAPPERS:
        errors.append(f"Job payload wrapper drift: {payload_map!r}")

    covered_operations = {
        message.get("operation") for message in valid_messages if message.get("channel") == "job"
    }
    if covered_operations != JOB_OPERATIONS:
        errors.append(
            f"valid Job fixtures do not cover all operations: missing={sorted(JOB_OPERATIONS - covered_operations)}"
        )

    expected_context_fields = {
        "operationContext": {"taskRunId", "taskKey", "moduleId", "parentRunId", "operationKey"},
        "fileBatchContext": {
            "batchId", "batchNumber", "taskRunId", "taskKey", "moduleId",
            "parentRunId", "operationKey",
        },
    }
    for name, expected in expected_context_fields.items():
        actual = set(defs.get(name, {}).get("required", []))
        if actual != expected or defs.get(name, {}).get("additionalProperties") is not False:
            errors.append(f"{name} exact-field drift: {sorted(actual)}")

    policy_defs = policy_schema.get("$defs", {})
    action_required = set(policy_defs.get("actionPolicy", {}).get("required", []))
    limits_schema = policy_defs.get("protocolLimitsPolicy", {})
    if "protocolLimits" not in action_required:
        errors.append("actionPolicy.protocolLimits is not required")
    for field in ("commandMaxBytes", "eventMaxBytes"):
        if limits_schema.get("properties", {}).get(field, {}).get("const") != PLATFORM_PROTOCOL_MAX_BYTES:
            errors.append(f"protocolLimits.{field} ceiling drift")

    mutation_results: dict[str, bool] = {}
    for name, mutate in (
        ("missing-limit", lambda policy: policy.pop("protocolLimits", None)),
        ("zero-limit", lambda policy: policy.__setitem__(
            "protocolLimits", {"commandMaxBytes": 0, "eventMaxBytes": PLATFORM_PROTOCOL_MAX_BYTES}
        )),
        ("over-limit", lambda policy: policy.__setitem__(
            "protocolLimits", {
                "commandMaxBytes": PLATFORM_PROTOCOL_MAX_BYTES + 1,
                "eventMaxBytes": PLATFORM_PROTOCOL_MAX_BYTES,
            }
        )),
    ):
        mutated = copy.deepcopy(registry)
        policy = mutated["actions"]["background-execution:pure-compute-canary"]
        mutate(policy)
        rejected = bool(json_errors(policy_validator, mutated))
        mutation_results[name] = rejected
        if not rejected:
            errors.append(f"policy protocol limit mutation passed: {name}")

    compound_action = next(
        (key for key, policy in registry.get("actions", {}).items()
         if policy.get("resources", {}).get("compound")),
        None,
    )
    if compound_action:
        for name, mutate in (
            ("compound-missing-child-resource", lambda compound: compound.pop("childResource", None)),
            ("compound-duplicate-root", lambda compound: compound.__setitem__(
                "root", {"cpuSlots": 0, "workerThreadSlots": 1, "utilityProcessSlots": 0,
                         "ioHeavySlots": 0, "memoryBytes": 1}
            )),
        ):
            mutated = copy.deepcopy(registry)
            compound = mutated["actions"][compound_action]["resources"]["compound"]
            mutate(compound)
            rejected = bool(json_errors(policy_validator, mutated))
            mutation_results[name] = rejected
            if not rejected:
                errors.append(f"compound mutation passed: {name}")

    resource_vector = defs.get("resourceVector", {})
    if (
        set(resource_vector.get("required", [])) != {"memoryBytes", "cpuSlots", "ioHeavySlots"}
        or resource_vector.get("additionalProperties") is not False
    ):
        errors.append("Service resourceVector must remain the exact Worker-requested three dimensions")

    start_fixture = next(
        (
            message for message in valid_messages
            if message.get("channel") == "job"
            and message.get("operation") == "job:start"
        ),
        None,
    )
    boundary_results: dict[str, Any] = {"fixturePresent": start_fixture is not None}
    if start_fixture is None:
        errors.append("missing job:start byte-boundary fixture")
    else:
        start = copy.deepcopy(start_fixture)
        start["payload"] = {"input": {"text": ""}}
        remaining = PLATFORM_PROTOCOL_MAX_BYTES - json_utf8_size(start)
        boundary_results["remainingAsciiBytes"] = remaining
        if remaining <= 0:
            errors.append("protocol byte boundary fixture has no payload headroom")
        else:
            start["payload"]["input"]["text"] = "x" * remaining
            boundary_results["exactBytes"] = json_utf8_size(start)
            if protocol_message_semantic_errors(start, registry):
                errors.append("exact UTF-8 byte ceiling was rejected")
            start["payload"]["input"]["text"] = "x" * (remaining - 1) + "界"
            boundary_results["multibyteOverBytes"] = json_utf8_size(start)
            if not any(
                "exceeds" in err
                for err in protocol_message_semantic_errors(start, registry)
            ):
                errors.append("multi-byte UTF-8 boundary overflow was not rejected")

    resource_contract = (
        "Worker dynamic resourceVector 只含 memoryBytes/cpuSlots/ioHeavySlots；Main 扩展为五维时"
        "固定 workerThreadSlots=0、utilityProcessSlots=0，OS 载体已由 spawn 前 BaseLease 计入。"
    )
    compound_contract = (
        "active compound = resources.base + resources.phase + childResource * effectiveChildCount；"
        "childrenMax/effectiveChildCount 只计 children，不含 root。"
    )
    for name, path in (
        ("platform-contract", PLATFORM_CONTRACT_PATH),
        ("E00-techdoc", E00_TECHDOC_PATH),
        ("CODEX-techdoc", CODEX_TECHDOC_PATH),
    ):
        text = path.read_text(encoding="utf-8")
        if resource_contract not in text:
            errors.append(f"{name} missing Worker 3D to Main 5D resource contract")
        if compound_contract not in text:
            errors.append(f"{name} missing compound root/children accounting contract")
    e00_text = E00_TECHDOC_PATH.read_text(encoding="utf-8")
    if "以下八个 `platform:*` 名称只是 test scenario labels，不是 Action Manifest/Policy Registry 的 `actionKey`" not in e00_text:
        errors.append("E00 TechDoc does not distinguish platform:* scenario labels from actionKey")

    return errors, {
        "jobOperationCount": len(operations),
        "payloadWrapperCount": len(payload_map),
        "policyMutationResults": mutation_results,
        "utf8Boundary": boundary_results,
        "errors": errors,
    }


def execution_result_contract_errors() -> list[str]:
    errors: list[str] = []
    heading = "ExecutionResultV1 terminalSource 权威枚举："
    for name, path in (
        ("lifecycle", LIFECYCLE_MAPPING_PATH),
        ("E00-techdoc", E00_TECHDOC_PATH),
        ("CODEX-techdoc", CODEX_TECHDOC_PATH),
    ):
        try:
            actual = _extract_text_enum_after(path.read_text(encoding="utf-8"), heading)
        except ValueError as exc:
            errors.append(f"{name} terminalSource enum unreadable: {exc}")
            continue
        if actual != EXECUTION_TERMINAL_SOURCES:
            errors.append(f"{name} terminalSource drift: {actual!r}")
    return errors


def protocol_sequence_errors(
    messages: list[dict[str, Any]], registry: dict[str, Any]
) -> list[str]:
    """Validate exact seq continuity, Job unit settle gates and Service resource continuity."""
    errors: list[str] = []
    last_seq: dict[tuple[Any, ...], int] = {}
    job_identity: dict[str, tuple[Any, ...]] = {}

    for index, message in enumerate(messages):
        channel = message.get("channel")
        direction = message.get("direction")
        if channel == "job":
            scope = (
                "job", message.get("jobId"), message.get("workerInstanceId"), direction
            )
            job_id = str(message.get("jobId"))
            identity = (
                message.get("actionKey"), message.get("operationKey"),
                message.get("workerInstanceId"), message.get("serviceGeneration"),
            )
            previous_identity = job_identity.setdefault(job_id, identity)
            if previous_identity != identity:
                errors.append(
                    f"message[{index}] job route/generation changed {previous_identity} -> {identity}"
                )
        elif channel == "service-control":
            scope = (
                "service-control", message.get("serviceKey"),
                message.get("serviceGeneration"), message.get("workerInstanceId"), direction,
            )
        else:
            continue
        seq = message.get("seq")
        if isinstance(seq, int):
            expected = last_seq.get(scope, 0) + 1
            if seq != expected:
                errors.append(
                    f"message[{index}] seq must equal last + 1 in {scope}: expected {expected}, got {seq}"
                )
            last_seq[scope] = seq

    job_messages = [m for m in messages if m.get("channel") == "job"]
    if job_messages:
        units: dict[str, str] = {}
        unknown_units: set[str] = set()
        terminal_seen = False
        action_key = job_messages[0].get("actionKey")
        failure = registry.get("actions", {}).get(action_key, {}).get("failure", {})
        allow_unit_error = (
            failure.get("unitBusinessError") == "collect-and-continue"
            or failure.get("unitTransportCrash") == "fail-unit-and-continue"
        )
        allowed_at_done = {"done", *(("error",) if allow_unit_error else ())}
        for index, message in enumerate(job_messages):
            operation = message.get("operation")
            unit_id = message.get("unitId")
            if terminal_seen:
                errors.append(f"job message[{index}] arrived after execution terminal")
                continue
            if operation == "unit:start":
                if unit_id in units:
                    errors.append(f"job message[{index}] duplicate registered unit {unit_id}")
                else:
                    units[str(unit_id)] = "running"
            elif operation in {"unit:progress", "unit:done", "unit:error", "unit:cancel"}:
                key = str(unit_id)
                if key not in units:
                    unknown_units.add(key)
                    errors.append(f"job message[{index}] references unknown unit {key}")
                elif operation == "unit:done":
                    units[key] = "done"
                elif operation == "unit:error":
                    units[key] = "error"
                elif operation == "unit:cancel":
                    units[key] = "cancelled"
            elif operation == "job:done":
                invalid = {key: state for key, state in units.items() if state not in allowed_at_done}
                if unknown_units or invalid:
                    errors.append(
                        f"job:done gate rejected unknown={sorted(unknown_units)} nonTerminal={invalid}"
                    )
                terminal_seen = True
            elif operation == "job:error":
                # Early stop is authoritative; remaining registered units are cleaned up internally.
                for key, state in list(units.items()):
                    if state == "running":
                        units[key] = "cancelled"
                terminal_seen = True

    errors.extend(_service_resource_sequence_errors(messages))
    return errors


def _service_resource_sequence_errors(messages: list[dict[str, Any]]) -> list[str]:
    """Validate Service Control identity and resource request/grant/adopt/release continuity."""
    errors: list[str] = []
    service_messages = [m for m in messages if m.get("channel") == "service-control"]
    if not service_messages:
        return errors

    canonical_identity = (
        service_messages[0].get("serviceKey"),
        service_messages[0].get("workerInstanceId"),
        service_messages[0].get("serviceGeneration"),
    )
    initialized = False
    ready = False
    close_command: dict[str, Any] | None = None
    close_ack = False
    requests: dict[str, dict[str, Any]] = {}
    grants: dict[str, dict[str, Any]] = {}
    adopted: dict[str, dict[str, Any]] = {}
    adopt_acks: set[str] = set()
    active_reservations: dict[str, str] = {}
    releases: dict[str, dict[str, Any]] = {}
    revokes: dict[str, dict[str, Any]] = {}
    release_acks: set[str] = set()
    current_reservation_by_owner: dict[str, str] = {}
    owner_by_reservation: dict[str, str] = {}
    replaced_reservations: set[str] = set()

    def job_ref_key(message: dict[str, Any]) -> Any:
        return message.get("jobRef")

    for index, m in enumerate(service_messages):
        identity = (m.get("serviceKey"), m.get("workerInstanceId"), m.get("serviceGeneration"))
        if identity != canonical_identity:
            errors.append(f"message[{index}] service identity changed {canonical_identity} -> {identity}")

        op = m.get("operation")
        payload = m.get("payload", {})
        if op == "executor:init":
            if initialized:
                errors.append(f"message[{index}] duplicate executor:init")
            initialized = True
        elif op == "executor:ready":
            if not initialized:
                errors.append(f"message[{index}] executor:ready before executor:init")
            ready = True
        elif op == "resource:request":
            if not ready:
                errors.append(f"message[{index}] resource:request before executor:ready")
            request_id = payload.get("requestId")
            if request_id in requests:
                errors.append(f"message[{index}] duplicate resource request {request_id}")
            owner = payload.get("owner", {})
            owner_key = (owner.get("kind"), owner.get("ownerKeyHash"))
            request_kind = payload.get("requestKind")
            replaces = payload.get("replacesReservationId")
            if request_kind == "persistent-state-replace":
                current = current_reservation_by_owner.get(owner_key)
                if current is not None and replaces != current:
                    errors.append(
                        f"message[{index}] persistent owner must replace current reservation {current}, got {replaces}"
                    )
                if current is None and replaces is not None:
                    errors.append(
                        f"message[{index}] first persistent owner request must use replacesReservationId=null"
                    )
            elif replaces is not None:
                errors.append(f"message[{index}] {request_kind} cannot replace a reservation")
            requests[request_id] = m
        elif op in {"resource:grant", "resource:reject"}:
            request_id = payload.get("requestId")
            req = requests.get(request_id)
            if req is None:
                errors.append(f"message[{index}] {op} without matching resource:request")
                continue
            if job_ref_key(req) != job_ref_key(m):
                errors.append(f"message[{index}] {op} jobRef differs from request")
            if req.get("controlId") != m.get("controlId"):
                errors.append(f"message[{index}] {op} controlId differs from request")
            if op == "resource:grant":
                if payload.get("replacesReservationId") != req.get("payload", {}).get("replacesReservationId"):
                    errors.append(f"message[{index}] grant replacesReservationId differs from request")
                requested = req.get("payload", {}).get("requested", {})
                granted = payload.get("granted", {})
                for field in ("memoryBytes", "cpuSlots", "ioHeavySlots"):
                    if isinstance(requested.get(field), int) and isinstance(granted.get(field), int) and granted[field] > requested[field]:
                        errors.append(f"message[{index}] grant exceeds requested {field}")
                grants[request_id] = m
        elif op == "resource:adopted":
            request_id = payload.get("requestId")
            grant = grants.get(request_id)
            req = requests.get(request_id)
            if grant is None or req is None:
                errors.append(f"message[{index}] resource:adopted without matching grant")
                continue
            gp = grant.get("payload", {})
            if payload.get("grantId") != gp.get("grantId") or payload.get("reservationId") != gp.get("reservationId"):
                errors.append(f"message[{index}] adopted grant/reservation identity mismatch")
            if payload.get("owner") != req.get("payload", {}).get("owner"):
                errors.append(f"message[{index}] adopted owner differs from request")
            if job_ref_key(grant) != job_ref_key(m):
                errors.append(f"message[{index}] adopted jobRef differs from grant")
            adopted[request_id] = m
        elif op == "resource:adopt-ack":
            request_id = payload.get("requestId")
            ad = adopted.get(request_id)
            grant = grants.get(request_id)
            if ad is None or grant is None:
                errors.append(f"message[{index}] adopt-ack without adopted/grant")
                continue
            ap = ad.get("payload", {})
            if payload.get("grantId") != ap.get("grantId") or payload.get("reservationId") != ap.get("reservationId"):
                errors.append(f"message[{index}] adopt-ack identity mismatch")
            if ad.get("controlId") != m.get("controlId"):
                errors.append(f"message[{index}] adopt-ack must echo adopted controlId")
            if job_ref_key(ad) != job_ref_key(m):
                errors.append(f"message[{index}] adopt-ack jobRef differs from adopted")
            adopt_acks.add(request_id)
            reservation_id = payload.get("reservationId")
            if reservation_id in active_reservations:
                errors.append(f"message[{index}] duplicate active reservation {reservation_id}")
            active_reservations[reservation_id] = request_id
            req = requests.get(request_id, {})
            req_payload = req.get("payload", {})
            owner = req_payload.get("owner", {})
            owner_key = (owner.get("kind"), owner.get("ownerKeyHash"))
            replaced = req_payload.get("replacesReservationId")
            if replaced is not None:
                active_reservations.pop(replaced, None)
                owner_by_reservation.pop(replaced, None)
                replaced_reservations.add(replaced)
            current_reservation_by_owner[owner_key] = reservation_id
            owner_by_reservation[reservation_id] = owner_key
        elif op == "resource:revoke":
            reservation_id = payload.get("reservationId")
            request_id = active_reservations.get(reservation_id)
            grant = grants.get(request_id) if request_id is not None else None
            if grant is None:
                errors.append(f"message[{index}] revoke references non-active reservation {reservation_id}")
                continue
            if payload.get("grantId") != grant.get("payload", {}).get("grantId"):
                errors.append(f"message[{index}] revoke grantId mismatch")
            if job_ref_key(grant) != job_ref_key(m):
                errors.append(f"message[{index}] revoke jobRef differs from grant")
            revokes[reservation_id] = m
        elif op == "resource:release":
            reservation_id = payload.get("reservationId")
            if reservation_id not in active_reservations:
                errors.append(f"message[{index}] release references non-active reservation {reservation_id}")
            revoke = revokes.get(reservation_id)
            if revoke is not None:
                if revoke.get("controlId") != m.get("controlId"):
                    errors.append(f"message[{index}] revoked release controlId mismatch")
                if job_ref_key(revoke) != job_ref_key(m):
                    errors.append(f"message[{index}] revoked release jobRef mismatch")
            releases[reservation_id] = m
        elif op == "resource:release-ack":
            reservation_id = payload.get("reservationId")
            rel = releases.get(reservation_id)
            if rel is None:
                errors.append(f"message[{index}] release-ack without release")
                continue
            if rel.get("controlId") != m.get("controlId"):
                errors.append(f"message[{index}] release-ack must echo release controlId")
            release_acks.add(reservation_id)
            active_reservations.pop(reservation_id, None)
            owner_key = owner_by_reservation.pop(reservation_id, None)
            if owner_key and current_reservation_by_owner.get(owner_key) == reservation_id:
                current_reservation_by_owner.pop(owner_key, None)
        elif op == "executor:close":
            if not ready:
                errors.append(f"message[{index}] executor:close before ready")
            if active_reservations:
                errors.append(f"message[{index}] executor:close with active reservations {sorted(active_reservations)}")
            close_command = m
        elif op == "executor:close-ack":
            if close_command is None:
                errors.append(f"message[{index}] close-ack without close")
            elif close_command.get("controlId") != m.get("controlId"):
                errors.append(f"message[{index}] close-ack must echo close controlId")
            close_ack = True

    for request_id, grant in grants.items():
        if request_id not in adopted:
            errors.append(f"granted request {request_id} missing resource:adopted")
        if request_id not in adopt_acks:
            errors.append(f"granted request {request_id} missing resource:adopt-ack")
        reservation_id = grant.get("payload", {}).get("reservationId")
        if reservation_id not in releases and reservation_id not in replaced_reservations:
            errors.append(f"reservation {reservation_id} missing resource:release")
        if reservation_id not in release_acks and reservation_id not in replaced_reservations:
            errors.append(f"reservation {reservation_id} missing resource:release-ack")
    if close_command is not None and not close_ack:
        errors.append("executor:close missing executor:close-ack")
    return errors

def recovery_contract_errors(registry: dict[str, Any], recovery_source_schema: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    actions = registry.get("actions", {})
    for action_key, policy in actions.items():
        commit = policy.get("commit", {})
        kind = commit.get("kind")
        receipt = commit.get("receiptKind")
        expected_intent = (
            kind == "worker-durable"
            or (kind == "main-settlement" and receipt == "target-post-image")
        )
        if commit.get("criticalIntent") is not expected_intent:
            errors.append(
                f"{action_key}: {kind}/{receipt} requires criticalIntent={str(expected_intent).lower()}"
            )
        if kind == "existing-critical-protocol" and commit.get("criticalIntent") is not False:
            errors.append(f"{action_key}: existing-critical-protocol must not create platform Critical Intent")

    seed = actions.get("statement:resolve-manual-balance", {}).get("commit", {})
    if seed.get("receiptKind") != "target-post-image" or seed.get("criticalIntent") is not True:
        errors.append("statement:resolve-manual-balance must use target-post-image with Main-owned critical intent")
    for action_key, policy in actions.items():
        if (
            policy.get("commit", {}).get("receiptKind") == "target-post-image"
            and policy.get("production", {}).get("enabled") is not False
        ):
            errors.append(
                f"{action_key}: target-post-image must remain production disabled before Windows durability probe"
            )

    expected_kinds = {
        "critical-intent", "publisher-journal", "target-post-image",
        "existing-protocol", "module-recovery",
    }
    actual_kinds = set(recovery_source_schema["properties"]["sourceKind"]["enum"])
    if actual_kinds != expected_kinds:
        errors.append(f"RecoverySourceV1 sourceKind drift: expected={sorted(expected_kinds)} actual={sorted(actual_kinds)}")

    contract_text = (CONTRACT_DIR / "platform-contract-v1.md").read_text(encoding="utf-8")
    tech_text = (CONTRACT_DIR / "E00-platform-contract-v1-techdoc.md").read_text(encoding="utf-8")
    lifecycle_text = (CONTRACT_DIR / "platform-lifecycle-mapping.md").read_text(encoding="utf-8")
    spec_text = (CONTRACT_DIR / "E00-platform-contract-v1-spec.md").read_text(encoding="utf-8")
    statement_text = (PACKAGE_ROOT / "changes/3.2.3/techdoc.md").read_text(encoding="utf-8")

    required_pairs = [
        (contract_text, "platform-recovery-source-v1.schema.json", "platform contract missing normative RecoverySourceV1 schema link"),
        (contract_text, "`existing-critical-protocol` | `false`", "platform contract missing existing-critical-protocol no-intent mapping"),
        (contract_text, "证据不足时保持 `blocked`", "platform contract permits ad-hoc intent around insufficient existing protocol"),
        (tech_text, "Inspector 是唯一判定权威", "E00 TechDoc has not frozen InspectorRegistry authority"),
        (tech_text, "MUST NOT 自行 inspect", "SettlementRecoveryProvider still has independent inspect authority"),
        (tech_text, "`recover(source, inspection)` 必须按 `(sourceKind, sourceRef, operationKey)` 幂等", "SettlementRecoveryProvider recovery idempotency is not frozen"),
        (tech_text, "Main-owned control DB", "E00 TechDoc has not frozen Main-owned persistence boundary"),
        (lifecycle_text, "prepared → running | failed | cancelled | interrupted", "lifecycle missing prepared terminal edges"),
        (lifecycle_text, "state=resolved, finalOutcome=succeeded", "lifecycle missing explicit Batch overlay mapping"),
        (statement_text, "criticalIntent = true", "Statement target-post-image intent semantics missing"),
        (statement_text, "不发送", "Statement main-owned intent must not use Worker critical handshake"),
    ]
    for source, needle, message in required_pairs:
        if needle not in source:
            errors.append(message)

    # RecoverySourceV1 must be defined once; TechDoc and lifecycle only reference the schema.
    docs = list(PACKAGE_ROOT.rglob("*.md"))
    inline_type_defs = []
    canonical_type_body = ""
    for path in docs:
        body = path.read_text(encoding="utf-8")
        if "type RecoverySourceV1 =" in body:
            inline_type_defs.append(str(path.relative_to(PACKAGE_ROOT)))
            match = re.search(r"type RecoverySourceV1 = \{(?P<body>.*?)\n\};", body, re.DOTALL)
            if match:
                canonical_type_body = match.group("body")
    if inline_type_defs != ["changes/background-execution/platform-contract-v1.md"]:
        errors.append(f"RecoverySourceV1 inline definition must exist only in platform-contract-v1.md, got {inline_type_defs}")
    expected_fields = {
        "contractVersion", "sourceKind", "sourceRef", "actionKey", "operationKey",
        "taskRunId", "conflictScopeKey", "inspectorKey", "settlementKey", "intentId",
        "evidenceVersion", "boundedEvidence",
    }
    actual_fields = set(re.findall(r"^\s{2}([A-Za-z][A-Za-z0-9]*):", canonical_type_body, re.MULTILINE))
    if actual_fields != expected_fields:
        errors.append(f"RecoverySourceV1 inline fields drift: expected={sorted(expected_fields)} actual={sorted(actual_fields)}")
    for legacy_field in ("intent", "receiptHint", "safeEvidence"):
        if re.search(rf"^\s{{2}}{re.escape(legacy_field)}:", canonical_type_body, re.MULTILINE):
            errors.append(f"RecoverySourceV1 canonical type contains legacy field {legacy_field}")

    provider_match = re.search(
        r"interface SettlementRecoveryProvider \{(?P<body>.*?)\n\}",
        tech_text,
        re.DOTALL,
    )
    if not provider_match:
        errors.append("SettlementRecoveryProvider interface missing")
    else:
        body = provider_match.group("body")
        if "inspect(" in body:
            errors.append("SettlementRecoveryProvider must not define inspect(); use InspectorRegistry")
        for required in ("listOpenSources()", "recover("):
            if required not in body:
                errors.append(f"SettlementRecoveryProvider missing {required}")

    startup_start = tech_text.find("## 11. Startup Recovery Coordinator")
    startup_end = tech_text.find("## 12.", startup_start + 1) if startup_start >= 0 else -1
    startup_text = tech_text[startup_start:startup_end if startup_end >= 0 else None] if startup_start >= 0 else ""
    for needle, message in (
        ("load active Recovery Holds", "startup recovery missing active hold scan"),
        ("load open Critical Intents", "startup recovery missing open intent scan"),
        ("provider.listOpenSources()", "startup recovery missing settlement-provider enumeration"),
        ("open publisher journals", "startup recovery missing publisher-journal enumeration"),
        ("normalize and deduplicate RecoverySourceV1", "startup recovery missing source normalization/deduplication"),
        ("manual` hold 不进入 InspectorRegistry", "startup recovery does not isolate manual holds from machine inspection"),
    ):
        if needle not in startup_text:
            errors.append(message)

    if "Critical Intent Store 放主库还是独立平台 DB | PROBE" in spec_text:
        errors.append("E00 Spec still leaves Platform Control Store as PROBE")
    return errors


def recovery_result_contract_errors(
    recovery_source_schema: dict[str, Any],
) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    defs = recovery_source_schema.get("$defs", {})
    expected_inspection_outcomes = {
        "committed", "not-committed", "partially-committed", "compensated", "unknown",
    }
    expected_settlement_outcomes = {
        "completed", "incomplete", "transient-failure", "terminal-failure",
    }
    for definition in ("RecoveryInspectionResultV1", "SettlementRecoveryResultV1"):
        if definition not in defs:
            errors.append(f"RecoverySource machine contract missing $defs.{definition}")

    if errors:
        return errors, {"validFixtureCount": 0, "invalidFixtures": [], "errors": errors}

    inspection_schema = {
        "$schema": recovery_source_schema["$schema"],
        "$defs": defs,
        "$ref": "#/$defs/RecoveryInspectionResultV1",
    }
    settlement_schema = {
        "$schema": recovery_source_schema["$schema"],
        "$defs": defs,
        "$ref": "#/$defs/SettlementRecoveryResultV1",
    }
    inspection_validator = Draft202012Validator(inspection_schema)
    settlement_validator = Draft202012Validator(settlement_schema)
    actual_inspection_outcomes = set(
        defs["RecoveryInspectionResultV1"]["properties"]["outcome"]["enum"]
    )
    actual_settlement_outcomes = set(
        defs["SettlementRecoveryResultV1"]["properties"]["outcome"]["enum"]
    )
    if actual_inspection_outcomes != expected_inspection_outcomes:
        errors.append("RecoveryInspectionResultV1 outcome enum drift")
    if actual_settlement_outcomes != expected_settlement_outcomes:
        errors.append("SettlementRecoveryResultV1 outcome enum drift")

    identity_fields = ("sourceKind", "sourceRef", "actionKey", "operationKey", "taskRunId")

    def semantic_errors(item: dict[str, Any]) -> list[str]:
        found: list[str] = []
        source = item["source"]
        inspection = item["inspection"]
        settlement = item["settlement"]
        for field in identity_fields:
            if inspection.get(field) != source.get(field):
                found.append(f"inspection {field} does not equal source")
            if settlement.get(field) != source.get(field):
                found.append(f"settlement {field} does not equal source")
        if settlement.get("settlementKey") != source.get("settlementKey"):
            found.append("settlementKey does not equal source")
        inspection_evidence = inspection.get("boundedEvidence")
        settlement_result = settlement.get("boundedResult")
        try:
            inspection_bytes = jcs_json_bytes(inspection_evidence)
            settlement_bytes = jcs_json_bytes(settlement_result)
        except (TypeError, ValueError) as exc:
            found.append(f"result contains non-canonical JSON-safe value: {exc}")
            return found
        if len(inspection_bytes) > 65536:
            found.append("inspection boundedEvidence exceeds 65536 UTF-8 bytes")
        if len(settlement_bytes) > 65536:
            found.append("settlement boundedResult exceeds 65536 UTF-8 bytes")
        if inspection.get("evidenceHash") != hashlib.sha256(inspection_bytes).hexdigest():
            found.append("inspection evidenceHash is not canonical SHA-256")
        if settlement.get("inspectionEvidenceHash") != inspection.get("evidenceHash"):
            found.append("settlement inspectionEvidenceHash mismatch")
        if settlement.get("resultHash") != hashlib.sha256(settlement_bytes).hexdigest():
            found.append("settlement resultHash is not canonical SHA-256")
        return found

    valid_items = load_json(VALID_RECOVERY_RESULT_PATH)
    for index, item in enumerate(valid_items):
        for err in json_errors(inspection_validator, item["inspection"]):
            errors.append(f"valid result[{index}] inspection {err}")
        for err in json_errors(settlement_validator, item["settlement"]):
            errors.append(f"valid result[{index}] settlement {err}")
        errors.extend(f"valid result[{index}] {err}" for err in semantic_errors(item))

    invalid_details: list[dict[str, Any]] = []
    base = valid_items[0]
    for fixture in load_json(INVALID_RECOVERY_RESULT_PATH):
        item = copy.deepcopy(base)
        mutation = fixture["mutation"]
        if mutation == "inspection-extra-field":
            item["inspection"]["extra"] = True
        elif mutation == "inspection-source-identity-mismatch":
            item["inspection"]["operationKey"] = "different-operation"
        elif mutation == "inspection-evidence-hash-mismatch":
            item["inspection"]["evidenceHash"] = "0" * 64
        elif mutation == "settlement-source-identity-mismatch":
            item["settlement"]["taskRunId"] = "different-task"
        elif mutation == "settlement-inspection-hash-mismatch":
            item["settlement"]["inspectionEvidenceHash"] = "0" * 64
        elif mutation == "settlement-result-hash-mismatch":
            item["settlement"]["resultHash"] = "0" * 64
        elif mutation == "transient-failure-without-retry":
            item["settlement"]["outcome"] = "transient-failure"
            item["settlement"]["safeError"] = {"code": "RETRY", "message": "retry"}
            item["settlement"]["retryAfterMs"] = None
        elif mutation == "terminal-failure-with-retry":
            item["settlement"]["outcome"] = "terminal-failure"
            item["settlement"]["safeError"] = {"code": "TERMINAL", "message": "terminal"}
            item["settlement"]["retryAfterMs"] = 1000
        elif mutation == "oversized-multibyte-evidence":
            item["inspection"]["boundedEvidence"] = {"value": "汉" * 22000}
            item["inspection"]["evidenceHash"] = jcs_json_sha256(
                item["inspection"]["boundedEvidence"]
            )
            item["settlement"]["inspectionEvidenceHash"] = item["inspection"]["evidenceHash"]
        else:
            errors.append(f"unknown invalid recovery result mutation: {mutation}")
        fixture_errors = (
            json_errors(inspection_validator, item["inspection"])
            + json_errors(settlement_validator, item["settlement"])
            + semantic_errors(item)
        )
        rejected = bool(fixture_errors)
        invalid_details.append({"fixture": fixture["name"], "rejected": rejected})
        if not rejected:
            errors.append(f"invalid recovery result unexpectedly passed: {fixture['name']}")

    tech_text = E00_TECHDOC_PATH.read_text(encoding="utf-8")
    lifecycle_text = LIFECYCLE_MAPPING_PATH.read_text(encoding="utf-8")
    for needle in (
        "provider 结果 identity/hash mismatch 必须 fail closed",
        "`completed` 才允许原子收口",
        "`incomplete` 保持 open/interrupted",
        "`SETTLEMENT_PROVIDER_UNAVAILABLE`",
        "不得重做业务 mutation",
        "register() 必须拒绝 freeze 后注册",
        "Main DB init → 构造并注册全部 inspectors/providers → freeze",
        "之后才允许 `initializeArchiveCenter()`",
        "`disposition=blocked-by-active-scope-hold`",
        "hold resolve 后必须重新枚举与 inspect",
        "reason=`DURABILITY_BARRIER_UNAVAILABLE` hold",
        "legacy `ArchiveOutboxStore` 吞 directory fsync 错误的行为不能作为平台 durability 证据",
    ):
        if needle not in tech_text:
            errors.append(f"E00 TechDoc missing recovery result/registry/startup rule: {needle}")
    if "`not-committed` 必须走 `interrupted → running(recovery) → failed`" not in lifecycle_text:
        errors.append("lifecycle missing conservative not-committed recovery failure mapping")
    if "startup recovery 不得写 `cancelled`" not in lifecycle_text:
        errors.append("lifecycle permits cancelled as startup recovery terminal")

    return errors, {
        "validFixtureCount": len(valid_items),
        "invalidFixtures": invalid_details,
        "inspectionOutcomes": sorted(actual_inspection_outcomes),
        "settlementOutcomes": sorted(actual_settlement_outcomes),
        "errors": errors,
    }

def invalid_fixture_results(
    policy_validator: Draft202012Validator,
    protocol_validator: Draft202012Validator,
    registry: dict[str, Any],
) -> tuple[list[str], list[dict[str, Any]]]:
    errors: list[str] = []
    details: list[dict[str, Any]] = []
    for path in sorted((FIXTURE_DIR / "invalid").glob("policy-*.json")):
        obj = load_json(path)
        schema_errors = json_errors(policy_validator, obj)
        semantic_errors = policy_semantic_errors(obj, load_json(STATIC_KEYS_PATH))
        rejected = bool(schema_errors or semantic_errors)
        details.append({"fixture": path.name, "rejected": rejected, "schemaErrors": len(schema_errors), "semanticErrors": len(semantic_errors)})
        if not rejected:
            errors.append(f"invalid policy fixture unexpectedly passed: {path.name}")
    protocol_invalid = load_json(FIXTURE_DIR / "invalid" / "protocol-messages.invalid.v1.json")
    for item in protocol_invalid:
        schema_errors = json_errors(protocol_validator, item["message"])
        semantic_errors = protocol_message_semantic_errors(item["message"], registry)
        rejection_layer = item.get("rejectionLayer", "schema")
        rejected = (
            bool(schema_errors) if rejection_layer == "schema"
            else not schema_errors and bool(semantic_errors)
        )
        details.append({
            "fixture": item["name"], "rejected": rejected,
            "schemaErrors": len(schema_errors), "semanticErrors": len(semantic_errors),
            "rejectionLayer": rejection_layer,
        })
        if not rejected:
            errors.append(
                f"invalid protocol fixture did not fail at {rejection_layer}: {item['name']}"
            )
    sequence_invalid = load_json(INVALID_PROTOCOL_SEQUENCE_PATH)
    required_service_seq_negatives = {
        "service-seq-gap", "service-seq-duplicate", "service-seq-backtrack",
        "service-event-seq-gap", "service-event-seq-duplicate",
        "service-event-seq-backtrack", "service-command-old-generation",
        "service-event-old-generation",
    }
    actual_service_seq_negatives = {item.get("name") for item in sequence_invalid}
    missing_service_seq_negatives = (
        required_service_seq_negatives - actual_service_seq_negatives
    )
    if missing_service_seq_negatives:
        errors.append(
            "missing per-direction Service seq negative fixtures: "
            f"{sorted(missing_service_seq_negatives)}"
        )
    for item in sequence_invalid:
        per_message_errors = [
            err
            for message in item["messages"]
            for err in json_errors(protocol_validator, message)
        ]
        semantic_message_errors = [
            err
            for message in item["messages"]
            for err in protocol_message_semantic_errors(message, registry)
        ]
        sequence_errors = protocol_sequence_errors(item["messages"], registry)
        # This fixture class is intentionally schema-valid and sequence-invalid.
        rejected = not per_message_errors and not semantic_message_errors and bool(sequence_errors)
        details.append({
            "fixture": item["name"],
            "rejected": rejected,
            "schemaErrors": len(per_message_errors),
            "semanticMessageErrors": len(semantic_message_errors),
            "sequenceErrors": len(sequence_errors),
        })
        if not rejected:
            errors.append(
                f"invalid protocol sequence did not fail only at semantic continuity: {item['name']} "
                f"schemaErrors={len(per_message_errors)} semanticMessageErrors={len(semantic_message_errors)} "
                f"sequenceErrors={len(sequence_errors)}"
            )
    return errors, details


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, default=REPORT_PATH)
    parser.add_argument("--no-write-report", action="store_true")
    authority_source = parser.add_mutually_exclusive_group(required=True)
    authority_source.add_argument(
        "--authority-mode",
        choices=("repo", "genesis"),
        help=(
            "repo reads merge-base authority; genesis still verifies merge-base absence "
            "inside Git and is non-merge-evidence outside Git"
        ),
    )
    authority_source.add_argument(
        "--previous-authority",
        type=Path,
        help="external previous authority; paths inside the current package are rejected",
    )
    parser.add_argument(
        "--previous-authority-sha256",
        help="optional lowercase SHA-256 expected for the exact external previous bytes",
    )
    parser.add_argument("--base-ref", default="origin/v3.2.0")
    args = parser.parse_args()
    espree_dependency = resolve_espree_dependency()
    previous_authority_context = resolve_previous_authority(args)
    report_target = args.report.resolve()
    if report_target != REPORT_PATH.resolve():
        try:
            report_target.relative_to(PACKAGE_ROOT.resolve())
        except ValueError:
            pass
        else:
            raise MachineJsonContractError(
                "VALIDATION_REPORT_TARGET_SCOPE_INVALID",
                "a custom validation report target must be outside the contract package",
            )
    if (
        not args.no_write_report
        and report_target == REPORT_PATH.resolve()
        and not (
            args.previous_authority is None
            and args.authority_mode == "repo"
            and args.base_ref == "origin/v3.2.0"
            and previous_authority_context.get("requestedAuthorityMode") == "repo"
            and previous_authority_context.get("mode") in {
                "repo-merge-base-genesis",
                "repo-merge-base-previous",
            }
        )
    ):
        raise MachineJsonContractError(
            "VALIDATION_CANONICAL_REPORT_PROVENANCE_REQUIRED",
            "the package validation report may only be generated in repo/default mode",
        )
    if report_target.is_file():
        previous_report = load_json(report_target)
    elif args.no_write_report:
        raise MachineJsonContractError(
            "VALIDATION_REPORT_TARGET_MISSING",
            "--no-write-report requires an existing report target",
        )
    else:
        previous_report = {}
    allow_report_bootstrap = not args.no_write_report
    expected_report_command = validation_command(args, previous_authority_context)

    checks: list[CheckResult] = []
    all_errors: list[str] = []

    policy_schema = load_json(POLICY_SCHEMA_PATH)
    protocol_schema = load_json(PROTOCOL_SCHEMA_PATH)
    recovery_source_schema = load_json(RECOVERY_SOURCE_SCHEMA_PATH)
    recovery_control_schema = load_json(RECOVERY_CONTROL_SCHEMA_PATH)
    schema_errors: list[str] = []
    for name, schema in (
        ("policy", policy_schema),
        ("protocol", protocol_schema),
        ("recovery-source", recovery_source_schema),
        ("recovery-control", recovery_control_schema),
    ):
        try:
            Draft202012Validator.check_schema(schema)
        except Exception as exc:  # pragma: no cover - diagnostic path
            schema_errors.append(f"{name} schema invalid: {exc}")
    checks.append(CheckResult("schema-meta-validation", not schema_errors, {"errors": schema_errors}))
    all_errors.extend(schema_errors)

    actual_jsonschema_version = importlib.metadata.version("jsonschema")
    runtime_errors = [] if actual_jsonschema_version == EXPECTED_JSONSCHEMA_VERSION else [
        f"jsonschema version must be {EXPECTED_JSONSCHEMA_VERSION}, got {actual_jsonschema_version}"
    ]
    if espree_dependency.get("version") != EXPECTED_ESPREE_VERSION:
        runtime_errors.append(
            f"espree version must be {EXPECTED_ESPREE_VERSION}, "
            f"got {espree_dependency.get('version')}"
        )
    checks.append(CheckResult("validation-runtime-version", not runtime_errors, {
        "expectedJsonschemaVersion": EXPECTED_JSONSCHEMA_VERSION,
        "actualJsonschemaVersion": actual_jsonschema_version,
        "expectedEspreeVersion": EXPECTED_ESPREE_VERSION,
        "actualEspreeVersion": espree_dependency.get("version"),
        "espreeResolutionMode": espree_dependency.get("resolutionMode"),
        "espreeModulePath": espree_dependency.get("reportPath"),
        "errors": runtime_errors,
    }))
    all_errors.extend(runtime_errors)

    machine_json_errors, machine_json_details = machine_json_input_contract_errors()
    checks.append(CheckResult(
        "machine-json-duplicate-and-authority-metadata-rejection",
        not machine_json_errors,
        machine_json_details,
    ))
    all_errors.extend(machine_json_errors)

    policy_validator = Draft202012Validator(policy_schema, format_checker=FormatChecker())
    protocol_validator = Draft202012Validator(protocol_schema, format_checker=FormatChecker())
    recovery_source_validator = Draft202012Validator(recovery_source_schema, format_checker=FormatChecker())

    registry = load_json(REGISTRY_FIXTURE_PATH)
    policy_errors = json_errors(policy_validator, registry)
    semantic_errors = policy_semantic_errors(registry, load_json(STATIC_KEYS_PATH))
    checks.append(CheckResult("full-policy-registry-schema", not policy_errors, {"actionCount": len(registry.get("actions", {})), "errors": policy_errors}))
    checks.append(CheckResult("full-policy-registry-semantic", not semantic_errors, {"errors": semantic_errors}))
    all_errors.extend(policy_errors + semantic_errors)

    manifest_errors = action_manifest_errors(registry)
    checks.append(CheckResult("action-manifest-registry-coverage", not manifest_errors, {"errors": manifest_errors}))
    all_errors.extend(manifest_errors)

    binding_errors, binding_details = action_binding_contract_errors(registry)
    checks.append(CheckResult(
        "canonical-action-legacy-task-binding",
        not binding_errors,
        binding_details,
    ))
    all_errors.extend(binding_errors)

    jcs_errors, jcs_details = jcs_contract_errors()
    checks.append(CheckResult("rfc8785-jcs-known-answer-vectors", not jcs_errors, jcs_details))
    all_errors.extend(jcs_errors)

    valid_messages = load_json(VALID_PROTOCOL_PATH)
    protocol_errors: list[str] = []
    for index, message in enumerate(valid_messages):
        for err in json_errors(protocol_validator, message):
            protocol_errors.append(f"message[{index}] {err}")
        for err in protocol_message_semantic_errors(message, registry):
            protocol_errors.append(f"message[{index}] semantic {err}")
    checks.append(CheckResult("protocol-valid-fixtures", not protocol_errors, {"messageCount": len(valid_messages), "errors": protocol_errors}))
    all_errors.extend(protocol_errors)

    protocol_policy_errors, protocol_policy_details = protocol_policy_contract_errors(
        policy_schema, protocol_schema, policy_validator, registry, valid_messages
    )
    checks.append(CheckResult(
        "protocol-policy-contract-drift",
        not protocol_policy_errors,
        protocol_policy_details,
    ))
    all_errors.extend(protocol_policy_errors)

    valid_recovery_sources = load_json(VALID_RECOVERY_SOURCE_PATH)
    recovery_source_errors: list[str] = []
    for index, source in enumerate(valid_recovery_sources):
        for err in json_errors(recovery_source_validator, source):
            recovery_source_errors.append(f"source[{index}] {err}")
        encoded = jcs_json_bytes(source.get("boundedEvidence", {}))
        if len(encoded) > 65536:
            recovery_source_errors.append(f"source[{index}] boundedEvidence exceeds 65536 bytes")
    checks.append(CheckResult(
        "recovery-source-valid-fixtures",
        not recovery_source_errors,
        {"sourceCount": len(valid_recovery_sources), "errors": recovery_source_errors},
    ))
    all_errors.extend(recovery_source_errors)

    invalid_recovery_sources = load_json(INVALID_RECOVERY_SOURCE_PATH)
    invalid_recovery_errors: list[str] = []
    invalid_recovery_details: list[dict[str, Any]] = []
    for item in invalid_recovery_sources:
        fixture_errors = json_errors(recovery_source_validator, item["source"])
        rejected = bool(fixture_errors)
        invalid_recovery_details.append({"fixture": item["name"], "rejected": rejected, "schemaErrors": len(fixture_errors)})
        if not rejected:
            invalid_recovery_errors.append(f"invalid recovery source unexpectedly passed: {item['name']}")
    checks.append(CheckResult(
        "recovery-source-invalid-fixtures-rejected",
        not invalid_recovery_errors,
        {"fixtures": invalid_recovery_details, "errors": invalid_recovery_errors},
    ))
    all_errors.extend(invalid_recovery_errors)

    valid_sequences = load_json(VALID_PROTOCOL_SEQUENCE_PATH)
    sequence_errors: list[str] = []
    for sequence in valid_sequences:
        per_message_errors = [
            err
            for message in sequence["messages"]
            for err in json_errors(protocol_validator, message)
        ]
        if per_message_errors:
            sequence_errors.extend(f"{sequence['name']}: schema {err}" for err in per_message_errors)
        sequence_errors.extend(
            f"{sequence['name']}: semantic {err}"
            for message in sequence["messages"]
            for err in protocol_message_semantic_errors(message, registry)
        )
        sequence_errors.extend(
            f"{sequence['name']}: {err}"
            for err in protocol_sequence_errors(sequence["messages"], registry)
        )
    independent_service_sequence = next(
        (
            sequence for sequence in valid_sequences
            if sequence.get("name") == "service-independent-direction-seq-with-revoke"
        ),
        None,
    )
    if independent_service_sequence is None:
        sequence_errors.append("missing valid Service independent-direction seq/revoke fixture")
    else:
        service_messages = independent_service_sequence["messages"]
        if not any(m.get("operation") == "resource:revoke" for m in service_messages):
            sequence_errors.append("independent-direction fixture missing resource:revoke")
        correlated_pairs = (
            ("resource:request", "resource:grant", "ctl-request-2"),
            ("resource:adopted", "resource:adopt-ack", "ctl-adopt-2"),
            ("resource:release", "resource:release-ack", "ctl-release-2"),
            ("executor:close", "executor:close-ack", "ctl-close"),
        )
        for event_op, command_op, control_id in correlated_pairs:
            pair = [
                m for m in service_messages
                if m.get("controlId") == control_id
                and m.get("operation") in {event_op, command_op}
            ]
            if len(pair) != 2:
                sequence_errors.append(
                    f"independent-direction fixture missing correlated pair {control_id}"
                )
            elif pair[0].get("seq") == pair[1].get("seq"):
                sequence_errors.append(
                    f"independent-direction fixture must prove non-echo seq for {control_id}"
                )
    checks.append(CheckResult(
        "protocol-resource-lifecycle-continuity",
        not sequence_errors,
        {"sequenceCount": len(valid_sequences), "errors": sequence_errors},
    ))
    all_errors.extend(sequence_errors)

    recovery_errors = recovery_contract_errors(registry, recovery_source_schema)
    checks.append(CheckResult("cross-document-recovery-contract", not recovery_errors, {"errors": recovery_errors}))
    all_errors.extend(recovery_errors)

    recovery_result_errors, recovery_result_details = recovery_result_contract_errors(
        recovery_source_schema
    )
    checks.append(CheckResult(
        "recovery-result-contract",
        not recovery_result_errors,
        recovery_result_details,
    ))
    all_errors.extend(recovery_result_errors)

    codex_errors, codex_details = codex_input_contract_errors(protocol_schema)
    checks.append(CheckResult("codex-input-contract-drift", not codex_errors, codex_details))
    all_errors.extend(codex_errors)

    execution_result_errors = execution_result_contract_errors()
    checks.append(CheckResult(
        "execution-result-contract-drift",
        not execution_result_errors,
        {"terminalSources": EXECUTION_TERMINAL_SOURCES, "errors": execution_result_errors},
    ))
    all_errors.extend(execution_result_errors)

    recovery_control_errors, recovery_control_details = recovery_control_contract_errors()
    checks.append(CheckResult(
        "recovery-control-transaction-contract-drift",
        not recovery_control_errors,
        recovery_control_details,
    ))
    all_errors.extend(recovery_control_errors)

    recovery_control_schema_errors, recovery_control_schema_details = (
        recovery_control_schema_contract_errors(recovery_control_schema)
    )
    checks.append(CheckResult(
        "recovery-control-exact-schema-and-hash-sensitivity",
        not recovery_control_schema_errors,
        recovery_control_schema_details,
    ))
    all_errors.extend(recovery_control_schema_errors)

    authority_errors, authority_details = contract_authority_anchor_errors(
        binding_details,
        recovery_control_schema_details,
        recovery_control_schema,
        previous_report,
        allow_report_bootstrap,
        previous_authority_context,
        expected_report_command,
    )
    checks.append(CheckResult(
        "contract-authority-anchor",
        not authority_errors,
        authority_details,
    ))
    all_errors.extend(authority_errors)

    negative_errors, negative_details = invalid_fixture_results(
        policy_validator, protocol_validator, registry
    )
    checks.append(CheckResult("negative-fixtures-rejected", not negative_errors, {"fixtures": negative_details, "errors": negative_errors}))
    all_errors.extend(negative_errors)

    table_errors, table_rows = action_table_errors()
    checks.append(CheckResult("version-action-table-canonical-values", not table_errors, {"rowCount": table_rows, "errors": table_errors}))
    all_errors.extend(table_errors)

    alignment_errors, compared_fields = action_table_registry_alignment_errors(registry)
    checks.append(CheckResult(
        "version-action-table-registry-alignment",
        not alignment_errors,
        {"comparedFieldCount": compared_fields, "errors": alignment_errors},
    ))
    all_errors.extend(alignment_errors)

    path_errors, ref_count = document_path_errors()
    checks.append(CheckResult("document-contract-paths", not path_errors, {"referenceCount": ref_count, "errors": path_errors}))
    all_errors.extend(path_errors)

    governor_errors = service_governor_boundary_errors()
    checks.append(CheckResult("service-main-governor-boundary", not governor_errors, {"errors": governor_errors}))
    all_errors.extend(governor_errors)

    required_errors = required_file_errors()
    checks.append(CheckResult("required-baseline-files", not required_errors, {"errors": required_errors}))
    all_errors.extend(required_errors)

    hygiene_errors = package_hygiene_errors()
    checks.append(CheckResult("package-hygiene", not hygiene_errors, {"errors": hygiene_errors}))
    all_errors.extend(hygiene_errors)

    contract_text = (CONTRACT_DIR / "platform-contract-v1.md").read_text(encoding="utf-8")
    lifecycle_text = (CONTRACT_DIR / "platform-lifecycle-mapping.md").read_text(encoding="utf-8")
    invariant_errors: list[str] = []
    for required_text in (
        "Service Control Envelope v1",
        "resource:request",
        "resource:grant",
        "PendingInteractionReservation",
        "Critical Intent Store",
        "platform-recovery-source-v1.schema.json",
        "仅 `worker-durable` 与 `main-settlement + target-post-image` 使用平台 Critical Intent",
        "`publisher-journal` 与 `existing-critical-protocol` 不创建平台 Intent",
    ):
        if required_text not in contract_text:
            invariant_errors.append(f"platform contract missing {required_text}")
    for required_text in (
        "prepared",
        "interrupted → running(recovery)",
        "Option B（冻结）",
        "Append-only recovery events（MUST）",
        "publisher-journal",
        "target-post-image",
        "prepared → running | failed | cancelled | interrupted",
    ):
        if required_text not in lifecycle_text:
            invariant_errors.append(f"lifecycle mapping missing {required_text}")
    checks.append(CheckResult("normative-text-invariants", not invariant_errors, {"errors": invariant_errors}))
    all_errors.extend(invariant_errors)

    codex_ready_manifest = load_json(CODEX_READY_MANIFEST_PATH)
    expected_runtime_check_count = len(checks) + 1
    metadata_errors: list[str] = []
    manifest_expected_check_count = codex_ready_manifest.get("validation", {}).get(
        "expectedCheckCount"
    )
    if manifest_expected_check_count != expected_runtime_check_count:
        metadata_errors.append(
            "codex-ready manifest expectedCheckCount/runtime drift: "
            f"manifest={manifest_expected_check_count} runtime={expected_runtime_check_count}"
        )
    if (
        f"Validation README enumerates all {expected_runtime_check_count} executable gates"
        not in codex_ready_manifest.get("targetedClosures", [])
    ):
        metadata_errors.append("codex-ready manifest human-readable gate count drift")
    manifest_validation = codex_ready_manifest.get("validation", {})
    if manifest_validation.get("contractAuthorityCheck") != "contract-authority-anchor":
        metadata_errors.append("codex-ready manifest contract authority gate name drift")
    if codex_ready_manifest.get("manifestVersion") != 10:
        metadata_errors.append("codex-ready manifest version drift")
    if manifest_validation.get("validationReportVersion") != REPORT_VERSION:
        metadata_errors.append("codex-ready manifest validation report version drift")
    if manifest_validation.get("publishedValidationReportAuthorityMode") != "repo/default":
        metadata_errors.append("codex-ready manifest published report mode drift")
    if manifest_validation.get("publishedValidationReportPath") != "validation-report.json":
        metadata_errors.append("codex-ready manifest published report path drift")
    if manifest_validation.get("canonicalReportCommand") != (
        "PYTHON_BIN=<python3> changes/background-execution/validation/"
        "run-validation.sh --authority-mode repo --base-ref origin/v3.2.0"
    ):
        metadata_errors.append("codex-ready manifest canonical report command drift")
    runtime_manifest_counts = {
        "contractAuthorityContractVersion": authority_details.get("contractVersion"),
        "contractAuthorityRevision": authority_details.get("revision"),
        "genesis": authority_details.get("genesis"),
        "approvalStatus": authority_details.get("approvalStatus"),
        "mergeReady": authority_details.get("trustModel", {}).get("mergeReady"),
        "productionEnablementAllowed": authority_details.get("trustModel", {}).get(
            "productionEnablementAllowed"
        ),
        "contractAuthorityFutureRevisionMutationCount": len(
            authority_details.get("futureRevisionMutationResults", {})
        ),
        "contractAuthorityCoordinatedMutationCount": len(
            authority_details.get("coordinatedMutationResults", {})
        ),
        "contractAuthorityExternalPreviousAuditCount": len(
            authority_details.get("externalPreviousAuditResults", {})
        ),
        "contractAuthorityGenesisCliMutationCount": len(
            authority_details.get("genesisCliMutationResults", {})
        ),
        "contractAuthorityReportProvenanceMutationCount": len(
            authority_details.get("reportProvenanceMutationResults", {})
        ),
        "machineJsonDuplicateMutationCount": len(
            machine_json_details.get("duplicateMutationResults", {})
        ),
        "authorityPositiveIntegerMutationCount": len(
            machine_json_details.get("positiveIntegerMutationResults", {})
        ),
        "recoveryControlNegativeSelfTestCount": len(
            recovery_control_details.get("negativeSelfTests", [])
        ),
        "recoveryControlSchemaMutationClassCount": recovery_control_schema_details.get(
            "invalidMutationClassCount"
        ),
        "recoveryControlSchemaMutationAssertionCount": recovery_control_schema_details.get(
            "mutationAssertionCount"
        ),
        "recoveryControlRequiredDeletionAssertionCount": recovery_control_schema_details.get(
            "requiredDeletionAssertionCount"
        ),
        "recoveryControlInventoryMutationCount": len(
            [
                item for item in recovery_control_schema_details.get("mutationResults", [])
                if str(item.get("name", "")).startswith("schema-delete-")
            ]
        ),
        "recoveryControlTransitionBranchCount": recovery_control_schema_details.get(
            "validTransitionBranchCount"
        ),
        "recoveryControlObservationBranchCount": recovery_control_schema_details.get(
            "validObservationBranchCount"
        ),
        "recoveryControlRequestCount": (
            recovery_control_schema_details.get("validTransitionBranchCount", 0)
            + recovery_control_schema_details.get("validObservationBranchCount", 0)
        ),
        "recoveryControlImmutableResultCount": recovery_control_schema_details.get(
            "validResultCount"
        ),
        "recoveryControlLeafSensitivityAssertionCount": recovery_control_schema_details.get(
            "fullEnvelopeLeafSensitivityAssertionCount"
        ),
        "recoveryControlObservationOptionalStateAssertionCount": recovery_control_schema_details.get(
            "observationOptionalStateAssertionCount"
        ),
        "recoveryResultProjectionFieldCount": recovery_control_schema_details.get(
            "resultProjectionContract", {}
        ).get("projectionFieldCount"),
        "recoveryResultRequestProjectionCount": recovery_control_schema_details.get(
            "resultProjectionContract", {}
        ).get("requestProjectionCount"),
        "recoveryResultKnownAnswerCount": recovery_control_schema_details.get(
            "resultProjectionContract", {}
        ).get("knownAnswerContract", {}).get("knownAnswerCount"),
        "recoveryResultKnownAnswerSha256": recovery_control_schema_details.get(
            "resultProjectionContract", {}
        ).get("knownAnswerContract", {}).get("sha256"),
        "recoveryResultKnownAnswerComparisonCount": recovery_control_schema_details.get(
            "resultProjectionContract", {}
        ).get("knownAnswerComparisonCount"),
        "recoveryResultKnownAnswerMutationCount": len(
            recovery_control_schema_details.get("resultProjectionContract", {}).get(
                "knownAnswerMutationResults", {}
            )
        ),
        "recoveryResultSqliteRoundTripCount": recovery_control_schema_details.get(
            "resultProjectionContract", {}
        ).get("sqliteRoundTripCount"),
        "recoveryResultFieldMutationCount": recovery_control_schema_details.get(
            "resultProjectionContract", {}
        ).get("fieldMutationCount"),
        "recoveryResultOwnerMutationCount": recovery_control_schema_details.get(
            "resultProjectionContract", {}
        ).get("ownerMutationCount"),
        "recoveryResultMutationSqliteRoundTripCount": sum(
            1
            for key in ("fieldMutationResults", "ownerMutationResults")
            for item in recovery_control_schema_details.get(
                "resultProjectionContract", {}
            ).get(key, [])
            if item.get("sqliteRoundTrip") is True
        ),
        "recoveryOwnerImmutableProjectionComparisonCount": sum(
            recovery_control_details.get("ownerDdlExecution", {})
            .get(section, {})
            .get("projectionComparedFieldCount", 0)
            for section in ("lifecycle", "observationLifecycle")
        ),
        "recoveryObservationAttemptLifecycleCount": len(
            recovery_control_schema_details.get("observationAttemptLifecycleResults", [])
        ),
        "recoveryObservationRetryScenarioCount": len(
            recovery_control_schema_details.get("observationRetryScenarioResults", [])
        ),
        "recoveryHoldCollisionScenarioCount": len(
            recovery_control_schema_details.get("holdSourceCollisionScenarioResults", [])
        ),
        "recoveryRequestKeyBranchCount": recovery_control_schema_details.get(
            "requestKeyContract", {}
        ).get("branchCount"),
        "recoveryOwnerEventEqualityFieldCount": len(
            recovery_control_details.get("ownerDdlExecution", {}).get(
                "eventOwnerEqualityFields", []
            )
        ),
        "recoveryPhysicalSqlStatementCount": recovery_control_details.get(
            "physicalSqlContract", {}
        ).get("statementCount"),
        "recoveryResultCrossDtoMutationCount": len(
            recovery_control_schema_details.get("crossResultDtoMutationResults", {})
        ),
        "recoveryCanonicalSha1InjectionCount": len(
            recovery_control_schema_details.get("sha1SchemaMutationResults", [])
        ),
        "jcsKnownAnswerCount": jcs_details.get("canonicalCaseCount"),
        "jcsRuntimeRejectionCount": jcs_details.get("runtimeRejectionCaseCount"),
        "jcsRawInputCaseCount": jcs_details.get("rawInputCaseCount"),
        "jcsRuntimeGuardMutationCount": len(
            jcs_details.get("runtimeGuardMutationResults", [])
        ),
        "taskPolicyInventoryCount": binding_details.get("hardCounts", {}).get(
            "expectedTaskPolicyInventoryCount"
        ),
        "taskPolicyInventoryJcsSha256": binding_details.get(
            "taskPolicyInventoryJcsSha256"
        ),
        "actionTaskBindingHostileApiCaseCount": len(
            binding_details.get("hostileApiResults", {})
        ),
        "actionTaskBindingStartupAstMutationCount": len(
            binding_details.get("startupAstMutationResults", {})
        ),
        "canonicalLegacyBindingPairCount": binding_details.get("hardCounts", {}).get(
            "expectedPairCount"
        ),
        "canonicalLegacyBindingProvenanceCount": binding_details.get("hardCounts", {}).get(
            "expectedProvenanceCount"
        ),
        "espreeVersion": espree_dependency.get("version"),
    }
    for key, runtime_value in runtime_manifest_counts.items():
        if manifest_validation.get(key) != runtime_value:
            metadata_errors.append(
                f"codex-ready manifest {key} drift: "
                f"manifest={manifest_validation.get(key)} runtime={runtime_value}"
            )
    validation_readme = VALIDATION_README_PATH.read_text(encoding="utf-8")
    enumerated_gates = [
        int(value)
        for value in re.findall(r"^(\d+)\. `[^`]+`：", validation_readme, re.MULTILINE)
    ]
    if enumerated_gates != list(range(1, expected_runtime_check_count + 1)):
        metadata_errors.append(
            f"Validation README executable gate enumeration drift: {enumerated_gates!r}"
        )
    if f"## {expected_runtime_check_count} 项实际检查" not in validation_readme:
        metadata_errors.append("Validation README gate-count heading drift")
    package_readme = PACKAGE_README_PATH.read_text(encoding="utf-8")
    if f"`{expected_runtime_check_count}/{expected_runtime_check_count} PASS`" not in package_readme:
        metadata_errors.append("package README gate-count summary drift")
    previous_summary = previous_report.get("summary", {})
    if not allow_report_bootstrap and (
        previous_report.get("status") != "PASS"
        or previous_summary.get("checkCount") != expected_runtime_check_count
        or previous_summary.get("passed") != expected_runtime_check_count
        or previous_summary.get("failed") != 0
    ):
        metadata_errors.append("validation report gate-count/status drift")

    hash_suffixes = {".js", ".md", ".json", ".py", ".sh", ".txt"}
    excluded_hash_paths = {
        args.report.resolve(),
        (PACKAGE_ROOT / "validation-report.json").resolve(),
        (PACKAGE_ROOT / "PACKAGE-SHA256SUMS.txt").resolve(),
    }
    files_to_hash = sorted(
        p for p in PACKAGE_ROOT.rglob("*")
        if p.is_file()
        and p.suffix.lower() in hash_suffixes
        and p.resolve() not in excluded_hash_paths
    )
    # Conservative coverage: every Markdown/JSON/Python/Shell/text input in the package is hashed.
    # All documents/fixtures read by this validator are a subset of this list.
    validation_read_inputs = [str(p.relative_to(PACKAGE_ROOT)) for p in files_to_hash]
    current_input_hashes = {
        str(p.relative_to(PACKAGE_ROOT)): sha256_file(p) for p in files_to_hash
    }
    report_read_inputs_matched = (
        previous_report.get("validationReadInputs") == validation_read_inputs
    )
    report_input_hashes_matched = (
        previous_report.get("inputHashes") == current_input_hashes
    )
    if not allow_report_bootstrap and not report_read_inputs_matched:
        metadata_errors.append("validation report read-input inventory drift")
    if not allow_report_bootstrap and not report_input_hashes_matched:
        metadata_errors.append("validation report input hash evidence drift")
    hash_coverage_errors = list(metadata_errors)
    for required_path in (
        CODEX_SPEC_PATH, CODEX_TECHDOC_PATH, PLATFORM_CONTRACT_PATH, E00_SPEC_PATH,
        E00_TECHDOC_PATH, LIFECYCLE_MAPPING_PATH,
        POLICY_SCHEMA_PATH, PROTOCOL_SCHEMA_PATH, RECOVERY_SOURCE_SCHEMA_PATH,
        RECOVERY_CONTROL_SCHEMA_PATH,
        REGISTRY_FIXTURE_PATH, STATIC_KEYS_PATH, ACTION_MANIFEST_PATH,
        VALID_PROTOCOL_PATH, VALID_PROTOCOL_SEQUENCE_PATH, INVALID_PROTOCOL_SEQUENCE_PATH,
        VALID_RECOVERY_SOURCE_PATH, INVALID_RECOVERY_SOURCE_PATH,
        VALID_RECOVERY_RESULT_PATH, INVALID_RECOVERY_RESULT_PATH,
        VALID_RECOVERY_CONTROL_PATH, INVALID_RECOVERY_CONTROL_PATH,
        JCS_VECTOR_PATH, JCS_SCRIPT_PATH, CONTRACT_AUTHORITY_PATH,
    ):
        if required_path.resolve() not in {p.resolve() for p in files_to_hash}:
            hash_coverage_errors.append(
                f"validation input is not covered by inputHashes: {required_path.relative_to(PACKAGE_ROOT)}"
            )
    checks.append(CheckResult(
        "validation-input-hash-coverage",
        not hash_coverage_errors,
        {
            "inputCount": len(validation_read_inputs),
            "expectedCheckCount": expected_runtime_check_count,
            "manifestExpectedCheckCount": manifest_expected_check_count,
            "validationReadmeEnumeratedGateCount": len(enumerated_gates),
            "defaultReportCheckCount": previous_summary.get("checkCount"),
            "reportReadInputsMatched": (
                report_read_inputs_matched or allow_report_bootstrap
            ),
            "reportInputHashesMatched": (
                report_input_hashes_matched or allow_report_bootstrap
            ),
            "errors": hash_coverage_errors,
        },
    ))
    all_errors.extend(hash_coverage_errors)

    report = {
        "reportVersion": REPORT_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "PASS" if not all_errors else "FAIL",
        "command": expected_report_command,
        "pythonVersion": sys.version.split()[0],
        "jsonschemaVersion": importlib.metadata.version("jsonschema"),
        "espreeDependency": {
            "expectedVersion": espree_dependency.get("expectedVersion"),
            "version": espree_dependency.get("version"),
            "resolutionMode": espree_dependency.get("resolutionMode"),
            "modulePath": espree_dependency.get("reportPath"),
        },
        "packageRoot": ".",
        "contractAuthority": authority_details.get("reportProjection"),
        "authorityTrust": {
            "source": authority_details.get("previousAuthoritySource"),
            **authority_details.get("trustModel", {}),
        },
        "checks": [asdict(c) for c in checks],
        "summary": {
            "checkCount": len(checks),
            "passed": sum(1 for c in checks if c.passed),
            "failed": sum(1 for c in checks if not c.passed),
            "errorCount": len(all_errors),
            "actionPolicyCount": len(registry.get("actions", {})),
            "validProtocolMessageCount": len(valid_messages),
            "validProtocolSequenceCount": len(valid_sequences),
            "actionTableRowCount": table_rows,
            "documentContractReferenceCount": ref_count,
            "validRecoverySourceCount": len(valid_recovery_sources),
            "validRecoveryTransitionBranchCount": len(
                load_json(VALID_RECOVERY_CONTROL_PATH)["transitionRequests"]
            ),
            "validRecoveryObservationBranchCount": len(
                load_json(VALID_RECOVERY_CONTROL_PATH)["observationRequests"]
            ),
            "hashedInputFileCount": len(files_to_hash),
            "validationReadInputCount": len(validation_read_inputs),
        },
        "validationReadInputs": validation_read_inputs,
        "inputHashes": current_input_hashes,
        "errors": all_errors,
    }
    if not args.no_write_report:
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], **report["summary"]}, ensure_ascii=False, indent=2))
    if all_errors:
        for err in all_errors:
            print(f"ERROR: {err}", file=sys.stderr)
        return 1
    return 0


def run_validator_fail_closed() -> int:
    """Return stable machine-readable FAIL output for malformed/deleted inputs."""
    try:
        return main()
    except Exception as exc:  # noqa: BLE001 - validator inputs must fail closed
        failure = {
            "status": "FAIL",
            "checkCount": 0,
            "passed": 0,
            "failed": 1,
            "errorCount": 1,
            "failure": {
                "code": "VALIDATION_INPUT_CONTRACT_ERROR",
                "inputCode": getattr(exc, "code", "UNCLASSIFIED_INPUT_ERROR"),
                "exceptionType": type(exc).__name__,
            },
        }
        print(json.dumps(failure, ensure_ascii=False, indent=2))
        print(
            "ERROR: VALIDATION_INPUT_CONTRACT_ERROR: "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(run_validator_fail_closed())
