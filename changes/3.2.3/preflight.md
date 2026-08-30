# v3.2.3 Release Metadata Closeout — Preflight

## Task Brief

- Goal：让最终 v3.2.3 分支携带正确的 package 元数据、权威 Spec/TechDoc 与三份同步发布文档。
- Context：Statement/NewAccount 业务链与 R3.2.3 evidence 已在隔离叠栈完成验证；metadata 已重放到最终本地 evidence 候选 `57fab04a…`，仍须等待远端业务链完成并核对最终 ancestry 后才可推送。
- Constraints：不改业务代码、金额/币种/借贷方向/余额/Workbook/事务/幂等/取消/恢复合同；不启用 production；不合并 main、不创建 tag；按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：两处 package 版本均为 `3.2.3`；顶层 Spec/TechDoc 与冻结来源逐字节一致；`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md` 同步记录本版能力与未解除的 Windows、资金和恢复人工门禁；历史 R3.2.3 evidence 仍在其精确提交上可复验；定向静态校验通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 冻结 Spec/TechDoc 的 SHA-256 分别为 `533684fe718d333456088c2511a17135ec4f479e592e94ba1dc15e7ff6a68851`、`b10687d5e26f85b477eeece913c46078404a4eea175702454be9bd8b5dcda4d4` | 冻结来源与顶层副本逐字节 `cmp` | 收口提交不得重写合同。 |
| R3.2.3 是 exact-parent/branch/worktree 绑定的一次性证据 | `scripts/validate-v3-2-3-release-evidence.js` 的 Git authority guard | 后续 metadata 提交不能冒充原 evidence head；必须独立保留并复验历史精确提交。 |
| production strategy 为 legacy/0，Windows 与资金/恢复证据未完成 | R3.2.3 snapshot/validator 和 implementation notes | 发布说明只能写 capability，不能写 production ready/PASS。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 最终远端 v3.2.3 tip 是否与本地最终候选 ancestry 一致 | 已知未知 | 高 | 一般 | 当前 metadata worktree 精确基于本地 evidence `57fab04a…`；远端 #199 CI 尚未完成 | PROBE | 逐 PR 核对 exact head/base/checks 并按序合并 | 保持本地候选；不得越序推送。 |
| 后续 package bump 是否会破坏历史 R3.2.3 exact evidence 复验 | 已知未知 | 高 | 容易 | 原 validator 强绑定 `3.1.14` 与 exact Git state | PROBE | 在历史 exact evidence head 的隔离 checkout 运行原始 validator/test | 历史证据与当前 metadata authority 分层，不放宽原 Git guard。 |
| 自动证据能否解除资金/恢复或 Windows 门禁 | 业务盲区 | 高 | 困难 | 冻结 Spec 与 evidence 均明确 PENDING/NOT_RUN | BLOCK | release owner/资金负责人真实样本和 packaged 人工复核 | 不能；文档保持人工门禁与 production disabled。 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 核对最终业务链、历史 evidence 与前序版本 ancestry | 防止 metadata 建在旧 stack 上 | exact head/base/ancestry 与历史 suite | 推翻远端发布顺序 | 保留本地提交，重放到最终 tip。 |
| 2 | 同步 package 元数据和权威 Spec/TechDoc | 版本/合同单一 authority | JSON 三处一致、逐字节 `cmp` | 阻止提交 | 回退纯 metadata diff。 |
| 3 | 同步三份发布文档 | capability 与 production strategy 分离 | 交叉文档测试 | 阻止提交 | 只修文档，不改业务。 |
| 4 | 复验历史 evidence 与当前 metadata | 不弱化 exact guard、不误报人工 PASS | 历史 exact suite、当前定向测试、`git diff --check` | 阻止推送 | 保留门禁，修正测试适配。 |
