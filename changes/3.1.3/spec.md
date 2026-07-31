# Codex Implementation Spec — 平盘对账百万级 Excel 流式导入、增量派生与崩溃隔离

> change-name: `position-reconciliation-large-table-import`
> status: `release-prepared`（PR #110 已合入 `main`；自动发布门禁通过；人工资金与 Windows 实机验收待完成）
> baseline-branch: `main`
> baseline-commit: `db43294`
> baseline-version: `3.1.2`
> target-version: `3.1.3`
> implementation-branch: `codex/v3.1.3-pr-e-bank-account-ui-release`
> owner: PM / Dev
> updated: 2026-08-01
> risk: 🔴 资金红线
> delivery-mode: `必须按 PR-A → PR-B → PR-C1 → PR-C2 → PR-D → PR-E 分阶段实施；禁止单个 mega PR`

---

## 0. Codex 执行总则

本 Spec 是实现契约，不是讨论稿。除第 18 节列出的停止点外，Codex 应直接执行，不再自行扩大范围或重新设计业务规则。

### 0.1 目标

修复「平盘对账数据处理」在百万级 Excel 导入时因 Electron 主进程全量物化 workbook、行数组、主键集合和链接派生集合而直接退出的问题，并把有界内存、崩溃隔离、增量写库和可恢复存档覆盖到：

1. 平盘银行对账单；
2. 中台调拨订单表；
3. 中台测试付款全量信息表；
4. 中台网关原始入账订单；
5. 中台网关原始出账订单；
6. 清结算银行账户表；
7. 百万级银行/来源删除；
8. 百万级 FundTransfer 账户映射重建。

### 0.2 必须保持的发布契约

1. 银行导入仍为**全部所选文件一个事务、全有或全无**。
2. 普通来源仍为**先完成全批预检，再按文件独立事务提交**；前序成功文件不因后序失败回滚。
3. 清结算银行账户表仍为确认后整表替换。
4. 文件字节证据、业务数据、revision、`position_operation_inputs`、checkpoint history 和存档恢复必须可证明一致。
5. 不修改平盘资金性质匹配算法、来源业务主键字段、状态过滤、金额/币种/日期规则或链接派生规则；来源业务主键不再承担技术唯一性。
6. 不允许 Electron main 持有随输入行数增长的完整行、主键、冲突、派生或 raw JSON 集合。
7. 本 change 不改变匹配规则，不得自行提升 `POSITION_RULESET_VERSION`；来源 revision 变化继续使旧 pending run 失效。
8. 新引擎失败后不得自动回退到 Electron main 中的 `XLSX.readFile`。
9. 本版只承诺“百万级可导入、可管理、可删除、可重建派生”；不承诺百万级 `run/export` 全链路。

### 0.3 明确非目标

1. 不重写 `matching-engine.js`。
2. 不交付 300 万行原始表、链接表或银行表的流式导出。
3. 不交付 300 万行资金性质校验运行。
4. 不新增业务明细表到主库。
5. 不自动合并同一 workbook 中多个同结构业务 sheet。
6. 不以提高 V8 heap 上限作为主修复。
7. 不引入新的第三方依赖；优先使用现有 `yauzl`、`sax`、`xlsx`、`node:sqlite`。

### 0.4 完成定义

全部满足以下条件才可认为本 change 完成：

1. 真实 1,339,185 行五文件网关出账批次不再使 Electron main 退出。
2. 银行、网关入账、网关出账分别完成不少于 3,000,000 行的多文件导入压力测试。
3. Electron main RSS 不随 130 万 → 300 万行近似线性增长。
4. utilityProcess OOM、SIGKILL、未捕获异常时 Electron main 存活，当前事务回滚，已提交文件可恢复。
5. 新旧 reader 在 characterization 范围内的 JS 值、类型、日期、hash、DB JSON、错误首因完全等价。
6. 普通来源增量写入不再调用全量 `sourceRecords()` + `deriveLinkedRows()`。
7. 银行摘要、银行删除、来源删除和映射重建不再全量加载行对象。
8. 自动化、故障注入、真实样本、macOS/Windows 手测、重要变量检查和人工资金复核全部通过。

---

## 1. 当前代码基线与必须修改的入口

### 1.1 当前实现事实

以下事实属于本 change 的实现基线，不得在编码时重新假设：

1. `src/main-process/position-reconciliation/readers.js`
   - 在 Electron main 中调用 `XLSX.readFile(..., { cellDates: true, raw: true })`；
   - 通过 `sheet_to_json` 全量物化 sheet；
   - 银行批次持有完整 `records` 和 `bizIds Map`；
   - 来源批次持有完整 `records`、文件内 `seen Map` 和跨文件 `acceptedKeys Map`。
2. `src/main-process/position-reconciliation/service.js`
   - `prepareBankImport()` 是 prepare/token；
   - `prepareSourceImport()` 当前会自动提交非账户来源，只为账户快照生成确认 token；
   - bank/account token 只在当前进程内有效，重启即失效。
3. `src/main-process/position-reconciliation/store.js`
   - `applySourceImport()` 先 upsert 完整 `parsed.records`；
   - 随后调用 `rebuildLinkedRows(sourceType)`；
   - `rebuildLinkedRows()` 会读取该来源全表、生成完整 `derived` 数组、删除并重建全部链接；
   - `_mutation()` 负责 checkpoint、history 和业务事务；
   - `_recordOperationInputs()` 负责文件级提交凭证。
4. `src/main.js`
   - 每个 `position-reconciliation:*` tracked IPC 都由 `runPositionReconciliationOperation()` 新建一个独立 `operationToken`；
   - prepare IPC 和 apply IPC 的 `operationToken` 不同；
   - pending、archive intent、checkpoint 同步和恢复均按该单次 operationToken 管理。
5. `src/backend/big-table-import/import-worker.js` 和 `pipeline.js`
   - 虽然已有流式 scanner 和 worker 调度，但每个 worker 仍会积累完整 `batch`；
   - pipeline 会缓存整文件结果再写入；
   - 禁止原样复用到百万级平盘写库。

### 1.2 必须新增或重构的模块

建议目录如下；文件名允许小幅调整，但职责不得合并回 `main.js` 或完整 batch 管道：

```text
src/backend/position-reconciliation-import/
├── constants.js                 # 引擎常量、阈值、协议版本
├── xlsx-reader.js               # 平盘 XLSX sheet 识别与值等价层
├── xls-reader.js                # SheetJS 兼容路径，只在 utilityProcess
├── shared-strings-provider.js   # 内存/磁盘两级 SST provider
├── contracts.js                 # 银行与五类来源 reader contract
├── ledger.js                    # job ledger schema、预检、封存、验证
├── source-writer.js             # 普通来源逐文件增量写入
├── bank-writer.js               # 银行整批替换
├── account-writer.js            # 账户快照整表替换
├── maintenance-writer.js        # 删除、映射重建、索引迁移
└── worker-entry.js              # utilityProcess 作业入口

src/main-process/position-reconciliation/
├── import-dispatch.js           # spawn、协议、进度、取消、worker 退出恢复
├── side-db-mutation.js          # Store 与 worker 共用的 mutation helper
└── large-import-schema.js       # 现代索引检查、迁移和 schema fingerprint
```

### 1.3 禁止的实现方式

1. 禁止 parser worker 通过 IPC 返回完整行数组。
2. 禁止 main 接收完整主键数组或完整冲突集合。
3. 禁止 worker 构造整文件 `batch` 后统一 INSERT。
4. 禁止普通来源每写一个文件后调用现有全量 `rebuildLinkedRows()`。
5. 禁止逐来源行执行无索引的 `DELETE FROM position_link_rows WHERE source_row_id=?`。
6. 禁止 bank apply 在 JS 中构造全部既有 BizId Map。
7. 禁止用 `lastInsertRowid` 判断 upsert 更新后的既有 `source_row_id`。
8. 禁止在 worker 中复制第二套 checkpoint 算法。
9. 禁止在 worker 中自动迁移未知侧库、补表或接管 schema 不匹配的数据库。
10. 禁止用“增加 heap”掩盖无界数据结构。

---

## 2. 已锁定的核心决策

| ID | 决策 | 强制要求 |
| --- | --- | --- |
| D-01 | `jobId`、`confirmationToken`、`operationToken` 是三种不同身份 | 禁止跨 IPC 复用 operationToken |
| D-02 | 普通来源 apply 前必须由 main 持久化 archive intent，并收到持久化确认后才允许 worker 写 side DB | 引入 `PREFLIGHT_READY → APPLY_GRANTED` 握手 |
| D-03 | job ledger 预检结束后封存，不再修改 | apply 只读打开并验证 SHA/size/snapshot/schema/manifest |
| D-04 | 生产路径不依赖可写 ATTACH ledger | ledger 使用独立只读连接；银行只复制 scope 聚合，逐行按 BizId 精确复核 ledger 归属 |
| D-05 | worker 与 Store 共用唯一 mutation helper | helper 必须精确校验 expected checkpoint 和外部 operationToken |
| D-06 | 增量链接写入前必须补 `source_row_id` 索引和唯一约束 | 未迁移成功不得启用生产增量 writer |
| D-07 | 新链接读取顺序由 `(source_row_id, leg_index, id)` 定义 | 新写 `ordinal=source_row_id`；旧 ordinal 不回填 |
| D-08 | 原始来源行是否落库与链接派生 0/隐藏/可见分开统计 | 派生 0 行不得误当作来源过滤 |
| D-09 | 外部业务错误继续使用旧 reader 的首个错误契约 | 可继续扫描计数，但 `code/message/detailLines` 以首错为准 |
| D-10 | `.xlsx` 生产接线前必须通过 SheetJS parity | 未证明的 cell form 阻断该 sourceType 生产 gate，不得静默转空 |
| D-11 | `.xls` 继续 SheetJS，但只在 utilityProcess | main 不执行 BIFF 全量读取 |
| D-12 | 取消采用协作取消 + 超时强制终止 | hard terminate 后依赖 SQLite 回滚和 operation evidence 恢复 |
| D-13 | 生产默认不自动 fallback | legacy 仅为开发/紧急显式模式，且只能在 utilityProcess 和安全阈值内运行 |
| D-14 | target version 为 `3.1.3` | 版本 bump 仅在 PR-E 执行 |
| D-15 | 普通来源混合账户快照的现有行为保留 | 普通来源自动提交；账户仍返回待确认 token |
| D-16 | 普通来源以完整规范行的 `row_hash` 作为内部记录键 | 同业务主键不同内容全部保留；完全相同行在同批及后续独立导入中折叠 |

