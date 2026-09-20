# G2 公共入口与任务适配实现独立审查

审查结论：**在本次范围和代码快照内，未发现需要修复的实现问题。** 独立执行五组针对性测试，103 个通过、0 个失败、0 个跳过。此结论不替代 G2-T5 的真实存储恢复组合验证或完整交付门禁。

## 代码状态与独立性

- 分支：`codex/v3.2.10-business-task-adapters`。
- worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-business-task-adapters`。
- HEAD / 固定 G1 集成依赖：`5ccbf3f022488026f725a5111be00422a04ce221`。
- 受审代码为该 HEAD 上的未提交实现；[审查快照](evidence/implementation-review-snapshot.json)保存 10 个相关生产文件的 SHA256、真实 policy 全量绑定清单和验证摘要。
- 本次审查范围由另一实现者完成：Main 公共入口、task-adapters 的 registry/scope/passthrough、业务 adapter composition、Toolbox/VCC adapters。审查者仅新增本审查文档及对应证据，没有修改受审源码。
- 审查者此前实现的 terminal registry / Controller 接线不计为本次独立审查范围；Position task-owner 的完整领域行为由另行审查及测试承接。本次只检查公共入口与 Position adapter 的调用和身份交接合同。
- 依据：[G2 Spec](spec.md)、[G2 TechDoc](techdoc.md)、[基线清点](baseline-inventory.md)与总索引 §6.2–§6.4。

## 已核查的风险与事实

| 审查点 | 实现证据与判断 |
| --- | --- |
| prepare 成功后的资源边界 | `src/main.js` 的 `runArchiveAwareOperation` 在 `proceed:true` 后立即建立 scope。第二 gate、Archive 初始化与可用性检查、adapter resolve/createInvocation、payload 构造、生命周期调用都位于同一次 `scope.run` 内。prepare 取消与 prepare 自身抛错仍由原 prepare 负责，没有创建新的 BOR/task/batch。 |
| 清理次数与资源状态 | `prepared-resources.js:21` 先写 `abandonAttempted=true`，再调用 onAbandon；失败不重试，成功才置 `released`。`run` 单飞并复用结果；清理中或完成后拒绝再次移交。markExecuteStarted 后 owner 为 execution，scope 不再调用 abandon。 |
| 错误优先级 | pre-lifecycle 的 gate/初始化/构建与 cleanup 双异常保留原异常；lifecycle 不可用的失败返回遇 cleanup 异常传播 cleanup；enterLifecycle 后尚未执行的失败继续采用原 finally 的 cleanup 异常优先级。同步抛错也被 Promise 微任务中的 work 捕获。对应 TechDoc §3.4，没有统一改成另一种错误优先级。 |
| 退出等待 | `scope.run` 先创建 Promise 并延迟到微任务执行 work，Main 同步把这一整个 Promise 加入 `archiveOperationTail`；tail 因而覆盖前置失败、lifecycle、abandon 及清理诊断。Main 原退出路径继续 await tail。延迟清理用例验证尾部 Promise 在 cleanup 完成前不结算。该验证边界从 prepare 成功起，不宣称改变 prepare 仍在 picker 中时的原退出行为。 |
| 生命周期及业务时点所有权 | 原 TaskLifecycle 和 IPC task contract 相对固定 G1 提交无改动。scope 不分配/释放 BOR，不写业务 pending。passthrough 在真实 executeBusiness 前标记；Position 仍经 admission 接受后的 callback 标记，busy/reject 不接管，且不触发业务 settlement。第三次 Hold gate 先于 prepared.beforeStart。 |
| 四种执行形态及显式身份 | 公共入口仍分别选择 operation-only、eager、deferred、legacy run。Position 显式 prepared.taskRunId/operationKey 优先于生成身份，而终态 route 使用本次生成 token；测试保留这种历史形状。普通任务缺省身份交回 TaskLifecycle。legacy 分支保持 recovery 与 sourceSnapshots；无文件任务不新增 file-only recovery 参数。 |
| 全部受控 task 的绑定 | 实际调用 `createTaskPolicyRegistry().list()` 和生产 `createBusinessTaskAdapterRegistry`，268 个 policy 中 134 个受控 task 全部可解析；107 个 passthrough、15 个 Position、10 个 VCC、2 个 Toolbox。当前生产清单中，旧 Position channel 前缀规则与新 scope 选择逐项一致，差异为 0。注册后按精确 taskKey 查找，没有运行期前缀 fallback。 |
| receipt hook 的精确范围 | 独立逐项创建非 Position 的真实 invocation，只有 `toolbox:merge`、`toolbox:split:export`、`vccFinancialOp:data-manager:export`、`vccFinancialOp:export:import-audit`、`vccFinancialOp:export:result` 替换 prepared hook。其他 publication-only 领域和所有 no-file 任务继续透传。空 `toolboxPublicationTaskIds` 数组仍优先于 VCC ids，保留基线有效语义。 |
| receipt 的最终确认权限 | 两个 adapter 均只注入现有 acknowledgement 能力；Main 仍调用原 `acknowledgeToolboxPublicationReceiptsIntoArchive`。其 owner、task/batch、succeeded 和耐久 artifact proof 检查未被此次迁移删改。相对固定 G1，`toolbox-archive-recovery.js` 无改动；本次未把调用 afterTerminal 本身当作 receipt 已确认的证据。 |
| 中立模块与生产调用方 | 公共入口没有 Position 前缀分派、pending/settle/cleanup 调用；中立 registry、scope、passthrough 不导入 Position。领域选择在 Main 启动 composition 中一次性完成；三个公共 IPC wrappers 继续进入同一公共入口。 |

## 运行验证

所有命令均明确在上述 G2 worktree 执行。

```bash
node --test \
  tests/unit/main-process/task-adapter-registry.test.js \
  tests/unit/main-process/prepared-resource-scope.test.js \
  tests/unit/main-process/archive-aware-prepared-resource-entry.test.js \
  tests/unit/main-process/task-adapters.test.js \
  tests/unit/main-process/archive-task-policy-registry.test.js
