# v3.2.10 本地集成记录

当前已纳入 G1 应用恢复、G2 业务任务适配器、G4 共用 XLSX、G5 BizOP 查询边界、G6 存储与执行分离。下方分批保留各次集成证据；最新组合见「G2 business-task-adapters 合入」。G3/G7/G8 尚未纳入本次集成。

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

## G2 business-task-adapters 合入

2026-09-21，按用户要求将 `codex/v3.2.10-business-task-adapters` 合入既有 release；之前 G1/G4/G5/G6 成果全部保留。源工作区以 G1 合并提交 `5ccbf3f022488026f725a5111be00422a04ce221` 为固定依赖，交付实现原本未提交。本次将本模块 114 个文件冻结提交，保留该工作区 29 个无关未跟踪设计副本。

| 项目 | 实际记录 |
| --- | --- |
| 合并前 release | `320d20df68bdeb175060ed37513a2fe5f23436bc` |
| G2 功能提交 | `3e203858ea49fc2935f5ab847de8af7f793d356a` |
| 合并提交 / 受验组合 | `8b12a6d5fd71b70ade58b9b6e7a347e29dbe8d05` |
| 合并方式 | `--no-ff`；代码自动合并，导航及生成清单冲突按下述方式处理 |
| release 工作区 | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |

### 本批内容与组合核验

- G2 最新启动补测快照 46/46 SHA-256 与冻结源一致；其旧完整门禁及后续 63/63 集成记录作为来源证据保留，不冒充此次组合运行。
- Main 自动合并结果精确等于 G2 Main 加上既有 G6 worker failure listener 锁所有权修复。公共任务入口迁入 task adapter 与 prepared resource scope，G1 恢复依赖保留；第二 gate / Archive initialize 抛错后的 onAbandon 收口由 G2 对应回归覆盖。
- 除 AGENTS、版本索引、测试清单和 Main 外，G2 110 个文件逐字节一致；此前 release 的 317 个非交集文件保持原内容。见 [组合核验](evidence/merge-g2/composition-audit.json)。
- 仅两处冲突：`AGENTS.md` 同时保留 XLSX 与任务适配器入口；`integration-test-policy.md` 第七节前的规则正文一致，先保留 release 旧生成清单，最终由全部集成通过后的 runner 自动刷新。版本索引同步所有已集成模块。
- 主工作区保持 `main@11086a3c`，原 97 个未跟踪文件的内容不变；G2 源工作区的 114 个模块文件和 29 个范围外设计副本均保持冻结字节。见 [工作区保留核验](evidence/merge-g2/workspace-preservation.json)。

### 本批组合验证

`UNIT_TEST_CONCURRENCY=2 npm run release-check` 对上述合并提交完整执行，**PASS，exit 0**。环境为 macOS arm64 / Node v25.8.0；2026-09-21 00:07:51—00:26:03（Asia/Shanghai），约 18 分 12 秒。

| 检查 | 本次实际结果 |
| --- | --- |
| lint / smoke | 全部 PASS |
| 完整单测 | 530 个文件，8439 项中 8435 PASS、0 FAIL、0 CANCELLED、4 Windows 条件 SKIP、0 TODO |
| 全量集成 | 66/66 脚本通过；可解析的断言汇总 2664/2664，单个未输出计数的历史脚本按 exit 0 判定 |
| G2 prepared 资源回归 | 第二 gate、Archive initialize、adapter 构建、生命周期拒绝、延迟 cleanup / exit tail 等实际入口测试通过 |
| G2 task-adapter recovery | 4/4 PASS |
| G2 production Position startup recovery | 3/3 PASS |
| G1 / G4 / G5 / G6 专项集成 | 应用恢复 4/4、共享 XLSX 51/51、BizOP 查询边界 9/9、Acquiring worker 边界 14/14，均 PASS |

四项跳过为真实 Windows PowerShell/CIM 及 packaged canary 场景；具体名称见 [单测摘要](evidence/merge-g2/unit-summary.json)。

完整日志见 [release-check.log](evidence/merge-g2/release-check.log)，运行环境、起止时间、退出码及摘要见 [release-check-result.json](evidence/merge-g2/release-check-result.json)。记录提交仅同步版本状态、证据和 runner 生成的测试清单，源码、测试、执行脚本及依赖对象与受验组合一致，见 [validated-input-objects.json](evidence/merge-g2/validated-input-objects.json)。

### 本批状态与验收边界

- 当前已集成 G1/G2/G4/G5/G6；G3/G7/G8 未纳入。G2 的 `ARCH-TASK-ADAPTER` 机器规则激活仍待 G8 后续联合验收，现有 composition 单测和完整门禁不代替该激活。
- 上批记录中归属 G2 的 prepare 后第二 gate / initialize 资源清理缺口已由本批实现及对应回归承接；上方旧记录保留其当时状态。
- 真实 Electron 进程强杀与 GUI、Windows 文件锁及安装包、Excel/WPS 人工验收未执行；确定性 Node 恢复集成不等同这些平台验收。
- G2 原 Spec/TechDoc、实施与审查证据保留历史“未提交/未集成”及分轮验证描述，当前集成事实以本节和 Git 历史为准。原独立 manifest 现行与历史 actions 上下文差异保持原记录。
- 本次仅本地合并，未推送、未开 PR、未合入 main、未升版、未创建标签或发布。
