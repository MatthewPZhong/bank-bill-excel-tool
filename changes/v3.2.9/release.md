# v3.2.9 本地集成记录

- 目标分支：`release/v3.2.9`。
- 上一正式基线：`v3.2.8` / `2ba9ef14fe972363b604955636cff0c9ac53700f`。
- 本轮已纳入范围：业务 OP 自动保存错误报告、按模块配置存档保留期限；仅进行本地 release 集成，未推送、升版、创建 PR、正式标签或发布。
- 集成日期：2026-09-12。

## 纳入模块

| 模块 | 源分支 | 纳入提交 | 集成方式 |
| --- | --- | --- | --- |
| 业务 OP 导入错误报告自动保存与状态反馈 | `codex/v3.2.9-biz-op-error-report-auto-save` | `3efe5c78e8cde10d89db90d4509d883b28d61f4f` | 独立 worktree 无冲突合并，保留 merge commit |
| 按模块配置存档保留期限与保存队列保护 | `codex/v3.2.9-archive-retention-by-module` | `a2bd6e817a08190e82caecfe4f248054b25cae6e` | 基于首次集成结果继续合并；生产代码无冲突，自动测试清单由 runner 重建 |

Biz OP 源分支原有 20 个未提交文件已核对归属并形成上述提交，包含最后一轮 review 的 renderer 状态反馈修复。源提交内容与保存的快照逐文件一致。主工作区保持 `main` 及既有未提交改动。

## 首次 Biz OP 集成验证（896fe12d）

- `UNIT_TEST_CONCURRENCY=2 npm run release-check`：2026-09-12 14:00:55 +08:00 完成，exit 0 / PASS。lint、smoke 通过；470 个单测文件，7,351 PASS / 0 FAIL / 3 SKIP；54 个集成脚本全部通过，汇总 2,500/2,500。
- Electron 原生 DOM：`node scripts/verify-biz-op-v329-renderer-dom.js <本次证据目录>`，10/10 PASS，布局、长路径换行和文本选择检查通过。
- 3 个跳过项均为既有 Windows 专属 PowerShell/packaged canary 测试，本次新增测试没有跳过。
- 本次 [候选摘要与验证结果](codex/v3.2.9-biz-op-error-report-auto-save/integration-candidate-20260912.json)绑定 14 个代码、测试和脚本文件；合并前再次核对全部与源提交一致。测试后仅补充本记录、验证记录、候选摘要及 runner 自动刷新的集成清单。
- 完整日志、DOM 输出与截图保存在本地忽略目录 `logs/verification/release-v3.2.9/biz-op-auto-report/`，日志 SHA-256 已记入候选摘要。日志不随源码提交。
- Windows Excel/WPS 打开报告及完整 Windows 应用人工验收未执行，仍为正式交付前的验收项。

原 `candidate-sha256.json` 与旧验证记录保留为 review 修复前的历史证据；本次结果使用新的候选摘要和日志，不覆盖旧记录。

## 模块保留期限组合验证

- 本次合并前 release 为 `896fe12d29e518ccece8afce5c3d120b1c6de5c7`，源分支 22 个文件与其最新完整门禁及复审摘要逐项一致，已提交为 `a2bd6e81`。
- `src/main.js` 自动合并保留了模块期限 resolver、维护 IPC 和 Biz OP 自动报告的既有注入。唯一文本冲突是自动集成测试清单，规则正文没有冲突。
- 合并后的 Electron 设置布局与交互 6/6 PASS，覆盖两种尺寸及三档缩放；Biz OP 原生 DOM 10/10 PASS。
- 新增 `scripts/integration/archive-biz-op-auto-report-retention.js`，真实组合回归 6/6 PASS：OP/FLOW 模块有限期限、永久和继承、历史批次期限不变、双向修改设置后的未决归档恢复，以及真实 INPUT hold 和 Documents 报告保护。该脚本使用现有 fixture 的装配入口，没有修改生产源码或公共 helper。
- 组合完整命令 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 于 2026-09-12 14:26:40 +08:00 完成，exit 0 / PASS：lint、smoke 通过；471 个单测文件，7,361 PASS / 0 FAIL / 3 SKIP；56 个集成脚本全部通过，汇总 2,516/2,516。其中模块期限 10/10、Biz OP 自动报告 12/12、组合回归 6/6。
- 自动集成清单由本次全量 runner 成功后重新生成，包含两个模块及新增组合脚本，未手工拼接运行数字或改动规则正文。
- 本次 [组合候选摘要与验证结果](codex/v3.2.9-archive-retention-by-module/integration-candidate-20260912.json)绑定 29 个代码、测试和脚本文件，门禁后再次核对全部一致。最终补充仅为验证记录和摘要。
- 当前组合日志及 DOM 截图位于本地忽略目录 `logs/verification/release-v3.2.9/archive-retention-integration/`，日志 SHA-256 已记入候选摘要，不随源码提交。首次 Biz OP 集成记录和源模块的历史验证证据保留。
- Windows、Excel/WPS、安装包及真实业务人工验收仍未执行。