---

## 3. 三种身份与状态机

### 3.1 `jobId`

`jobId` 标识一个 staging + preflight 作业：

- 由 main dispatcher 创建 UUID；
- 可以跨越 bank/account 用户确认；
- 绑定 staging root、sealed ledger 和文件 manifest；
- 不代表一次 side DB mutation；
- 不写入 checkpoint history；
- 可出现在进度、日志和 confirmation descriptor 中；
- 不得由 renderer 自定义。

### 3.2 `confirmationToken`

`confirmationToken` 是 renderer 持有的一次性 opaque token：

- bank prepare 和 account prepare 成功后生成；
- 指向 `{jobId, sealedLedgerEvidence, selectedFileDescriptors, manifest}`；
- 只保存在 `PositionReconciliationService` 的内存 token map；
- 下一次同类 prepare、明确 cancel、service close 或应用重启后失效；
- 成功 apply 前先从 map 删除，防双击重复提交；
- apply 失败后不恢复同一个 token，用户必须重新选择文件；
- token 不包含行数组、主键数组或 raw JSON。

### 3.3 `operationToken`

`operationToken` 标识一次 `runPositionReconciliationOperation()` 生命周期：

- 每次 tracked IPC 新建；
- prepare 和 apply 必须是不同 token；
- 只能由 main 当前 AsyncLocalStorage operation context 提供；
- worker path 必须显式传入，缺失直接失败；
- 同一次普通来源 prepare 中，多个成功文件可共享同一个 operationToken，但每个文件独立推进 generation；
- bank/account apply 各自使用 apply IPC 新创建的 operationToken；
- 禁止从 renderer payload、job ledger 或 confirmationToken 中复用旧 operationToken。

### 3.4 Bank 状态机

```text
IDLE
  → STAGING
  → PREFLIGHTING
  → PREPARED(jobId, confirmationToken)
  → APPLY_REQUESTED(new operationToken)
  → INTENT_DURABLE
  → APPLYING(single transaction)
  → COMMITTED
  → ARCHIVE_DURABLE
  → CHECKPOINT_SYNCED
  → DONE
```

失败规则：

- prepare 失败：不修改 side DB，不登记业务 input evidence；清理无保护 staging/ledger。
- apply 事务失败：全部回滚，旧 scope 保持不变。
- COMMIT 后 worker 未回复：由 side DB checkpoint/history + operation inputs 推断真实成功，不允许用户重复导入。
- archive/outbox 未 durable：不允许同步主库 checkpoint 或清 pending。

### 3.5 普通来源状态机

```text
IDLE
  → STAGING
  → PREFLIGHTING(all selected files)
  → PREFLIGHT_READY(accepted ordinary files + optional account file)
  → main persists archive intent for accepted ordinary files
  → APPLY_GRANTED(current operationToken + exact baseCheckpoint)
  → APPLY file 0 transaction
  → FILE_COMMITTED(nextCheckpoint)
  → APPLY file 1 transaction
  → ...
  → result summary
  → ARCHIVE_DURABLE(committed files only)
  → CHECKPOINT_SYNCED
  → DONE
```

约束：

- 预检接受文件的跨文件记录身份所有权在 apply 前已固定；
- 前序文件 DB 系统失败不会让后序完全重复记录重新获得首次所有权；
- 每个成功文件独立推进一次 generation；
- worker fatal 时，side DB `position_operation_inputs(operationToken)` 是已提交文件的唯一权威；
- 未提交文件不得归档为成功输入。

### 3.6 混合账户快照状态机

一次 source 选择中可同时存在普通来源和最多一份账户快照，保持现有行为：

1. 全批共同 staging/preflight；
2. 普通来源按 §3.5 自动提交；
3. 账户文件不登记到当前 source prepare operation 的 archive intent；
4. prepare 返回 `needs-confirmation` 账户项和独立 `confirmationToken`；
5. 账户 apply 使用新的 operationToken；
6. 普通来源完成存档后，可清理普通文件 staging；账户 staging 和 sealed ledger 在 token 解决前继续保留；
7. 用户取消账户 token 后清理账户 staging 和 ledger；
8. 应用重启后 token 失效，孤儿 job 由过期清理处理；不自动续提交流程。

---

## 4. 业务不变量

### 4.1 平盘银行对账单

1. 支持 `.xlsx/.xls`，表头只接受：
   - 46 列 `BANK_STATEMENT_FIELDS`；
   - 49 列 `POSITION_BANK_HEADERS`。
2. 49 列输入中的三个审计字段只用于识别；实际 `originalRow/workingRow` 仍只保存 46 个银行字段。
3. sheet 必须名为 `渠道对账单`；允许 workbook 存在其它无关 sheet。
4. prepare 完成全部文件校验后才返回确认信息。
5. 用户确认前不修改 side DB。
6. apply 使用全部所选文件的单一事务。
7. `BizId` 在本批次必须唯一。
8. incoming BizId 不得与既有其它 `Channel + month_key` 冲突。
9. 目标范围为本次 manifest 中出现的全部 `Channel + month_key`。
10. apply 顺序严格为用户文件选择顺序、文件内物理行顺序。
11. `import_order` 从 0 开始跨文件单调递增。
12. 任一文件、任一行、manifest 对账、SQLite 写入或 checkpoint 失败，整个批次回滚。
13. prepare 的既有 scope 行数必须用 SQL 聚合，不得调用 `getBankRows().length`。
14. bank apply 不绑定 prepare 时的 side DB checkpoint；apply 必须以 apply IPC 当前 checkpoint 为基准重新校验。

### 4.2 普通链接来源

普通来源为：

- `fund-transfer`
- `test-payment`
- `gateway-inbound`
- `gateway-outbound`

规则：

1. 一次选择必须先完成所有文件预检，再开始任何普通来源写库。
2. 输出结果顺序等于用户选择顺序。
3. 同文件 `row_hash` 相同：折叠，保留第一次物理行。
4. 同文件业务主键相同、`row_hash` 不同：作为两条独立来源记录全部保留。
5. 任一业务非法行：整文件拒绝。
6. 跨文件 `sourceType + row_hash` 相同：后序完全重复行折叠；业务主键相同但 `row_hash` 不同不冲突。
7. 被拒绝文件不得产生来源行、链接行、revision、checkpoint 或 operation input evidence。
8. 后续独立导入相同 `sourceType + row_hash` 执行 upsert；同业务主键的新内容作为新记录插入，旧内容不被覆盖。
9. 每个预检接受文件一个独立 side DB transaction。
10. 同一文件即使全部 upsert 内容与现库相同，仍保持当前行为：执行写入/链接重建、bump revision、推进 checkpoint；本 change 不做 no-op 优化。
11. 一个非空文件即使全部是本批前序文件的完全重复行，也保持文件接受、独立事务和 input evidence；其 `persistedCandidateRows=0`，全部计入 `collapsedDuplicateRows`。
12. `row_hash` 为完整规范行的 SHA-256；`business_key` 继续保存原业务主键并允许重复。若同一 `row_hash` 对应不同规范行或业务主键，按哈希碰撞 fail closed。

### 4.3 清结算银行账户表

1. 同一次选择最多一份账户快照。
2. 只有 `账户状态=正常` 的行进入有效快照。
3. 非正常账户属于 `readerFilteredRows`，不是错误，也不进入来源表。
4. 内容完全相同的账户物理行也分别保留；账户记录身份绑定完整规范行和 Excel 物理行号，不按内容摘要折叠。
5. 过滤后 0 行：拒绝，旧快照保持不变。
6. prepare 只保存 manifest/token，不保存完整行数组。
7. 用户确认后的 apply 为单一整表替换事务。
7. account apply 使用新的 operationToken，不能复用 source prepare token。

### 4.4 来源原始行与链接派生必须分开

必须使用以下计数术语：

```text
scannedNonBlankRows      扫描到的业务表头范围内非空数据行
persistedCandidateRows   通过 reader 业务校验、且在本批首次出现的唯一 row_hash 行
collapsedDuplicateRows  同文件或跨文件 row_hash 相同而折叠的完全重复行
readerFilteredRows       旧 reader 本来就不写来源表的行；当前主要是账户状态非正常
invalidRows              导致整文件拒绝的非法行数量
visibleLinkRows          派生 visible=1 的链接行
hiddenLinkRows           派生 visible=0 的链接行
derivedZeroSourceRows    来源行已落库，但该来源记录派生 0 条链接
```

