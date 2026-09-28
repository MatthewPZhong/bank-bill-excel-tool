# 第十二轮证据与复现

所有仓库命令显式使用工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`。before 为 R11 repair 准确起点，current 为 R12 冻结清单。共享四工具和政策均逐文件核对 hash。

## 材料说明

- `input-manifest.json`、`input-diff.patch`、`renderer-incremental.diff` 与 comparison JSON：冻结和范围。
- `r12-renderer-*`：原 6 例及 actual20 两代表，新 6 例 before/current 和 VM；原脚本入口复用 R11 evidence。
- `r12-array-original-*`：原 8 最小例、3 个实际配置代表；`r12-array-neighbor-*`：8 个新邻近及 4 个实际配置代表。`scanError` 表示分析器异常，不能当成 0 诊断。
- `r12-array-neighbor-attempt1.log` 保留初次未捕获错误。对应空 JSON 没有完成结果，未归档为有效 JSON。
- `r12-array-raw-helper-*` 和 `r12-array-capture-raw.cjs` 保留单例未捕获异常。原始子进程 exit 1，stdout 为空，stderr 为 RangeError；捕获器本身正常退出只代表记录成功。
- `r12-shared-*` 与 `r12-bindings-*`：56+6 既有 fixture，保留 Promise 纠正和已知保守拒绝。
- `architecture-tests.log`、`architecture-check.json/log` 为本轮执行；`reused-gate-verification.json` 是未重跑完整门禁的输入及日志核验。
- `verify-probes.py`、`verify-shared-archive.py` 核验归档，后者替代原 `/tmp` 路径版本 `r12-shared-verify.py`。
- `finalize-artifact.py` 完成保全、链接/JSON 校验与哈希。

## 复现入口

运行时依赖该 worktree 的 Node、node_modules、当前源码配置及 R11 repair 的 `before/scripts/architecture/renderer-contracts.js` 和输入清单。使用新的临时输出路径保存重放结果，不覆盖原审查证据。

```sh
node --test --test-concurrency=1 tests/unit/architecture/*.test.js
node scripts/check-architecture.js --json /tmp/r12-architecture-replay.json
node changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-probes.cjs
node changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-member-realconfig.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-renderer-probes.cjs
renderer_before_root="$(node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-renderer-before-bootstrap.cjs)"
RENDERER_SCANNER_ROOT="$renderer_before_root" node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-renderer-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-original-real-probe.cjs real
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-compare.cjs r12-array-original-probe.cjs minimal
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-compare.cjs r12-array-neighbor-probe.cjs minimal
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-compare.cjs r12-array-neighbor-real-probe.cjs real
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-raw-helper-probe.cjs minimal
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-shared-shared-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-shared-destructure-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-shared-localenv-probes.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-shared-default-combinations.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-shared-async-array-combinations.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-shared-logical-combinations.cjs
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-bindings-probes.cjs
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/verify-shared-archive.py
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/verify-probes.py
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/finalize-artifact.py
```

`r12-array-raw-helper-probe.cjs` 预期重现本轮缺陷并非零退出。其他数组 compare/probe 逐例捕获并记录异常后继续采集，不能以命令 exit 0 判断所有 fixture 通过。compare 与其 cases/probe 脚本应保持在同一目录。哈希和断言将拒绝后来漂移的源码；不要将本轮结论直接套用到新版本。

原 JSON 里的随机 `/tmp` 工具路径仅是执行记录；before 自举从仓库归档重建，不要求原临时目录继续存在。当前归档断言只读取本 evidence 下的结果，必要的历史比较均指向保留的 R11 repair/R11 review。
