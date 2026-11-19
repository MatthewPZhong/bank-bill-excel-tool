# TechDoc — 下线四个对账模块

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.20（暂定） |
| 功能分支 | `feat/retire-recon-modules`，基于 v3.2.19 发布合并提交 `466bb6fa`（原基于 `v3.2.17`，先后迁到 v3.2.18、v3.2.19，见 §九） |
| 日期 | 2026-11-16 |
| 依据 | [spec.md](spec.md) |

## 一、范围与模块映射

| 模块（module id） | 删除的代码 |
| --- | --- |
| 业务OP数据核对（`biz-op-recon`，旧版与 v327 两代） | `src/backend/biz-op-recon-{db,import}/`、`biz-op-legacy-guard.js`；`src/main-process/biz-op-recon-{session,run-data,writer}.js`、`biz-op-archive-lineage.js`、`biz-op-v327/`、`read-only-exports/biz-op/`；`src/renderer-biz-op-v327.js`、`styles-biz-op-v327.css`、`renderer/controllers/biz-op-legacy.js` |
| 月度Pending数据核对（`pending-reconciliation`） | `src/backend/pending-{db,export,import,reconcile}/`、`pending-db.js`；`src/main-process/pending-{session,import-preflight,archive-lineage,archive-worker}.js`、`read-only-exports/pending/`、`background-execution/pending-bizop-adapter-policies.js`；`src/renderer-pending.js`、`renderer/controllers/pending.js` |
| 收单单据币种校验（`acquiring-bill-currency`） | `src/backend/acquiring-bill-currency-{db,import}/`；`src/main-process/acquiring-bill-currency-*.js`、`run-check-{worker,worker-pool,multiworker,multiworker-worker}.js`、`background-execution/acquiring-adapter-policies.js`、`adapters/acquiring-adapter.js`、`read-only-exports/acquiring/`；`renderer/controllers/acquiring.js` |
| 月度银行对账单BU回填校验（`bank-bu-recon`） | `src/backend/bank-bu-recon-{db,import}/`；`src/main-process/bank-bu-recon-{session,run-data,writer}.js`、`bank-bu-worker/`（生产未接线）；`renderer/controllers/bank-bu.js` |
| 仅服务上述模块的基础设施 | 大表导入引擎 `backend/big-table-import/{engine,engine-worker-entry,import-worker,pipeline,contract}.js`、`main-process/big-table-import-dispatch.js`、`execution-descriptors/mature-adapters.js`；共享的 `big-table-import/row-scanner.js`、`zip-reader.js` 保留 |
| 随包模板 | `assets/Pending.xlsx`、`Pending数据管理.xlsx`、`业务OP账单.xlsx`、`收单币种校验导出差异表模版.xlsx`、`移除归档Pending账单.xlsx` |

## 二、解耦（保留模块对被删代码的依赖）

| 保留方 | 原依赖 | 处理 |
| --- | --- | --- |
| VCC财务OP校验（审核 / 结果导出发布核对） | `biz-op-v327/export-validator.hashClosedFile`、`export-file-identity.exportFileIdentity` | 逐字迁入 `src/main-process/vcc-financial-op-output/file-evidence.js`；错误码与文案改为中性：`OUTPUT_FILE_INVALID` / `OUTPUT_FILE_CHANGED`，「输出文件状态或证据不满足操作条件」 |
| VCC业务OP计算、设置 → 模板文件「流水对账单」 | `biz-op-recon-db/columns` 的流水 28 列定义 | 逐字迁入 `src/backend/vcc-op-calc-db/columns.js`（含 `FLOW_REQUIRED_HEADERS`，口径不变）；迁移时以深比较核对新旧导出全等 |
| 重复入金匹配（单据对账单读取） | 收单 `BILL_HEADERS`、`reader.js` 的 `openZipWithEntries / loadSharedStrings`、`reader-handrolled.js` 的 `streamSheetRowsHandRolled` | 只取用到的函数逐字迁入 `duplicate-inbound-match/document-xlsx-stream.js`（去掉收单入库与校验依赖）；`BILL_HEADERS` 迁入 `document-statement-reader.js` 并导出 |
| 设置 → 模板文件 | `pending-import/removed-reader`、`biz-op-recon-db/columns`、`biz-op-v327/import-adapter.cellText` | 删除只绑定已下线模块的 5 个资源；`flow-statement` 只保留 VCC业务OP计算 绑定，识别结构只用 VCC 读法（`readFirstWorksheetHeaderRow`），去掉「业务 OP 账单」固定对照；`vcc-removed-pending` 去掉 twin |