禁止：

- 把 `derivedZeroSourceRows` 计入 `readerFilteredRows`；
- 因派生 0 行而不写 `position_source_rows`；
- 因链接隐藏而删除原始来源行。

当前派生语义必须保持：

- FundTransfer：一条来源可派生 0 或 2 条链接；
- TestPayment：一条来源可派生 0 或 1 条链接；
- GatewayInbound：一条来源可派生 0 或 1 条链接，且可能 hidden；
- GatewayOutbound：一条来源派生 1 条链接；
- BankAccount：有效来源派生 1 条链接。

### 4.5 外部错误契约

1. 对旧 reader 已存在的业务错误，继续保留当前 `code/message/detailLines` 首因语义。
2. 新 reader 可以继续扫描文件以获得总错误数，但 renderer/API 对外仍使用按物理行顺序遇到的第一个错误。
3. 额外错误只能进入：
   - 有上限的内部 `diagnostics`；
   - benchmark/fault evidence；
   - 结构化日志的聚合计数。
4. 不得把所有错误拼进 `detailLines`，避免 IPC 和内存膨胀。
5. 新系统级错误使用第 12 节定义的新错误码。

---

## 5. utilityProcess 协议与 archive intent 握手

### 5.1 作业命令

`worker-entry.js` 至少支持：

```text
BANK_PREPARE
BANK_APPLY
SOURCE_PREPARE_AND_APPLY
ACCOUNT_APPLY
DELETE_BANK
DELETE_SOURCE
REBUILD_FUND_TRANSFER_MAPPING
ENSURE_LARGE_IMPORT_INDEXES
```

### 5.2 允许的消息

main → worker：

```js
{
  type: 'START_JOB',
  protocolVersion: 1,
  command,
  jobId,
  files,
  userDataDir,
  sideDbPath,
  contractOptions,
  featureFlags
}
```

worker → main：

```js
{
  type: 'PROGRESS',
  jobId,
  stage,
  currentFile,
  totalFiles,
  fileName,
  scannedRows,
  acceptedRows,
  committedRows,
  elapsedMs
}
```

普通来源 preflight 完成后：

```js
{
  type: 'PREFLIGHT_READY',
  jobId,
  archiveManifestHash,
  acceptedOrdinaryInputFiles,
  accountConfirmationDescriptor,
  orderedFileResults,
  ledgerEvidence
}
```

main 完成 pending archive intent 持久化后：

```js
{
  type: 'APPLY_GRANTED',
  jobId,
  operationToken,
  expectedCheckpoint,
  archiveManifestHash,
  schemaFingerprint
}
```

每个普通来源文件 commit 后：

```js
{
  type: 'FILE_COMMITTED',
  jobId,
  fileIndex,
  sourceType,
  rowCount,
  linkedRowCount,
  nextCheckpoint,
  inputKey
}
```

完成：

```js
{
  type: 'COMPLETE',
  jobId,
  result
}
```

fatal：

```js
{
  type: 'FATAL',
  jobId,
  code,
  stage,
  fileIndex,
  scannedRows,
  message,
  detailLines
}
```

取消：

```js
{ type: 'CANCEL', jobId }
{ type: 'CANCEL_ACK', jobId, stage }
```

### 5.3 `PREFLIGHT_READY → APPLY_GRANTED` 强制握手

普通来源自动提交必须按以下顺序：

1. worker 完成全部文件 preflight；
2. worker 发送 `PREFLIGHT_READY` 后暂停，不得打开 side DB 写事务；
3. main 从当前 operation context 读取 operationToken；
4. main 对所有“预检接受且可能提交”的普通来源文件调用 `recordPositionArchiveIntentFiles(..., 'input')`；
5. main 将 `archiveManifestHash` 写入当前 pending 的附加字段；
6. main 重新读取 pending，验证：
   - pending operationToken 未变化；
   - archiveFiles 精确包含该 manifest 的文件证据；
   - archiveManifestHash 一致；
7. main 获取当前 `service.persistenceCheckpoint()`；
8. main 发送 `APPLY_GRANTED`；
9. worker 收到 grant 后再次验证 jobId、manifest hash、schema fingerprint 和 base checkpoint，才可开始第一笔事务。

任何情况下都不得出现：

```text
worker 已 COMMIT side DB
但 main pending 尚未持久化该文件 archive intent
```

### 5.4 Bank/account apply intent

bank/account apply handler 继续遵守现有调用顺序：

1. 通过 confirmationToken 取得 job descriptor；
2. 调用 `recordPositionArchiveIntentFiles()` 持久化全部 apply 输入；
3. 验证 pending 所有权；
4. 再向 apply worker 发 `APPLY_GRANTED`；
5. token 在进入 apply 前即一次性消费。

---

## 6. Staging 与 Job Ledger

### 6.1 Staging

1. 路径继续位于：

```text
run-data/position-reconciliation/import-staging/<jobId>/<fileIndex>/
```

2. utilityProcess 使用异步流复制原文件；同一次读取同时计算 SHA-256。
3. 复制前后校验源文件 stat；复制完成后校验 staging 文件 stat、大小和 SHA-256。
4. 每个文件 descriptor 至少包含：

```js
{
  fileIndex,
  originalPath,
  originalName,
  stagedPath,
  stagingDir,
  sourceSnapshot,
  sha256,
  sizeBytes
}
```

5. staging 文件权限尽可能设置为仅当前用户可读写。
6. 业务解析、side DB 提交和存档均使用同一 staging 副本。
7. 任何 apply 前必须再次执行完整 snapshot + size + SHA 校验。

### 6.2 Ledger schema

job ledger 为临时 SQLite 文件，不属于主库或业务侧库。最小 schema：

```sql
CREATE TABLE job_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE job_files (
  file_index INTEGER PRIMARY KEY,
  original_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  staged_path TEXT NOT NULL,
  source_type TEXT,
  sheet_name TEXT,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  source_snapshot_json TEXT NOT NULL,
  preflight_status TEXT NOT NULL,
  scanned_non_blank_rows INTEGER NOT NULL DEFAULT 0,
  persisted_candidate_rows INTEGER NOT NULL DEFAULT 0,
  collapsed_duplicate_rows INTEGER NOT NULL DEFAULT 0,
  reader_filtered_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows INTEGER NOT NULL DEFAULT 0,
  visible_link_rows INTEGER NOT NULL DEFAULT 0,
  hidden_link_rows INTEGER NOT NULL DEFAULT 0,
  derived_zero_source_rows INTEGER NOT NULL DEFAULT 0,
  date_min TEXT,
  date_max TEXT,
  content_hash TEXT,
  first_error_code TEXT,
  first_error_message TEXT,
  first_error_detail_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE source_seen_records (
  source_type TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  row_guard_hash TEXT NOT NULL,
  business_key TEXT NOT NULL,
  first_file_index INTEGER NOT NULL,
  first_row_number INTEGER NOT NULL,
  PRIMARY KEY(source_type, row_hash)
);

CREATE INDEX idx_source_seen_business_key
ON source_seen_records(source_type, business_key);

CREATE TABLE bank_seen_biz_ids (
  biz_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  month_key TEXT NOT NULL,
  first_file_index INTEGER NOT NULL,
  first_row_number INTEGER NOT NULL
);

CREATE TABLE bank_scopes (
  channel TEXT NOT NULL,
  month_key TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  PRIMARY KEY(channel, month_key)
);

CREATE TABLE file_errors (
  file_index INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  row_number INTEGER,
  code TEXT NOT NULL,
  field TEXT,
  message TEXT NOT NULL,
  PRIMARY KEY(file_index, seq)
);
```

### 6.3 Ledger preflight 规则

1. `PRAGMA journal_mode=DELETE`。
2. `PRAGMA synchronous=FULL`。
3. `PRAGMA temp_store=FILE`。
4. 每个文件使用独立 savepoint。
5. 文件最终失败时回滚该文件写入的 seen keys、scope 和统计。
6. 普通来源文件被接受后，其 seen record identities 保留，用于折叠后序跨文件完全重复行；同业务主键不同 `row_hash` 不冲突。
7. 错误详情每文件最多 100 条；`invalid_rows` 记录全量计数。
8. ledger 不保存完整行或 raw JSON。
9. 业务 key、row hash 和独立 SHA-512 `row_guard_hash` 可保存在 ledger，但不得进入
   日志、IPC 或用户可见错误明细。相同 row hash 的 guard 或业务 key 不一致时按哈希碰撞
   fail closed。

### 6.4 Ledger 封存

preflight 全部完成后：

1. 写入：
   - `ledgerSchemaVersion=2`；
   - `protocolVersion=1`；
   - `jobId`；
   - `kind`；
   - `createdAt`；
   - 小型 manifest JSON 和 manifest hash。
2. 执行 `PRAGMA quick_check`，必须返回唯一 `ok`。
3. 提交并关闭 writer connection。
4. 确认不存在未完成 `-journal`；若存在，封存失败。
5. 对 ledger 主文件计算 snapshot、size、SHA-256。
6. 生成：

```js
{
  ledgerPath,
  ledgerSchemaVersion: 2,
  ledgerSnapshot,
  ledgerSizeBytes,
  ledgerSha256,
  manifestHash
}
```

