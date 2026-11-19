# v3.2.20 发布与集成记录

本文件记本轮范围、模块合入与最终证据；模块内的决策、审查处置与验证细节见 spec / TechDoc，不重复复制。

## 本轮信息

| 项目 | 事实 |
| --- | --- |
| 目标版本 | 3.2.20 |
| 操作范围 | 2026-11-18 v3.2.19 发布流程失败、标签不可移动后，用户决定「改发 v3.2.20」，随后要求「把 feat/retire-recon-modules 带上」；完整发布（合并、正式标签、发布审批）沿用本轮已获授权的流程 |
| 基线 | `v3.2.19` → `466bb6facf1e447bffc03612888411c161d47076`（PR #254 合并提交；该标签未发布，见 [v3.2.19 记录](../v3.2.19/release.md)「发布流程失败与修复」） |
| release 分支 | `release/v3.2.20`，2026-11-18 从基线新建（此前本地与远端均不存在）；工作树 `.claude/worktrees/release-v3.2.20` |
| 远端 main | `466bb6fa`（即基线），已包含在 release 历史 |
| 未纳入 | 主签出 `CLAUDE.md` 的未提交改动（压缩说明，与本轮无关，未动） |

## 纳入范围（清单 A4 / B5）

| 内容 | 源分支 / 末端 | 合入提交 | 文档 |
| --- | --- | --- | --- |
| 发布检查修复：渲染生命周期测试 Electron 进程总时限 120 → 300 秒 | `release/v3.2.19` / `d8a07a4b`（PR #255） | `305ef4b0` | [v3.2.19 记录](../v3.2.19/release.md) |
| 下线四个对账模块（业务OP数据核对、月度Pending数据核对、收单单据币种校验、月度银行对账单BU回填校验） | `feat/retire-recon-modules` / `6f24b27d` | `4bf7a559` | [Spec](feat/retire-recon-modules/spec.md)、[TechDoc](feat/retire-recon-modules/techdoc.md) |

- `feat/retire-recon-modules` 基于 `466bb6fa`，此前已有 `71b7cc24`（下线）与 `3916bed3`（§七 回写）。两轮 Codex 审查修复在主签出未提交，2026-11-18 按用户要求纳入本轮前提交为 `6f24b27d`（排除无关的 `CLAUDE.md`）。该分支没有远端分支与模块 PR，Windows 证据以本轮 release PR 的 CI 为准。
- v3.2.19 的全部功能（`466bb6fa` 已含）随本版首次发出安装包。

## 审查

- 模块分支 Codex 审查两轮，处置见 TechDoc「Codex 审查修复」「Codex 第二轮审查修复」两节；第二轮确认 10 条，修 8 条、放行 1 条（spec D5）、不采纳 2 条（B109、设置页「待完成删除」提示）。第二轮修复后未再做本地 Codex 审查。

## 升版与发布文档（清单 C1–C2）

- `package.json` / `package-lock.json` 升为 3.2.20（只改版本行，保留原格式）。
- `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md` 新增 3.2.20 条目；`docs/USER_GUIDE.md` 更新版本并新增 v3.2.20 说明，v3.2.19 说明标为「随 v3.2.20 发布」（模块各节的下线说明由模块分支写入）；`src/main-process/release-notes/release-notes.json` 顶部新增 3.2.20 升级弹窗要点 4 条（从 3.2.18 升级时同时显示 3.2.19 条目）。

## 遗留项处置（清单 B4）

- 模块分支新增 B105、B107–B110，B106、B34 随模块下线关闭（已在「已完成」）。
- B105（Windows 打包版验收）本轮未做，目标改为 v3.2.21（暂定）。
- 目标为 v3.2.20 的 17 条既有条目（B45、B47、B48、B52–B58、B60、B70、B75、B77、B79、B86、B92）本轮无修复纳入，顺延到 v3.2.21（暂定），已在原条目更新目标版本与原因。

- **PR #256 Codex 云端审查 P1（已修复，直接提交到 release）**：已下线模块 v3.1.10 及更早生成的旧格式批次，其导出升级前已保存文件、归档未收尾时，新版启动被 `ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED` 阻止。已复现；v3.1.11 起的批次不受影响。用户选择方案 A（spec D6）：只放行恢复流程写入的追加意图，其余已下线通知仍原样保留；回归 `retired-module-publication-recovery.test.js`（撤掉修复即失败）。

## 待人工复核（清单 C5）

- **⚠️ 存档记录的状态与血缘（资金红线）**：启动扫尾、流程绑定意图重放与 File Task 收口确认跳过已下线模块；outbox 中已下线模块的终态通知整条原样保留；到期清理只删已结束批次，跳过进行中、仍有遗留通知或缺收口凭证的批次。须复核：升级后保留模块的存档、Task Run 与发布行为不变，已下线模块的存档记录前后不变（升级兼容集成测试 42 项断言覆盖，见 TechDoc）。
- **⚠️ 已下线模块导出的启动收尾（spec D6）**：升级前已保存文件、归档未收尾的 Pending / 业务OP / 收单导出，新版启动照常收尾（任务记为成功、附件就绪），与旧版重启时一致。
- **BizOP 遗留发布记录（B108）**：处理前统一发布流程的导出被拒，须确认提示文案与影响范围可接受。
- **实机**：Windows 打包版启动、模块切换回默认模块、存档中心不显示已下线模块未做（B105）。
- **结果**：待用户确认。

## 验证（清单 C4）

- 模块分支：两轮修复后 `npm run release-check` 通过（TechDoc 记录：单测 8934 个，8930 通过、4 跳过、0 失败；集成 88 个脚本全部通过）。
- 架构策略历史：合入后 `npm run check:architecture` 报 `renderer-duplicate-inbound.activationEvidence`、`renderer-pre-fund.activationEvidence`、`shared-xlsx.requiredConsumers` 被放宽——模块分支的 policyChanges 登记在 `466bb6fa`，而 release 侧的 `d8a07a4b` / `305ef4b0` 不在其历史中。按 v3.2.19 先例，为 `305ef4b0` 补登 3 条同值 policyChanges（`architecture/boundaries.json`），复跑通过（检查 366 个提交）。
- release 候选（升版提交）：lint 通过；架构检查通过；`release-notes`、`vcc-financial-op-release-docs`、`app-update-contract`、`windows-build-contract`、`ci-release-check-jobs`、`architecture/policy-history` 单测 108 个（106 通过、2 跳过、0 失败）；集成 `release-notes-upgrade-prompt` 6/6。本机未跑完整 `npm run release-check`（用户此前要求跳过本地 release-check），以 PR Windows CI 与发布流程内的 release-check 为准。
- PR Windows CI：待填写。
