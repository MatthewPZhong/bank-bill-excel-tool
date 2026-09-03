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
