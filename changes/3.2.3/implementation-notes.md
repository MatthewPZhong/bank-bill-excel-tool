# v3.2.3 Release Metadata Closeout — Implementation Notes

## Baseline

- Goal/spec：顶层 `changes/3.2.3/spec.md`、`techdoc.md` 逐字节同步冻结 v3.2.3 合同，并在最终版本分支收口元数据与发布文档。
- Initial plan：以冻结 candidate `d12abe7c…` 为第一父，仅通过 natural merge 把已正式发布的 v3.2.2 最终 `main=c2d23f59…` 作为第二父传播，再经受保护 PR、main exact CI、唯一 annotated tag 与 Windows Release workflow 串行发布。
- Done when：版本、文档、历史 evidence、当前测试与人工边界均有可审计证据；PR exact 与合并后 main exact 门禁通过；tag/Release/四资产完成独立回读；application production 始终 disabled/legacy。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 版本元数据只在最终 v3.2.3 分支收口为 `3.2.3` | 各版本必须保留自己的真实版本号 | 提前把 v3.2.2～v3.2.5 统一写成同一版本 | 后续版本各自独立 bump。 |
| 顶层 Spec/TechDoc 逐字节同步冻结来源 | 防止 metadata 节点静默改写资金、恢复或生产合同 | 在顶层副本润色或合并旧文档 | 合同 hash 可独立复验。 |
| R3.2.3 exact evidence 与当前 metadata authority 分层 | 原 evidence validator 锁定 exact parent/branch/worktree/package 事实 | 放宽旧 validator 让任意后续 commit 伪装为原证据 | 历史 head 原样复验；当前版本由独立 closeout 测试证明。 |
| 文档只声明 capability，不声明 production ready | 历史 snapshot 明确 production legacy/0，且其 PENDING/NOT_RUN 事实不可篡改；当前技术 Release authority 来自发布负责人后续明确人工验收与授权 | 用自动测试改写历史 snapshot 或启用 production | 允许本次技术 Release，但 production enablement 继续 false。 |
| NewAccount heartbeat 测试改用可控 copy gate + 一次真实 timer turn | 全量并发运行时固定 `60ms/5ms/≥5 ticks` 只观察到 2 ticks；该断言混入机器调度吞吐，不能稳定证明“copy await 不阻塞 event loop” | 放宽 tick 数或把偶发失败当作环境噪声 | 保留真实 timer heartbeat、post-copy cancel 与 staging 清理断言，同时移除墙钟吞吐假设；生产代码零变化。 |
| 最终版本链只用 natural merge 传播 | 冻结 candidate 与已发布 v3.2.2 共同祖先为 `a5af61ea…`；candidate-first/main-second 能同时保留候选血缘和已发布修复 | rebase、cherry-pick、历史改写或反向父序 | merge commit 必须保持 parents=`[d12abe7c…,c2d23f59…]`。 |
| 三份发布文档冲突按版本链语义合并 | 产品代码无内容冲突；文档需同时保留 v3.2.3 capability、v3.2.2 已发布事实和当前技术发布授权 | 选择 ours/theirs 整体覆盖 | 不回退 v3.2.2 修复与 Release 历史，也不把 v3.2.3 提前写成已发布。 |
| 历史 exact evidence 的临时克隆恢复冻结 tag refs 快照 | 当前真实仓库在历史 evidence 之后新增了 v3.2.0～v3.2.2 annotated tags；继承这些 refs 会先触发 `GIT_TAG_REFS_INVALID`，掩盖原始 duplicate-key 反例 | 放宽 validator 的 25 refs/hash、删除真实仓库 tags 或改写历史 snapshot | 仅在测试私有临时 clone 删除后续 `v3.2.x` refs，并强制回读 25 refs 与冻结 SHA-256 `94a09eb7…`；validator、历史提交与真实 refs 不变。 |

## Assumptions