保留共用的 CSS 类（`.pending-board`、`.pending-action-pair`、`.acquiring-bill-currency-board`、`.pending-import-month-picker`、`.biz-op-recon-date-*` 等，被重复入金匹配、VCC业务OP计算、VCC财务OP校验使用）；只删除已无任何引用的选择器。

## 三、主进程与平台注册

- `main.js`：删除四组 IPC、会话、收单操作锁、run-check worker 池、启动期孤儿清理、退出清理、BizOP 激活与恢复装配、Pending 库打开、BU 流程证据解析。空闲定时器只驱动「空闲时自动整理主库」；空闲整理与升级忙检查只看银行对账单操作锁。
- `preload.js`：删除 `pending`、`bankBuRecon`、`bizOpReconV327`、`bizOpRecon`、`acquiringBillCurrency` 五个命名空间。
- 应用恢复（`application-recovery/composition.js`）：参与者改为 `platform-scan → pre-fund-runs → position → toolbox-vcc-publications → vcc-import-terminal → vcc-import-lineage`。`platform-scan` 在预检阶段调用一次后台执行平台全量扫描 `scanAndRecover()`（v3.2.17 由 BizOP 参与者在预检中触发，无 BizOP 未决来源时行为相同），扫描完成才允许应用 ready。
- 归档中心：从模块范围、TaskPolicy、FilePlan、操作追踪删除四个模块；删除不再使用的 FilePlan 来源类型。
- 后台执行：`action-manifest`、`action-task-binding-registry`（合同计数与摘要按新清单重算：action 67→39，可恢复 TaskPolicy 134→100）、`mature-action-adapters`、执行描述符（`policy-catalog`、`memory-profiles`、`memory-qualification.json` 删除 `bizop-*` 阶段）。
- 批准基线 `approved-execution-baseline.json`：只删除已下线 action 的条目并重算计数；保留条目经脚本与当前候选推导逐条深比较一致（生产启用 action 13→1，删除的 12 个均为 BizOP v327）。
- 存储层：`run-data-store` 去掉三模块侧库登记与 legacy guard；`database.js` / `migrations.js` 停止这些模块的建表、加列、设置种子和数据迁移（含收单 N4 raw_json 瘦身、N4-cont-2 diff_rows 级联改造）。
- 设置：`ALL_MODULE_IDS` 去掉四个 id；收单 4 项设置读写删除（键值保留在库中）。

## 四、数据保留与遗留记录兼容

**不删除、不改写**：主库中这些模块的表与设置键、`run-data/{acquiring-bill-currency,biz-op-recon,bank-bu-recon,biz-op-v327}/` 侧库与数据目录、`tool-data-pending.sqlite`、存档记录（批次、Task Run、附件、outbox 通知；到期清理见下）、共享发布记录、模板文件用户版本、`.usage-stats.txt` 中的历史计数（统计注册表保留四个条目以免保存时被抹去）。新装用户不再创建这些表。回退旧版安装包后由旧版迁移按原逻辑幂等补齐。已下线模块 id 的唯一清单在 `src/backend/database/retired-modules.js`（同时是主模块 id 与存档 `module_id`；设置、保留期策略、存档仓储与 controller 共用）。

