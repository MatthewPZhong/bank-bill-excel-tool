# v3.2.3 正式技术发布 — Preflight

## Task Brief

- Goal：把冻结 v3.2.3 candidate `d12abe7c…` 的 Statement/NewAccount capability 与已正式发布的 v3.2.2 最终 `main=c2d23f59…` 组成可审计版本链，并经受保护 PR、main exact CI、唯一 annotated tag 和 Windows Release workflow 正式发布。
- Context：v3.2.0～v3.2.2 已完成正式技术发布；v3.2.3 顶层 Spec/TechDoc 与冻结基线一致，package 元数据为 `3.2.3`。历史 R3.2.3 evidence 的 PENDING/NOT_RUN 状态保持不可篡改，当前发布 authority 来自 `MatthewPZhong` 后续明确人工验收与授权。
- Constraints：主工作区只读，仅 isolated worktree；candidate 必须作为第一父，仅 natural merge 最终 main 作为第二父；不 rebase/cherry-pick/force/admin/auto merge，不删除远端分支，不 rerun/dispatch。本地不运行 `release-check`、`check-vars`、`scan:vars`；production 始终 disabled/legacy。
- Done when：双亲和冻结文档无漂移；三份发布文档同步；本地 Node 22.18 exact-lock 回归、PR exact CI 和合并后 main exact CI 通过；无阻断 review；唯一 annotated `v3.2.3`、required-reviewer 审批、Release 与四资产完整回读一致；production 未启用。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 冻结 candidate 为 `d12abe7ca781305aaf3eef77d8b86018261741ff`，package 为 `3.2.3` | Git 对象、tree、package/package-lock 只读回读 | 不替换 candidate，不改变第一父。 |
| 当前远端 main 为已发布 v3.2.2 的 `c2d23f5981b1b2218b0988cf13e7e048e02ced46` | 远端 ref、annotated tag、Release 与四资产链审计 | 只把该 exact main 作为第二父传播。 |
| 冻结 Spec/TechDoc SHA-256 分别为 `533684fe718d333456088c2511a17135ec4f479e592e94ba1dc15e7ff6a68851`、`b10687d5e26f85b477eeece913c46078404a4eea175702454be9bd8b5dcda4d4` | isolated worktree 逐字节 digest | 合并和 closeout 不得重写合同。 |
| 历史 R3.2.3 evidence 是 exact-parent/branch/worktree 绑定的一次性 snapshot | 冻结 validator 与 release-evidence.json | 不修改 PENDING/NOT_RUN，也不让当前提交冒充历史 evidence head。 |
| 当前人工验收与正式技术发布授权已确认 | 用户持续授权；`MatthewPZhong` 明确确认资金、恢复、真实样本和稳定窗口 | 允许串行技术 Release；不允许启用 production，Windows 补测仍走 Issue #220。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| natural merge 是否只产生可解释冲突并保持双亲顺序 | 已知未知 | 高 | 容易 | merge-base 为 v3.2.2 candidate `a5af61ea…` | PROBE | isolated worktree 执行 `git merge --no-ff`，逐项查看冲突与 parents | 仅三份发布文档冲突；产品代码自动合并，按语义逐项解决。 |
| v3.2.2 已发布修复是否完整传播且 v3.2.3 合同未回退 | 业务盲区 | 高 | 一般 | staged tree、冻结 hashes、版本文档 | PROBE | 定向 diff/合同测试、完整 unit/integration/smoke | 未通过本地完整证据前不推送。 |
| PR exact 与合并后 main exact CI 是否全部成功 | 已知未知 | 高 | 一般 | 尚未创建 PR | PROBE | 自然触发 workflow，逐 context 和关键 step 回读 | 不用旧 CI 或本地绿代偿，不 rerun/dispatch。 |
| Release tag、资产与更新元数据是否一致 | 已知未知 | 高 | 困难 | v3.2.3 tag/Release 尚不存在 | PROBE | main exact 通过后唯一建 annotated tag，完整下载四资产并核验 digest/latest.yml | 未完成前不声明正式发布。 |
| Windows 实机、SmartScreen、离线覆盖与 online canary | 环境未知 | 中 | 一般 | Issue #220 规定发布后补测 | 发布后人工 | 由 release owner 按 Issue #220 补测 | 不阻塞技术 Release，不代偿 production gate。 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 固定 candidate/main/tag/Release 远端快照 | 防漂移与错误版本起点 | exact OID、版本链与审计 digest | 立即停止 | 不创建 worktree/分支。 |
| 2 | candidate-first、main-second natural merge | 真实 ancestry、禁止历史改写 | merge parents 精确；冲突逐项解释 | 阻止提交 | 仅在 isolated worktree 调整冲突，不改远端。 |
| 3 | 同步三份发布文档并保留冻结合同 | 版本 authority、历史 Release、不误启用 production | package 三处一致、Spec/TechDoc digest、无 conflict marker | 阻止提交 | 只修文档，不改业务合同。 |
| 4 | 本地 exact-lock 回归与三项 blindspot 复核 | 行为、资金、恢复、重要变量和打包输入 | focused/full unit、integration、smoke、lint、diff、packaged-inputs 与审计报告 | 阻止 push | isolated worktree 最小修复或停止。 |
| 5 | PR exact、review、精确普通 merge 与 main exact | 远端 exact head/base、Windows 步骤和最终 main | smoke/build 与四关键步骤实际 SUCCESS；无阻断线程；双亲精确 | 停止，不 rerun/dispatch | 保留分支和证据。 |
| 6 | annotated tag、Release 与四资产终审 | 不可变版本锚点和公开资产完整性 | tag object/peeled target、required-reviewer、四资产 digest/latest.yml | 停止，不改 tag/手工发布 | 保留失败日志，由人工决定新方向。 |

## 当前边界

- Statement 四金额模式、借贷方向、币种、余额、current/all 行序和 Workbook 不变。
- NewAccount 日期、账户、币种、记录与命名语义不变。
- unknown/partial/committed-result-lost 不自动重跑或解除 Hold。
- capability 与 effective production strategy 分离；所有相关 action 必须保持 `enabled=false`、`effectiveMode=legacy`、`effectiveWorkerCount=0`。
- workflow 可运行内置 `release-check`；本地禁止的三个命令不得记录为 PASS。
