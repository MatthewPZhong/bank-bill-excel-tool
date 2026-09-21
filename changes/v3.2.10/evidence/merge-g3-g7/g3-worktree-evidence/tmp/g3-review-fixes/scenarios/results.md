# R03 / R05 专项修复证据

基线 HEAD：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`。对象为功能 worktree 当前未提交实现；仅修改 `src/renderer/controllers/bank-statement.js`、`recon-id-fix.js`，新增 `tests/unit/renderer/scenario-controller-feedback.test.js`。原审查报告、原反例、既有服务/路由测试及总实施记录均保留。

- 修前备份：`../before/scenarios/`；前后 SHA-256：`before-snapshot.json`、`after-snapshot.json`。
- 本次生产补丁：`controllers.patch`。
- 原审查反例：修前 0/3 PASS（`before-probes.log`），修后 3/3 PASS（`after-probes.log`）。
- 新增回归：修前 15/35 PASS、20 FAIL（`before-regression.log`），修后 35/35 PASS（`after-regression.log`）。
- 专项回归：新反馈35＋既有Main/Preload/SQLite/controller31＋service44＋状态框22＝132/132 PASS（`focused-regression.log`）。
- ESLint：两控制器及新测试通过，0错误/警告（`lint.log`）。

R03 每次从busy、当前类别和该类别的可选场景完整计算disabled；不读取旧disabled作为业务资格。R05 仅在命中确定失效时标记结果反馈待重绘，隐藏时不写DOM；下次成功状态读取按Main事实补绘后才清标记。失败读取不吞标记；resync不伪造确定清空，未命中域和无变更关闭不标记。

| 场景 | 数量 | 验证 |
|---|---:|---|
| Recon import/run/export × 成功/失败/取消/reject | 12 | 在途禁用；单次命令；结算后恢复可选资格 |
| 无可选场景、列表失败、类别不匹配 | 3 | busy收尾仍保持禁用 |
| 隐藏Bank/Recon × 批删/空applyImport/Bank create/Recon create/Bank resync/Recon resync/仅关闭/明确失败/渠道写 | 18 | 隐藏不写DOM；重入Main结果、导出按钮、已导出反馈一致；未命中域保持 |
| 隐藏Bank/Recon确定失效→重入读取失败→静默重读成功 | 2 | 错误可见；成功恢复时待重绘事实未丢失 |

验证命令均在 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries` 执行，证据为受控面板＋真实控制器、命令服务、路由、共享会话、当前Main handler与实际Preload场景/渠道映射、内存SQLite。导出API只提供合成前置反馈，未生成业务文件。本次没有修改Main/Preload/持久化契约，没有执行完整门禁、真实Electron界面、Windows/Excel/WPS验收或提交操作。

规则入口：项目 `AGENTS.md`、`CODEX.md` 验证与风险审查；G3 Spec §5及AC13/15/19/20、TechDoc §6；`changes/v3.2.10/codex/v3.2.10-renderer-boundaries/review-2026-09-20.md` 的R03/R05。
