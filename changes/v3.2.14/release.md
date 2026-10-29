# v3.2.14 发布与集成记录

## 2026-10-29 模块集成

用户要求：把 v3.2.14 的两个功能分支并入 `release/v3.2.14`，跑完门禁后由 Codex 审查一轮。推送、开 PR、升版和发布尚未授权。

| 项目 | 事实 |
| --- | --- |
| 正式基线 | `v3.2.13` → `e68089cc46c88c3eaed87b942fcd8badef00dff7` |
| release 分支 | `release/v3.2.14`，从基线新建，仅在本地，未推送 |
| 远端 main | `e68089cc46c88c3eaed87b942fcd8badef00dff7`，已包含在 release 历史 |
| 合并方式 | 必须使用 merge commit：补登的 policyChanges 以 `0043b2be`、`9d4a554b`、`0aea4c26` 为来源，squash 或 rebase 后这些提交不在 main 历史中，架构检查会失败 |

## 纳入范围

| 分支 | 已合入来源 SHA | 合入提交 | 内容 |
| --- | --- | --- | --- |
| `feat/statement-balance-gap-prompt` | `0aea4c26` | `0043b2be`、`a12e77f1` | 发生额计算余额的账单日期断档提醒（`9d4a554b`），以及本轮 Codex 审查的 3 条修复（`0aea4c26`），见 [spec](feat/statement-balance-gap-prompt/spec.md) §8 T11–T13 |
| `feat/release-notes-on-upgrade` | `8ea9bbb5` | `8c049d36` | 升级后首次启动弹出更新说明，见 [spec](feat/release-notes-on-upgrade/spec.md) |

合并时的处理：

- `feat/statement-balance-gap-prompt` 从 `v3.2.12`（`0f890fb2`）创建，不是本轮基线 `v3.2.13`。合入时 `knowledge/backlog.md` 冲突，两侧都在「未实施」顶部新增了条目，全部保留，B34–B32 在上。`rules/integration-test-policy.md` 第七节是自动生成的耗时表，先取基线版本，再由完整集成运行重写。
- 架构历史检查报 5 条 `ARCH-POLICY-HISTORY`。断档分支的两个提交持有 v3.2.12 的 `boundaries.json`（blob `77bb6897`），第一次合并提交 `0043b2be` 持有 v3.2.13 的版本（blob `17a36724`）。已有的 policyChanges 来源 `0f890fb2`、`e68089cc` 都不是这些提交的后代，因此无法覆盖。按 v3.2.11–v3.2.13 的先例补登两条，现行允许集合不变：
  - `renderer-dialog-app-settings.allowedApiFields`：以 `0043b2be` 为来源，补登更新说明的同一放宽（`ui` 新增 `openReleaseNotes`）。断档分支提交中的原值与 v3.2.13 相同，也由这一条覆盖。
  - `renderer-dialog-template-files.allowedApiFields`：以断档分支末端 `9d4a554b` 为来源，补登 v3.2.13 模板文件版本管理的同一放宽。
- 审查修复在断档分支上提交为 `0aea4c26`，再以 `a12e77f1` 合入。新末端仍持有 v3.2.12 的 `boundaries.json`，不是 `0043b2be`、`9d4a554b` 的祖先，所以以 `0aea4c26` 为来源，再补登上述两个字段的同一放宽。这一条也覆盖断档分支的全部早先提交。

## 检查与证据边界

- 两次合并后首次运行 `release-check`：lint 通过，架构检查报上述 5 条 `ARCH-POLICY-HISTORY` 后中止。
- 补登后在提交内容上重跑 `release-check`，通过：架构检查 801/801 文件、历史 87 个提交；单测 9736/9740，4 项为既有条件跳过；集成测试 88/88 脚本。
- 合入审查修复（`a12e77f1`）并补登后，在提交内容上重跑 `release-check`，通过：架构检查 801/801 文件、历史 90 个提交；单测 9737/9741，4 项为既有条件跳过；集成测试 88/88 脚本。
- 真实应用 GUI 未实测：断档提醒见 B33、B34，更新说明只有 renderer-lifecycle 布局截图。

## 审查与处理

2026-10-29 Codex 只读审查 `main...release/v3.2.14`（`27430b29`）。更新说明的版本判定、确认语义和 policyChanges 补登未发现缺陷。断档提醒有 3 条发现，已对照代码核实。按用户要求在功能分支修复（`0aea4c26`），每条都补了回归测试，并确认修复前失败、修复后通过：

| 等级 | 位置 | 问题 |
| --- | --- | --- |
| P1 · 资金红线，须人工复核 | `src/main.js` `regenerateVirtualTemplateBalanceFromSession` | 各模板组固定按 `scope: 'all'` 生成，内部文件带 `__all` 后缀。只有一个模板组时，这个文件会直接缓存为当前批次余额；之后“导出全部”覆盖同名文件，再“导出当前批次”就会混入其他批次的账号。`v3.2.13` 的补录路径已经如此，选择“不补录”断档后新增了一个入口 |
| P2 | `src/renderer/dialogs/configuration.js` `createExportScopeDialog` | 会话有多批文件时，明细导出经过范围选择弹窗，成功后 `setStatus` 不保留断档入口，用户只能重新导入，与断档 spec §4.2 第 5 条“导出明细不清除该入口”不符。直接导出路径（`controllers/statement.js`）有保留 |
| P2 | `src/styles-gemini-extra.css` `.balance-gap-body` | 正文不可收缩、不能滚动；断档较多且窗口较矮或缩放到 150% 时，底部两个按钮会被 `.modal-card` 裁掉 |

处理：P1 按真实范围生成各模板组余额（T11），新增单测回读当前批次文件；P2 范围选择弹窗把结果交回账单页统一处理（T12），生命周期用例覆盖经范围选择导出明细后重开断档；P3 正文可收缩滚动（T13），生命周期在最小窗口 150% 缩放、12 处断档下用真实鼠标点击按钮。P1 属资金红线，修复后仍须人工复核余额导出范围。

2026-10-29 Codex 第二轮只读审查 `main...release/v3.2.14`（`a00b4052`）：确认上一轮 3 条已从根因修复，未发现新的正确性缺陷；余额日期、币种、人工种子与导出范围链路，以及更新说明的版本区间、确认语义、全新安装判定、弹窗排队和 policyChanges 父链绑定均已核对。只读沙箱中有 5 项需要临时目录的测试未能运行，真实 GUI、Windows 与余额导出范围的人工复核仍待完成。
