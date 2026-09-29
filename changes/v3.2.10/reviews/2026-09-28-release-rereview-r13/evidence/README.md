# R13 证据与重放

本目录属于只读审查。入口为[审查报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/review.md)，机器汇总为[verification.json](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/verification.json)。`evidenceAssertions: PASS` 表示归档证据与已陈述观察一致；RR13-01 的漏报仍然存在，不能将此 PASS 当成检查器无缺陷或 release 验收通过。

所有仓库命令的 cwd 固定为 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`。原始命令/退出码见 [Renderer 记录](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-renderer-verification.json)、[数组复核](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-array-review.md)、[共享重放](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-commands.md)。原始记录中的 `/tmp` 是当时的执行位置；本目录保存脚本和结果，可独立读取，不需要保留随机临时工具目录。

## 证据核验（本轮均已执行）

```sh
python3 changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/verify-probes.py
python3 changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-verify.py
node changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-array-verify.cjs
```

主断言核查 4 个新时序例前后差异、实际配置 2 个代表例及分支 VM 的源码/结果一致，逐一核对 795 个源码/配置文件哈希，以及两版 5 个工具对应冻结清单。数组原始异常保留在 `scanError`；不会将缺失诊断字段或异常包装当作通过。

## 重新执行 RR13-01

以下为从归档启动的重放方式，cwd 仍须是上述工作区；生成新的结果时不要覆盖历史记录。before 自举从 R12 repair 的 `before` 文件复制检查器，其他工具经哈希匹配后复用，临时树链接当前 `node_modules`。本轮实际执行命令位于 Renderer 记录；以下命令仅调整脚本为归档路径。

```sh
R13_EVIDENCE="/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence"
R13_BEFORE_ROOT="$(node "$R13_EVIDENCE/r13-renderer-before-bootstrap.cjs" "$PWD")"
RENDERER_SCANNER_ROOT="$R13_BEFORE_ROOT" node "$R13_EVIDENCE/r13-renderer-probes.cjs"
node "$R13_EVIDENCE/r13-renderer-probes.cjs"
RENDERER_SCANNER_ROOT="$R13_BEFORE_ROOT" node "$R13_EVIDENCE/r13-renderer-conditional-realconfig-replay.cjs"
node "$R13_EVIDENCE/r13-renderer-conditional-realconfig-replay.cjs"
node "$R13_EVIDENCE/r13-renderer-branch-vm.cjs" "$R13_EVIDENCE/r13-renderer-conditional-realconfig.json"
```

before bootstrap 会在 `/tmp` 创建工具目录和本次工具输入 JSON。该目录由命令返回；不会写入业务源码。实际配置脚本只在内存中追加 AST 样例，VM 使用 mock API/controller。`20 boundaries` 指保留真实 Renderer 配置，不指执行 20 个控制器业务。

数组 14 个已有 fixture 的重放命令与每例观察见数组复核文档。共享 56 + binding 6 的执行方式见共享重放文档；保留 async IPC 的拒绝期望和已记录保守拒绝。

## 本轮正式检查与门禁复用

- `node --test tests/unit/architecture/*.test.js`：589/589 PASS，见 [测试结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/architecture-tests-result.json)。
- `node scripts/check-architecture.js --json <本目录绝对路径>/architecture-check.json`：exit 0，见 [CLI 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/architecture-check-result.json)。
- 完整 `release-check` 本轮未重跑。原 2026-09-23 R12 repair 的 1709 个输入集合、哈希和 HEAD 全匹配，日志/进程结果再次核实；见[输入比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/gate-evidence-comparison.json)、[日志核对](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/gate-log-audit.json)。

[最终保全](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/preservation-final.json)检查 5006 个冻结文件、HEAD/status/tracked diff，以及新文件是否均限本轮目录；[产物校验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/artifact-validation.json)验证 Markdown 链接及 JSON/JSONL 可解析性；[产物哈希](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/artifact-sha256.json)覆盖本目录及上层本轮报告。