- `current_module` / `enabled_modules` 指向已下线 id：读取时按非法值忽略，回到默认模块。`enabled_modules` 全部是已下线 id（旧版的合法配置）时，只在内存中回退默认列表、不改写库值；混有真正非法值时仍按原逻辑重置为默认列表。
- 写回保留：`setEnabledModules` 和「全部非法时重置为默认列表」写库时，把库中原有的已下线 id 追加在列表末尾原样保留；`setModuleRetentionDays` 写回按模块保留期时保留已下线模块的原有条目（`retention-policy.js` 的 `RETIRED_SCOPE_IDS`）。这样用户在新版调整收纳或保留期后回退旧版，已下线模块的启用状态与保留期不变。`current_module` 是单值，Renderer 回退到可用模块时按 v2.1.4 起的通用逻辑写回，回退旧版后停在新版最后所在的模块（不涉及数据）。
- 存档（spec D3，用户 2026-11-18 决定）：四个模块移出存档范围（模块筛选、保留期设置不再列出），其批次不在存档中心展示——`archive-repository.js` 的 `VISIBLE_BATCH_PREDICATE_SQL` 排除已下线 `module_id`，覆盖列表、搜索、按号打开、关联批次与统计；公共附件入口（`archive-center:open-file` / `save-as`，按附件编号）在 controller 先检查所属批次，已下线模块按「存档文件不存在」处理且不弹保存对话框。用户无法打开或手动删除。已结束的批次**照常参与到期清理**，按生成时记录的保留期删除；以下旧版现场不清理、不改写，也不阻止其余批次：
  - 仍为 reserved/running 的批次：`listExpiredBatches` 不选入。
  - 仍有原样保留的终态通知的批次（删除闸门返回 `ARCHIVE_DELETE_OWNER_PENDING`），或缺少收口凭证的批次（`ARCHIVE_DELETE_OWNER_COMPLETION_REQUIRED`：v3.2.9 前生成，或其原收口责任留给旧版确认）：到期清理本轮跳过、不算失败（`archive-service.js` `_deleteExpiredBatch` 的 `RETIRED_RETENTION_SKIP_CODES`；分页时排除已跳过的批次，避免同一批次重复占满一页）。保留模块遇到这两种情况仍按原行为（缺凭证的通用问题见 backlog B110）。
  - 启动时不改写已下线模块的存档记录：扫尾（`markInterruptedTasks`、`markInterruptedArtifacts`）不改写其进行中批次、Task Run 与待存档附件；流程绑定意图重放（`replayFlowBindIntents` / `replayTaskFlowBindIntents`）跳过其意图，不写流程锚点、不累加失败次数；`recoverFileTaskOwnerCompletions` 不代旧版确认其「无后处理」收口责任（责任记录原样保留，批次因此缺凭证，到期清理跳过）。到期清理闸门（`getEntryMaintenanceGateState`、controller 的 outbox 检查）不计入这些记录。
  - 旧版建批失败遗留的无归属文件重试通知会使同模块到期批次都被跳过（只保留、不误删），见 backlog B109。
  - 存储层一致性维护（文件核验、附件补生成）仍覆盖全部批次，只补全存档、不改业务状态。
- 模板中心变更记录只列当前目录中的资源；已下线资源（如 `removed-pending`）的旧记录保留在库中、不再展示为点不开的链接（`template-resource-repository.listChanges` 先筛选再限量）。
- 遗留恢复记录（升级前异常退出可能留下）：