7. apply 使用 `new DatabaseSync(ledgerPath, { readOnly: true })` 独立只读连接。
8. apply 打开前和打开后再次校验 ledger snapshot/size/SHA。
9. ledger 打开后保持连接至 apply 校验完成，防止验证后替换。
10. 生产路径不使用可写 `ATTACH` ledger。

### 6.5 Ledger 生命周期

1. 普通来源无账户 token：operation 完成并存档 durable 后删除整个 job root。
2. 混合账户 token：普通文件完成后只删除普通 staging；保留账户 staging 和 sealed ledger。
3. bank/account cancel：删除 token 对应 staging/ledger，前提是没有 pending/outbox/artifact 引用。
4. worker fatal：
   - 有已提交 operation input proof：先完成恢复和存档；
   - 无提交 proof：可清理未保护 staging/ledger；
   - 保护集读取失败：保守保留。
5. 应用启动继续使用现有过期清理思想；默认 7 天，仅清理无 pending/outbox/token 保护的 orphan job。
6. 大目录删除必须在 utilityProcess 或异步路径执行，禁止 main `rmSync` 长时间阻塞。

---

## 7. XLSX/XLS Reader 契约

### 7.1 XLSX sheet 选择

复用 `backend/big-table-import/zip-reader.js` 的 yauzl/workbook rels 能力，但不能复用“多 sheet 直接拒绝”的公共 `openWorkbook()` 行为。

新增平盘专用 API，例如：

```js
openPositionWorkbook(filePath)
locatePositionBusinessSheet(workbook, contracts)
```

规则：

#### 银行

- 查找名称精确为 `渠道对账单` 的 sheet；
- 该 sheet 第 1 物理行表头必须精确匹配 46 或 49 列；
- 缺失时报现有 bank sheet missing 错误；
- 允许其它无关 sheet。

#### 来源

- 扫描 workbook 中每个 sheet 的第 1 物理行；
- 与五类 `SOURCE_DEFINITIONS[*].headers` 精确比较；
- 0 个命中：`position-source-unrecognized`；
- 多个命中：`position-source-ambiguous`；
- 恰好 1 个命中：只扫描该 sheet；
- 无关说明 sheet 不导致拒绝。

### 7.2 SheetJS parity

新 `.xlsx` decoder 必须与：

```js
XLSX.readFile(path, { cellDates: true, raw: true })
```

在 characterization 覆盖的 cell form 上等价：

- shared string；
- inline string；
- formula cached string/number/boolean；
- number、科学计数法、负数、负零、零；
- boolean；
- error cell；
- 日期样式 number；
- 1900/1904 date system；
- ISO 日期；
- 文本数字、前导零、15 位以上 ID；
- rich text SST；
- XML entity；
- 稀疏行、稀疏列、物理行跳号；
- UTF-8 跨 chunk。

必须比较：

1. JS 值；
2. `typeof` / `Date` 类型；
3. `stableJson`；
4. `stableHash`；
5. `normalizeDate/monthOf`；
6. `original_json/working_json/raw_json`；
7. Excel 物理行号；
8. 错误首因。

### 7.3 未证明 cell form 的处理

1. 开发阶段若遇到旧 reader 接受、但新 decoder 尚未证明等价的合法 cell form：
   - 返回 `position-import-parser-parity-unproven`；
   - 阻断该 sourceType 的生产 feature gate；
   - 增加 fixture 后再接线。
2. 不得静默转为空字符串。
3. 不得自动回退 Electron main。
4. 小文件开发对照可显式使用 `legacy-worker` 模式；不属于生产自动 fallback。
5. 所有真实样本中观察到的 cell form 未全部 parity 前，不得宣称该 sourceType 完成生产迁移。

### 7.4 空白行和物理行号

1. 表头固定为物理第 1 行。
2. 数据行判空只检查业务表头对应列；右侧未声明列不影响旧 reader 的空行判断。
3. 行存在但所有业务列为空：静默跳过。
4. `<row>` 缺少 `r` 时，使用顺序物理行 fallback，必须与旧 `__rowNum__ + 1` fixture 一致。
5. 49 列银行输入的审计字段不进入 46 列业务 JSON。

### 7.5 Shared Strings Provider

禁止无上限 `string[]`。

统一接口：

```js
provider.get(index) -> string
provider.count
provider.close()
```

两种模式：

#### 内存模式

- SST 估算内存不超过 `POSITION_SST_MEMORY_BUDGET_BYTES`；
- 初始默认 64 MiB；
- 预算常量集中定义，可通过 benchmark 调整。

#### 磁盘模式

1. `sst.bin`：UTF-8 长度前缀字符串文件；
2. `sst.idx`：固定 12 字节索引记录：
   - 8 字节 little-endian offset；
   - 4 字节 length；
3. `get(index)` 通过索引文件定点读取，不在内存保存完整 offset 数组；
4. 有界 LRU，默认最多 8,192 项；
5. SST 解析和索引写入逐 chunk；
6. index 越界、截断、单字符串超限、UTF-8 损坏必须显式失败；
7. provider 关闭后删除临时 SST 文件，除非 job fatal 诊断保护需要保留。

### 7.6 XLS

1. `.xls` 继续 SheetJS。
2. 只能在 utilityProcess 中读取。
3. 结果仍按行流向 writer，不允许把完整 workbook 传回 main。
4. 标准 BIFF 行数上限低于百万目标，本 change 不实现 BIFF 流式 parser。
5. `.xls` utilityProcess 崩溃时 main 存活并返回文件级错误。

### 7.7 增量 hash

必须与现有：

```js
stableHash(records.map(record => record.row/originalRow))
```

等价。

实现方式：

```text
SHA256(
  '['
  + stableJson(row0)
  + ',' + stableJson(row1)
  + ...
  + ']'
)
```

注意：

- 不能拼接 row hash 替代数组 stable JSON；
- source hash 只包含 `persistedCandidateRows` 的唯一记录；
- 账户 hash 在过滤非正常账户后计算；
- bank hash 按用户文件顺序和物理行顺序计算；
- apply 重新扫描得到的 hash 必须与 sealed manifest 一致，否则回滚。

---

## 8. 现代 Side DB 来源身份、索引与 Schema Gate

### 8.1 来源记录唯一身份迁移

普通来源必须从“业务主键唯一”迁移为“完整规范行唯一”：

```text
business_key       = 原来源业务主键，仅用于业务展示、查询和血缘，允许重复
source_record_key  = row_hash，即 stableHash(完整规范行)，作为跨导入稳定技术身份
source_row_id      = 当前侧库自增物理主键，不作为跨重建稳定身份
```

侧库契约调整为：

1. `position_source_rows` 移除 `UNIQUE(source_type,business_key)`，新增 `UNIQUE(source_type,row_hash)`。
2. 新增非唯一索引 `idx_position_source_type_business_key(source_type,business_key)`。
3. `position_link_rows` 新增非空 `source_record_key`，值取父来源行 `row_hash`。
4. `position_consumed_sources` 新增非空 `source_record_key`，唯一约束改为 `(source_type,source_record_key,leg_index)`；`business_key` 保留用于审计。
5. 新运行的 lineage 必须同时记录 `sourceBusinessKey` 与 `sourceRecordKey`。
6. 旧确认运行没有 `sourceRecordKey` 时，只允许在迁移期间通过旧库唯一的 `source_type + business_key` 解析并回填；无法唯一解析则阻断迁移。
7. 表重建、回填、索引创建和 schema fingerprint 更新必须在同一 `BEGIN IMMEDIATE` 事务内完成。
8. 迁移前执行磁盘空间门禁；失败不得留下半迁移 schema。

后续独立导入语义：

- 完全相同规范行：命中同一 `source_record_key`，更新文件血缘，不新增记录；
- 同业务主键但内容不同：生成不同 `source_record_key`，新增记录并独立派生、匹配和消费；
- 删除仍按既有来源类型/月范围删除命中的全部内容版本。

### 8.2 必需索引

增量链接 writer 上线前必须存在：

```sql
CREATE UNIQUE INDEX uq_position_link_source_leg
ON position_link_rows(source_row_id, leg_index);

CREATE INDEX idx_position_link_type_source_order
ON position_link_rows(source_type, source_row_id, leg_index, id);
```

理由：

- `DELETE ... WHERE source_row_id=?` 必须走索引；
- FK cascade 删除来源行必须能快速定位链接行；
- 新读取顺序需要 sourceType/sourceRow/leg 索引；
- `(source_row_id, leg_index)` 保证单来源腿唯一。

### 8.3 迁移前检查

创建唯一索引前执行：

```sql
SELECT source_row_id, leg_index, COUNT(*) AS count
FROM position_link_rows
GROUP BY source_row_id, leg_index
HAVING COUNT(*) > 1
LIMIT 51;
```

- 0 行：允许迁移；
- 有重复：fail closed，错误码 `position-link-source-leg-duplicate`；
- 不得自动删除、保留第一条或重新编号。

### 8.4 迁移方式

1. 新增 `ENSURE_LARGE_IMPORT_INDEXES` utility job。
2. 平盘全局 operation lock 覆盖整个迁移。
3. 使用 side DB 独立连接：
   - `foreign_keys=ON`；
   - `journal_mode=WAL`；
   - `synchronous=NORMAL`；
   - `busy_timeout=30000`。