```

结果：**103 tests / 103 pass / 0 fail / 0 skipped / 0 TODO**。[完整日志](evidence/implementation-review-tests.log)。

此外执行了只读 production composition 枚举，核对 134 个 taskKey 可解析、Position 选择与旧合同一致、receipt hook 恰好五项。全量绑定及五项列表保存在[审查快照](evidence/implementation-review-snapshot.json)。

## 验证边界与接续

- 公共入口测试执行当前 Main 的实际函数文本和真实 scope/adapter，替换了外围 gate、Archive、TaskLifecycle 和领域存储；它证明入口编排及资源交接，不证明 Electron GUI、真实 BOR/SQLite 的完整组合。
- 本次未运行新一轮全量 `release-check`；本报告的 103 个测试不能替代完整门禁。完整门禁和 G1+G2 重启/恢复组合证据由统一实施记录承接。
- Windows、Excel/WPS 文件占用、真实安装包、真实 GUI 未在本次审查执行。
- 如受审源码在本快照之后改变，须针对影响补审和补测；最终实现与验证状态以[实施记录](implementation-notes.md)为准。

## 独立 Position 迁移复核（追加）

本节补齐前述范围中未覆盖的 Position task-owner/task-adapter 实现审查。审查者未实现这两个模块。本次只读核对固定 G1 提交的 Main 与当前实现，**未发现需修复的行为偏差**；不新增生产或测试改动，也未重复执行测试或全量门禁。

本节代码状态仍为 `5ccbf3f022488026f725a5111be00422a04ce221` 上的未提交改动；文件 SHA256 如下。前述 Main 快照之后删除了一个未使用的 `isPublicationOnlyFileTask` import 及空行，不影响受审行为。

| 文件 | 本节读取的 SHA256 |
| --- | --- |
| `src/main-process/position-reconciliation/task-owner.js` | `4a3341991c3fa2100fd2f2f5f2d66e1acbc29a58dcb990ac5941baedb0c969e3` |
| `src/main-process/position-reconciliation/task-adapter.js` | `e9ffbd792615d8dd8a768beec2a7af74c270d7ea4801e36bbad912653ebb0b44` |
| `src/main.js` | `0ed3e6a1a1b467b9e608d608c8017405fe5262f732de70ae8d4fb41dddd24635` |

### 核对方法与结果

通过 `git show 5ccbf3f022488026f725a5111be00422a04ce221:src/main.js` 读取迁移前实现，使用 Acorn 提取函数，再仅对已明确的依赖替换进行正常化，例如 `database.getSetting → readSetting`、`positionReconciliationService → getCurrentService()`、`archiveCenterService → getArchiveCenter()`。去除排版与注释差异后，**26 个迁移函数的 token 序列完全一致**，包括 pending 读写与清理身份检查、文件意图持久化、取消确认、运行 admission、恢复 route owner 检查、受管暂存保护和清理。

四个不同正文逐项人工复核：

- `finalizePositionPendingAfterTaskTerminal`：原 token/taskRunId/batchId 检查保留，再进入共用收口函数；live 仍仅在 file-batch 下补写 durable，archiveRequired 尚未 durable 时保留 pending，不额外做 recovery checkpoint 或文件清理。
- `finalizeRecoveredPositionPending`：改为调用共用收口函数并明确 `recovery:true`。将共用函数中新增的 live 分支排除后，其 recovery 正文在上述依赖替换后与固定 G1 原函数 token 序列完全一致。
- `syncPositionReconciliationCheckpoint`：原 database/db/service 可用性检查改为注入能力检查，设置键、checkpoint 来源与写入顺序不变。
- `positionArchiveStagingRoot`：原 database/dbPath 判空改为 `getDatabasePath()` 判空，仍使用相同 `run-data/position-reconciliation/import-staging` 根目录。

这项源码比较用于缩小需人工复核的差异，不代替行为测试。`operation-lifecycle.js`、`input-staging.js`、`archive-file-plan-evidence.js` 相对固定 G1 无差异。

### 关键行为复核

| 风险 | 已确认保持的行为 |
| --- | --- |
| owner 与并发 admission | AsyncLocalStorage 和活动 operation 变量由唯一 owner 实例持有；active busy、不完整 pending 和 service 初始化失败仍在业务接管之前拒绝。initial pending、后续更新及清除沿用原 token 检查；Main 接线只转移调用入口，没有保留第二套 pending writer。 |
| 身份与终态路由 | prepared 显式身份优先级不变；生成 token 继续进入 Position route。live 的 token/taskRunId/batchId 与 replay 的 route/metadata/owner/targetBatchId 校验保持；历史无 owner 仅允许匹配原 file-batch，不扩展为 operation owner。 |
| checkpoint 与 pending | 普通执行仍由原 `runPositionOperationLifecycle` 同步 checkpoint 并延迟 pending 清除。replay 仍先要求归档 durable 或原 deleted 证明、必要时终结原 task，再检查 side-DB/提交凭证，随后依次同步 checkpoint、清 bootstrap、清 pending、尝试受管暂存回收。任何前置依赖失败不会提前清 pending。 |
| 业务提交而归档失败 | current FilePlan 保持 intent → 业务结果/异常捕获 → outcome → manifest settlement → durable 标记与受管 cleanup，非 durable 标 incomplete；legacy 保持原 result/error settlement 与恢复意图路径。不新增业务重提交流程，也不把 cleanupPaths 当作删除授权。 |
| 双异常与结果 | current/legacy 的 settlement 抛错仍先于捕获的业务异常传播；已进入原 Position lifecycle 的错误最终仍由原 failureResult 处理。legacy archive/cleanup 失败的原结果保留与 incomplete 标记逻辑继续复用原 helper。 |
| 取消 ACK | SQLite pending 的 cancelled 真相先写，再登记原 owner 的终态 outbox，最后调用匹配原 operationToken 的 cancelActive。Main 取得的 active operation 变为冻结快照，但没有改变 token/channel 内容或 callback 的时点。 |
| managed path 与删除保护 | 清理仍仅允许受管根内路径；pending、未完成 outbox 和 active import 路径一起参与保护。保护列表不可读时返回 null 并放弃删除。目录层级检查、保护过滤及重试参数与基线一致；外部原始文件和用户输出不因模块迁移获得新删除授权。 |
| Service 初始化与恢复等待 | Main 在原位置调用 `completePositionServiceInitialization`，三项 setting 写入顺序保持。存在 pending 时仍等待 `positionPendingRecoveryPromise`，保留未收口 pending 检查与启动失败关闸，并登记到原 archive tail。 |

同时阅读了 `position-task-adapter.test.js` 对 admission、显式身份冲突、current/legacy 双异常、非 durable、live/replay、历史 owner、取消以及真实临时路径保护的断言，未发现为迁移而放宽原合同的断言。其实际执行结果由统一实施记录和当前门禁记录提供；本节没有将“读过测试”写成新一次测试通过。

本节范围没有扩展到真实 Windows 文件占用、Electron GUI 或安装包，也没有重新评价基线既有路径保护算法的其他潜在边界。最终结论仍须结合对应代码快照的完整门禁及 G1+G2 恢复组合结果。

## 终态合同独立复核与专项范围

另一实现者对 T4 registry / Controller / Pending、BizOP、PreFund live 与 replay 接线进行了只读复核。[162 个逐样本差分](evidence/terminal-compatibility-probe.json)与[审查证据](evidence/terminal-compatibility-review.log)记录固定 G1 与当前源摘要、样本结果和命令：四个 route 的合法/非法输入、trim、丢弃额外字段、终态状态在 normalizer 层零差异；三个原领域 finalizer 正文未改；真实 operation context 为 exact-5，新增 live 委托仍通过原 owner 验证。该次 134 项定向运行中的旧 VM 夹具失败随后仅通过正确注入真实 owner 修复，[修复后 11/11](evidence/toolbox-owner-fixture-after.log)，没有据此改动生产合同。

本轮按 reconciliation-blindspot-pass 针对身份、状态、幂等、审计和资源处理审查：owner 冲突失败关闭、业务已提交而归档失败保留证据、live 与 replay 不重复确认、受管文件清理不授权删除外部源。[真实临时 SQLite / archive / outbox 组合恢复](evidence/task-adapter-recovery.log) 4/4 通过；每次恢复再重开实例验证，不重跑业务且原 task/batch/artifact 保持。没有改变金额、币种、匹配、回填或输出列，本轮不据此宣称那些业务规则完成新一轮逐笔人工验收。

最终 Main 相对本报告首个快照只清除了未使用的领域 import 和空行；功能正文不变。最终完整内容和门禁结果以 [source-snapshot.json](evidence/source-snapshot.json) 与[实施记录](implementation-notes.md)为准。

### 完整门禁后的日志修正复核

第三轮 integration 的 SR-log-1 发现 scope 新增的默认/兜底 console.error 不符合项目日志规范。实现者将其改为既有 `backend/logger.appendModuleLog`，补临时目录中的真实日志落盘回归；[受影响测试 44/44](evidence/resource-logging-fix.tap)、[日志集成 33/33](evidence/resource-logging-integration.log)。独立只读复核确认该变更仅替换诊断输出，owner/closing/单飞/abandonAttempted 和 enterLifecycle 两侧的错误优先级保持；appendModuleLog 的 graceful 处理不覆盖原错误，且没有领域状态或数据库依赖回流。最终范围以更新后的源快照为准，主 Agent 随后对修正快照完成第四轮完整门禁：exit 0，8300 单测通过、4 Windows 跳过、62/62 集成脚本通过；命令与完整证据见实施记录。此为主 Agent 的最终验证，不计入本报告最初独立执行的 103 个定向测试。

最终交付记录经另一 Agent 只读一致性复核，固定依赖、未提交/未集成状态、历史与当前证据及平台验收边界无冲突；该次文档复核未执行测试或修改源码。

## 同事复审后的生产启动入口补测

同事审查提出的 V1 被接受为验证缺口：原 4/4 场景在恢复前已有 outbox，其 fixture participant 未执行完整生产 Position 启动链。本轮新增集成脚本执行 Main 原始恢复函数、生产 G1 composition、真实 streaming 导入和 Position side DB，补齐“已提交＋pending＋零 outbox”、原恢复等待屏障、checkpoint token 错配关闸及 durable 后 pending 写失败重放。实现未改变生产 JavaScript、IPC、schema 或清理授权。

[补测独立审查](evidence/startup-independent-review.md)确认基线 3/3；[两项内存变异](evidence/startup-mutation-results.json)分别被“必须经生产 owner 恢复补建 intent”和“Main 必须等待原恢复 promise 才能让 Controller 完成启动”断言拦截，源码未变。源状态见 [startup-supplement-source-snapshot.json](evidence/startup-supplement-source-snapshot.json)，当前全部检查结果由[实施记录](implementation-notes.md)汇总。

A1 的 ARCH-TASK-ADAPTER 仍按总索引 §6.2 由后续 G8 集成激活；本轮补测不替代该联合验收，也不等同 Electron 整进程强杀或平台人工验收。原同事审查与旧完整门禁原文、日志均保留。
