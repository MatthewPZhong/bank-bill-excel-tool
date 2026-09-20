# G1 实施审查记录

审查日期：2026-09-20。审查对象为 `codex/v3.2.10-application-recovery`、`HEAD=11086a3cbf632a30adbcfa796e4cd81810c5aef9` 加当前未提交差异，工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-application-recovery`。未提交、推送、合并或发布。实现过程中并行修复已反映在下文状态；本记录不把设计审查结论用作实现验证。

本轮先读取 Spec/TechDoc，再审查由其他实施者修改的 Archive owner、共享 helper、dispatcher 和 Main 真实接线；应用阶段代码同时纳入核对。审查者此前实现了应用阶段模块，因此本记录将该部分视为作者复核，Archive owner/生产调用方发现则来自跨实现者审查。审查期间新增 producer 回归测试及本文；后续按明确分工迁移了两份过时的 Main 接线测试，见文末记录。未编辑业务代码。

## 当前结论

本轮记录的 **R1、R2、R3、R4 均已修复并验证关闭**：两个生产身份合同缺陷由真实临时 SQLite producer 测试覆盖；E09-C seam 已迁移为显式受控发布注入；最后发现的历史 prepared 普通对象发布旁路已用私有 provenance 封闭，并独立复测两条专项回归通过。当前已审查的生产接线、Archive ack 证明、三阶段汇总、应用 ready 顺序和 prepared 发布授权范围内，没有具体未关闭代码缺陷。

**主实施者在本轮独立审查关闭后完成最终完整门禁：exit 0 / PASS。** 单测 8167 passed、0 fail、4 Windows 专属条件跳过；全量 61/61 集成脚本通过，其中 Archive 扩展 52/52。初次磁盘阻塞及失败日志保留为历史证据；下文各轮审查只代表其标明时点，最终状态见[实施记录](implementation-notes.md)。这不替代真实 Electron/Windows 人工验收。

## Findings 与处理状态

### R1 / P1：遗漏 Position 两个真实 shared Publisher producer

- 原触发路径：Main 的 `position-reconciliation:run:export` 和 `position-reconciliation:run:export-filtered` 在 managed export 开启时调用 `executeManagedPositionReadOnlyExport` → `publishReadOnlyExportArtifacts` → `publishToolboxArtifacts`。持久 moduleId 为 `position-reconciliation-process`。
- 原缺陷：Archive owner 仅登记原十二项 publication-only task 及 ReconID/NewAccount。合法 Position committed journal 在 identify 阶段返回 `not-owned`，实时 ack 失败；保留的 receipt 随后使同根新发布或启动失败关闭。
- 精确范围：`bank:export`、`linked:export`、`raw:export`、`source:export-anomaly` 当前仍走旧 service，不因同属 Position 而获得 publication owner 授权。
- 初始证据：真实临时 SQLite 中已建立 exact-7、succeeded Task/batch 和 ready 输出附件，Position `run:export` 的 `owner.identify()` 仍返回 `not-owned`。
- 修复：`src/main-process/publication-recovery/archive-owner.js` 的静态表仅补上述两个真实 producer；Task/batch、manifest 附件、摘要、终态证明仍由原 Archive repository/service 提供，不将它们混入 publication-only completion 列表。
- 状态：**已修复，定向验证通过**。新 producer suite 对两个入口逐一证明 `observe-committed` / `ack-stage` / `ack-finalize`；错误 role、sourceOperation、hash 和 Task 终态冲突均 `defer`、permission=null。

### R2 / P1：NewAccount 原 manifest role/sourceOperation 被通用映射覆盖

- 原触发路径：`new-account/artifact-copy.js` 的 E10-B FilePlan 使用 `new-account-source-artifact`、`new-account-save-as-output`，两者 sourceOperation 为 `new-account:save-as`，其 Archive taskKey 为 `new-account:export`。
- 原缺陷：Archive owner 用 `toolboxRecoveryInputFiles` / `toolboxRecoveryOutputFiles` 构造通用 input/output 身份，输出 sourceOperation 也变成 taskKey。因此两个 ready 附件和 succeeded Task/batch 均已耐久时，合法 ack 仍 `TOOLBOX_ARCHIVE_HANDOFF_INCOMPLETE`；receipt 不能确认。之前使用 synthetic owner 的 NewAccount 测试未覆盖真实 Archive owner 的合同。
- 初始证据：真实临时 SQLite probe 返回 `identify.ownerId=archive-publication`，但 authorize 为 `defer`，detail 为“第 1 个归档附件尚未 ready”；原附件实际均 ready，role/sourceOperation 与 E10-B 真实 producer 一致。
- 修复：新增 manifest proof provider，以持久 manifest 和 exact-7 核对 Task/batch succeeded、完整 artifactKeys、方向、路径、role/sourceOperation、blob hash/size。NewAccount 显式沿用原两个 role 和 `new-account:save-as`；其他 producer 保持原 input/output 与 sourceOperation，未移除身份检查。
- 状态：**已修复，定向验证通过**。新 suite 正向授权，并证明分别修改输入/输出 role、来源、hash 或 Task 终态时拒绝 cleanup。

### R3 / P2：E09-C 原默认 journalPublisher 直接调用无 authority 的 prepare

- 原位置：`src/main-process/statement-worker/publication.js` 的 `journalPublisher()` 原先直接调用 `prepareToolboxPublication()`，没有受控 dispatcher preflight/worker authority。
- 初始失败：共享 core 收紧后，原默认成功路径抛 `PUBLICATION_RECOVERY_AUTHORITY_REQUIRED`；原成功与 rollback 合同测试失败。精确复现日志 [g1-review-statement.log](evidence/g1-review-statement.log) 保留，不用后续成功覆盖。
- 范围边界：当前 `src/main.js` 未调用此 E09-C seam，本轮没有据此认定生产账单导出受损。但这是仓库已有导出接口与完整单测的真实兼容回归，不能将两条失败测试当作无关环境失败。
- 修复：移除该 seam 对 raw prepare/publish 的直接依赖；`journalPublisher()` 接收显式 `publishPublication`，`validateAndPublishStatementGeneration()` 传递该依赖。缺少注入时在 Publisher 执行前抛 `PUBLICATION_RECOVERY_AUTHORITY_REQUIRED`，带 `preserveTemporaryFiles=true`；外围既有 finally 遵守该标志。测试显式使用专用 authority helper，生产 core 没有无 authority 放行。当前 Main 仍未启用 E09-C seam。
- 状态：**已修复，精确复测通过**。原两条复现用例 **2/2 PASS、0 skipped、exit 0**；另独立运行缺 authority 用例 **1/1 PASS、0 skipped、exit 0**。后者直接断言错误与保留标志；其名称中的文件保留/无 journal 范围结合 seam 代码审查确认，不将空 artifact fixture 当作真实文件保留集成测试。

### R4 / P1：plain prepared 对象可重新发布历史 journal，绕过本次 owner 授权

- 原触发路径：调用公开的 `publishPreparedToolboxPublication({ taskId, userDataDir, journalPath })`，指向 crash 后的历史 prepared journal。原实现缺少 private provenance 时回退到 `createRuntime()`，只凭持久字段继续发布，未要求本次成功 prepare 或 owner recovery 授权。
- RED 证据来源：publisher_authority 实施者在同一 worktree 先运行 `node --test --test-name-pattern='plain prepared' tests/unit/main-process/publication-recovery-owner.test.js`，实际 **tests 1 / pass 0 / fail 1**，在 `publication-recovery-owner.test.js:270:10` 得到 `AssertionError [ERR_ASSERTION]: Missing expected exception.`（actual undefined、operator throws）。普通对象未被拒绝，历史任务实际进入发布。该次 RED 仅保存于实施者当时的工具输出，未落盘为日志文件；本段是实施者提供的复现记录，本审查者没有回退源码重造 RED。初始失败与修复后的独立复测分开记录，不将 GREEN 日志充作 RED。
- 修复：成功且已授权的 prepare 将返回对象登记在模块私有 `WeakMap`，保存原 taskId、root、journalPath、runtime 和 reservations。publish 在读取 journal 前要求原对象的登记、单次消费登记，再核对 task/root/journal scope；plain/复制/重复消费对象报 `PUBLICATION_RECOVERY_AUTHORITY_REQUIRED`，scope 重绑定报 `PUBLICATION_RECOVERY_GRANT_INVALID`，错误保持临时材料。旧 runtime 默认回退已移除。
- 独立复测命令：`node --test --test-name-pattern='plain prepared 对象|成功 prepare 的私有 provenance' tests/unit/main-process/publication-recovery-owner.test.js`。结果 **2/2 PASS、0 skipped、exit 0**，日志 [g1-review-r4-provenance-final.log](evidence/g1-review-r4-provenance-final.log)。
- 覆盖：真实临时根中的历史 prepared 普通对象拒绝；成功 prepare 返回值复制后拒绝；原对象合法发布一次；再次使用拒绝；原对象改 taskId 后拒绝。拒绝前后 index、journal、staged、backup、target 五类材料的存在性/内容 hash 一致。没有改业务源码或扩大重跑整套测试。
- 状态：**已修复，独立定向验证关闭**。原 production worker 继续使用同一调用栈中刚 prepare 成功的原对象；这项关闭结论不消除完整门禁和磁盘环境导致的集成缺口。

## 审查覆盖与未发现新增问题的边界

- Main 启动绑定 owner authority 后再执行 BizOP preflight，应用 composition 冻结 participant 顺序；Archive Controller 仍负责 owner 独立尝试、post-owner outbox、flow/interrupted/artifact 收口、post-outbox。Archive Promise 成功后才调用应用完成断言；平台扫描与业务 recoveryReady 继续分离。Duplicate gate 仍核对原 exact scope Hold。
- 公共 coordinator 先全根 identify，未知/冲突在 execute worker 前拒绝；ack IDs 必须属于本次 requested tasks 且不能跨 owner。dispatcher 的 publish preflight 和 transport-error 共用当前 FIFO 内部 primitive，不重入 enqueue。
- Archive helper 要求完整 summary；三阶段结果保留 deferred/skippedActive，各 observation 独立留存，不合并成虚构 snapshot；只有后续同 owner/task 的明确 commit-cleanup 才移除该未决。live 请求未决时不推进 settlement/ack，startup 自身 owner 未决时阻断并保留证据。
- publication-only completion 的 `afterTerminal:null` 是原合法事实，不能按 truthiness 拒绝。实施者已将 proof 校验改为 terminalStatus、archiveInstanceId 与完整 owner 一致；本轮阅读确认该修复，原组合用例及该修复的专项运行证据由负责实施者记录。
- 未生产启用的 mature adapter 必须显式注入受控 facade，Main/runtime 接线由主实施者补齐；production flag 保持原值。这里不把未启用 seam 的装配当作已完成生产 UI 验收。

## 本轮新增或执行的证据

全部命令工作目录均为上述独立 worktree；只使用临时目录、临时 SQLite 和合成文件，没有读取真实业务数据。

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 初始 Position/NewAccount Archive owner probe | 复现 R1 `not-owned`、R2 `defer` | 本文各 finding 的实际返回值；probe 只构造临时 Archive facts |
| 修复后两个 owner probe，含 Task 终态冲突 | 正向均 `ack-finalize`；冲突均 `defer` / null permission | [g1-review-owner-recheck.json](evidence/g1-review-owner-recheck.json) |
| `node --test tests/unit/main-process/publication-recovery-producer-contracts.test.js` | **3/3 PASS，0 skipped，exit 0** | [g1-review-producer-contracts.log](evidence/g1-review-producer-contracts.log)；[新增测试](../../../../tests/unit/main-process/publication-recovery-producer-contracts.test.js) |
| R3 初始精确复现：`node --test --test-name-pattern='现有journal Publisher\|all scope全量0输出' tests/unit/main-process/statement-generation-e09-c.test.js` | **2/2 FAIL，exit 1**，错误来自缺 authority（历史失败） | [g1-review-statement.log](evidence/g1-review-statement.log) |
| R3 修复后重跑上述同一精确命令 | **2/2 PASS，0 skipped，exit 0** | [g1-review-statement-final.log](evidence/g1-review-statement-final.log) |
| `node --test --test-name-pattern='disabled Statement Publisher seam' tests/unit/main-process/statement-generation-e09-c.test.js` | **1/1 PASS，0 skipped，exit 0** | [g1-review-statement-authority-final.log](evidence/g1-review-statement-authority-final.log) |
| `git diff --check` | **exit 0** | [g1-review-diff-check-final.log](evidence/g1-review-diff-check-final.log)（无错误输出） |

本轮没有重跑所有已有内部单测，避免把同一套用例重复运行当作独立覆盖。整体 release-check、真实 Electron 隔离冷启动、Windows 文件锁及真实平台持久性不在本报告 PASS 范围。

## 审查快照摘要

HEAD 相同的 dirty 工作仍可能继续改变。下表为生成本文时关键文件内容的 SHA-256；后续修改影响结论时须追加修复/复测结果，不将本文时间点冒充最终冻结状态。

| 文件 | SHA-256 |
| --- | --- |
| `src/main-process/publication-recovery/archive-owner.js` | `4759ea8f7df2ccefda2555a4d52f2a8fd139a2cc5fbe1b5f7f688ccf45bd581c` |
| `src/main-process/publication-recovery/coordinator.js` | `b939ae75bbedcccd60ca18e466095ae4ce0dcc3cdb63ca361a2d577ee6828147` |
| `src/main-process/toolbox-archive-recovery.js` | `b2f4a88a7596bb35d0d38e2a4688ac796f33773bf02a0ca99127b7e0d3c64bda` |
| `src/main-process/toolbox-output-publication-dispatch.js` | `c691f97b82b1112faba935135e34612c051c6c24021a73d672180500a93956a3` |
| `src/main.js` | `ec9e3a80a784e48bcae74bdc5a2f85fde43cdd78d4c5ebf58db9d442aa8d7034` |
| `src/main-process/statement-worker/publication.js` | `6204ebc7f73b28a2dfabc3cc49a86bf0bcaa92d4cfa46fdf52f215a6f13e5ab4` |
| `tests/unit/main-process/publication-recovery-producer-contracts.test.js` | `9da25d3c4567d9fa9cae6d89ebf179275d0abe82f6d155d628185e72641481f5` |

## 关闭复核快照

R3 修复后的精确复测由本审查者独立执行，未扩大为整套 Statement 测试重跑。R1/R2 涉及的 Archive owner、公共 coordinator、Archive helper、dispatcher、Main 和 producer 回归测试与上表 SHA-256 相同，故沿用已实际运行通过的 3/3 真实 SQLite 证据，不重复运行相同版本用例。

上表是本文首次写入时的并行工作目录快照，不能反推为初始失败时源码快照：Statement seam 的修复已在首次摘要生成时落盘，但当时尚未完成本审查者复测。关闭时再次核验 Statement SHA-256 仍为 `6204ebc7f73b28a2dfabc3cc49a86bf0bcaa92d4cfa46fdf52f215a6f13e5ab4`；对应 `tests/unit/main-process/statement-generation-e09-c.test.js` 为 `bccf206785ade924330ba36a8fb3c2dd387003b708f95f2af43df9da20cc6646`。历史失败、修复后结果和快照时点已分别记录。

R3 关闭时状态：R1 已关闭、R2 已关闭、R3 已关闭；后续追加发现 R4，最终状态见下节。

## R4 关闭与门禁缺口复核

R4 的 core SHA-256 为 `b5f71e9e32f84cd558041c3607ccf6357307e6a24280c1a5423130c76edf1dd1`；`tests/unit/main-process/publication-recovery-owner.test.js` 为 `b4ca850fa2c71b4719bb1bf91ebdb935db884916e548cec8b3fa2d08671c3b5c`。本审查者仅重跑上述两条 provenance 回归，结果记录在 [g1-review-r4-provenance-final.log](evidence/g1-review-r4-provenance-final.log)；`git diff --check` exit 0，日志 [g1-review-r4-diff-check.log](evidence/g1-review-r4-diff-check.log) 无错误输出。

[扩展 Archive 集成日志](evidence/archive-center-permanent-delete.log) 保留了 15 项 PASS 后的 `PositionReconciliationError: 平盘导入可用磁盘空间不足，未修改现有数据` 和 `15/52 PASS` 汇总。本审查者读取核实该失败日志，未重跑扩展集成或完整 release gate；剩余 37 项不记 PASS。完整门禁没有取得最终 PASS，完整失败处置见实施记录；最终集成状态以 [实施记录](implementation-notes.md) 及后续实际执行证据为准。

最终审查状态：R1、R2、R3、R4 均已关闭；在本文明确审查范围内，没有具体未关闭代码缺陷。完整门禁、扩展集成与平台验收仍存在上述未完成项。

## 完整门禁暴露的旧 Main 接线测试迁移

完整门禁运行期间，主实施者授权迁移 `tests/unit/main-startup-contract.test.js` 与 `tests/unit/renderer-pre-fund-reconciliation.test.js` 中的旧内联编排断言。本审查者先独立复现，两文件 **13 PASS / 2 FAIL**：VCC 用例仍要求 Main 存在内联 `postOutboxStartupHooks: [{`；PreFund 用例仍按 Main 中的四个 `ownerName` 文本位置判断顺序。实际编排已迁移到公开 application composition，失败来源是旧接线测试未随契约迁移，而非已证明的运行时顺序错误。

本次只修改两个测试文件，保留 run/export 血缘断言，并将恢复顺序验证落到 `createApplicationRecoveryComposition()` 的公开 `archiveOwnerHooks()` / `postOutboxHooks()`：

- VCC terminal 位于 owner 阶段，lineage 不提前执行；post-outbox 的 BizOP activation → VCC lineage 顺序固定，两次调用返回 hooks 仍只执行一次成功的 lineage gate。
- 完整 owner 表保持固定顺序；实际执行证明 Pending → legacy Biz → PreFund → Position，重复取 hooks 后成功 owner 不重复调用。Main 每项真实 callback 映射仍须唯一，并要求 Archive await → 应用完成断言 → PreFund startup cleanup。
- Main 初始化仍禁止重复直接调用 VCC lineage；测试没有移除旧业务要求或增加生产放行。

准确复现/复测命令（工作目录始终为文首 worktree）：

```sh
node --test tests/unit/main-startup-contract.test.js tests/unit/renderer-pre-fund-reconciliation.test.js
./node_modules/.bin/eslint tests/unit/main-startup-contract.test.js tests/unit/renderer-pre-fund-reconciliation.test.js
```

证据：[迁移前日志](evidence/startup-prefund-contract-initial.log) **13 PASS / 2 FAIL、exit 1**；[迁移后日志](evidence/startup-prefund-contract-final.log) **15/15 PASS、0 skipped、exit 0**；[ESLint 日志](evidence/startup-prefund-contract-lint.log) **exit 0**；[diff 检查](evidence/startup-prefund-contract-diff-check.log) **exit 0**。此次未重跑完整门禁，完整门禁和磁盘环境阻塞的缺口仍按前文保留，不将两文件定向通过外推为完整通过。

## 主实施者后续验证更新

初次完整门禁已结束（8138/8170 PASS、28 fail、4 skipped）；本轮迁移失败、历史文件生成冲突及三个单例环境失败均已有逐项修复或独立复测记录，见[实施记录](implementation-notes.md#完整门禁失败处置)。磁盘空间回升后扩展 Archive 集成以原代码/原准入复测 [52/52 PASS](evidence/archive-center-permanent-delete-final.log)，先前 15/52 阻塞证据保留。本文前述独立审查结果不反推为当时已完成上述后续验证。最终整套 release-check 已 exit 0，结果由实施记录统一维护。

最终收口：主实施者的 [release-check-final.log](evidence/release-check-final.log) 记录 8167 单测通过、4 Windows 条件跳过、0 失败，以及 61/61 集成脚本通过。本文独立关闭的 R1—R4 均无新增改动；后续 fixture 迁移也在本次完整门禁内执行。未提交、未集成，平台人工验收仍未执行。