4. `BEGIN IMMEDIATE`；执行来源身份表重建与回填；检查重复；创建索引；`COMMIT`。
5. schema-only 索引迁移不推进业务 checkpoint generation。
6. 失败或 worker exit 依赖 SQLite DDL transaction 回滚。
7. 新建空库可以在首次大导入前创建索引；不要求 main 启动时同步构建大索引。
8. 来源身份 schema 为全局结构，不按 sourceType 分表。首次生产迁移前，仍走旧小文件
   reader 的来源写入路径也必须兼容 `row_hash` 唯一键和 `sourceRecordKey` 链接结构；
   sourceType streaming gate 不得让旧 `ON CONFLICT(source_type,business_key)` SQL 在现代
   schema 上继续运行。未完成该兼容时不得启用任何生产 schema 迁移。

### 8.5 Legacy schema 常量

`SUPPORTED_EMPTY_LEGACY_TABLE_INFO/SQL/INDEX_INFO` 继续描述“允许接管的旧空库证明”，不得直接改成要求旧库预先拥有新索引。

新增独立的现代 schema gate：

```js
assertPositionLargeImportSchema(db)
positionLargeImportSchemaFingerprint(db)
```

worker 每次生产写入前校验：

- 必需表和字段存在；
- 两个新索引存在且定义正确；
- checkpoint/history 完整；
- schema fingerprint 与 main grant 一致。

---

## 9. 唯一 Side DB Mutation Helper

### 9.1 API

新增：

```js
runPositionSideDbMutation({
  db,
  expectedCheckpoint,
  operationToken,
  inputEvidence = [],
  requireExternalOperationToken = false,
  mutate
})
```

返回：

```js
{
  result,
  nextCheckpoint
}
```

### 9.2 强制步骤

helper 必须按以下固定顺序执行：

1. 验证 `mutate` 为函数。
2. 规范化 expected checkpoint。
3. 若 `requireExternalOperationToken=true` 且 operationToken 为空，立即失败。
4. `BEGIN IMMEDIATE`。
5. 读取 side DB 当前 checkpoint。
6. 调用现有 checkpoint history 完整性校验。
7. 当前 checkpoint 必须与 expected 的 `identity/generation/token` 精确相等。
8. 执行 `mutate({ db, operationToken, currentCheckpoint })`。
9. 在同一事务内写入并复核 `inputEvidence`。
10. CAS 更新 generation。
11. CAS 更新 checkpoint token。
12. 插入 `position_checkpoint_history`，绑定同一 operationToken。
13. 复核三项 changes 均为 1。
14. `COMMIT`。
15. 返回 next checkpoint。
16. 任意错误 `ROLLBACK`，保留原错误。

### 9.3 Store 接入

1. `PositionReconciliationStore._mutation()` 改为该 helper 的薄包装。
2. main Store 保留现有 provider 行为；测试直接调用且没有 provider 时可以生成 UUID。
3. worker 必须设置 `requireExternalOperationToken=true`，禁止随机 fallback。
4. `_recordOperationInputs` 的 normalization/hash 逻辑抽成共享函数，不复制。
5. 所有现有 mutation characterization 必须保持通过。

### 9.4 多文件 checkpoint 链

普通来源同一 operationToken 下：

```text
base checkpoint
  -- file A --> generation +1
  -- file B --> generation +1
  -- file C --> generation +1
```

worker 必须：

- 第一文件 expected = main grant base checkpoint；
- 后续文件 expected = 上一文件 helper 返回的 nextCheckpoint；
- 不得每次重新读取后“顺着最新值继续”；
- 任一不匹配 fail closed。

Bank/account：

- 每次 apply 只有一笔 mutation；
- bank 全部输入文件在同一 inputEvidence 数组中；
- account 单文件一项 evidence。

---

## 10. Writer 契约

### 10.1 普通来源逐文件 writer

每个预检接受文件：

1. 验证 staging 文件 evidence。
2. 验证 sealed ledger 和该文件 manifest。
3. 创建连接级 TEMP 去重表，`temp_store=FILE`。
4. 调用 shared mutation helper，开始单文件事务。
5. 重新流式扫描文件并执行完整业务校验。
6. 来源记录身份规则在 TEMP 表和只读 ledger 中重演：
   - 同 `sourceType + row_hash`：完全重复，只有本批首次所有者写入，其他物理行折叠；
   - 同 business key 不同 hash：全部保留；
   - 同 hash 却出现不同规范行或业务主键：按哈希碰撞阻断并回滚。
7. 每条唯一来源执行：

```sql
INSERT INTO position_source_rows(...)
VALUES (...)
ON CONFLICT(source_type, row_hash) DO UPDATE SET
  business_key = excluded.business_key,
  ...文件血缘字段...
RETURNING id;
```

8. 禁止使用 `lastInsertRowid` 推断 upsert 后的 ID。
9. 取得 `source_row_id` 后：

```sql
DELETE FROM position_link_rows
WHERE source_row_id = ?;
```

10. 调用唯一的单记录派生 API：

```js
deriveLinkedRowsForRecord(sourceType, record, mappings)
```

11. 写入 0/1/2 条链接：

```text
source_row_id = RETURNING id
source_record_key = row_hash
ordinal      = source_row_id
leg_index    = 0..N-1
```

12. 扫描结束后比较：
   - nonblank count；
   - persisted count；
   - collapsed count；
   - filtered count；
   - content hash；
   - date range；
   - sourceType/sheetName。
13. 任一与 preflight manifest 不同：`position-import-preflight-apply-mismatch`，回滚。
14. 每文件只 bump 一次：
   - `source/<sourceType>`；
   - `linked/<sourceType>`。
15. 写该文件 operation input evidence。
16. helper 推进 checkpoint 并 commit。

### 10.2 单记录派生 API

重构 `derivation.js`：

```js
deriveLinkedRowsForRecord(sourceType, record, mappings)
deriveLinkedRows(sourceType, records, mappings)
```

- 批量 API 只循环调用单记录 API；
- 业务判断只能存在一份；
- characterization 比较旧批量 API 与新单记录 API 的：
  - row JSON；
  - visible；
  - legIndex；
  - 0/1/2 行数量；
  - 相对顺序。

### 10.3 链接读取顺序

统一业务读取为：

```sql
ORDER BY source_row_id, leg_index, id
```

要求：

1. 搜索所有依赖 `ordinal` 的生产读取并改成新顺序。
2. `ordinal` 字段保留，不迁移旧数据。
3. 新写 `ordinal=source_row_id`。
4. 旧数据和新数据混合时仍由 source_row_id/leg 定义顺序。
5. 匹配结果、导出顺序、隐藏行和消费关系通过 characterization。

### 10.4 Bank writer

Bank apply 采用一个 transaction：

1. 只读打开 sealed ledger。
2. 在 side DB connection 只创建小型 scope TEMP 表：

```sql
CREATE TEMP TABLE incoming_bank_scopes(
  channel TEXT NOT NULL,
  month_key TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  PRIMARY KEY(channel, month_key)
);
```

3. 从 ledger 复制 scope 聚合；禁止复制完整 BizId TEMP 表或构造 JS 主键数组。
4. 进入 shared mutation helper。
5. 删除 TEMP scopes 命中的旧银行行。
6. 按文件选择顺序重新流式扫描；每行 BizId、scope、文件序号和物理行号必须与只读 ledger 首次归属一致。
7. INSERT 依赖正式表 BizId 唯一约束原子阻断其它 scope 冲突；冲突时查询该 BizId 的既有 scope，返回 `position-bank-existing-bizid-conflict` 并回滚整个事务。
8. 49 列输入只写 46 列业务 JSON。
9. 验证 batch/per-file counts、hash、scopes、importOrder。
10. bump 每个实际目标 scope 一次，bump `bank-global/all` 一次。
11. 写全部文件 evidence。
12. checkpoint 只推进一次。
13. COMMIT。

### 10.5 Account writer

1. apply 前复核 token/job/ledger/file evidence。
2. shared mutation helper 内删除 `bank-account` 全部 source rows，依赖 FK cascade 删除 link rows。
3. 重新扫描文件，只写 `账户状态=正常` 行。
4. 过滤后必须 >0。
5. 每条记录 upsert/insert 后单记录派生。
6. manifest hash/count 必须一致。
7. bump source 和 linked revision 各一次。
8. 写 input evidence，推进一次 checkpoint。
9. 任一失败恢复旧快照。

### 10.6 FundTransfer 映射重建

移动到 utilityProcess，并保持一个事务：

1. 校验/规范化 mappings，沿用现有空值、重复中台账号错误。
2. shared mutation helper。
3. 删除并重写 `position_account_mappings`。
4. 删除 `source_type='fund-transfer'` 的全部链接行。
5. 通过 SQLite iterator：

```sql
SELECT *
FROM position_source_rows
WHERE source_type='fund-transfer'
ORDER BY id;
```

6. 每读一行解析 raw JSON，调用单记录派生，立即 INSERT 链接。
7. 每 5,000～10,000 行让出事件循环并检查取消。
8. bump `mapping/global` 和 `linked/fund-transfer`。
9. 任一错误或取消回滚旧 mappings 和旧链接。
10. 不 bump source revision。

### 10.7 来源删除

1. Account 仍只允许 wholeTable。
2. 非账户必须明确 months，禁止 wholeTable。
3. utilityProcess 中一个事务完成。
4. 按 `source_type + month_key` 直接删除 source rows；FK cascade 删除 link rows。
5. 为支持取消，按 rowid/id 每批 10,000 行删除，但整个操作仍在一个事务中。
6. 每批 yield/check cancel。
7. 完成后 bump source 和 linked revision 各一次。
8. 保持当前语义：即使匹配月份 0 行，非账户 delete 仍可返回 `deletedCount=0` 并完成 mutation/revision；不得自行改成 bank 风格错误。
9. 不调用 `rebuildLinkedRows()`。

