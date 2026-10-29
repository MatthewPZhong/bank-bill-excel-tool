# v3.2.14 发布与集成记录

## 2026-10-29 模块集成

用户要求：把 v3.2.14 的两个功能分支并入 `release/v3.2.14`，跑完门禁后由 Codex 审查一轮。推送、开 PR、升版和发布尚未授权。

| 项目 | 事实 |
| --- | --- |
| 正式基线 | `v3.2.13` → `e68089cc46c88c3eaed87b942fcd8badef00dff7` |
| release 分支 | `release/v3.2.14`，从基线新建，仅在本地，未推送 |
| 远端 main | `e68089cc46c88c3eaed87b942fcd8badef00dff7`，已包含在 release 历史 |
| 合并方式 | 必须使用 merge commit：补登的 policyChanges 以 `0043b2be`、`9d4a554b` 为来源，squash 或 rebase 后这两个提交不在 main 历史中，架构检查会失败 |

## 纳入范围

| 分支 | 已合入来源 SHA | 合入提交 | 内容 |
| --- | --- | --- | --- |
| `feat/statement-balance-gap-prompt` | `9d4a554b` | `0043b2be` | 发生额计算余额的账单日期断档提醒，见 [spec](feat/statement-balance-gap-prompt/spec.md) |
| `feat/release-notes-on-upgrade` | `8ea9bbb5` | `8c049d36` | 升级后首次启动弹出更新说明，见 [spec](feat/release-notes-on-upgrade/spec.md) |

合并时的处理：

- `feat/statement-balance-gap-prompt` 从 `v3.2.12`（`0f890fb2`）创建，不是本轮基线 `v3.2.13`。合入时 `knowledge/backlog.md` 冲突，两侧都在「未实施」顶部新增了条目，全部保留，B34–B32 在上。`rules/integration-test-policy.md` 第七节是自动生成的耗时表，先取基线版本，再由完整集成运行重写。
- 架构历史检查报 5 条 `ARCH-POLICY-HISTORY`。断档分支的两个提交持有 v3.2.12 的 `boundaries.json`（blob `77bb6897`），第一次合并提交 `0043b2be` 持有 v3.2.13 的版本（blob `17a36724`）。已有的 policyChanges 来源 `0f890fb2`、`e68089cc` 都不是这些提交的后代，因此无法覆盖。按 v3.2.11–v3.2.13 的先例补登两条，现行允许集合不变：
  - `renderer-dialog-app-settings.allowedApiFields`：以 `0043b2be` 为来源，补登更新说明的同一放宽（`ui` 新增 `openReleaseNotes`）。断档分支提交中的原值与 v3.2.13 相同，也由这一条覆盖。
  - `renderer-dialog-template-files.allowedApiFields`：以断档分支末端 `9d4a554b` 为来源，补登 v3.2.13 模板文件版本管理的同一放宽。

## 检查与证据边界

- 两次合并后首次运行 `release-check`：lint 通过，架构检查报上述 5 条 `ARCH-POLICY-HISTORY` 后中止。
- 补登后在提交内容上重跑 `release-check`，通过：架构检查 801/801 文件、历史 87 个提交；单测 9736/9740，4 项为既有条件跳过；集成测试 88/88 脚本。
- 真实应用 GUI 未实测：断档提醒见 B33、B34，更新说明只有 renderer-lifecycle 布局截图。
- Codex 审查结论完成后补记在这里。
