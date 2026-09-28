"""在当前 release 工作区冻结可执行输入并运行完整门禁，仅使用测试数据。"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[4]
EVIDENCE = Path(__file__).resolve().parent


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def snapshot():
    paths = git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
                "src", "scripts", "tests", "architecture", "index.html", "package.json",
                "package-lock.json", "eslint.config.*", ".github/workflows").decode().split("\0")
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            for name in sorted(set(paths)) if name and (ROOT / name).is_file()}


def save(name, value):
    (EVIDENCE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    assert (ROOT / "package.json").is_file(), ROOT
    before = snapshot()
    head = git("rev-parse", "HEAD").decode().strip()
    save("gate-input-manifest.json", {"head": head, "cwd": str(ROOT), "sha256": before})
    started = datetime.datetime.now().astimezone().isoformat()
    free = shutil.disk_usage(ROOT).free
    result = {"command": "UNIT_TEST_CONCURRENCY=1 npm run release-check", "cwd": str(ROOT),
              "head": head, "startedAt": started, "minimumFreeBytes": free,
              "abortBelowFreeBytes": 2 * 1024 ** 3, "inputFiles": len(before)}
    assert free > result["abortBelowFreeBytes"], "磁盘余量不足，未启动门禁"
    with (EVIDENCE / "release-check.log").open("w") as log:
        proc = subprocess.Popen(["npm", "run", "release-check"], cwd=ROOT,
                                env={**os.environ, "UNIT_TEST_CONCURRENCY": "1"},
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        result["pid"] = proc.pid
        while proc.poll() is None:
            free = shutil.disk_usage(ROOT).free
            result["minimumFreeBytes"] = min(result["minimumFreeBytes"], free)
            if free < result["abortBelowFreeBytes"]:
                result["aborted"] = "disk-space"
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                break
            save("gate-progress.json", result)
            time.sleep(10)
        result["exitCode"] = proc.wait()
    result["finishedAt"] = datetime.datetime.now().astimezone().isoformat()
    after = snapshot()
    result["changedInputs"] = [name for name in sorted(before.keys() | after.keys())
                               if before.get(name) != after.get(name)]
    result["headAfter"] = git("rev-parse", "HEAD").decode().strip()
    save("release-check-result.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    raise SystemExit(result["exitCode"] or bool(result["changedInputs"]) or result["head"] != result["headAfter"])