### 10.8 银行删除

1. 删除前 SQL 聚合实际命中 scopes 和总行数。
2. 0 行时返回现有 `position-bank-delete-empty`，不进入 mutation。
3. utilityProcess 中一个事务完成。
4. 分批删除目标 scope 行，整个事务一次 commit。
5. 只 bump 实际有删除的 scope 和 `bank-global`。
6. 不加载 JSON，不构造 ID 数组，不使用超大 `IN`。

### 10.9 摘要 API

新增/重写：

```js
countBankRowsByScopes(scopes)
deleteBankScopesStreamed(selection)
deleteSourceRowsStreamed(selection)
rebuildFundTransferLinksStreamed(mappings)
```

`status/dataManager/linkedManager` 继续只返回小型聚合结果。300 万行下同步 SQL P95 超过 1 秒时，发布前必须补索引或异步化。

普通来源和链接管理摘要使用 side DB 内的派生缓存
`position_source_summaries`。来源导入、来源删除、账户快照替换和
FundTransfer 映射重建必须在同一个业务事务内刷新对应缓存；缓存缺失或结构损坏时只允许
回退事实表查询，不得把损坏缓存当成 0 行。缓存不是匹配、消费或恢复的业务事实来源。

---

## 11. Main/Service/IPC/Renderer 接入

### 11.1 既有 IPC 名称保持

以下名称不得改：

- `position-reconciliation:bank:prepare-import`
- `position-reconciliation:bank:apply-import`
- `position-reconciliation:bank:cancel-import`
- `position-reconciliation:source:prepare-import`
- `position-reconciliation:source:apply-import`
- `position-reconciliation:source:cancel-import`
- `position-reconciliation:bank:delete`
- `position-reconciliation:source:delete`
- `position-reconciliation:mappings:save`

### 11.2 新增辅助 IPC

```text
position-reconciliation:import:cancel
position-reconciliation:import-progress
```

preload：

```js
cancelActiveImport(jobId)
onImportProgress(listener) -> unsubscribe
```

Renderer 必须在 `finally` 调用 unsubscribe。

### 11.3 Service 方法异步化

允许改为 async：

- `prepareBankImport`
- `applyBankImport`
- `prepareSourceImport`
- `applySourceImport`
- `deleteBank`
- `deleteSource`
- `saveMappings`

外部返回主字段保持兼容。

### 11.4 Bank prepare 返回

```js
{
  status: 'needs-confirmation',
  token,
  jobId,
  fileCount,
  rowCount,
  scopes: [{ channel, monthKey }],
  existing: [{ channel, monthKey, rowCount }]
}
```

### 11.5 Source prepare 返回

```js
{
  status: successCount > 0 || confirmationCount > 0 ? 'ok' : 'failed',
  message,
  results: [
    {
      status: 'ok' | 'failed' | 'needs-confirmation' | 'cancelled',
      code,
      sourceType,
      sourceName,
      fileName,
      rowCount,
      linkedRowCount,
      collapsedDuplicateCount,
      token,
      oldValidCount,
      newValidCount,
      message,
      detailLines
    }
  ],
  successCount,
  failedCount,
  confirmationCount,
  archiveDeferred,
  inputPaths,       // 仅实际 commit 的普通来源 staging 路径
  inputFiles,       // 仅实际 commit 的 evidence
  cleanupPaths      // 当前 operation 完成后可清理的普通来源路径
}
```

规则：

- worker fatal 前若已有文件 commit，top-level 仍按现有规则返回 `status='ok'`；
- 当前失败文件和未尝试文件都以 `status='failed'` 返回；
- 未尝试文件使用 `position-source-not-attempted-after-fatal`；
- 若账户 descriptor 完整且用户未取消，仍可返回 `needs-confirmation`；
- `inputFiles` 以 side DB proof 为准，不以 worker 已发送消息为准。

### 11.6 进度 UI

新增可复用 `position-import-progress-dialog`：

- 标题：当前操作；
- 显示 stage、文件序号、文件名、扫描/接受/提交行数、耗时；
- staging/preflight/applying/deriving 阶段显示“取消导入”；
- 用户点击后变为“正在停止…”并禁用重复点击；
- summarizing/committing 阶段取消按钮禁用，文案“正在提交，无法取消”；
- worker 必须再次拒绝在 summarizing/committing 阶段到达的竞态取消，并返回
  `CANCEL_ACK accepted=false`；main 收到后取消强制终止计时器并恢复真实阶段，禁止把已进入
  提交区间的任务显示为停止成功；
- utility process 真实进度间隔超过 750ms 时，dispatcher 只重复最后一份阶段和计数作为
  heartbeat，不得虚增扫描、接受或提交数量；
- UI 耗时和 benchmark 间隔使用 monotonic clock；系统墙上时间跳变不得制造负耗时、虚假
  超时或错误的进度静默结论；
- worker 完成/失败后关闭；
- bank/account 确认框在 prepare 完成后继续沿用当前 UI；
- 增加 preview：
  - `position-import-progress`
  - `position-import-stopping`
  - `position-import-committing`

### 11.7 Feature flag

新增内部 gate，不提供用户 UI：

```js
POSITION_IMPORT_ENGINE = 'streaming' | 'legacy-worker' | 'disabled'
POSITION_STREAMING_SOURCE_TYPES = Set<sourceType | 'bank'>
```

阶段要求：

- PR-B：默认 `disabled`，仅测试/preflight flag；
- PR-C2：开发环境仅启 `gateway-outbound`；
- PR-D：逐 sourceType 开启；
- PR-E 全部门禁通过后，生产默认 `streaming`。

`legacy-worker`：

- 只在 utilityProcess；
- 只用于开发对照或显式紧急回退；
- 需要集中定义安全大小阈值；
- 超阈值直接拒绝；
- 新 streaming 失败不得自动转 legacy。

---

## 12. 取消、Fatal、部分提交与恢复

### 12.1 协作取消

worker 必须：

1. IPC 收到 `CANCEL` 后设置 cancel flag；
2. worksheet scan 每最多 10,000 行或 100ms：
   - pause stream；
   - yield `setImmediate`；
   - 检查 cancel；
3. SQLite 写循环每 5,000～10,000 行 yield/check；
4. commit 前最后检查一次；
5. cancel 抛统一 `CancelError`，当前事务回滚。

### 12.2 强制终止

1. main 发出 cancel 后 2 秒内 UI 必须进入“正在停止”。
2. 10 秒内若 worker 未 `CANCEL_ACK`，main 可 terminate utilityProcess。
3. 强制终止后：
   - 当前未提交 SQLite transaction 自动回滚；
   - 已提交普通来源文件保留；
   - main 按 operation input evidence 恢复；
   - UI 显示“正在回滚/核对已提交文件”，不虚假承诺 10 秒内 rollback 完成。

### 12.3 Worker exit 处理

worker exit 后 dispatcher 不得仅凭最后一条 IPC 判断结果。必须读取：

- side DB current checkpoint；
- checkpoint history operationToken；
- `position_operation_inputs(operationToken)`。

#### 普通来源

1. proof 存在的文件重建为 `ok`。
2. 当前/后续未 proof 文件重建为 `failed`。
3. 结果顺序保持用户选择顺序。
4. 返回结构化 summary 给 `runArchiveAwareOperation()`；若 side DB 已推进，不要把异常直接抛出绕过 archive settle。
5. 正常 archive 只传 committed inputFiles；pending 中预登记的其它文件由 proof 交集过滤。

#### Bank/account

1. 事务未 commit：0 input proof，返回失败。
2. 事务已 commit 但 worker 未回复：
   - operation inputs 与预期文件集合完全相等；
   - checkpoint history 在当前 operationToken 下推进预期次数；
   - 数据行/范围可用 manifest + SQL 聚合重建；
   - 满足时恢复为成功，不允许重复 apply。
3. 证据不完整：fail closed，保留 pending，要求恢复核对。

### 12.4 同进程恢复

worker fatal 后若 side DB 已推进：

1. 优先调用现有 `persistPositionArchiveIntentIfNeeded` 逻辑；
2. 存档集合严格为 pending intent 与 committed operation inputs 的交集；
3. archive/outbox durable 后同步 checkpoint；
4. 清理未提交 staging；
5. 若同进程恢复失败，保留 pending，返回 `position-recovery-required`，提示重启；
6. 禁止直接清 pending 或让用户重复操作。

### 12.5 Cleanup paths

普通来源 result 的 `cleanupPaths` 应覆盖：

- 已提交普通文件 staging；
- 预检拒绝文件 staging；
- fatal 后未提交普通文件 staging；
- 无账户 token 引用时的 ledger/job root。

混合账户时不得清：

- account staging；
- account token 仍引用的 sealed ledger。

---

## 13. 新错误码

业务错误继续复用现有 code。新增系统/大表错误：

