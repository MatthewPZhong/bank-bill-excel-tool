# v3.2.13 发布与集成记录

## 2026-10-21 正式发布准备

用户明确授权：升版到 3.2.13，同步三份发布文档，重跑 `release-check` 后推送 `release/v3.2.13`，由 PR 的 Windows CI 检查最终候选。合并 PR、创建附注标签和正式发布尚未授权，须另行确认。

| 项目 | 冻结事实 |
| --- | --- |
| 正式基线 | `v3.2.12` → `0f890fb2da3546f39e53b82d296694ff30d5db7d` |
| 接手 release | `release/v3.2.13@4d07c3a30f7990d06b2f24f98ef8f58f88c15331` |
| 远端 main | `0f890fb2da3546f39e53b82d296694ff30d5db7d`，已包含在 release 历史 |
| 目标版本／日期 | `3.2.13`／2026-10-21，America/Los_Angeles |
| PR | [#243](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/243)：`release/v3.2.13` → `main`（draft） |
| 合并方式 | 必须使用 merge commit：补登的 policyChanges 以 release 侧提交 `df0f0591` 为来源，squash 或 rebase 后该提交不在 main 历史中，架构检查会失败 |
| 发布要求 | PR 的 smoke-test 与 build 通过，Windows 人工检查完成，合并后 main 检查通过，再于最终 main 创建附注标签并执行发布 |

## 2026-10-27 发布授权

用户明确决定：Windows 人工检查（B26、B27）顺延到 v3.2.14，以 merge commit 合并 PR #243 并正式发布 v3.2.13。发布要求相应改为：PR 最终 head 的 smoke-test 与 build 通过，合并后 main 检查通过，再于最终 main 创建附注标签并执行发布。本版发布时 Windows GUI 与在线升级未经人工确认。

## 纳入范围

| 分支 | 已合入来源 SHA | 合入提交 | 内容 |
| --- | --- | --- | --- |
| `chore/rules-doc-drift` | `f83d5ee1` | `00315b61` | 归档约定改为现行做法，集成清单仅在实质变化时回写 |
| `chore/backlog-carryover` | `89d98f78` | `8de13879` | 遗留项统一登记到 `knowledge/backlog.md`，发版开头读取并清理上一轮遗留 |
| `chore/hotfix-branch-retention` | `ba30c173` | `df0f0591` | 紧急修复路径、分支保留与 draft PR 门禁，删除 v3.2.9 验收 workflow |
| `feat/settings-template-versions` | `838877c63e91365bed6912724c2703c217d49541` | `4d07c3a3` | 设置 → 模板文件开放版本管理（`36054db6`），以及八轮审查修复，见 [TechDoc](feat/settings-template-versions/techdoc.md) 9.3 |

合并 `feat/settings-template-versions` 时的处理：

- 唯一冲突在 `knowledge/backlog.md`，两侧都在「未实施」顶部新增条目。保留全部条目，B31 在上。
- 架构检查发现 release 侧历史快照未被 policyChanges 覆盖，以 `df0f0591` 补登同一放宽后通过。

## 遗留项（清单 B4）

| 编号 | 状态 | 本轮处理 |
| --- | --- | --- |
| B26 | 未做，顺延到 v3.2.14 | 模板文件页的 Windows 实机 GUI 检查，本轮扩大到版本管理的导入、启用、恢复默认与删除，并用 Excel 打开、打印一份重新打包保存的版本文件。本轮没有可用的 Windows 实机，2026-10-27 按用户决定顺延 |
| B27 | 未做，顺延到 v3.2.14 | 已安装旧版经应用内更新升级的人工验收。本轮没有可用的 Windows 实机，2026-10-27 按用户决定顺延 |
| B31 | 顺延，新增 | managed 后台只读导出尚未接入模板版本；生产路径未启用，目标未定 |
| B28–B30 | 目标未定 | 本轮未处理 |

## 审查与处理

模板文件版本管理先由 Claude 审查一轮，再由 Codex 只读复审七轮（每轮都含此前的修复），共修复 40 项，其余发现记为已知限制。逐项问题、修复与每轮验证见 [TechDoc](feat/settings-template-versions/techdoc.md) 9.3，已知限制见第七节。

## 检查与证据边界

- `4d07c3a3`：
  - 本地在合并结果上运行 `release-check`，通过：单测 9687/9691，4 项为既有条件跳过；集成测试 86/86 脚本、3149/3149 断言。
  - [Windows CI](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/39637553376) 通过：`smoke-test` 完整运行 `release-check`（单测 9687/9691、86 个集成脚本），`build` 通过。
- 升版与发布文档提交后的最终候选，本地结果与 Windows 结果记录在 PR #243，不在此预填。
- 真实应用走查在 macOS 上用隔离的 userData 完成；重新打包文件另用 Info-ZIP、Python `zipfile` 与 macOS 快速查看做了独立解析核对。本机未装 Excel，见 TechDoc 9.2、9.3。
- 生产内存档资格沿用 2026-10-02 的人工确认 `manual-v3.2.11-2026-10-02`：清单按执行档 `policyDigest` 授予，不与应用版本比对。本轮未修改执行档，`memory-qualification.json` 保持原样。新增的模板检查 Worker 已登记到原生载体清单。
