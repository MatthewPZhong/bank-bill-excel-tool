# v3.2.3 Release Metadata Closeout — Implementation Notes

## Baseline

- Goal/spec：顶层 `changes/3.2.3/spec.md`、`techdoc.md` 逐字节同步冻结 v3.2.3 合同，并在最终版本分支收口元数据与发布文档。
- Initial plan：在最终本地 R3.2.3 evidence 候选上重放纯 metadata 提交；远端业务 PR 完成后再核对精确 ancestry，未满足前保持仅本地。
- Done when：版本、文档、历史 evidence、当前测试与人工边界均有可审计证据，且 main/tag/production 未修改。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 版本元数据只在最终 v3.2.3 分支收口为 `3.2.3` | 各版本必须保留自己的真实版本号 | 提前把 v3.2.2～v3.2.5 统一写成同一版本 | 后续版本各自独立 bump。 |
| 顶层 Spec/TechDoc 逐字节同步冻结来源 | 防止 metadata 节点静默改写资金、恢复或生产合同 | 在顶层副本润色或合并旧文档 | 合同 hash 可独立复验。 |
| R3.2.3 exact evidence 与当前 metadata authority 分层 | 原 evidence validator 锁定 exact parent/branch/worktree/package 事实 | 放宽旧 validator 让任意后续 commit 伪装为原证据 | 历史 head 原样复验；当前版本由独立 closeout 测试证明。 |
| 文档只声明 capability，不声明 production ready | snapshot 明确 production legacy/0，Windows/资金/恢复仍 PENDING/NOT_RUN | 用自动测试代偿人工门禁 | production enablement 继续 false。 |
| NewAccount heartbeat 测试改用可控 copy gate + 一次真实 timer turn | 全量并发运行时固定 `60ms/5ms/≥5 ticks` 只观察到 2 ticks；该断言混入机器调度吞吐，不能稳定证明“copy await 不阻塞 event loop” | 放宽 tick 数或把偶发失败当作环境噪声 | 保留真实 timer heartbeat、post-copy cancel 与 staging 清理断言，同时移除墙钟吞吐假设；生产代码零变化。 |

## Assumptions

无。远端 PR 的 CI、最终 tip 与 ancestry 均不作假设，继续作为 `PROBE` 项现场核对。

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 业务 PR 合并时同步版本元数据 | 增加独立 metadata closeout 节点 | 业务分支仍保留历史 `3.1.14`，三份发布文档未收口 | 不改业务行为，只补版本 authority | 不适用；冻结 Spec 未变 |
| 完整 unit 只需重跑验证 metadata | 首轮全量暴露 NewAccount heartbeat 墙钟计数竞态，改成可控 async gate 后重跑 | 高并发下 `60ms` 延迟不保证产生至少 5 个 `5ms` interval tick | 仅稳定测试 harness，不改变 copy/cancel/Publisher 合同 | 不适用；业务 Spec 未变 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 顶层 Spec/TechDoc 与冻结来源 SHA-256/逐字节比较 | PASS；Spec `533684fe…`、TechDoc `b10687d5…` | 合同未漂移。 |
| package 三处版本、三份发布文档交叉测试 | 与历史发布文档回归组合 `16/16 PASS` | 当前版本 authority 与人工边界。 |
| R3.2.3 exact evidence 隔离复验 | 原 `57fab04a…` / `codex/v3.2.3-r3-final-evidence-chain-20260830` 上完整 TAP `22/22 PASS` | 原 parent/branch/source/reviewed-head hard gate 未被 metadata 放宽；后续提交不冒充原 evidence head。 |
| R3.2.2 历史 snapshot / 当前 package authority 兼容 | 定向 `29/29 PASS`；历史仍锁定 `3.1.14/bumped=false`，当前只接受 `3.2.2+` 的稳定 `v3.2.x` 且 package-lock 两处必须一致 | 前序 evidence 不因当前版本向前推进而失效，也不接受 prerelease/跨 minor/回退。 |
| 最终 R3.2.3 evidence 精确提交完整 unit | `6601/6604 PASS`、`0 FAIL`、`3 SKIP`；日志 `logs/unit-tests/unit-20260830-162234.log` | metadata 重放前的最终业务/evidence 树全仓回归。 |
| 当前 metadata + 历史 evidence 定向组合 | `46/46 PASS` | 当前版本 authority、R3.2.2 冻结 blob、R3.2.3 exact historical suite 与三份发布文档同时成立。 |
| NewAccount heartbeat/cancel 稳定化 | 精确用例连续 `20/20 PASS`，完整 E10-B 文件 `50/50 PASS` | event loop 可调度、copy 完成后 cancel 胜出、staging/target 均不残留；不再依赖机器在 60ms 内产生固定 tick 数。 |
| 首轮 metadata closeout 完整 unit | `6581/6585 PASS`、`1 FAIL`、`3 SKIP`；唯一失败为 heartbeat `ticks=2`，其余行为通过；日志 `logs/unit-tests/unit-20260830-163112.log` | 保留真实失败与归因，不以单次定向重跑掩盖竞态。 |
| 稳定化后 metadata closeout 完整 unit | `6582/6585 PASS`、`0 FAIL`、`3 SKIP`；日志 `logs/unit-tests/unit-20260830-163339.log` | 全仓回归、当前 metadata、历史 evidence 与确定性 heartbeat/cancel 合同共同通过。 |
| 完整 integration runner | `53/53` 个脚本通过、`2488/2488 PASS` | 后台执行、恢复、statement generation、NewAccount 与其他跨模块集成合同。runner 自动刷新了 `rules/integration-test-policy.md` 的运行时间统计；该纯时序噪声已恢复，未纳入提交。 |
| 完整 smoke | PASS；包含 scenario engines `45/45`、scenario repository `7/7`、migrations `19/19`、IPC `11/11`、recon-id engine `45/45`、gateway `20/20`、IO `14/14`、handlers `21/21`、end-to-end `6/6` | Electron 主流程、打包前关键模块与端到端冒烟。 |
| `git diff --check`、`npm run check:packaged-inputs` | PASS；`build.files` 9 条覆盖范围与精确 HEAD 一致 | 静态质量与打包输入。 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 最终远端 v3.2.3 tip/ancestry | PROBE | 业务 PR 与 v3.2.2 metadata 合并后重放并核对 | 未完成前不得推 metadata PR。 |
| Windows packaged/Setup/portable 与 Excel/WPS | BLOCK / 人工复核 | release owner | 不阻塞 dormant capability，阻止 production/正式发布声明。 |
| Statement/NewAccount 真实资金文件、金额/币种/余额和恢复处置 | BLOCK / 人工复核 | 资金与恢复负责人 | 自动测试不得代偿，production 保持关闭。 |

按用户明确要求，不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。
