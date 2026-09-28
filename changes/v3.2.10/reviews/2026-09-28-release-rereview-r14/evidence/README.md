# R14 证据与重放

入口：[审查报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/review.md)、[机器汇总](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/verification.json)。`evidenceAssertions: PASS` 仅表示归档结果、输入身份与报告观察一致；RR14-01 的漏报仍然存在，不代表检查器无缺陷或 release 验收通过。

所有仓库命令的 cwd 固定为 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`。原始执行命令、退出码与范围见 [Renderer 记录](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-renderer-verification.json)、[覆盖顺序记录](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-order-review.md)、[共享重放说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-shared-commands.md)。原记录中的 `/tmp` 是当时执行位置，脚本及结果均已保存到本目录。

## 归档核验

以下断言在本轮已经执行，不需要重新启动实际配置扫描或业务：

```sh
python3 changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/verify-probes.py
python3 changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-shared-verify.py
node changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-order-verify.cjs
```

主断言逐一检查 Renderer 归档哈希、before/current 的 5 个工具、795 个源码/配置输入、新增 6 例及 12 次 VM 分支结果、实际配置前后两代表、原 RR13 的 4+2 例关闭、数组 14 例稳定性和正式验证汇总。`scanError` 与诊断分别核查；不会把异常包装或缺失诊断当作零诊断通过。

## 新反例重放

下列命令使用归档脚本，cwd 仍须固定为上述工作区。运行输出到终端；需要保留新结果时请另建文件，避免覆盖本轮原始证据。

```sh
R14_EVIDENCE="/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence"
R14_BEFORE_ROOT="$(node "$R14_EVIDENCE/r14-renderer-before-bootstrap.cjs" "$PWD")"
RENDERER_SCANNER_ROOT="$R14_BEFORE_ROOT" node "$R14_EVIDENCE/r14-renderer-probes.cjs"
node "$R14_EVIDENCE/r14-renderer-probes.cjs"
RENDERER_SCANNER_ROOT="$R14_BEFORE_ROOT" node "$R14_EVIDENCE/r14-renderer-do-realconfig.cjs"
node "$R14_EVIDENCE/r14-renderer-do-realconfig.cjs"
node "$R14_EVIDENCE/r14-renderer-branch-vm.cjs" "$R14_EVIDENCE/r14-renderer-probes-current.jsonl"
```

before 自举使用 R13 repair 中保存的检查器和经哈希匹配的共享工具，创建 `/tmp` 工具树并链接当前 `node_modules`，不依赖旧随机临时目录。它会写 `/tmp/r14-renderer-before-inputs.json`；不写业务源码。实际配置脚本只在内存中追加 AST 样例，VM 使用 mock API/controller；20 个 Renderer 边界不等于执行 20 个控制器业务。

原 RR13 的 4+2 例使用上一轮归档的相同脚本重新执行，准确命令见 Renderer 记录。覆盖顺序的 8 例有自己的比较/断言入口；共享 62 例通过 [完整重放入口](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-shared-replay.py)创建临时输出并校验。数组 14 例使用相同旧 fixture、准确 R13 before 与当前检查器执行：

```sh
node changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-array-compare.cjs r14-array-original-probe.cjs minimal
node changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-array-compare.cjs r14-array-finite-probe.cjs minimal
```

数组比较入口会自行创建并清理临时工具目录。结果保存于 original/finite-before-current JSON；原 14 个 fixture 的诊断无变化，保守拒绝单列。

## 验证与保全

- 架构单测本轮重跑 621/621 PASS；[结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/architecture-tests-result.json)。
- 正式架构 CLI 本轮重跑 exit 0，31 active、零诊断；[结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/architecture-check-result.json)。
- 完整门禁本轮未重跑：复用 2026-09-28 R13 repair 最终门禁，并核实 1710 个输入集合、哈希及 HEAD 一致；[输入比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/gate-evidence-comparison.json)、[日志核对](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/gate-log-audit.json)。
- [最终保全](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/preservation-final.json)检查 5118 个既有非忽略文件、HEAD/status/tracked diff 及本轮目录外新增文件；[产物校验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/artifact-validation.json)检查 Markdown 链接及 JSON/JSONL；[产物哈希](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/artifact-sha256.json)覆盖本轮报告和证据。
