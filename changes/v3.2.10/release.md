# v3.2.10 本地集成记录

当前已纳入 G1 应用恢复、G4 共用 XLSX、G5 BizOP 查询边界、G6 存储与执行分离。下方分批保留各次集成证据；最新组合见「G4/G6/G5 三模块合入」。G2/G3/G7/G8 尚未纳入本次集成。

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

## G4/G6/G5 三模块合入

本次继续按用户指定范围，从已包含 G1 的 `5ccbf3f022488026f725a5111be00422a04ce221` 出发，按 G4 → G6 → G5 顺序本地合并。三个源工作区的实现原本均未提交；先冻结并核对既有审查摘要，再分别提交本模块源码、测试、设计和证据。其他模块、旧版本及相邻需求的设计副本没有纳入提交。

| 模块 | 功能分支 | 功能提交 | 合并提交 |
| --- | --- | --- | --- |
| G4 共用 XLSX 基础设施 | `codex/v3.2.10-shared-xlsx-infrastructure` | `a4d91d173945cc42fcd9593f56504060c98f9d47` | `fd1c95edc239fb544b58c762b8d6eb4e9cb8f401` |
| G6 存储与执行分离 | `codex/v3.2.10-storage-execution-separation` | `ed1cb2d73418fe1279cac96acd91090492555be3` | `dffd6e2aceea8caea3aecc7396cb025a1c693e47` |
| G5 BizOP 查询与归档边界 | `codex/v3.2.10-bizop-query-boundaries` | `e4389aafb07fc3d40c74af106abb2875981d07eb` | `49ac95a80bf884a0bfdc2f53ecbfdb4dd982819e` |

三个合并均为 `--no-ff`。组合源码候选是 `49ac95a80bf884a0bfdc2f53ecbfdb4dd982819e`，其历史包含上述三个功能提交及既有 G1 合并。当前仍为本地集成，未推送、未合入 main、未升版或发布。

### 内容核对与冲突处理

- G4 原独立审查输入 121/121 文件摘要匹配；G6 最终源码快照 23/23 匹配；G5 实施清单 18/18 与独立审查输入 63/63 匹配。
- 实际提交范围分别为 148、109、57 个文件。合并后除明确组合的 AGENTS、生成清单、VCC 两文件和 Main 外，其余模块文件逐字节保持各自冻结内容，见 [内容比对](evidence/merge-g4-g5-g6/composition-audit.json)。
- 源码均自动合并，没有人工选择一侧覆盖另一侧。VCC `review-export-plan.js` 与 `vcc-financial-op-dataset-writer.js` 同时保留 G4 的 reader 路径/有效预算与 G6 的纯 hash/血缘合同；Main 同时保留 G1 恢复装配与 G6 所属 prepare 释放锁的修复。两边原补丁均能在组合内容上通过只读反向适用检查，见 [重叠补丁核验](evidence/merge-g4-g5-g6/overlap-audit.json)。
- 实际冲突仅为 `AGENTS.md` 的模块导航和 `rules/integration-test-policy.md` 的自动生成章节。导航保留全部已落地模块；测试规则第七节以前正文逐字相同，最终清单交给组合集成 runner 全通过后自动刷新，不手填通过数字或放宽规则。
- 主工作区保持 `main@11086a3c`，86 个原未跟踪文件摘要及状态不变。三个源分支已跟踪文件干净，分别保留 8、39、32 个不属于本次模块提交的未跟踪设计副本；这些副本的内容未改变，见 [工作区保留核验](evidence/merge-g4-g5-g6/workspace-preservation.json)。

### 本次组合验证

本次针对组合源码 `49ac95a80bf884a0bfdc2f53ecbfdb4dd982819e` 重新运行 `UNIT_TEST_CONCURRENCY=2 npm run release-check`，**完整 PASS，exit 0**。执行环境为 macOS arm64 / Node v25.8.0，使用独立 release 工作区及测试自行创建的临时文件/数据库。运行时间为 2026-09-20 21:58:30—22:25:08（Asia/Shanghai），约 26 分 38 秒。

| 检查 | 本次实际结果 |
| --- | --- |
| lint | PASS |
| smoke | PASS |
| 完整单测 | 523 个文件，8306 项中 8302 PASS、0 FAIL、0 CANCELLED、4 SKIP |
| 全量集成 | 64/64 脚本通过，runner 可解析的断言汇总为 2657/2657；未提供统一计数的脚本仍按实际 exit 0 判定 |
| G1 应用恢复集成 | 4/4 PASS |
| G4 共享 XLSX 边界集成 | 51/51 PASS |
| G5 BizOP 查询边界集成 | 9/9 PASS |
| G6 Acquiring worker 边界集成 | 14/14 PASS |
| 测试清单 | runner 在全部集成通过后自动更新第七节，规则正文保持不变 |

完整日志见 [release-check.log](evidence/merge-g4-g5-g6/release-check.log)，退出码、时间、计数及日志摘要见 [release-check-result.json](evidence/merge-g4-g5-g6/release-check-result.json)。这次是合并后组合的完整运行，不是汇总各分支旧结果。后续记录提交仅更新本文、版本索引、验证证据和 runner 生成的测试清单；源码、测试、执行脚本及依赖配置的对象保持被测候选一致，见 [validated-input-objects.json](evidence/merge-g4-g5-g6/validated-input-objects.json)。

### 仍保留的边界

- G2/G3/G7/G8 未纳入，尤其 G8 的架构规则尚未在此组合激活。G5 TechDoc 对 G8 TechDoc 的相对链接随 G8 后续集成才在 release 可用，现可从[主工作区 G8 设计](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md)查阅；未为修复链接混入其他分支的设计副本。
- G6 已记录的共享 prepared 包装器第二 gate / initialize 异常未调用 onAbandon 的基线缺口仍属于 G2 后续范围，本次没有把它当作已修复。
- 完整自动门禁不替代 Windows 文件占用/安装包、Electron 真实 GUI 对账/取消/续跑、Excel/WPS 人工验收；本次未进行这些平台验收。
- 原各模块 Spec/TechDoc、实施与审查记录保留其原时点的“未提交/未集成”描述，当前集成事实以本文与 Git 历史为准。现行 67 actions 与历史 54 actions 的独立 manifest 上下文差异继续沿用原证据说明，没有改写历史冻结产物。
