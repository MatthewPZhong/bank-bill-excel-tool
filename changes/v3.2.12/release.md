# v3.2.12 发布与集成记录

## 2026-10-13 正式发布准备

用户明确授权升版到 3.2.12、更新三份发布文档，提交后推送 `release/v3.2.12`，由 PR 的 Windows CI 检查最终候选。合并 PR、创建附注标签和正式发布尚未授权，须另行确认。

| 项目 | 冻结事实 |
| --- | --- |
| 正式基线 | `v3.2.11` → `52b92b55c3d91f7a431ff62419e8712a6ed1774e` |
| 接手 release | `release/v3.2.12@3af7492f1aafc20d34057a2ee926b2f00da5ef54` |
| 远端 main | `52b92b55c3d91f7a431ff62419e8712a6ed1774e`，已包含在 release 历史 |
| 目标版本／日期 | `3.2.12`／2026-10-13，America/Los_Angeles |
| PR | [#242](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/242)：`release/v3.2.12` → `main` |
| 合并方式 | 必须使用 merge commit：补登的 policyChanges 以 release 侧提交 `fa89dec2` 为来源，squash 或 rebase 后该提交不在 main 历史中，架构检查会失败 |
| 发布要求 | PR 的 smoke-test 与 build 通过，合并后 main 检查通过，再于最终 main 创建附注标签并执行发布 |

## 纳入范围

| 分支 | 已合入来源 SHA | 合入提交 | 内容 |
| --- | --- | --- | --- |
| `chore/claude-migration` | `a93c9c6ee7050f32d5477b2c3f395d267d58e074` | `741bfa91` | Claude Code 沿用 AGENTS/CODEX 协作规则，清理已停用流程的残留引用；只涉及协作规则与文档 |
| `fix/bizop-upgrade-startup` | `fda7899496fa03ea8f5f927b32a940e2837402c3` | `fa89dec2` | 业务 OP 升级检查有界等待、准入诊断与旧格式月度文件兼容 |
| `feat/settings-template-files` | `d5427b261d09461170bb0ecc55646b063bc4780c` | `aae34038`、`132c8939`、`3af7492f` | 设置「模板文件」页（`39a70c74`）及两轮审查修复（`0af79568`、`d5427b26`） |

无顺延分支：本地没有基于 v3.2.11、尚未合入本分支的模块分支。

## 审查与处理

| 来源 | 意见 | 处理 |
| --- | --- | --- |
| 同事审查 | P2 读取失败被缓存；P2 激活模板后键盘焦点丢失 | `0af79568` 修复；同类的切换 Sheet、跳转关联模板丢焦点一并修复 |
| Codex 自动审查（PR #242） | P1 删除补登的 policyChanges；P2 另存为覆盖失败会截断原文件 | P1 不适用：该检查基于压成单父提交的历史，真实合并历史上删除该记录会报 5 处 `ARCH-POLICY-HISTORY`，已在讨论中说明并标为已解决。P2 由 `d5427b26` 修复 |
| Codex 复核 | 同上 P2；P3 首次加载期间搜索未定位到命中的工作表 | `d5427b26` 修复；列表返回前不执行筛选，保留加载提示 |

## 检查与证据边界

- `132c8939`：本地 lint、架构检查、smoke 通过，单测 9631/9635（4 项既有条件跳过）。完整集成测试两轮各 84/85，失败脚本不同（`toolbox-rows-csv-admission`、`toolbox-biff8-admission`），均为本机可用内存低于 64 MiB 触发的 `EXECUTION_SYSTEM_MEMORY_PRESSURE`，单独复跑均通过。[Windows CI](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/38438743846) 的完整 `release-check` 通过（85/85 集成脚本），`build` 通过。
- `3af7492f`：本地受影响检查通过（lint；架构检查对比 `52b92b55`；模板相关单测 77/77；另存为集成 7/7；Renderer 生命周期 `template-files` 15/15）。[Windows CI](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/38500177998) 的完整 `release-check` 通过（单测 9631/9635、85/85 集成脚本），`build` 通过。
- 升版与发布文档提交后的最终候选，其本地与 Windows 结果记录在 PR #242，不在此预填。
- 生产内存档资格沿用 2026-10-02 的人工确认 `manual-v3.2.11-2026-10-02`：清单按执行档 `policyDigest` 授予，不与应用版本比对。本轮未修改执行档，`memory-qualification.json` 保持原样，其中的 `releaseVersion` 记录的是该次人工验收针对的版本。
- 未做 Windows GUI 人工检查（设置 → 模板文件的浅色、深色与最小窗口），也未做已安装旧版的在线升级人工验收。本机 macOS 可用内存低，`npm start` 会被业务 OP 升级预检拒绝；模板文件页的真实应用验证是在临时副本中固定内存采样后完成的。
