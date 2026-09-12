# v3.2.9 本地集成记录

- 目标分支：`release/v3.2.9`。
- 上一正式基线：`v3.2.8` / `2ba9ef14fe972363b604955636cff0c9ac53700f`。
- 本次范围：将业务 OP 自动保存错误报告功能合入本地 release；未推送、升版、创建 PR、正式标签或发布。
- 集成日期：2026-09-12。

## 纳入模块

| 模块 | 源分支 | 纳入提交 | 集成方式 |
| --- | --- | --- | --- |
| 业务 OP 导入错误报告自动保存与状态反馈 | `codex/v3.2.9-biz-op-error-report-auto-save` | `3efe5c78e8cde10d89db90d4509d883b28d61f4f` | 独立 worktree 无冲突合并，保留 merge commit |

源分支原有 20 个未提交文件已核对归属并形成上述提交，包含最后一轮 review 的 renderer 状态反馈修复。源提交内容与保存的快照逐文件一致。主工作区保持 `main` 及既有未提交改动。

## 本次验证

- `UNIT_TEST_CONCURRENCY=2 npm run release-check`：2026-09-12 14:00:55 +08:00 完成，exit 0 / PASS。lint、smoke 通过；470 个单测文件，7,351 PASS / 0 FAIL / 3 SKIP；54 个集成脚本全部通过，汇总 2,500/2,500。
- Electron 原生 DOM：`node scripts/verify-biz-op-v329-renderer-dom.js <本次证据目录>`，10/10 PASS，布局、长路径换行和文本选择检查通过。
- 3 个跳过项均为既有 Windows 专属 PowerShell/packaged canary 测试，本次新增测试没有跳过。
- 本次 [候选摘要与验证结果](codex/v3.2.9-biz-op-error-report-auto-save/integration-candidate-20260912.json)绑定 14 个代码、测试和脚本文件；合并前再次核对全部与源提交一致。测试后仅补充本记录、验证记录、候选摘要及 runner 自动刷新的集成清单。
- 完整日志、DOM 输出与截图保存在本地忽略目录 `logs/verification/release-v3.2.9/biz-op-auto-report/`，日志 SHA-256 已记入候选摘要。日志不随源码提交。
- Windows Excel/WPS 打开报告及完整 Windows 应用人工验收未执行，仍为正式交付前的验收项。

原 `candidate-sha256.json` 与旧验证记录保留为 review 修复前的历史证据；本次结果使用新的候选摘要和日志，不覆盖旧记录。