无。远端 PR/main exact CI、最终 tip、tag 与 Release 资产均不作假设，继续作为 `PROBE` 项现场核对。

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 业务 PR 合并时同步版本元数据 | 增加独立 metadata closeout 节点 | 业务分支仍保留历史 `3.1.14`，三份发布文档未收口 | 不改业务行为，只补版本 authority | 不适用；冻结 Spec 未变 |
| 完整 unit 只需重跑验证 metadata | 首轮全量暴露 NewAccount heartbeat 墙钟计数竞态，改成可控 async gate 后重跑 | 高并发下 `60ms` 延迟不保证产生至少 5 个 `5ms` interval tick | 仅稳定测试 harness，不改变 copy/cancel/Publisher 合同 | 不适用；业务 Spec 未变 |
| 等待旧叠栈 tip 后重放纯 metadata | 以冻结 `d12abe7c…` 为第一父，自然合并已发布 `main=c2d23f59…` | v3.2.2 正式发布包含候选分叉后完成的必要修复与发布文档事实 | 产品代码由 Git 自动合并；仅三份发布文档需语义解冲突 | 不适用；冻结 Spec/TechDoc hash 未变 |
| 历史 exact suite 直接复用当前仓库全部 tags | wrapper 在临时 clone 内先恢复历史 25-tag authority 快照再执行 exact suite | v3.2.0～v3.2.2 正式发布后，当前 28-tag refs 与冻结历史 hash 必然不同 | 防止后续合法 release refs 污染历史 fixture；仍以 exact count/hash fail closed | 不适用；历史 validator 与 snapshot 未变 |

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
| 2026-09-04 远端/候选预检 | main=`c2d23f59…`；candidate=`d12abe7c…` 且 package=`3.2.3`；v3.2.0～v3.2.2 tag/Release 链无漂移；审计 `/private/tmp/bbet-v323-initial-remote-preflight-20260904-055159.json`，SHA-256 `b9c79bd6…` | 冻结对象、祖先、版本序列和发布起点。 |
| natural merge 冲突复核 | 产品代码零内容冲突；仅 `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md` 三处文档冲突，逐项语义合并；无冲突标记，`git diff --check` PASS | 避免整体 ours/theirs 覆盖造成历史 Release 或当前版本说明回退。 |
| natural merge 提交回读 | commit `15bffc58471701542d3f828cad18866b79933b47`；parents 精确为 `[d12abe7ca781305aaf3eef77d8b86018261741ff,c2d23f5981b1b2218b0988cf13e7e048e02ced46]`；tree `86b4145a1801a3f2248d551863c5be76732fb6a7` | 冻结 candidate-first / released-main-second 血缘成立。 |
| 冻结文档与版本回读 | package/package-lock 三处均为 `3.2.3`；Spec `533684fe…`、TechDoc `b10687d5…` | natural merge 未改写冻结合同或版本 authority。 |
| production policy 只读回读 | 13 项 live policy 全部 `enabled=false/effectiveMode=legacy/effectiveWorkerCount=0`；v3.2.3 的 7 项中 Statement 5 项未注册、NewAccount 2 项注册但关闭；审计 `/private/tmp/bbet-v323-production-policy-readback-20260904-141333.json`，SHA-256 `9f6c9e4b…`，`allChecksPass=true` | application production 未启用，历史 PENDING/NOT_RUN snapshot 未改写。 |
| v3.2.3 相关 11 文件定向组合（首次） | `200/201 PASS`；唯一失败为历史 exact wrapper 继承新增 v3.2.0～v3.2.2 tag refs，先报 `GIT_TAG_REFS_INVALID` | 保留真实失败与根因，不用旧成功或单项测试代偿。 |
| 历史 tag 快照隔离回归 | 单文件历史 exact wrapper `1/1 PASS`；临时 clone 恢复后精确为 25 refs、冻结 SHA-256 `94a09eb7…`，原 exact child suite `22/22 PASS` | 后续 release tag 不再污染历史 fixture，duplicate-key 原反例仍是唯一预期错误。 |
| v3.2.3 相关 11 文件定向组合（修复后） | `201/201 PASS`、`0 FAIL`、`0 SKIP`，official Node `22.18.0` | Statement/NewAccount、metadata closeout 与历史 R3 evidence 同时成立。 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| natural merge 最终提交与双亲 | CLOSED | `15bffc58…` 已精确回读 parents=`[d12abe7c…,c2d23f59…]`、tree=`86b4145a…` | 已满足；后续提交只能为该 merge 的线性后继。 |
| PR exact 与合并后 main exact CI | PROBE | 自然触发 workflow，核对 smoke/build 及 release-check/Windows adapter/SQLite teardown/panel alignment 实际步骤 | 任一失败即停止，不 rerun/dispatch。 |
| annotated tag、Release 与四资产 | PROBE | main exact 通过后唯一建 tag；正常 required-reviewer 审批并完整下载核验 | 未完成前不得声明 v3.2.3 正式发布。 |
| Windows 10/11、SmartScreen、离线覆盖与 online canary | 发布后人工补测 | Issue #220 | 不阻塞本次技术 Release，不得据此启用 production。 |

按用户明确要求，本地不运行 `release-check`、`check-vars` 或 `scan:vars`；`check-vars` 仅按 skill 做只读扫描，这些本地命令不得记录为 PASS。Release workflow 可运行内置 `release-check`。