| 记录 | 新版处理 | 实现 |
| --- | --- | --- |
| BizOP 的 active recovery hold | 只读跳过，不改写；保留给回退旧版继续恢复 | `background-execution/retired-recovery-actions.js` 包装恢复控制只读仓储，过滤 BizOP v327 的 12 个 action |
| 存档 outbox 中已下线模块的终态通知（operation 与 file-batch owner、无 owner 的旧格式，含 `pending-run` / `biz-op-run` route） | 整条跳过并原样保留：不写 Task Run 终态、不执行业务收尾、不删除；不计入待重试数量（不阻断存档中心初始化）与到期清理闸门；回退旧版后由旧版重放 | `archive-center/controller.js` `isRetiredOutboxRecord`；`retired-terminal-routes.js` 只保留 route 识别，`finalize` 兜底拒绝（`ARCHIVE_RETIRED_TERMINAL_ROUTE_RETAINED`） |
| Pending / 业务OP / 收单导出的 publication-only 发布 journal | 按原 owner 证明由通用逻辑收尾（与旧版重启时的处理相同） | `toolbox-archive-recovery.js` `PUBLICATION_ONLY_FILE_TASKS` 保留识别条目 |
| BizOP v327 导出的发布 journal（`biz-op-v327-export-<taskRunId>`） | 只识别、一律 defer：journal、staging、备份与目标原样保留，启动继续并记活动日志（含恢复路径）；共享发布器对 defer 记录的失败关闭合同不变，处理前经统一发布流程的导出被拒绝，主消息即写明处理方式：先用 v3.2.19 及更早版本打开一次（spec D4，backlog B108） | `publication-recovery/retired-module-owner.js`（前缀、exact-7 batchContext、7 个导出 taskKey 与 taskRunId 一致才认领，不一致时失败关闭）；`toolbox-output-publication-dispatch.js` 的 `RETIRED_PUBLICATION_HINTS` |
| 上一行中旧版已标为 `manual-recovery` 的 journal（旧版回滚自身失败） | 同样 defer（代码 `PUBLICATION_RECOVERY_RETIRED_MODULE_MANUAL`），提示按恢复路径人工处理（旧版也无法自动收尾）（spec D5） | 共享发布器发现阶段（`toolbox-output-publication.js` `discoverRecoveryInternal`）只对 `RETIRED_PUBLICATION_TASK_PREFIXES` 前缀且状态为 `manual-recovery` 的记录不抛错、跳过目标父目录身份核验（常是标记原因），只读交给 owner；身份校验仍由 owner 负责。执行阶段对 defer 记录不做任何动作。其他记录（含其他模块的 `manual-recovery`、索引与 journal 锚点不符、v1 旧索引）的发现门禁不变 |

## 五、架构检查：边界退役

`check:architecture` 的历史防倒退规则禁止曾 active 的边界消失或降级，因此新增退役状态：

- `schema.js`：边界状态增加 `retired`，须带 `retirement: { reason, designDoc, removedPaths, releasedPaths }`。retired 边界保留 id 与规则绑定，清空全部生效约束（入口、消费者、保护范围、工厂、注入合同等）；`REQUIRED_BOUNDARIES` 对 retired 不再要求入口。
- `rules.js`：retired 边界不参与常规规则；改为校验 `designDoc` 存在、`removedPaths` 与保留的已退役兼容入口在当前树中不存在且无依赖指向（防止复活）。
- `policy-history.js`：active → retired 仅在依据完整（原因具体、设计文档非空）、`removedPaths` 已全部删除、且原入口要么在 `removedPaths`、要么显式登记在 `releasedPaths` 时成立；`releasedPaths` 必须是仍在当前树中的共享文件（如 `archive-repository.js`），已删除的原入口只能登记为删除路径，释放的文件以后被删除时须改登记到 `removedPaths`。已退役边界不得删除登记、复活或缩减删除路径。
- 退役边界可原样保留状态为 retired 的兼容入口登记（`deprecatedEntrypoints`，作为防复活依据），仍为 compat 的入口不得保留。已退役兼容入口的登记只增不减，历史快照中边界本身已退役时同样核对（兼容入口与边界在同一提交退役后，不能再删登记并恢复 shim）。
- `boundaries.json`：`renderer-{bank-bu,acquiring,biz-op-legacy,pending,biz-op-v327}`、`bizop-recovery-private`、`bizop-query-q1~q3` 改为 retired；shared-xlsx 的 `pending-import/{streaming-xlsx-reader,xlsx-size-preflight}.js` 兼容入口标为 retired（生产消费者已全部迁往 `src/backend/xlsx/legacy/*`，本次全仓清点无剩余引用），各兼容入口的 `existingConsumers` 去掉已删除文件，`requiredConsumers` 用精确 `policyChanges` 移除已删除的消费者；`compositionEntrypoints`、`dynamicLoads`、`generatedModules` 去掉已删除目标；`legacy-allowlist.json` 删除 `baseline-cycle-001`。

## 六、测试与工具

- 删除四个模块的单测、fixtures、helpers、集成脚本、冒烟脚本、预览用例、BizOP 专项脚本与只服务收单的 POC / perf / benchmark 脚本。
- 共享契约测试按新清单更新：归档 TaskPolicy / 文件计划 / 操作追踪、应用恢复、后台执行 manifest、执行描述符基线（重新生成）、模板文件、设置、run-data-store。
- 新增：`retired-recovery-actions`、`retired-terminal-routes`、平台扫描参与者、架构退役机制的单测；升级兼容集成脚本 `scripts/integration/retired-modules-upgrade-compat.js`。

