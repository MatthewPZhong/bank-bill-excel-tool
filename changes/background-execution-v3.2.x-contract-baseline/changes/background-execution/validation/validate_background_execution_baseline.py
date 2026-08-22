#!/usr/bin/env python3
"""Reproducible contract validation for the v3.2.x background-execution baseline."""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.metadata
import json
import re
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from jsonschema import Draft202012Validator, FormatChecker

HERE = Path(__file__).resolve().parent
CONTRACT_DIR = HERE.parent
PACKAGE_ROOT = CONTRACT_DIR.parent.parent
REPORT_PATH = PACKAGE_ROOT / "validation-report.json"
FIXTURE_DIR = HERE / "fixtures"
POLICY_SCHEMA_PATH = CONTRACT_DIR / "platform-contract-v1.schema.json"
PROTOCOL_SCHEMA_PATH = CONTRACT_DIR / "platform-protocol-v1.schema.json"
RECOVERY_SOURCE_SCHEMA_PATH = CONTRACT_DIR / "platform-recovery-source-v1.schema.json"
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
CODEX_SPEC_PATH = PACKAGE_ROOT / "CODEX-SPEC.md"
CODEX_TECHDOC_PATH = PACKAGE_ROOT / "CODEX-TECHDOC.md"
PLATFORM_CONTRACT_PATH = CONTRACT_DIR / "platform-contract-v1.md"
E00_TECHDOC_PATH = CONTRACT_DIR / "E00-platform-contract-v1-techdoc.md"
E00_SPEC_PATH = CONTRACT_DIR / "E00-platform-contract-v1-spec.md"
LIFECYCLE_MAPPING_PATH = CONTRACT_DIR / "platform-lifecycle-mapping.md"
EXPECTED_JSONSCHEMA_VERSION = "4.26.0"
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


