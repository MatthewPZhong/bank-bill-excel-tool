"""只读核对本轮门禁和保护证据，摘要写入本目录。"""
import hashlib
import json
from pathlib import Path
import re
import subprocess

EVIDENCE = Path(__file__).resolve().parent
ROOT = EVIDENCE.parents[3]
PRIMARY = ROOT.parents[2]


def read(name):
    return json.loads((EVIDENCE / name).read_text())


def save(name, value):
    (EVIDENCE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def verify(base, items):
    return {"files": len(items), "changed": [
        name for name, digest in items.items()
        if not (base / name).is_file()
        or hashlib.sha256((base / name).read_bytes()).hexdigest() != digest
    ]}


def head(root):
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()


gate = read("release-check-result.json")
assert gate["exitCode"] == 0 and not gate["changedInputs"] and gate["headAfter"] == gate["head"], gate
log = (EVIDENCE / "release-check.log").read_text()
unit = {name: int(re.search(r"^ℹ " + name + r" (\d+)$", log, re.M)[1])
        for name in ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"]}
assert unit["fail"] == unit["cancelled"] == 0
integrations = []
for match in re.finditer(r"^\[integration\] ▶ (.*?) \.\.\. PASS (?:(\d+)/(\d+)|\(no count\)) \((\d+)ms\)$", log, re.M):
    name, passed, total, duration = match.groups()
    integrations.append({"name": name, "passed": int(passed) if passed else None,
                         "total": int(total) if total else None, "durationMs": int(duration)})
assert len(integrations) == 68 and "全部 68 个集成脚本通过" in log
initial = read("input-manifest.json")["sha256"]
prior = json.loads((EVIDENCE.parent / "2026-09-21-release-repair/input-preservation.json").read_text())
preservation = {
    "initial": verify(ROOT, initial),
    "production": verify(ROOT, {n: h for n, h in initial.items() if n.startswith("src/")}),
    "historicalReviews": verify(ROOT, {n: h for n, h in initial.items() if n.startswith("changes/v3.2.10/reviews/")}),
    "primaryDirty": verify(PRIMARY, prior["primaryDirty"]),
    "primaryHead": head(PRIMARY), "releaseHead": head(ROOT)
}
allowed = {
    "architecture/README.md", 
    "changes/v3.2.10/README.md", "changes/v3.2.10/release.md",
    "changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md",
    "changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md",
    "scripts/architecture/contracts.js", "scripts/architecture/renderer-contracts.js",
    "scripts/architecture/rules.js", "scripts/architecture/scan.js", "rules/integration-test-policy.md"
}
preservation["unexpectedChanges"] = sorted(set(preservation["initial"]["changed"]) - allowed)
assert not preservation["unexpectedChanges"], preservation
assert all(not preservation[k]["changed"] for k in ["production", "historicalReviews", "primaryDirty"])
assert preservation["primaryHead"] == prior["primaryHead"] and preservation["releaseHead"] == gate["head"]
preservation["architectureConfig"] = verify(ROOT, {n: h for n, h in initial.items() if n.startswith("architecture/") and n.endswith(".json")})
assert not preservation["architectureConfig"]["changed"]
architecture = read("architecture-check.json")
assert not architecture["violations"] and not architecture["staleExceptions"] and len(architecture["activeBoundaries"]) == 31
assert "ℹ pass 270" in (EVIDENCE / "architecture-tests.log").read_text()
save("preservation-final.json", preservation)
result = {
    "result": "PASS", "gate": gate, "unit": unit,
    "integration": {"scripts": len(integrations),
                    "countedPassed": sum(x["passed"] or 0 for x in integrations),
                    "countedTotal": sum(x["total"] or 0 for x in integrations),
                    "withoutCount": [x["name"] for x in integrations if x["total"] is None],
                    "results": integrations},
    "architecture": {"testsPassed": 270, "active": 31, "diagnostics": 0, "stale": 0,
                     "newRegressions": 33, "parsedProductionFiles": 765},
    "preservation": preservation
}
save("verification.json", result)
print(json.dumps({"gate": gate, "unit": unit, "integrationScripts": len(integrations),
                  "preservation": preservation}, ensure_ascii=False, indent=2))