## 七、CI

- `build-windows.yml`：删除 `bizop-durability-contract` job 与打包版 BizOP 验收步骤。
- `release-windows.yml`：删除打包版 BizOP 验收步骤。
- `windows-bizop-durability-probe.yml` → `windows-durability-probe.yml`：删除 `normal-app` job 与 `bizop` 分组，`recovery` 分组只保留 `recovery-contract-c2`；`archive` 分组与 `probe` job 保留。

## 八、回滚

回滚代码即可恢复四个模块；本分支未改写任何数据，旧版启动时迁移幂等补齐表结构。

## 九、实施补记

实施中发现、与计划不同或计划未写明的事项。

- **平台扫描参与者按 preflight 函数身份绑定**：`platform-scan` 起初以参与者对象为 WeakMap 键绑定平台入口；G7 汇总与恢复协调器都会浅拷贝参与者对象，正式启动时取不到绑定而报错（单测用原对象，未暴露）。改为以 `preflight` 函数为键；替换 preflight 的伪造参与者在创建前拒绝，同一参与者重复绑定也拒绝。升级兼容集成测试用真实 Main 启动覆盖这条路径。
- **派发混合门禁移除**：v3.2.17 的 composition 在注入 BizOP 授权（`bizOpV327`）后，给其他缺自身派发 hook 的非生产 action 补一个显式拒绝函数，只为 BizOP 关闭观察服务。BizOP 下线后该条件恒不成立，删除该分支及对应用例；「生产 action 缺 hook 在载体前拒绝」与「已配置 hook 先于 adapter 调用」两条门禁不变，仍由 `execution-descriptor-dispatch-compatibility.test.js` 覆盖。
- **内存续接**：`memory-admission` 的续接（continuation）旁路是通用机制，原唯一生产调用方是 BizOP 共享发布观察（`captureLegacyMemoryContinuation`）。机制保留，生产暂无调用方；`memory-continuation` 单测改为用测试内登记的准入策略验证该机制。
- **历史发布证据**：
  - `scripts/validate-v3-2-2-release-evidence.js` 读取已删除的 BU 回填模块代码（`BANK_BU_POLICIES` 等），整体退役：删除脚本、npm script 与单测；`v3-2-2-release-metadata-closeout` 只内联其仍需的版本判断。
  - `validate-v3-2-5-release-evidence.js` 仍有效，但其证据引用含已删除文件；新增封闭清单 `RETIRED_EVIDENCE_REFS`，只对清单内路径跳过存在性检查，清单外缺失仍失败。
- **测试工具**：
  - `run-unit-tests.js` 的串行分片机制只为 BizOP 用例存在，一并删除；6 个分片按历史耗时均衡全部文件。
  - `execution-descriptor-governance.js` 删除 adapter 场景（大表导入引擎 + Pending 导入 TaskLifecycle），保留 thread / inline / service 三个场景。
  - `memory-qualification.json` 删除 10 个 `bizop-*` 配置后剩 8 个；`packaged-memory-identity.js` 原写死 18 个人工批准配置，改为从清单取数并断言 8。
  - 固定基线 fixture（`tests/fixtures/execution-descriptors/*.json`）不改，测试按显式列出的已下线前缀扣除条目并断言扣除数量（runtime 49 → 25 action，Archive 268 → 194 channel）。
  - 后台执行 manifest 证据（`changes/v3.2.10/.../evidence/manifest-current/*`）由 `check:background-execution-manifest --write` 重算；已核对保留的 action、route、surface 逐字不变，只删除已下线条目。
