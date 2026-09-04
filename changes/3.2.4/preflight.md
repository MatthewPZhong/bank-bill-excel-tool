# v3.2.4 Release Metadata Closeout — Preflight

## 2026-09-04 正式发布准备更新

- Goal：把冻结候选 `e1c31c4229ce68b18b82eca84cacb75f1e1dc889` 与已完成正式发布的 v3.2.3 main `5574a0e63aaa530db6669809b645f6d8397082d5` 通过自然 merge 汇合，在不改写历史证据的前提下形成唯一 v3.2.4 发布候选。
- Context：v3.2.0～v3.2.3 已逐版经受保护 PR、annotated tag、Windows Release workflow 与四资产回读完成正式技术发布；`MatthewPZhong` 已另行确认本次资金、恢复、真实业务样本及稳定窗口人工验收通过。
- Constraints：候选必须是双亲自然 merge，禁止 rebase/cherry-pick/force；生产策略继续 disabled/legacy；金额、币种、方向、匹配、receipt、Hold、Workbook 与发布 owner 不变；冻结 R3.2.4 evidence 的 `PENDING_HUMAN_REVIEW` / `NOT_RUN` 保持原样；本地不运行 `release-check`、`check:vars` 或 `scan:vars`。
- Done when：自然 merge 冲突逐项解释并验证；package/三份发布文档/冻结 Spec 与 TechDoc 一致；Node 22.18 exact-lock 定向、完整 unit/integration/smoke/lint 与静态检查通过；只读盲区/重要变量/资金复核无红线；随后才允许普通 push、PR、exact CI、review、精确普通 merge、main CI、唯一 annotated tag 与 Release 审计。

### 当前关键未知

| 未知 | 类型 | 当前证据 | 决定 |
| --- | --- | --- | --- |
| v3.2.4 与最终 v3.2.3 在启动恢复协调器上的并行演进能否组合 | PROBE | 冲突一侧增加 action-specific task authority/observation anchor，另一侧增加默认确定性 Hold resolution | 同时保留两组能力，以恢复合同定向测试和全量测试判定；失败即停止。 |
| 三份发布文档如何同时保留历史 R3 快照与当前人工授权 | PROBE | 历史 JSON 固定为 PENDING/NOT_RUN；当前用户授权是后续独立事实 | 历史快照不修改；发布候选文档明确分层，不把自动测试写成人工 PASS。 |
| production 是否随版本发布启用 | BLOCK | 6 个 v3.2.4 action 的冻结策略均为 false/legacy/0 | 不启用；任何漂移立即停止。 |

## Task Brief

- Goal：让最终 v3.2.4 分支携带正确的 package 元数据、权威 Spec/TechDoc 与三份同步发布文档。
- Context：ReconFix/VCC 业务链与 R3.2.4 evidence 已在隔离叠栈完成验证；metadata 当前精确基于本地 R3 evidence `5f9ee049fc4a4daf7089fa99d98b769b3d69540f`，仍须等待远端业务链完成并核对最终 ancestry 后才可推送。
- Constraints：不改业务代码、金额/币种/方向/匹配/Workbook/事务/幂等/取消/恢复合同；不启用 production；不合并 main、不创建 tag；按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：两处 package 版本均为 `3.2.4`；顶层 Spec/TechDoc 与冻结来源逐字节一致；`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md` 同步记录本版能力与未解除的 Windows、资金和恢复人工门禁；历史 R3.2.4 evidence 仍在其精确提交/PR 分支身份上可复验；定向与适当完整校验通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 冻结 Spec/TechDoc SHA-256 分别为 `dad81f149405281043306f7ce735f672fa20a167b4d8de751d5b254318fac2c7`、`0933775b673c0023e1c273be692dbaa3e3b1aa3fab3c77192ed06be430a55829` | 冻结来源与顶层副本逐字节 `cmp` | 收口提交不得重写合同。 |
| R3.2.4 是 exact-parent/branch/worktree 绑定的一次性证据 | `scripts/validate-v3-2-4-release-evidence.js` 的 Git authority guard；远端 PR #204 branch=`codex/v3.2.4-r3-release-evidence-restacked` | 后续 metadata 提交不能冒充原 evidence head；必须隔离复验历史精确提交。 |
| R3.2.4 exact head `5f9ee049…` validator PASS，固定 8 文件 `241/241 PASS`，其中 evidence suite `62/62 PASS` | 同名隔离 clone + exact main ref | closeout 只能新增当前版本 authority，不能放宽旧 gate。 |
| 6 个 action 均已注册但 production strategy 为 legacy/0，Windows 与资金/恢复证据未完成 | R3.2.4 snapshot/validator 和 implementation notes | 发布说明只能写 capability，不能写 production ready/PASS。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 最终远端 v3.2.4 tip 是否与本地最终候选 ancestry 一致 | 已知未知 | 高 | 一般 | 本地 closeout 精确基于 `5f9ee049…`；远端前序业务 PR 尚未合并 | PROBE | 逐 PR 核对 exact head/base/checks 并按序合并 | 保持本地候选；不得越序推送。 |
| 后续 package bump 是否会破坏历史 R3.2.4 exact evidence 复验 | 已知未知 | 高 | 容易 | 原 validator 强绑定 `3.2.3` 与 exact Git state | PROBE | 在历史 exact evidence head 的隔离 checkout 运行原始 validator/test | 历史证据与当前 metadata authority 分层，不放宽原 Git guard。 |
| 自动证据能否解除资金/恢复、Windows 或真实样本门禁 | 业务盲区 | 高 | 困难 | 冻结 Spec 与 evidence 均明确 PENDING/NOT_RUN | BLOCK（production） | release owner/资金负责人真实样本和 packaged 人工复核 | 不能；文档保持人工门禁与 production disabled。 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 核对最终业务链、历史 evidence 与前序版本 ancestry | 防止 metadata 建在旧 stack 上 | exact head/base/ancestry 与历史 suite | 推翻远端发布顺序 | 保留本地提交，重放到最终 tip。 |
| 2 | 同步 package 元数据和权威 Spec/TechDoc | 版本/合同单一 authority | JSON 三处一致、逐字节 `cmp` | 阻止提交 | 回退纯 metadata diff。 |
| 3 | 同步三份发布文档 | capability 与 production strategy 分离 | 交叉文档测试 | 阻止提交 | 只修文档，不改业务。 |
| 4 | 复验历史 evidence 与当前 metadata | 不弱化 exact guard、不误报人工 PASS | 历史 exact suite、当前定向测试、`git diff --check` | 阻止推送 | 保留门禁，修正测试适配。 |
