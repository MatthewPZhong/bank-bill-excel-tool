# v3.2.2 Release Metadata Closeout — Preflight

## Task Brief

- Goal：让最终 v3.2.2 分支携带正确的 package 元数据、权威 Spec/TechDoc 与三份同步发布文档。
- Context：功能 PR #184～#191 已按序合并，但 `package.json`/`package-lock.json` 仍为 `3.1.14`，顶层 `changes/3.2.2` 尚未进入版本分支；审计同时发现最终 v3.2.0/v3.2.1 分支也遗漏各自元数据收口，因此必须先形成对应收口提交，再作为真实祖先进入 v3.2.2。
- Constraints：不改业务代码、金额/币种/Workbook/事务/幂等/恢复合同；不启用 production；不合并 main、不创建 tag；按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：最终 v3.2.0/v3.2.1 收口是当前分支真实祖先；两处 package 版本均为 `3.2.2`；v3.2.0～v3.2.2 顶层 Spec/TechDoc 与各自冻结来源逐字节一致；`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md` 按版本顺序同步记录能力与未解除的人工门禁；定向与完整验证通过。

## Unknowns Register

| 未知 | 处理 | 当前决定 |
| --- | --- | --- |
| 功能链合并后是否仍存在代码实现缺口 | PROBE | 复用 #184～#191 的精确合并与 release evidence；本节点不补业务实现。 |
| 补齐旧版本元数据时能否只复制文案而不建立祖先关系 | BLOCK | 不能；v3.2.0、v3.2.1 收口必须依次成为 v3.2.2 的真实 Git 祖先，后续版本也必须基于最终 v3.2.2 重新叠栈。 |
| 自动证据能否解除资金/恢复或 Windows 门禁 | BLOCK | 不能；发布文档必须保留人工复核与 production disabled。 |
| 顶层文档是否允许重写冻结语义 | PROBE | 不允许；只做逐字节同步并记录来源。 |
| 长时间 `release-check` 后专用 Windows 真实进程探针的 CIM snapshot 达到 15 秒上限，是否应放宽生产 adapter 超时 | PROBE | 不放宽。#210 run `33368091206` 已证明完整 release checks 成功、唯一真实用例总耗时约 15 秒并以 `PROCESS_SNAPSHOT_TIMEOUT` 失败；旧日志没有阶段标签，不能把具体调用点写成事实。采用仅限测试夹具的有界 30 秒 CIM 预热并补充阶段证据，随后仍以生产默认 15 秒 adapter 验证 snapshot/token/close/cleanup 全链。 |

## 风险优先计划

1. 核对最终 v3.2.0、v3.2.1 收口提交，并依次建立到 v3.2.2 的真实祖先链。
2. 同步 v3.2.2 package 元数据和权威 Spec/TechDoc。
3. 同步三份发布文档并保留三代历史，不把 dormant capability 表述为 production enabled。
4. 做祖先、字节、JSON、diff、文档交叉与适当完整验证；保留人工门禁。
5. 对 #210 Windows 真实进程探针失败做测试夹具级修复；保持生产 15 秒 fail-closed 上限，并以精确新 head CI 重新闭合 Windows 证据。

## 2026-09-04 Release Preflight Addendum