- **架构检查**：除第五节的边界退役外，`renderer-pre-fund`、`renderer-duplicate-inbound` 的 `activationEvidence` 去掉已删除的 `r4-controllers.test.js`，用两条 `policyChanges` 登记（每次迁移基线时与其余两条一并改绑到新基线提交的原 blob，当前为 `466bb6fa`，见下方「基线迁移」）。
- **CI 探针脚本**：`windows-durability-probe.yml` 仍用的通用耐久探针从 `scripts/biz-op-v327/probe-windows-durability.{js,ps1}` 迁到 `scripts/windows-durability-probe/probe.{js,ps1}`，内容按 v3.2.17 原样恢复，只把临时目录前缀改为中性名称。
- **升级兼容集成测试** `scripts/integration/retired-modules-upgrade-compat.js`：构造 v3.2.17 形态的数据目录（四个模块的主库表与设置、`current_module='biz-op-recon'`、已下线 id 的启用列表与保留期、遗留 BizOP recovery hold、`pending:import:start` 遗留批次及 finalize 失败的 `pending-run` outbox、三个模块的 run-data 侧库、Pending 库、BizOP 目录），用真实 Main 启动后断言：启动成功并回到默认模块、启用列表排除已下线 id、遗留批次在存档中心不可见、存档记录与 outbox 通知逐行不变、上述文件哈希与表行、设置、hold 均不变（Codex 审查修复后的补充见下方）。去掉兼容处理后该测试失败。
- **基线迁移（2026-11-18）**：v3.2.18 已发布（PR #253），release/v3.2.19 已进入门禁（PR #254）。本分支从 `v3.2.17` 迁到 `v3.2.18`（`41d10180`，相差 40 个提交），目标版本顺延到 v3.2.20（用户决策）。
  - 未提交的改动先 stash，分支移到 v3.2.18 后再还原。共 11 个文件冲突，都是两边在相邻位置各自增删：
    - v3.2.18 新增的内容全部保留：`pendingTemplateImports`、空闲定时器里的链接表过期清理、`ensureArchiveVccDefaultRetention` 迁移及其调用、两个模板预检 exclude 策略、渲染 fixture 的链接表保留期限响应。
    - 已下线模块的部分按本分支删除。
    - 计数类测试按「v3.2.18 新增 + 本分支删除」重算：Archive TaskPolicy 合计 235（reserve 46、no-file 54、exclude 119、support 16）；Renderer 边界 24 个（active 19、retired 5）。
  - `boundaries.json` 按结构三方合并，两边改动的边界没有重叠。`policyChanges` 保留 v3.2.18 新增的 19 条，再追加本分支的 4 条。本分支这 4 条改绑 `41d10180` 及其 blob，因为历史检查要求来源提交不早于任一历史快照。
  - 本分支新增内容中的版本标注从 `v3.2.18` 改为 `v3.2.20`，原有发布记录不动；TechDoc 目录改为 `changes/v3.2.20/`；用户手册里可回退使用的版本改为「v3.2.19 及更早」。
  - backlog 编号与 v3.2.18、v3.2.19 冲突，本分支的三条改为 B105–B107。B93（已删除的 BizOP 集成脚本偶发超时）移到「已废弃」；B34（弹窗预览启动即被 BizOP 激活检查阻断）实测预览出图正常，移到「已完成」。
  - 后台执行 manifest 证据用 `--write` 重算，只有源文件哈希变化。
  - 同日 PR #254 合入 main，基线再迁到 v3.2.19 的合并提交 `466bb6fa`（比 v3.2.18 多 16 个提交）。迁移时 `v3.2.19` 标签尚未创建；标签如果最终不指向该提交，需按标签提交复核。
    - 只有 3 个文件冲突：`boundaries.json`、backlog、集成测试清单 §七。
    - `boundaries.json` 同样按结构三方合并：保留 v3.2.19 新增的 1 条 `policyChanges`，本分支 4 条改绑 `466bb6fa` 及其 blob。
    - backlog 两边新增的条目都保留，§七 由完整集成测试重新生成。
    - 后台执行 manifest 证据再次用 `--write` 重算，只有 `src/main.js` 的哈希变化。
    - v3.2.19 没有改动后台执行、存档中心、执行描述符、应用恢复和 preload 相关文件；它新增和修改的代码中没有引用已下线模块。
