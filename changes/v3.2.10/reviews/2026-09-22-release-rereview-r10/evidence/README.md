# R10 证据与复现

所有仓库命令使用显式工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`。新增仅限本审查目录；探针在系统临时目录生成 fixture，并在内存中替换 scanner analysis。

## 文件用途

- `input-manifest.json`、`input-diff.patch`：审查起点；`prior-review-comparison.json`、`policy-production-comparison.json`：范围判定。
- `r10-renderer-*`：RR9-01 关闭、8 个 AND/Preload 邻近例、RR10-01 实际配置对照；`before-bootstrap.cjs` 用归档源重建工具并验证 hash，不依赖原随机临时目录仍存在。
- `r10-array-*`：RR9-02 关闭、7 个数组邻近例、4 个实际配置 before/current 对照。compare 脚本和各 `*-cases.cjs` 需放同一目录，已一并归档。
- `r10-shared-*`：50 个继承 fixture 加 6 个逻辑数据组合，含 shared scanner digest/evidenceId 稳定性；query fixture 使用独立内存 SQLite。
- `architecture-tests.log`、`architecture-check.{json,log}`：本轮重新执行的正式测试/CLI。`gate-evidence-comparison.json` 是完整门禁复用依据。
- `verify-shared-archive.py`：额外核对 56 个共享夹具、实际 SQL 与异步 Promise 的纠正期望。
- `verify-probes.py`：只校验归档观察、hash 与当前门禁输入；不会把已复现问题伪装成通过。
- `finalize-artifact.py`：结束保全、链接/JSON 检查与产物哈希。

## 已执行命令与可复现入口

本轮正式单测与 CLI 均 exit 0；31 项 RR9-01 定向测试包含在完整 482 项中。所有 fixture 的脚本完成状态与其期望结果不是一回事：两个 finding 的探针正常完成，输出恰好证明当前静态诊断与运行结果不一致。

下列入口可从上述工作目录执行；输出重定向建议用新的 `/tmp` 文件以保留本轮原证据。

```sh
node --test --test-concurrency=1 tests/unit/architecture/*.test.js
node scripts/check-architecture.js --json /tmp/r10-architecture-replay.json
node --test --test-name-pattern='RR9-01' tests/unit/architecture/release-rereview-r9.test.js
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-logical-realconfig.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-probes.cjs
renderer_before_root="$(node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-before-bootstrap.cjs)"
RENDERER_SCANNER_ROOT="$renderer_before_root" node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-nested-realconfig.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-array-selected-probe.cjs real
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-array-compare.cjs r10-array-neighbor-probe.cjs minimal
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-array-compare.cjs r10-array-real-neighbor-probe.cjs real
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-shared-shared-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-shared-destructure-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-shared-localenv-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-shared-default-combinations.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-shared-async-array-combinations.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-shared-logical-combinations.cjs
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/verify-shared-archive.py
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/verify-probes.py
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/finalize-artifact.py
```

依赖当前 worktree 的 `node_modules`、生产扫描输入和机器配置，以及 R9 repair `input-manifest.json` / `before/scripts/architecture/renderer-contracts.js`。before 比较脚本验证共享 4 工具 hash 后才复用当前文件；不从旧 HEAD 猜测未提交内容。原始实际 Renderer 逻辑反例脚本沿用上一轮归档入口。

已归档结果中的绝对 `/tmp` 路径是执行记录，不是长期输入依赖。`verify-probes.py` 校验本目录的 JSON/JSONL，不需要这些临时 fixture 仍存在。两次 before/current 及实际配置案例不是更多正式单测，不与 482 或 9256 相加。