- Goal：在不改变金额、币种、业务主键、Workbook、事务、幂等、恢复或 production strategy 的前提下，把冻结 v3.2.2 候选自然传播到已正式发布 v3.2.1 的最终 `main` 之上，并通过受保护 PR、annotated tag 与 Windows Release workflow 发布技术 stable Release。
- Context：v3.2.1 经 PR #223 与 safe forward-fix PR #224 完成正式发布；最终 `main` 为 `c547097c8829c1c39437fe9047b5accbf5f1e388`，annotated `v3.2.1` 和四项 Release 资产均已独立回读。冻结 v3.2.2 候选仍为 `a5af61ea186e3a13a34bf6d70491de673dfc6915`，两者共同祖先是冻结 v3.2.1 候选 `ea60a5c7bdaaeeb5117d1c20be1f3df2ed4b0e38`，不能用快进、rebase 或旧 CI 代替自然传播。
- Authorization：发布负责人 `MatthewPZhong` 已批准 v3.2.0 → v3.2.5 严格串行发布，并确认本次资金、恢复、真实业务样本及稳定窗口人工验收通过；Windows 最终资产出现后才能执行的项目继续按 Issue #220 发布后补测。
- Constraints：仅使用 isolated worktree；不 force、rebase、cherry-pick、删除远端分支、admin/auto merge、rerun 或 dispatch。本地不运行 `release-check`、`check:vars` 或 `scan:vars`；application production 始终 disabled/legacy。
- Done when：发布准备 PR 的 exact `smoke-test`/`build` 与关键步骤实际成功且 review 无阻断，以普通双亲 merge 合入未漂移的 `main`；合并后 main exact CI 同样成功；唯一 annotated `v3.2.2` 精确指向最终 merge commit；Release workflow 与四项资产独立回读成功；随后才能开始 v3.2.3。

### 2026-09-04 Unknowns Register

| 未知 | 处理 | 当前决定 |
| --- | --- | --- |
| v3.2.1 最终修复与 v3.2.2 候选是否存在语义冲突 | PROBE | natural merge 暴露 4 个内容冲突；产品代码无内容冲突，三份长文档按版本顺序组合，Windows 探针保留外层 adapter cleanup 作用域。定向与完整验证仍必须重新执行。 |
| 冻结 R3.2.2 evidence 能否由旧分支绿灯代偿本次传播 | BLOCK | 不能；冻结 evidence 只证明候选功能基线，新双亲 merge、PR exact CI 与 main exact CI 均须重新闭合。 |
| 人工验收是否意味着可以启用 production | BLOCK | 不能；人工签字只授权技术 Release，所有 effective production strategy、feature flag 与 worker 继续 disabled/legacy。 |
| v3.2.2 最终 Windows 资产是否已可人工补测 | PROBE | tag/Release 前不存在；仅在四资产生成并完成摘要回读后，按 Issue #220 进入发布后补测。 |

## 2026-09-04 P2 Review Remediation Addendum

- Goal：闭合 PR #225 的两条 P2，同时保持冻结 policy、Duplicate 模块内 receipt/recovery、资金语义和 application production disabled/legacy 不变。
- Context：PR exact head `b05e4bcea3ab7cf7ab0508a1666059ca861579d2` 的 smoke/build 与四个关键步骤已成功；review thread `PRRT_kwDORiHOzM6fHT10` 质疑 durable coordinator 路由，`PRRT_kwDORiHOzM6fHT15` 指出 managed export 可直接写任意 `savePath`。
- Constraints：只在现有 isolated worktree 做最小修复；不改公共 Protocol、冻结 policy fixture、金额/币种/匹配/receipt/Hold/side DB/Workbook 或 production gate；不把旧 CI 作为新 head 证据。
- Done when：真实 Worker 路径证明 Duplicate 零 business-unit Service command 不触发 Platform critical coordinator；managed export 只消费 task-private staging plan，拒绝正式目标、路径逃逸、符号链接逃逸和既有 target，失败清理可审计；定向及完整验证、新 exact CI 和 review threads 全部闭合。

### Review Unknowns Register

