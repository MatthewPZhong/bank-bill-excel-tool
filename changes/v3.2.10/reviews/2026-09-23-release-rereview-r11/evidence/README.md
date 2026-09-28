# 第十一轮证据与复现

所有仓库命令显式使用工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`。探针使用 Node、当前 node_modules、冻结生产扫描输入和配置；before 从 R10 repair 的 `before/` 恢复唯一变化的检查器，并核对其他四工具 hash 后复用。无需保留随机临时工具目录；JSON 中的 `/tmp` 字段仅是当时执行记录。

## 材料

- 冻结与范围：`input-manifest.json`、`input-diff.patch`、`renderer-incremental.diff`、两份 comparison JSON。
- `r11-renderer-*`：原 8/2 例、6 个邻近例及实际配置 2 代表，含 before/current hash、异步 VM、完整源码和诊断。
- `r11-array-*`：原 7/4 例、8 个邻近例及实际配置 3 代表，compare 脚本与全部 cases/probe 放在同一目录。JSON 内附脚本 SHA256。
- `r11-shared-*`、`r11-bindings-*`：共享 56 + 原 R10 adjacent 6 例；保留真实 Promise 和既有保守拒绝期望。
- `architecture-tests.log`、`architecture-check.json/log`：本轮正式运行；`reused-gate-verification.json`：最终完整门禁的复用核验。
- `verify-probes.py`、`verify-shared-archive.py`：只核验归档证据与当前输入；PASS 意为观察一致，不是检查器无缺陷。带 `r11-shared-verify.py` 的原文件保留原执行路径；复核归档请用 `verify-shared-archive.py`。
- `finalize-artifact.py`：工作区保全、链接与 JSON/JSONL 校验、SHA256 归档。

## 实际命令及可复现入口

下面命令从上述工作目录执行；重放时可把输出重定向到新的临时文件，避免覆盖本轮原始证据。原两个 Renderer probe 入口复用第十轮归档。运行 fixture 的命令正常结束与静态检查正确是不同事实：finding 脚本的正常输出正是诊断与 VM 行为不符的证据。

```sh
node --test --test-concurrency=1 tests/unit/architecture/*.test.js
node scripts/check-architecture.js --json /tmp/r11-architecture-replay.json
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-probes.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-nested-realconfig.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-probes.cjs
renderer_before_root="$(node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-before-bootstrap.cjs)"
RENDERER_SCANNER_ROOT="$renderer_before_root" node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-member-realconfig.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-array-original-probe.cjs minimal
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-array-original-real-probe.cjs real
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-array-compare.cjs r11-array-original-probe.cjs minimal
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-array-compare.cjs r11-array-neighbor-probe.cjs minimal
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-array-compare.cjs r11-array-neighbor-real-probe.cjs real
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-shared-shared-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-shared-destructure-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-shared-localenv-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-shared-default-combinations.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-shared-async-array-combinations.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-shared-logical-combinations.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-bindings-probes.cjs
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/verify-shared-archive.py
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/verify-probes.py
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/finalize-artifact.py
```

before 比较依赖 `2026-09-23-release-r10-repair/input-manifest.json` 及 `before/scripts/architecture/renderer-contracts.js`，共享归档断言还对照该 repair 的最终共享 JSON 和 adjacent 六例源码。不使用更早 R9 起点，也不把 R10 中间补丁结果当作 before。当前工具若后来变化，hash 断言会失败，应重新冻结审查对象，不能把此轮结果套用到新源码。