@dataclass
class CheckResult:
    name: str
    passed: bool
    details: dict[str, Any]


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def json_errors(validator: Draft202012Validator, instance: Any) -> list[str]:
    errors = sorted(validator.iter_errors(instance), key=lambda e: [str(x) for x in e.absolute_path])
    return [f"/{'/'.join(str(x) for x in e.absolute_path)}: {e.message}" for e in errors]


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def canonical_json_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


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
        "codex-ready-revision-manifest.json",
        "implementation-notes.md",
        "implementation-sequence.md",
        "changes/background-execution/platform-contract-v1.md",
        "changes/background-execution/platform-contract-v1.schema.json",
        "changes/background-execution/platform-protocol-v1.schema.json",
        "changes/background-execution/platform-recovery-source-v1.schema.json",
        "changes/background-execution/platform-lifecycle-mapping.md",
        "changes/background-execution/E00-platform-contract-v1-spec.md",
        "changes/background-execution/E00-platform-contract-v1-techdoc.md",
        "changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json",
        "changes/background-execution/validation/fixtures/valid/action-manifest.v3.2.x.json",
        "changes/background-execution/validation/fixtures/valid/recovery-sources.v1.json",
        "changes/background-execution/validation/fixtures/invalid/recovery-sources.invalid.v1.json",
        "changes/background-execution/validation/fixtures/valid/recovery-results.v1.json",
        "changes/background-execution/validation/fixtures/invalid/recovery-results.invalid.v1.json",
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
        for required_identity_field in (
            "actionKey", "operationKey", "taskRunId", "sourceKind", "sourceRef",
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
        actual_commands = set(re.findall(r"command: '([^']+)'", union_match.group("body")))
        if actual_commands != expected_commands:
            errors.append(
                f"{union_name} command drift: expected={sorted(expected_commands)} "
                f"actual={sorted(actual_commands)}"
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
            "action_key TEXT NOT NULL",
            "operation_key TEXT NOT NULL",
            "task_run_id TEXT NOT NULL",
            "source_kind TEXT",
            "source_ref TEXT",
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
    for required_runtime_rule in (
        "回调不得返回 Promise",
        "不得嵌套调用另一个 `runInControlTransaction()`",
        "不得跨 `await inspector()` 或 `await provider.recover()` 持有 SQLite control transaction",
        "Batch overlay 只允许 `absent → interrupted → recovering → resolved`",
        "基础 `task_status` 写为兼容值 `failed`、创建 overlay `interrupted` 并追加 `batch-overlay-transitioned`",
        "Hold-create eventId 必须由 Main 按 `(sourceKind, sourceRef, 'hold-created')` 稳定派生",
        "`recover(source, inspection)` 必须按 `(sourceKind, sourceRef, operationKey)` 幂等",
        "`archive_task_runs.task_key === expectedTaskKey`",
        "`archive_task_runs.operation_key === operationKey`",
        "event.action_key 记录经 adapter 验证的 canonical actionKey",
        "source 只有一项为 null 均 fail closed",
        "真实持久枚举始终写 `interrupted → running`",
        "`safePayload` 只记录 writer 完成后的 bounded 审计结果",
        "`toStatus='succeeded'` 时 API 必须拒绝 `failureCode/failureMessage`",
        "canonical JSON（UTF-8、递归 key 排序、无 undefined/非有限数/循环）",
        "最大 16384 bytes",
        "不含完整业务行或账号",
        "status 固定由 Repository 写为 `active`",
        "`Resolution` 精确为 `committed | not-committed | compensated | manual-override`",
        "not-committed + cancelled → cancelled（仅限 live execution 在进入 critical/protected 前，由 normal TaskLifecycle 完成）",
        "上述 cancelled 映射不适用于 startup/transport-loss recovery",
    ):
        if required_runtime_rule not in e00_text:
            errors.append(f"E00 TechDoc missing transaction runtime rule: {required_runtime_rule}")

    return errors


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

    canonical_boundary_tests: list[dict[str, Any]] = []
    for name, value, expected_size in (
        ("ascii-exact-16384", {"v": "a" * 16376}, 16384),
        ("multibyte-exact-16384", {"v": "汉" * 5458 + "aa"}, 16384),
    ):
        actual_size = len(canonical_json_bytes(value))
        passed = actual_size == expected_size
        canonical_boundary_tests.append(
            {"name": name, "expectedBytes": expected_size, "actualBytes": actual_size, "passed": passed}
        )
        if not passed:
            errors.append(f"canonical JSON byte boundary self-test failed: {name}")
    try:
        canonical_json_bytes({"v": float("nan")})
        non_finite_rejected = False
    except (TypeError, ValueError):
        non_finite_rejected = True
    canonical_boundary_tests.append({"name": "non-finite", "rejected": non_finite_rejected})
    if not non_finite_rejected:
        errors.append("canonical JSON invalid-value self-test failed: non-finite")
    cyclic: dict[str, Any] = {}
    cyclic["self"] = cyclic
    try:
        canonical_json_bytes(cyclic)
        cycle_rejected = False
    except (TypeError, ValueError):
        cycle_rejected = True
    canonical_boundary_tests.append({"name": "cycle", "rejected": cycle_rejected})
    if not cycle_rejected:
        errors.append("canonical JSON invalid-value self-test failed: cycle")

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
            "event_id TEXT NOT NULL UNIQUE,\n  action_key TEXT NOT NULL",
            "event_id TEXT NOT NULL UNIQUE,\n  action_key TEXT",
            1,
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
            1,
        ),
        "operation-key-cas-removed": e00_tech_text.replace(
            "`archive_task_runs.operation_key === operationKey`",
            "`operationKey === operationKey`",
            1,
        ),
        "task-source-pair-removed": e00_tech_text.replace(
            "sourceRef: string | null; expectedState: 'prepared' | 'running'",
            "expectedState: 'prepared' | 'running'",
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


def canonical_job_ref(message: dict[str, Any]) -> str:
    return json.dumps(message.get("jobRef"), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_utf8_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))


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

    start = copy.deepcopy(next(
        message for message in valid_messages
        if message.get("channel") == "job" and message.get("operation") == "job:start"
    ))
    start["payload"] = {"input": {"text": ""}}
    remaining = PLATFORM_PROTOCOL_MAX_BYTES - json_utf8_size(start)
    boundary_results = {"remainingAsciiBytes": remaining}
    if remaining <= 0:
        errors.append("protocol byte boundary fixture has no payload headroom")
    else:
        start["payload"]["input"]["text"] = "x" * remaining
        boundary_results["exactBytes"] = json_utf8_size(start)
        if protocol_message_semantic_errors(start, registry):
            errors.append("exact UTF-8 byte ceiling was rejected")
        start["payload"]["input"]["text"] = "x" * (remaining - 1) + "界"
        boundary_results["multibyteOverBytes"] = json_utf8_size(start)
        if not any("exceeds" in err for err in protocol_message_semantic_errors(start, registry)):
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

    def job_ref_key(message: dict[str, Any]) -> str:
        return json.dumps(message.get("jobRef"), ensure_ascii=False, sort_keys=True, separators=(",", ":"))

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
            owner_key = json.dumps(
                {"kind": owner.get("kind"), "ownerKeyHash": owner.get("ownerKeyHash")},
                ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            )
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
            owner_key = json.dumps(
                {"kind": owner.get("kind"), "ownerKeyHash": owner.get("ownerKeyHash")},
                ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            )
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
            inspection_bytes = canonical_json_bytes(inspection_evidence)
            settlement_bytes = canonical_json_bytes(settlement_result)
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
            item["inspection"]["evidenceHash"] = canonical_json_sha256(
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
    args = parser.parse_args()

    checks: list[CheckResult] = []
    all_errors: list[str] = []

    policy_schema = load_json(POLICY_SCHEMA_PATH)
    protocol_schema = load_json(PROTOCOL_SCHEMA_PATH)
    recovery_source_schema = load_json(RECOVERY_SOURCE_SCHEMA_PATH)
    schema_errors: list[str] = []
    for name, schema in (("policy", policy_schema), ("protocol", protocol_schema), ("recovery-source", recovery_source_schema)):
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
    checks.append(CheckResult("validation-runtime-version", not runtime_errors, {
        "expectedJsonschemaVersion": EXPECTED_JSONSCHEMA_VERSION,
        "actualJsonschemaVersion": actual_jsonschema_version,
        "errors": runtime_errors,
    }))
    all_errors.extend(runtime_errors)

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
        encoded = json.dumps(source.get("boundedEvidence", {}), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
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

    hash_suffixes = {".md", ".json", ".py", ".sh", ".txt"}
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
    hash_coverage_errors = []
    for required_path in (
        CODEX_SPEC_PATH, CODEX_TECHDOC_PATH, PLATFORM_CONTRACT_PATH, E00_SPEC_PATH,
        E00_TECHDOC_PATH, LIFECYCLE_MAPPING_PATH,
        POLICY_SCHEMA_PATH, PROTOCOL_SCHEMA_PATH, RECOVERY_SOURCE_SCHEMA_PATH,
        REGISTRY_FIXTURE_PATH, STATIC_KEYS_PATH, ACTION_MANIFEST_PATH,
        VALID_PROTOCOL_PATH, VALID_PROTOCOL_SEQUENCE_PATH, INVALID_PROTOCOL_SEQUENCE_PATH,
        VALID_RECOVERY_SOURCE_PATH, INVALID_RECOVERY_SOURCE_PATH,
        VALID_RECOVERY_RESULT_PATH, INVALID_RECOVERY_RESULT_PATH,
    ):
        if required_path.resolve() not in {p.resolve() for p in files_to_hash}:
            hash_coverage_errors.append(
                f"validation input is not covered by inputHashes: {required_path.relative_to(PACKAGE_ROOT)}"
            )
    checks.append(CheckResult(
        "validation-input-hash-coverage",
        not hash_coverage_errors,
        {"inputCount": len(validation_read_inputs), "errors": hash_coverage_errors},
    ))
    all_errors.extend(hash_coverage_errors)

    report = {
        "reportVersion": 9,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "PASS" if not all_errors else "FAIL",
        "command": "PYTHON_BIN=<python3> changes/background-execution/validation/run-validation.sh",
        "pythonVersion": sys.version.split()[0],
        "jsonschemaVersion": importlib.metadata.version("jsonschema"),
        "packageRoot": ".",
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
            "hashedInputFileCount": len(files_to_hash),
            "validationReadInputCount": len(validation_read_inputs),
        },
        "validationReadInputs": validation_read_inputs,
        "inputHashes": {str(p.relative_to(PACKAGE_ROOT)): sha256_file(p) for p in files_to_hash},
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


if __name__ == "__main__":
    raise SystemExit(main())
