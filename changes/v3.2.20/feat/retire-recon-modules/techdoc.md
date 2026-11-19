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

**不删除、不改写**：主库中这些模块的表与设置键、`run-data/{acquiring-bill-currency,biz-op-recon,bank-bu-recon}/` 侧库、`tool-data-pending.sqlite`、存档、模板文件用户版本、`.usage-stats.txt` 中的历史计数（统计注册表保留四个条目以免保存时被抹去）。新装用户不再创建这些表。回退旧版安装包后由旧版迁移按原逻辑幂等补齐。

- `current_module` / `enabled_modules` 指向已下线 id：读取时按非法值忽略，回到默认模块（`enabled_modules` 全部非法时按原逻辑重置为默认列表）。
- 写回保留：`setEnabledModules` 和「全部非法时重置为默认列表」写库时，把库中原有的已下线 id 追加在列表末尾原样保留；`setModuleRetentionDays` 写回按模块保留期时保留已下线模块的原有条目（`settings-repository.js` 的 `RETIRED_MODULE_IDS`、`retention-policy.js` 的 `RETIRED_SCOPE_IDS`）。这样用户在新版调整收纳或保留期后回退旧版，已下线模块的启用状态与保留期不变。`current_module` 是单值，用户在新版切换模块时按正常逻辑覆盖，回退旧版后停在新版最后所在的模块。
- 存档：四个模块移出存档范围（模块筛选、保留期设置不再列出）；历史批次仍在存档库，不按模块筛选时可见，到期时间沿用生成时记录的保留期。
- 遗留恢复记录（升级前异常退出可能留下）：

| 记录 | 新版处理 | 实现 |
| --- | --- | --- |
| BizOP 的 active recovery hold | 只读跳过，不改写；保留给回退旧版继续恢复 | `background-execution/retired-recovery-actions.js` 包装恢复控制只读仓储，过滤 BizOP v327 的 12 个 action |
| outbox / 任务终态意图中的 `pending-run`、`biz-op-run` route | 任务终态照常收口，业务侧收尾（写回 Pending 库 / BizOP 侧库血缘）不执行，记活动日志 | `archive-center/retired-terminal-routes.js` |
| Pending / 业务OP / 收单导出的 publication-only 发布 journal | 按原 owner 证明由通用逻辑收尾 | `toolbox-archive-recovery.js` `PUBLICATION_ONLY_FILE_TASKS` 保留识别条目 |
| BizOP v327 导出的发布 journal | **已知限制**：无对应 owner，启动发布恢复按原 fail-closed 语义阻止启动 | 仅在「BizOP 导出发布中崩溃、且未先用旧版（v3.2.19 及更早）重新启动一次就安装新版」时出现；处理方式为先启动旧版完成恢复再升级（backlog B106） |

## 五、架构检查：边界退役

`check:architecture` 的历史防倒退规则禁止曾 active 的边界消失或降级，因此新增退役状态：

- `schema.js`：边界状态增加 `retired`，须带 `retirement: { reason, designDoc, removedPaths, releasedPaths }`。retired 边界保留 id 与规则绑定，清空全部生效约束（入口、消费者、保护范围、工厂、注入合同等）；`REQUIRED_BOUNDARIES` 对 retired 不再要求入口。
- `rules.js`：retired 边界不参与常规规则；改为校验 `designDoc` 存在、`removedPaths` 在当前树中不存在且无依赖指向（防止复活）。
- `policy-history.js`：active → retired 仅在依据完整（原因具体、设计文档非空）、`removedPaths` 已全部删除、且原入口要么在 `removedPaths`、要么显式登记在 `releasedPaths`（保留的共享文件，如 `archive-repository.js`）时成立；已退役边界不得删除登记、复活或缩减删除路径。
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
- **升级兼容集成测试** `scripts/integration/retired-modules-upgrade-compat.js`：构造 v3.2.17 形态的数据目录（四个模块的主库表与设置、`current_module='biz-op-recon'`、已下线 id 的启用列表与保留期、遗留 BizOP recovery hold、`pending:import:start` 遗留批次及 finalize 失败的 `pending-run` outbox、三个模块的 run-data 侧库、Pending 库、BizOP 目录），用真实 Main 启动后断言：启动成功并回到默认模块、启用列表排除已下线 id、遗留批次可见、outbox 已收口、上述文件哈希与表行、设置、hold 均不变。去掉兼容处理后该测试失败。
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
- **已知缺口**：CI 不再有与业务无关的打包版正常启动检查，Windows 打包版验收未做（backlog B105）；BizOP v327 遗留发布 journal 阻止启动（B106）；是否提供历史数据清理入口待定（B107）。