| code | 含义 |
| --- | --- |
| `position-import-job-token-expired` | confirmation token/job 已失效 |
| `position-import-job-ledger-invalid` | ledger schema、hash、snapshot 或 manifest 损坏 |
| `position-import-intent-not-durable` | main pending archive intent 未完成持久化，禁止 apply |
| `position-import-worker-exited` | utilityProcess 异常退出 |
| `position-import-cancelled` | 用户取消，当前事务已回滚 |
| `position-import-disk-space-insufficient` | 写前磁盘门禁失败 |
| `position-import-parser-parity-unproven` | cell form 尚未证明与旧 reader 等价 |
| `position-import-preflight-apply-mismatch` | apply 重扫结果与 sealed manifest 不一致 |
| `position-side-db-schema-mismatch` | worker 所见 schema fingerprint 不匹配 |
| `position-link-source-leg-duplicate` | 现库存在 `(source_row_id,leg_index)` 重复，禁止建唯一索引 |
| `position-source-not-attempted-after-fatal` | 前序系统 fatal 后剩余文件未尝试 |
| `position-recovery-required` | 同进程恢复失败，需重启恢复 |

错误 payload 最多包含：

- stage；
- 文件名和文件序号；
- 物理行号；
- 字段名；
- 已扫描行数；
- 结构化 code；
- 不超过 100 条 detail。

禁止包含完整行、完整账号、完整业务 key 集合。

---

## 14. 磁盘、内存与可观测性

### 14.1 主进程内存硬约束

Electron main 不得持有随行数增长的：

- `records[]`；
- `acceptedKeys Map`；
- `bizIds Map`；
- `derived[]`；
- 完整错误数组；
- 完整 input row JSON 集合；
- shared strings 数组。

### 14.2 Worker 允许的内存

只允许：

- 当前行/当前 XML chunk；
- prepared statements；
- 小型 manifest；
- 有界错误列表；
- 有界 LRU；
- 当前文件的少量计数器。

主键和跨文件状态放 ledger；大量 SST 放 spill 文件；SQLite TEMP 使用 FILE。

PR-C2 普通来源 apply 连接额外约束：

- sealed ledger 只读连接和 side DB 写连接的 `cache_size` 均固定为 2 MiB；
- 两个连接均禁用 `mmap`，避免大型 ledger/side DB 映射页抬高 worker RSS；
- side DB 每个文件提交后执行 `PRAGMA shrink_memory`；
- 上述资源控制不得改变文件级事务、去重、派生或 checkpoint 语义。

### 14.3 磁盘门禁

正式业务 DELETE/INSERT 前估算：

```text
staging 副本
+ ledger
+ SST spill
+ side DB 新增页
+ WAL/rollback 空间
+ safety margin
```

要求：

1. 先记录真实 30 万、100 万、300 万行放大系数。
2. 校准前使用保守系数，不得用压缩 xlsx 大小直接等同 DB 需求。
3. 空间不足在任何业务 DELETE 前拒绝。
4. `SQLITE_FULL` 必须回滚并返回结构化错误。

### 14.4 日志

每 job 记录：

- jobId；
- kind；
- operationToken 仅记录短摘要；
- 文件数、压缩/解压估算；
- 各阶段耗时；
- scanned/persisted/collapsed/filtered/invalid/links/committed；
- worker pid、exit code、峰值 RSS/heap；
- checkpoint generation before/after；
- cleanup 结果。

不得记录：

- 完整账号、卡号、原始行；
- 全量 business key；
- 未掩码账户快照内容；
- ledger 内主键明细。

---

## 15. 分阶段实施计划

### PR-A — Characterization 与测试基线

**目标：不改生产行为，锁定旧契约。**

任务：

1. 为银行与五类来源建立旧 reader characterization。
2. fixture 覆盖：
   - 46/49 表头；
   - 多 sheet 识别；
   - 物理行号；
   - 所有 cell type/date system；
   - 同文件完全重复折叠、同业务主键不同内容保留；
   - 跨文件完全重复折叠；
   - 账户过滤；
   - 0/hidden/visible/2-leg 派生。
3. snapshot：
   - reader 返回；
   - DB rows；
   - link rows；
   - revision；
   - error code/message/detailLines；
   - result shape。
4. 增加 benchmark/fault harness 骨架。

**生产接线：无。**

**PR-A 门禁：** characterization 全绿后才能进入 PR-B。

### PR-B — Reader、SST、Ledger、utilityProcess Preflight

任务：

1. 实现平盘专用 XLSX sheet selection。
2. 实现 SheetJS parity decoder。
3. 实现 shared strings 两级 provider。
4. 实现 async staging/hash。
5. 实现 job ledger、savepoint、封存和验证。
6. 实现 utilityProcess dispatcher、进度、基础 cancel。
7. 只输出 manifest，不写业务 side DB。
8. 真实五文件跑完整 preflight。

**生产接线：默认 disabled，仅 feature flag preflight。**

### PR-C1 — Mutation Helper、Intent 握手、索引迁移与恢复

任务：

1. 抽 `side-db-mutation.js`。
2. 让现有 Store `_mutation` 使用共享 helper。
3. 实现 `PREFLIGHT_READY → APPLY_GRANTED`。
4. 实现现代索引迁移和 schema fingerprint。
5. 实现 worker exit 后按 operation inputs 重建结果。
6. 完成 checkpoint/archive fault matrix。
7. 此 PR 不接入真实百万来源 writer。

**生产接线：现有功能行为保持，新增路径仍 disabled。**

### PR-C2 — Gateway Outbound 最小生产切片

任务：

1. 实现普通来源逐文件 source writer。
2. 实现单记录派生 API。
3. 接 `gateway-outbound`。
4. 让未切 streaming 的旧小文件来源写入路径兼容现代全局身份 schema。
5. 改链接排序。
6. 真实五文件 1,339,185 行 end-to-end。
7. 文件 A commit/B fatal/恢复测试。

**生产接线：仅 `gateway-outbound` 使用流式 writer，受 sourceType gate 控制；同次选择中
未开放的普通来源复用预检暂存文件走现代 schema 兼容的小文件路径，不重新复制、不重复
登记存档意图。PR-C2 真实五文件 apply 必须满足 worker RSS 不超过 1 GiB，并保留
source/link/input proof/checkpoint/quick_check 数据库证据。PR-C2 允许集合必须由代码固定，
环境变量或 worker 消息均不得提前开放其它普通来源。**

### PR-D — 其它普通来源、删除与映射重建

任务：

1. 接 `gateway-inbound`。
2. 接 `fund-transfer`。
3. 接 `test-payment`。
4. 实现来源删除 utility job。
5. 实现银行删除 utility job。
6. 实现 FundTransfer 映射游标重建。
7. 验证 0/hidden/visible/2-leg parity。

**生产接线：代码级允许集合扩展为 `fund-transfer`、`test-payment`、
`gateway-inbound`、`gateway-outbound` 四类普通来源；配置仍可按 sourceType
缩小开启范围，但不能越过该集合。来源删除、银行删除和 FundTransfer 映射重建
统一在 utilityProcess 中使用同一 side DB mutation/checkpoint 事务，旧同步实现只在
streaming engine 未启用时作为兼容路径。普通来源作业在存档 durable 后按整个 job root
回收 staging、拒绝文件与 sealed ledger。**

### PR-E — Bank、Account、UI、磁盘门禁与发布收尾

任务：

1. Bank prepare/apply。
2. Account mixed-source confirmation/apply。
3. SQL 既有 scope 计数。
4. 进度/取消 modal 和 previews。
5. 软取消 + 强制 terminate。
6. 磁盘门禁。
7. 300 万银行/入账/出账压力测试。
8. 文档、CHANGELOG、用户指南和人工资金复核。

**生产接线：全部门禁通过后默认 streaming。**

---

## 16. 测试与 Benchmark

### 16.1 新增脚本

在 `package.json` 增加：

```json
{
  "test:position-import:parity": "node scripts/test-position-import-parity.js",
  "test:position-import:faults": "node scripts/test-position-import-faults.js",
  "benchmark:position-import": "node scripts/benchmark-position-import.js",
  "generate:position-import-fixture": "node scripts/generate-position-import-fixture.js"
}
```

300 万压力测试不加入每次 unit run，但发布前必须生成可追溯 evidence。

### 16.2 Parser parity

必须覆盖：

1. 银行 46/49。
2. 五类来源。
3. extra sheet、0 match、多 match。
4. shared/inline/formula string。
5. number/scientific/negative zero。
6. boolean/error。
7. 1900/1904 日期。
8. rich text/entity/UTF-8 chunk。
9. sparse row/column/row number fallback。
10. 长 ID、前导零。
11. JS type、stableJson、hash、monthKey、DB JSON 全等。
12. 首个业务错误 code/message/detailLines 全等。

### 16.3 业务语义

#### Bank

- 全批 duplicate；
- 其它 scope BizId 冲突；
- 多 Channel/月替换；
- 49 列审计字段忽略；
- apply 前 side DB 改变；
- token 过期/取消；
- manifest mismatch；
- 事务任一点失败旧范围不变；
- 300 万 existing count 不解析 JSON；
- 300 万 delete 不构造 ID 数组。

#### Source

- 同文件 same hash collapse；
- 同文件 same business key/different hash 全部保留；
- 跨文件 same hash collapse；
- 前序预检接受但 DB 失败，后序完全重复记录 ownership 不重分配；
- 后续独立导入 same hash upsert、different hash insert；
- 文件结果顺序；
- mixed account；
- partial success；
- fatal 后 unattempted 文件状态；
- inputFiles 只含 committed proof。

#### Derivation

