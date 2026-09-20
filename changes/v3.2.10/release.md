# v3.2.10 本地集成记录

## application-recovery 合入

本次按用户要求，将 `codex/v3.2.10-application-recovery` 合入 `release/v3.2.10`，范围为 G1 应用恢复阶段与共享发布恢复授权。G2—G8 未因本次合并被标为完成。本记录只确认本地集成，不代表正式发布或平台人工验收通过。

| 项目 | 实际记录 |
| --- | --- |
| 上一正式基线 | `v3.2.9` → `11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 合并前 release | `11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 功能分支 | `codex/v3.2.10-application-recovery` |
| 功能提交 | `856c9dce8ae4c381229e37b5b236e2e2f776921d` |
| 合并方式 | `--no-ff`，无冲突；先完成验证，再创建合并提交 |
| release 工作区 | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| 实际内容 | 源工作区 148 个文件冻结后提交，包含 63 个代码、测试、脚本及规则文件，其余为设计、审查与验证材料 |
| 内容一致性 | 148/148 文件与冻结内容一致；验证前的合并树与功能提交完全一致；最终合并仅额外加入本文和本次验证证据 |
| 范围外操作 | 未推送、未开 PR、未合入 main、未升版、未创建标签或发布 |

源分支原本没有独有提交，本次先核对其未提交实现与既有审查/门禁快照，再提交完整模块成果。主工作区保持 `main`，未修改其文件；源分支提交后工作区干净。原 [实施记录](codex/v3.2.10-application-recovery/implementation-notes.md)、[验证摘要](codex/v3.2.10-application-recovery/evidence/verification-summary.json)和[独立审查](codex/v3.2.10-application-recovery/review-2026-09-20.md)保留实施、审查时点的“未提交/未集成”历史描述，后续本地集成状态以本文及 Git 合并历史为准。

## 验证与证据

本次验证在独立 release 工作区执行，复用现有依赖，仅使用测试创建的临时数据。机器记录见 [merge-validation.json](codex/v3.2.10-application-recovery/evidence/merge-into-release/merge-validation.json)。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| `npm run lint` | PASS，exit 0 | [lint.log](codex/v3.2.10-application-recovery/evidence/merge-into-release/lint.log) |
| `npm run smoke` | PASS，exit 0 | [smoke.log](codex/v3.2.10-application-recovery/evidence/merge-into-release/smoke.log) |
| `node scripts/integration/application-recovery-governance.js` | 4/4 PASS，exit 0 | [application-recovery-governance.log](codex/v3.2.10-application-recovery/evidence/merge-into-release/application-recovery-governance.log) |
| 功能内容与既有门禁快照比对 | 63/63 文件 SHA-256 一致 | [source-snapshot.json](codex/v3.2.10-application-recovery/evidence/source-snapshot.json) |
| 既有独立审查输入比对 | 86/86 原输入 SHA-256 一致 | [input-manifest.json](codex/v3.2.10-application-recovery/evidence/review-2026-09-20/input-manifest.json) |
| 既有完整门禁 | 记录为 PASS：8167 单测通过、0 失败、4 项 Windows 条件跳过，61/61 集成脚本通过；本次未重新运行 | [release-check-final.log](codex/v3.2.10-application-recovery/evidence/release-check-final.log) |

既有完整门禁日志 SHA-256 为 `1558ae58418e94e3db39727df47b6ff2f5c6d9c8b752422b006bf1b22e29fb32`，与独立审查时记录一致。此次目标 release 原为同一基线，没有其他模块组合差异；代码、测试及规则与已验证快照完全一致，因此复用完整门禁证据，没有将本次局部运行写成新的完整门禁 PASS。

## 保留的验收边界

- 真实 Electron 冷启动、Windows 文件锁/安装包/平台耐久性、Excel/WPS 人工验收未执行，4 项 Windows 条件跳过仍保留。
- 既有独立 manifest 检查器的现行 67 actions 与历史冻结 54 actions 冲突已在基线复现，属于完整门禁之外的既有问题；证据见 [manifest-baseline-triage.json](codex/v3.2.10-application-recovery/evidence/manifest-baseline-triage.json)。本次未重写历史发布证据。
- 后续纳入其他模块、修改代码或准备正式发布时，按最终候选及适用规则重新执行受影响检查与正式交付门禁。
