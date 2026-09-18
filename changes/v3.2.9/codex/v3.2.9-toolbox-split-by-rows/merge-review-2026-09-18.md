# 按行拆分合入 release/v3.2.9：集成审查与验证

日期：2026-09-18。结论：候选无文本冲突，针对本次合并的自动化检查通过；本记录不代表完整发布验收通过。

## 范围和改动

- 源分支：`codex/v3.2.9-toolbox-split-by-rows`，原 HEAD `2ba9ef14fe972363b604955636cff0c9ac53700f`。将现有 80 项未提交实现、测试、文档与证据纳入源提交，另显式纳入历史审查文档引用的 14 个被全局日志规则忽略的 `.log` 文件。
- 源内容树：`b9749577bfac66712c7e9ae56d86a252bf451758`。本次未调整源生产代码；最新第三轮复审记录覆盖的 70 个文件内容全部一致，包含 29 个代码、测试和脚本文件。
- 目标分支：`release/v3.2.9`，合并前 HEAD `d3ebded61d277fc814f3e49be3778c2cd3f8c3e0`。在隔离副本完成候选合并与验证。
- 合并提交将 65 个功能文档及证据文件从 `changes/3.2.9/codex/v3.2.9-toolbox-split-by-rows/` 移入本目录，遵循 release 已有目录组织规则；历史文件内容和快照路径原样保留。源分支仍保留原目录。
- 新增 `scripts/integration/toolbox-row-split-archive-delete.js`，覆盖按行拆分与 release 已有归档永久删除能力的组合链路。
- release 原有 18 项未提交改动作为验证叠加层保留，不纳入合并提交。唯一重叠文件为 `src/styles-gemini-extra.css`，使用三方合并保留两侧样式后验证。主工作区不参与切换或提交。

## 关键兼容性检查

未发现需要额外修复的合并冲突：

1. 覆盖确认前冻结 FilePlan，确认后检查 freshness；IPC 复用已授权的规范化计划，不重新捕获目标身份。第三轮复审关闭的覆盖确认保护保留。
2. Worker Publisher 收到冻结计划中的 `expectedTargetParentIdentity`，release 包装路径保留该字段，父目录身份保护没有丢失。
3. FilePlan 同时保留按行拆分所需的线性别名检测，以及归档删除所需的 `expectedSha256`、大小和预生成输出证据。
4. 对外 taskKey 仍为 `toolbox:split:export`，`toolbox:split-rows` 仅作为内部后台动作。沿用 release 的原 owner ACK、持久化 completion 和 receipt 清理链路。

新增组合集成测试使用实际 Main 代码片段、Worker、FilePlan、发布器、SQLite、ArchiveService/Controller：5 行数据按每份 2 行拆为 3 份，回读表头、顺序和前导零；ACK 前永久删除受阻；真实 ACK 后 completion 跨数据库重开持久存在；删除仅移除受管归档副本和 Blob，外部原输入及 3 份正式输出的内容和哈希保持不变。对话框、admission 和流程包装采用夹具，未启动完整业务 Main。

## 本轮验证

完整日志索引：[checks.json](evidence/merge-2026-09-18/checks.json)。

| 检查 | 结果 |
| --- | --- |
| ESLint、smoke | PASS |
| 相关单元测试 | 46 个文件、790/790 PASS，无失败或跳过 |
| 原工具箱回读 | 30/30 PASS |
| 多输入拆分回读 | 17/17 PASS |
| 按行拆分 → owner completion → 永久删除 | 2/2 PASS |
| 隔离 Electron UI | 21 项交互、13 项文案、4 项主题、3 项原生焦点检查 PASS |
| K=1/8/9/30/1000 结果弹窗 | footer 可见可点击，长列表可滚动到尾部，确认后返回工具箱 |
| K=1/8/9/999/1000 容量 | 5/5 PASS，共 2017 份实际生成、发布、逐份回读和 journal 清理 |
| 代码和新增集成脚本差异空白检查 | PASS |

macOS 15.7.4 arm64；主检查使用 Node 24.13.0，新增组合集成及容量脚本使用 Node 25.8.0。首次沙箱内 Electron 在测试开始前 SIGABRT，沙箱外使用隔离 userData 重试通过，两次日志均保留。

容量 1000 档冻结计划 122 ms、总计 40.812 s、Worker 内存峰值约 72.28 MiB、整个验证进程 RSS 峰值约 842.12 MiB、主事件循环最大延迟 127 ms，最大活动 writer 为 1。数据为两列、每份一行的合成输入；数字仅描述该本机夹具。UI 使用真实页面、样式和 renderer 对话框，API 为 mock。

## 验证边界

本轮未重跑完整 `release-check`。源分支历史完整门禁存在 1 项 Main 子进程 30 秒超时，上一轮 release 完整单测同样保留 1 项超时失败；独立复跑通过不抹去原失败记录，本轮相关检查通过也不等同于完整门禁通过。源历史摘要见 [release-check-summary.txt](evidence/release-check-summary.txt)。历史日志中的两行空白原样保留。

Windows、Excel/WPS、完整业务 Main、安装包、极宽样式工作簿和网络卷未验证。此次仅完成本地分支集成，不包含推送或发布。
