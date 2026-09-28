# 第 15 轮审查证据

对应 [审查文档](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/review.md)。本目录的 PASS 仅表示机器断言和证据一致；包含明确记录的保守拒绝，不表示所有合法代码都获接受。

## 输入与结果索引

| 材料 | 用途 |
|---|---|
| [input-manifest.json](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/input-manifest.json)、[input-diff.patch](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/input-diff.patch) | 分支、HEAD、dirty 状态及 5,245 个非忽略文件冻结 |
| [prior-review-comparison.json](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/prior-review-comparison.json)、[renderer-incremental.diff](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/renderer-incremental.diff) | 对上轮 7 份原有文件变化、新增 34 例正式回归的范围依据 |
| [Renderer 子审](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-renderer-review.md)、[输入及结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-renderer-verification.json) | 原 6 例关闭、新 6 例、20 边界代表、12 次 VM；含 R15-O1 |
| [真实配置 before](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-renderer-forof-realconfig-before.json)、[current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-renderer-forof-realconfig-current.json)、[分支 VM](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-renderer-branch-vm.json) | 空 [] 安全拒绝与 [0] 违规拒绝对照 |
| [finally/helper 子审](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-flow-review.md)、[断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-flow-verification.json) | 8 个新相邻路径 |
| [旧数组/顺序断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-regression-verification.json) | 14 个数组与 8 个顺序探针 |
| [共享重放说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-shared-commands.md)、[断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-shared-verification.json) | 56 个共享加 6 个绑定身份例；包括实际 SQLite 10 例 |
| [架构单测日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/architecture-tests.log)、[结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/architecture-tests-result.json) | 本轮 655/655，exit 0 |
| [架构 CLI JSON](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/architecture-check.json)、[摘要](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/architecture-check-result.json) | 本轮 31 active，0 违规，exit 0 |
| [门禁输入比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/gate-evidence-comparison.json)、[原日志核验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/gate-log-audit.json) | 1,711 个输入精确匹配；完整门禁未在本轮重跑 |
| [主审断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/verification.json)、[保全](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/preservation-final.json) | 原始结果/归档哈希核对及结束状态 |
| [产物哈希](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/artifact-sha256.json)、[结构与链接校验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/artifact-validation.json) | 防止证据归档与文档脱节 |

`r15-renderer-preliminary-renamed-method-*` 是探针生成时误改合法 run 字段的中间结果，已保留但排除最终统计。最终脚本保留 run，并重新执行 before/current 真实配置。`r15-renderer-verify.py` 是该子审最初验证 /tmp 输出的原始脚本，归档后的统一验证使用下面的 `verify-probes.py`，不依赖旧临时输出。

## 核验已归档证据

所有命令必须在当前 release worktree 执行。主审断言读取原始 Renderer JSON/JSONL、VM、输入哈希及其余组摘要；各分组断言补充校验原始结果。下面不会重跑完整测试门禁；`verify-probes.py` 只更新自己的汇总结果。

```sh
cd "/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10"
r15_evidence="/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence"
python3 "$r15_evidence/r15-regression-verify.py"
python3 "$r15_evidence/r15-shared-verify.py"
node "$r15_evidence/r15-flow-verify.cjs"
python3 "$r15_evidence/verify-probes.py"
```

## 按需重新运行探针

归档包含源码和预期结果。before 是 R14 修复前 checker，不是 R13 修复前；compare/bootstrap 会核验 R14 修复起点与 R15 冻结哈希。重新执行时输出到 /tmp，避免覆盖本轮最终原始证据。旧数组、调用顺序及 finally/helper 比较脚本自动建立并清理临时工具树。

```sh
cd "/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10"
r15_evidence="/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence"
node "$r15_evidence/r15-array-compare.cjs" r15-array-original-probe.cjs minimal > /tmp/r15-replay-array-original.json
node "$r15_evidence/r15-array-compare.cjs" r15-array-finite-probe.cjs minimal > /tmp/r15-replay-array-finite.json
node "$r15_evidence/r15-order-compare.cjs" r15-order-probe.cjs minimal > /tmp/r15-replay-order.json
node "$r15_evidence/r15-flow-compare.cjs" r15-flow-probe.cjs minimal > /tmp/r15-replay-flow.json
```

Renderer 新例及 VM：

```sh
cd "/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10"
r15_evidence="/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence"
r15_before_root="$(node "$r15_evidence/r15-renderer-before-bootstrap.cjs")"
node "$r15_evidence/r15-renderer-probes.cjs" > /tmp/r15-replay-renderer-current.jsonl
RENDERER_SCANNER_ROOT="$r15_before_root" node "$r15_evidence/r15-renderer-probes.cjs" > /tmp/r15-replay-renderer-before.jsonl
node "$r15_evidence/r15-renderer-branch-vm.cjs" /tmp/r15-replay-renderer-current.jsonl > /tmp/r15-replay-renderer-vm.json
node "$r15_evidence/r15-renderer-forof-realconfig.cjs" > /tmp/r15-replay-renderer-actual-current.json
RENDERER_SCANNER_ROOT="$r15_before_root" node "$r15_evidence/r15-renderer-forof-realconfig.cjs" > /tmp/r15-replay-renderer-actual-before.json
```

原 RR14 脚本及共享 62 例的完整命令分别见 Renderer 子审和共享重放说明。共享 replay 会更新本目录自己的共享 JSON；如要保留最终归档，先在临时副本执行。重新运行后不得将旧 artifact 哈希当作新结果的证明。

## 正式检查与最终封存

本轮实际执行了下面两个正式检查，原退出码均为 0；这里为可重复命令，重跑输出放 /tmp。`release-check` 本轮没有重跑，复用条件及原始执行时间见审查文档。

```sh
cd "/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10"
node --test tests/unit/architecture/*.test.js > /tmp/r15-replay-architecture-tests.log
node scripts/check-architecture.js --json /tmp/r15-replay-architecture-check.json > /tmp/r15-replay-architecture-check.log
```

封存脚本逐一核对冻结文件、HEAD、Git status、binary diff 和本轮目录之外新文件，再验证 Markdown 链接、JSON/JSONL 并生成 SHA-256 索引。本轮已实际执行；后续只有确实重新生成本轮产物时才再封存。

```sh
cd "/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10"
python3 "/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/finalize-artifact.py"
```

本目录不证明 Electron GUI、Windows、Excel/WPS、安装包、真实业务或正式发布验收。