- **Codex 审查修复（2026-11-18，提交 `71b7cc24` 之后）**：Codex 审查确认的问题与本次处理，现行规则见第四、五节：
  - 存档：已下线批次原本仍可见、可手动删除，到期时与进行中的现场一起被清理。改为不展示；按用户调整后的决定（spec D3），已结束的批次照常到期清理，进行中或仍有遗留通知的现场不清理、不阻止其余批次。
  - 启动扫尾：删除 v3.2.19 的 BizOP / 收单保护后，进行中的已下线批次与 Task Run 会被改成失败或中断。改为在仓储层按已下线 `module_id` 排除，不必再打开业务侧库。⚠️ 资金红线（状态与血缘），需人工复核。
  - outbox：已下线模块的终态通知原先写入 Task Run 终态并删除通知（退役 route 只记日志）。改为整条原样保留。实施中另发现两处会被保留记录拖住的闸门：启动时要求 outbox 剩余为 0、到期清理要求 outbox 为空且无进行中的批次。两处都已排除这些记录，并补了回归。⚠️ 资金红线（终态确认血缘），需人工复核。
  - BizOP v327 遗留发布 journal（原 B106）：新增只识别、一律 defer 的 owner，启动不再中止；新的导出在旧版收尾前被拒绝并提示处理方式（用户选择「只放行启动」，不改共享发布器合同；剩余影响登记为 B108）。
  - 启用列表全部是已下线 id 时不再写库；模板中心变更记录不再列出已下线资源；架构检查要求 `releasedPaths` 仍存在，并允许退役边界保留已退役兼容入口。
  - 升级兼容集成测试改为在旧版真实数据目录 `run-data/biz-op-v327/` 下构造数据，补充 operation owner 通知、进行中的批次与 Task Run、BizOP 发布中途退出的遗留记录。逐行比对存档记录、outbox 与发布材料前后不变；去掉 retired-module owner 后，该测试会以 `PUBLICATION_RECOVERY_OWNER_UNKNOWN` 失败。
  - 未采纳：Pending / 业务OP / 收单 publication-only 导出的遗留 journal 仍按原 owner 证明回滚或收尾（与旧版重启时相同）；回退到可用模块时写回 `current_module`（v2.1.4 起的通用逻辑，不涉及数据）。
  - 修复后 `npm run release-check` 通过：单测 8929 个（8925 通过、4 跳过、0 失败），集成脚本 88 个全部通过，`retired-modules-upgrade-compat.js` 37 项断言。
- **Codex 第二轮审查修复（2026-11-18，未提交）**：确认 10 条，用户选择修 8 条并放行第 3 条（spec D5），不采纳 2 条：
  - 启动不改写已下线存档记录：流程绑定意图不重放、File Task「无后处理」收口责任不代为确认；缺收口凭证的已下线批次到期清理跳过（原只跳过有遗留通知的情况，缺凭证会使本轮停在当页）。⚠️ 资金红线（血缘与终态确认），需人工复核。
  - 需人工恢复的 BizOP 发布记录放行启动（见第四节表格）；导出被拒时处理方式写进主消息（VCC「数据管理 → 导出数据」等入口只展示主消息）。
  - 公共附件入口检查所属批次；架构历史检查补上「兼容入口随边界同一提交退役」的绕过路径。
  - 升级兼容集成测试：列表读取须成功，并加入保留模块批次须可见的对照；流程绑定意图、锚点、收口责任与凭证纳入前后逐行比对（42 项断言）。
  - 不采纳：无归属旧通知使同模块到期批次被跳过（只保留不误删，改删除归属判定属资金红线，登记 B109）；设置页「待完成删除」显示已下线批次号（元数据已删、文件待清理的必要提示）。缺收口凭证使到期清理停在当页的通用问题登记 B110。
  - v3.2.19 标签已创建，指向本分支基线 `466bb6fa`，基线迁移的前提成立。
  - 修复后 `npm run release-check` 通过：单测 8934 个（8930 通过、4 跳过、0 失败），集成脚本 88 个全部通过（`retired-modules-upgrade-compat.js` 42 项断言）；新增用例均做过变异验证（撤掉对应修复即失败）。
- **已知缺口**：CI 不再有与业务无关的打包版正常启动检查，Windows 打包版验收未做（backlog B105）；BizOP v327 遗留发布记录在处理前会使经统一发布流程的导出被拒绝（B108）；无归属的旧文件重试通知会使同模块到期批次被跳过（B109）；缺收口凭证的历史批次使到期清理停在当页（B110，基线既有）；是否提供历史数据清理入口待定（B107）。