| 未知 | 处理 | 当前决定 |
| --- | --- | --- |
| Duplicate 的首个 `critical:ready` 是否会进入 PreFund coordinator 并失败 | PROBE / CLOSED | `worker-host.js` 只发布 job terminal/resource-control，未发布 `critical:ready`/`commit:receipt`；真实 native runtime 使用会抛错的 coordinator 仍成功，新增调用计数锁定为 0。模块持久事实继续由 E07-B side receipt、Main mirror和startup inspector闭环，不新增 action-aware 公共 dispatcher。 |
| managed export 是否可看到或覆盖用户正式目标 | BLOCK / CONFIRMED | 当前直接消费任意 `input.savePath`，违背 TechDoc 的 FilePlan staging/main-settlement 合同；改为只接受 version 1 `stagingPlan`，单输出携带 FilePlan-owned `artifactKey` 与绝对 `stagingPath`。 |
| task-private 字符串前缀是否足以证明路径所有权 | PROBE / CLOSED | 不足；同时要求 lexical containment、Main 预先分配且已存在的普通非符号链接 root/父目录、物理 parent realpath containment，以及 target 通过 `lstat` 证明不存在（包括拒绝 dangling symlink）。Worker不递归创建目录，避免拒绝前沿中间符号链接在外部产生目录。 |
| Writer 或 artifact hash 失败后谁清理 | BLOCK / CLOSED | Worker只删除本轮已验证的 staging leaf；不递归删 Main-owned root。清理成功保留原错误；清理失败以明确 cleanup code 失败并把原错误作为 cause，避免静默遗留。 |
| artifact 如何与正式 FilePlan output 对接 | PROBE / CLOSED | 不再硬编码 artifact identity；result 原样返回 staging plan 中的 `artifactKey`，供 Main validator/Publisher 精确 join。 |

### 风险优先计划

1. 先用真实 Worker/Service 调用链证伪不可达的 coordinator 失败，不修改冻结公共协议。
2. 在任何 workbook 写入前完成 staging plan、lexical/physical path、target absence 校验。
3. 用成功、正式路径、越界、符号链接、既有目标、Writer 后失败及 cleanup 后失败回归锁定边界。
4. 重跑 Duplicate/Platform 邻接与完整 Node 22.18 验证，再以新 exact head 闭合远端门禁。

## 2026-09-04 指定会话修复纳入 Addendum

- Goal：把会话 `01a06168-1d95-7cf3-9be1-63d1513956ff` 已完成但未成为 Git 提交祖先的模板重命名与人工余额补录修复，作为 v3.2.2 的同一发布内容纳入 PR #225。
- Context：原会话已定位两条真实调用链：普通 no-file task 在没有模块 evidence 时返回 `null`；内存账单会话的余额补录 freshness 输入为空，因而形成空 eager FilePlan。当前 v3.2.2 head 仍保留两处旧行为，不能仅凭旧会话测试结论宣称已包含。
- Constraints：保留最终 Hold gate、eager FilePlan 与真实源文件血缘；不伪造输入、不把余额补录降为 no-file；余额 `0` 保持合法；覆盖确认仍只传 opaque `contextId`；不读取或写入用户真实余额数据。
- Done when：no-file 缺省 evidence 为对象；余额补录按 freshness → import context → 当前 statement session 顺序取得真实源文件，无来源时在业务前返回 `BALANCE_SEED_SOURCE_MISSING`；两个 renderer 入口对 IPC 失败给出可见反馈、保留草稿并防重复提交；三份发布文档与完整验证同步闭合。

### 指定会话 Unknowns Register

| 未知 | 处理 | 当前决定 |
| --- | --- | --- |
| 原会话修复是否已有可合并提交或已进入当前 ancestry | PROBE / CLOSED | 无对应提交祖先；当前源码仍有 `null` evidence、空 FilePlan 和直接 await IPC。依据原始会话补丁与当前调用链重新落地，不 cherry-pick、不改写历史。 |
| FilePlan 是否可因内存行不重读源文件而允许为空 | BLOCK / CLOSED | 不可；action 仍是 eager File Task。必须登记真实导入源文件；所有来源都缺失时 fail closed。 |
| 余额 `0` 是否需要改变金额解析 | PROBE / CLOSED | 不需要；现有 `parseNumericValue(...) === null` 已正确接受 `0`，仅补全链回归。 |
| 旧 Electron 窗口的现场结果能否作为本版证据 | BLOCK | 不能；代码/CI/Release 证据与发布后用户重启实机验证分开记录。 |