- outbound 1；
- inbound 0/hidden/visible；
- test 0/1；
- transfer 0/2；
- account filter/1；
- old batch vs new per-record JSON/visible/leg/order/matching parity。

### 16.4 Schema/index

1. 空新库建索引。
2. 空旧十表库兼容后建索引。
3. 非空 3.1.1 库原地建索引。
4. 重复 `(source_row_id,leg_index)` 阻断且不改数据。
5. `EXPLAIN QUERY PLAN` 证明 source_row delete/FK cascade 使用索引。
6. worker schema fingerprint mismatch fail closed。

### 16.5 故障注入

至少注入：

1. staging copy 中断；
2. hash 期间源文件变化；
3. preflight worker exit；
4. intent 持久化前 worker 尝试 apply；
5. grant manifest hash 不一致；
6. BEGIN 后退出；
7. source row 写后/link 前；
8. revision 前后；
9. input evidence 前后；
10. checkpoint CAS 前后；
11. COMMIT 后/FILE_COMMITTED 前；
12. file A commit、file B 中段退出；
13. worker COMPLETE 前退出；
14. main checkpoint sync 前；
15. archive failure/outbox success；
16. archive/outbox 均失败；
17. cancel；
18. `SQLITE_BUSY`；
19. `SQLITE_FULL`；
20. ledger 被替换/截断；
21. 同进程恢复成功；
22. 同进程恢复失败后重启恢复。

断言：

- 未提交事务全部回滚；
- 已提交文件均有 operation input proof；
- 未提交文件无 proof；
- archive 集合等于 pending ∩ proof；
- checkpoint/pending 所有权不被提前清除；
- Electron main 存活。

### 16.6 真实五文件

使用原真实批次：

```text
1426944489706424320_1.xlsx  300,000
1426944489706424321_2.xlsx  300,000
1426944489706424322_3.xlsx  300,000
1426944489706424323_4.xlsx  300,000
1426944489706424324_5.xlsx  139,185
合计                          1,339,185
```

断言：

1. preflight/apply 行数守恒；
2. 不出现 main `Array buffer allocation failed`；
3. main 无完整 records/acceptedKeys/derived；
4. 每成功文件独立 generation/history/input proof；
5. DB 来源/链接结果与业务抽样一致；
6. worker 资源指标写入 evidence。

### 16.7 300 万容量

分别构造：

- bank ≥3,000,000；
- gateway-inbound ≥3,000,000；
- gateway-outbound ≥3,000,000。

benchmark 必须自动记录：

```text
OS、CPU、总内存、Electron/Node/V8 版本
文件数、压缩/解压大小、行数、SST 大小
main baseline/peak/end RSS
worker peak RSS/heap
吞吐、各阶段耗时
side DB/WAL/staging/ledger/SST spill 峰值磁盘
status/data-manager/linked-manager P50/P95
```

运行耗时、采样间隔和进度静默必须由 monotonic clock 计算；`generatedAt/capturedAt`
可继续保留墙上时间用于审计。两种时间不得混用。

初始门槛：

1. main RSS 增量目标 ≤150 MiB；
2. worker RSS 目标 ≤1 GiB；
3. 进度最长静默 ≤2 秒；
4. cancel 2 秒内进入停止状态，10 秒内 ACK 或强制 terminate；
5. 不因 worksheet XML >2 GiB 而失败；
6. IPC 错误 payload 有界；
7. 同步 summary P95 >1 秒则发布前优化或异步化。

超出门槛不得仅放大 heap；必须附 profile 并重新 review。

### 16.8 常规回归

必须执行：

```bash
npm run test:position-import:parity
npm run test:position-import:faults
npm run test:unit
npm run test:integration
npm run smoke
npm run release-check
npm run scan:vars
npm run check:vars
```

并在 macOS、Windows 各完成一次真实导入手测。

---

## 17. Acceptance Criteria

- **AC-01**：真实五文件批次不再使 Electron main 退出。
- **AC-02**：bank、gateway-inbound、gateway-outbound 分别通过 300 万行导入。
- **AC-03**：main 不读取完整 workbook，不保存完整行、主键、冲突或派生集合。
- **AC-04**：`jobId/confirmationToken/operationToken` 严格分离，prepare/apply 不复用 operationToken。
- **AC-05**：普通来源在 main pending intent durable 前绝不写 side DB。
- **AC-06**：Store 与 worker 使用同一个 mutation helper。
- **AC-07**：增量 link delete/FK cascade 有正确索引，不发生 O(N²)。
- **AC-08**：upsert 通过 `RETURNING id` 或同事务精确查询取得 source_row_id，不依赖 lastInsertRowid。
- **AC-09**：新链接读取顺序为 source_row_id/leg/id，旧新数据 parity 通过。
- **AC-10**：派生 0/hidden 行不改变原始来源落库契约。
- **AC-11**：业务错误首因与旧 reader 等价。
- **AC-12**：cell type/date/hash/DB JSON parity 通过后才开启对应 sourceType。
- **AC-13**：bank 仍整批原子，source 仍逐文件部分成功，account 仍确认整表替换。
- **AC-14**：每个成功事务的业务数据、revision、input proof、checkpoint 原子一致。
- **AC-15**：worker fatal 后 archive 只包含 committed proof 文件。
- **AC-16**：bank/account COMMIT 后 worker 未回复可由证据恢复真实结果，禁止重复提交。
- **AC-17**：staging/ledger 清理不删除 pending/outbox/token 正引用的文件。
- **AC-18**：银行摘要、银行删除、来源删除、映射重建在百万行下有界内存。
- **AC-19**：用户可见进度和取消语义真实，不在 COMMIT 后虚假报告取消成功。
- **AC-20**：磁盘不足、DB busy、ledger 损坏、staging 变化、worker crash 均结构化失败。
- **AC-21**：release-check、重要变量检查、真实样本、压力测试和人工资金复核全部通过。

---

## 18. Codex 必须停止并 AskUserQuestion 的情况

仅出现以下情况时停止并提问；其余按 Spec 直接推进：

1. characterization 证明当前生产行为与本 Spec 的业务不变量冲突。
2. 真实生产样本包含旧 SheetJS 接受、但无法在不改变 JS 类型/hash 的情况下解码的 cell form。
3. 真实 side DB 存在 `(source_row_id, leg_index)` 重复，或旧消费关系无法唯一回填 `sourceRecordKey`，需要决定人工修复策略。
4. 要实现目标必须改变：
   - 银行事务粒度；
   - 普通来源跨文件完全重复 ownership；
   - account mixed import 行为；
   - 超出 D-16 已批准范围的来源业务主键字段、记录身份或派生规则；
   - 错误首因契约。
5. 300 万 benchmark 在有界结构下仍显著超过门槛，且下一步需要改变产品范围或硬件基线。
6. 需要提前执行 PR-E 的版本 bump，或合并到受保护分支。

提问时必须附：

- 当前证据；
- 影响的不变量；
- 最小可选方案；
- 推荐方案；
- 不回答时的保守默认。

---

## 19. Codex 每个 PR 的交付报告格式

每个 PR 完成后输出：

```text
1. 本 PR 实现范围
2. 修改文件清单
3. 保持的不变量及对应测试
4. 新增/修改的错误码和 IPC
5. 数据库/schema/index 变化
6. 内存/磁盘/性能证据
7. 故障注入结果
8. 未完成项和 feature flag 状态
9. npm run scan:vars / check:vars 结果
10. 是否触发资金红线人工复核
```

禁止仅报告“测试通过”；必须给出关键计数、checkpoint generation、operation input proof 和 archive 集合证据。

---

## 20. 发布文案边界

在百万级 `run/export` 独立规格完成前，产品文案只能写：

> 支持百万级平盘 Excel 数据的流式导入、管理、删除和链接派生重建。

不得写：

> 支持百万级平盘全链路处理、匹配和单文件导出。

---

## 21. 正式收尾与发布准备状态

1. PR #110 已于 2026-08-01 合入 `main`，merge commit 为
   `4bb08b54676c9dd826d48c63ec6f7b4f6acf96f1`；最终实现 commit 为
   `3185aa343b2c935dafcde093148ac436da4ef193`。
2. 合并后使用发布流水线同款 Node 22 环境重新完成：
   - parity `54/54`；
   - fault `50/50`；
   - unit `4454/4454`；
   - 44 个 integration 脚本 `2051/2051`；
   - lint、smoke、主页面对齐 `6/6` 和启动性能检查全部通过。
3. `scan:vars` 为 261 个 `src` 文件、3283 个顶层名称；发布准备提交未修改
   `src`，`check:vars -- --include-minor` 安全跳过。
4. macOS `Asia/Shanghai` 下直接运行单测时，旧 `xlsx@0.18.5` 会受 1899 年
   历史秒级时区偏移影响，使测试生成的日期夹具出现前一天/43 秒差异；这与
   Windows Node 22 发布环境不同。发布门禁按 Windows workflow 的 Node 22 + UTC
   环境执行并全绿，不在本次收尾中改变既有 SheetJS parity 或业务日期口径。
5. 用户已明确要求执行正式收尾和发布收尾，因此允许创建 `v3.1.3` 技术发布；
   该授权不等于以下人工门禁已通过：
   - Windows 安装版导入、取消和文件锁；
   - 真实资金范围替换、链接派生和账户数据逐笔复核。
6. 上述人工门禁继续作为发布公告和业务启用前 follow-up。任何最终归档不得把
   自动化证据写成真实资金人工验收结论。
