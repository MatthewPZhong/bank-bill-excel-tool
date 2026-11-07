# v3.2.15 发布与集成记录

各模块的合入过程、逐轮审查处置与模块级验证记录在 [PR #246](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/246) 正文；本文件只记本轮范围、遗留处理、发版准备与最终证据，不重复复制。

## 本轮信息

| 项目 | 事实 |
| --- | --- |
| 目标版本 | 3.2.15 |
| 正式基线 | `v3.2.14` → `245bae04285a443f7e733e9c6bbd4894ba008e43` |
| release 分支 | `release/v3.2.15`，从基线新建；冻结前末端 `849c65c7`，相对基线 94 个提交 |
| 远端 main | `245bae04`，已包含在 release 历史 |
| PR | [#246](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/246)，`release/v3.2.15` → `main`，自首次合入起为草稿 |
| 合并方式 | 必须使用 merge commit：`architecture/boundaries.json` 的 policyChanges 以 release 侧多个提交为来源（见 PR #246「合并方式」），squash 或 rebase 后这些提交不在 main 历史中，架构检查会失败 |
| 操作范围 | 2026-11-07 用户确认人工复核完成后要求“继续发版”：升版、同步发布文档、推送、PR 转为可合并并以 merge commit 合并、推送附注标签 `v3.2.15` 并核验发布结果。不删除分支 |

## 纳入范围

| 内容 | 源分支 / 末端 | 文档 |
| --- | --- | --- |
| 网银账单：渠道与子模板（取代主模板），含 Codex 审查（TechDoc 11.4）、release 审查与复审（11.5 I19–I35） | `feat/statement-channels` / `0b4d4736` | [Spec](feat/statement-channels/spec.md)、[TechDoc](feat/statement-channels/techdoc.md) |
| 更新说明：上一个版本到当前版本，每页一个版本 | `feat/release-notes-range` / `387e5f44` | [Spec](feat/release-notes-range/spec.md) |
| B42：输入表恢复默认核对同组结构冲突，VCC 来源识别拒绝多重命中 | `fix/input-structure-restore-default-conflict` / `4eaa2c94` | [Spec](fix/input-structure-restore-default-conflict/spec.md) |
| B43：Windows CI 的 release-check 拆成并行 job | `chore/ci-parallel-jobs`（经 PR #247 验证） | [TechDoc](chore/ci-parallel-jobs/techdoc.md) |
| 网银账单深审修复（F01–F05、F07）、KBANK-VN 导入（K1、K2）、大账号多币种提醒，以及 release 整体审查与复审（R1、R2、R1-a–R1-h，关闭 B65） | `fix/statement-balance-review-findings` / `82b9f026`，其后 `c84c1426`（多币种）、`4dec6769`（KBANK-VN）；`fix/statement-import-review-followups` / `c25d096c` | [Spec](fix/statement-balance-review-findings/spec.md) |
| 资金对账：R4 资金性质校验与退款回填遵守适用银行渠道（深审 F-01） | `fix/fund-recon-applicable-channels` / `ee88b751` | [Spec](fix/fund-recon-applicable-channels/spec.md) |
| 设置「账户管理」 | `feat/bank-account-management` / `a79bedf7` | [Spec](feat/bank-account-management/spec.md) |

逐项合入提交与 policyChanges 补登见 PR #246「本轮状态」「合并方式」。

## 遗留项处理（清单 B4，2026-11-07）

- **本轮关闭**：
  - B42、B43、B65：随修复合入关闭（见 backlog「已完成」）。
  - B26、B27、B33、B62、B64、B66、B67：2026-11-07 用户确认已完成实机检查与人工复核，未提供复核人与明细。
- **人工复核**：PR #246「转为可合并前待办」所列资金红线复核（B42 在 v3.2.14 期间可能已有的误分类，渠道 I14–I16 与 TechDoc 11.3，深审修复的业务口径与排除渠道抽查，B64、B67）2026-11-07 由用户确认全部完成，未提供复核人与明细。
- **不在本轮**：B68（跨批次输出覆盖，用户确认本轮不修）、B63（账户管理接入）、B44（停用 IPC 删除）、B45–B61（深审其余发现，部分目标 v3.2.16）、B32、B34–B41 等目标未定的条目，状态不变。

## 发版准备

| 项目 | 事实 |
| --- | --- |
| 升版 | `package.json`、`package-lock.json` 升到 3.2.15（`npm version 3.2.15 --no-git-tag-version`，项目无 version 生命周期脚本；npm 重排的 `build.files` 数组格式已还原） |
| 发布文档 | `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md` 新增 3.2.15；`docs/USER_GUIDE.md` 版本号与顶部说明更新，补充余额修复、导出全部阻断、无效账单日期与合计行、覆盖续跑、表头中间空列与多模板取舍、直接识别的多币种提醒、资金对账适用渠道、恢复默认与 VCC 来源识别；`release-notes.json` 新增 3.2.15 共 5 条要点 |
| 已知限制 | 见 PR #246「已知限制」与 backlog B68、B44、B35、B46、B45–B61 |

升版与文档提交为 `cf78fd0b`，推送后 PR #246 转为可合并。

## 2026-11-07 Codex 自动审查（审查提交 `cf78fd0b`）

PR 转为可合并后 Codex 自动审查提出 2 项，发版暂停在合并前；用户决定修完再继续。另一会话核实后在 release 上修复（`5a90823f`），详见 [TechDoc §11.5](feat/statement-channels/techdoc.md) I36、I37：

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| I37（P1，资金） | 启动迁移备份失败或事务回滚时只记日志、继续启动，旧主/子模板未归入渠道；月度余额只按 `channelId` 排除渠道模板，主、子模板维护同一账号时同一余额输出两次 | 仍有旧主/子标记即视为迁移未完成，网银账单导入（含按文件名映射）与月度余额装配返回 `STATEMENT_CHANNEL_MIGRATION_PENDING`，下次启动迁移成功后解除 |
| I36（P2，资金） | 模板加入渠道时只比较渠道的生效映射，漏掉待处理冲突的账户号；模板设置写入渠道后不在候选里，处理冲突时被覆盖 | 模板维护了目标渠道冲突账户号时阻断加入，列出候选与模板设置 |

- 核对：迁移成功路径一次清空全部旧主/子标记（含悬空的 `parent_template_id`），之后源码中没有再写入这两列的路径，不会在迁移完成后误阻断。
- 文档：本轮在 `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md`（渠道升级迁移与账户映射两处）补充上述行为；升级弹窗要点不变。
- 人工复核：backlog B69（I36、I37 的资金红线复核），合并前须用户确认。
- `cf78fd0b` 上的本机 `release-check` 运行期间（约 08:57–08:59）工作区出现上述修复的未提交改动，该次结果不作为任何提交的证据；`cf78fd0b` 以其 CI 为准，最终候选另跑。

最终候选的本地 `release-check`、CI、合并提交、正式标签与发布产物核验记录在 PR #246 正文「发布结果」。
