# TechDoc - 网银账单小助手 v2.1.16-beta.3

| 项目 | 内容 |
|------|------|
| 版本 | v2.1.16-beta.3 |
| 日期 | 2026-06-07 |
| 作者 | PM（代起草，供 Dev 落地）|
| 状态 | 定稿 |
| 关联 PRD | `docs/iterations/v2.1.16-beta.3/PRD-v2.1.16-beta.3.md`（18 条 AC）|
| 依赖 | v2.1.16-beta.1 阶段一地基（`table-type-detector.js` / `linked-table-repository.js` / 链接表 schema / `bank-statement-merge.js`）已合入 main |

> 本文档为 **①Channel 枚举表** 与 **②银行对账单入金表** 的技术设计，详细到 Dev 可据以实现：含 DDL、函数签名、字段映射表、单测用例清单与风险红线。
> 实现代码由 Dev 编写；本文不含可直接复制运行的成品实现，仅给出契约级骨架与关键片段。

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §5.1 Channel 枚举表 | 可行。`readBankStatement` 返回 rows 为对象数组（`bank-statement-io.js:86` `sheetToObjects(sheet, BANK_STATEMENT_FIELDS)`），可直接 `row['Channel']` / `row['地区']` 取值；仓储层仿现有 `linked-table-repository.js` 纯函数 `(db,...)` 范式即可 |
| §5.2 入金表复用导入按钮 | 可行且已验证。`detectTableType(filePath, candidateSignatures)` 只在传入候选集内匹配（`table-type-detector.js:200`）；只要新签名仅进 `LINKED_IMPORT_SIGNATURES` 不进 `ALL_TABLE_SIGNATURES`，现有「导入」按钮即可识别入金表且不污染预加工主表识别 |
| §5.2 整表覆盖落库 | 可行。`replaceLinkedTable(db, tableKey, rows, opts)`（`linked-table-repository.js:136`）整表 DELETE+批量INSERT+算日期范围+upsert meta，入金表加一条 `LINKED_TABLE_DEFS['bank-deposit']` 即直接复用 |
| §5.2 13 字段裁列 | 可行。`readLinkedRowsAsObjects(filePath, signature)`（`main.js:11123`）按 `signature.expectedHeaders` zip 出 44 字段对象；handler 内对 bank-deposit 分支按 13 字段名 pick 即可 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | 🔴 入金表签名与主表签名**同构 44 列**（指纹完全相同），若同进 `ALL_TABLE_SIGNATURES` 缺省候选集 → 任何缺省 `detectTableType` 调用 ambiguous | 单独导出 `LINKED_IMPORT_SIGNATURES`，`ALL_TABLE_SIGNATURES` 保持不含它；单测断言守护（见 §6 UT-D1）。详见 TECH §4.1 |
| R-2 | 🔴 裁列若用索引切片（`slice`）会与 `BANK_STATEMENT_FIELDS` 列顺序强耦合，列顺序一动就裁错列 | 按 13 个字段名常量 pick；启动期 / 单测 assert 13 字段全部 ∈ `BANK_STATEMENT_FIELDS`（见 TECH §4.4、§6 UT-C5）|
| R-3 | 🔴 裁列必须在 44 列校验**之后** | 裁列发生在 `readLinkedRowsAsObjects`（内部走 detector L1/L2 + zip 校验）返回之后；异构文件读不出 44 列对象就不会进裁列分支 |
| R-4 | ⚠️ 沉淀失败若上抛会阻断导入 | 沉淀调用在导入 handler 内 try-catch 包裹，catch 仅 `appendActivityLogEntry({level:'warning',source:'main',domain:'channel-enum',...})` 记 warning（🔁 禁 raw console，见 §3.5），不 rethrow（见 TECH §3.5）|
| R-5 | ⚠️ `migrations.js` 同时被 ① ② 改动（① 新增 `ensureChannelEnumSupport`、② 改 `ensureLinkedTableSupport`）→ 批次 2/3 并行时易冲突 | 两处改动物理隔离（① 新增独立函数 + export；② 在 `ensureLinkedTableSupport` 事务内加一张表），合并时按行段合并即可；建议批次顺序提交 |
| R-6 | ⚠️ `seen_count` 累加口径 PRD 留待确认 | 本 TECH 采用「去重前出现行数累加」口径（§3.4）；若用户改口径，只动 `recordFromBankStatementRows` 的计数逻辑，不影响 schema |

### 1.3 与 PRD 的差异

无。本 TECH 与 PRD §5/§6/§8 完全对齐；待澄清项（PRD §十 两条 unchecked）在 §3.4 / §三 给出默认实现口径，dev 实现前如有歧义回 PM 确认。

---

## 二、涉及的文件清单

| 文件 | 改动类型 | 概要 | 归属 |
|------|---------|------|------|
| `src/backend/database/migrations.js` | 修改 | ① 新增 `ensureChannelEnumSupport(db)` + export；② `ensureLinkedTableSupport` 内加 `linked_bank_deposit` 表 + 2 索引 | ①② |
| `src/backend/database/channel-enum-repository.js` | 新增 | ① 纯函数仓储：`recordValue` / `recordFromBankStatementRows` / `listChannelEnumValues` | ① |
| `src/backend/database.js` | 修改 | ① require repo + `init()` 调 `ensureChannelEnumSupport` + facade `recordChannelEnumFromBankStatement` / `listChannelEnumValues` | ① |
| `src/main.js` | 修改 | ① 2 处导入 handler 加沉淀钩子（try-catch）；② `LINKED_DETECTOR_TO_REPO_KEY` 加 bank-deposit、候选集改 `LINKED_IMPORT_SIGNATURES`、bank-deposit 分支裁 13 字段 | ①② |
| `src/constants/table-signatures.js` | 修改 | ② 新增 `BANK_DEPOSIT_SIGNATURE` + 导出 `LINKED_IMPORT_SIGNATURES`；`ALL_TABLE_SIGNATURES` 保持不含它 | ② |
| `src/backend/database/linked-table-repository.js` | 修改 | ② `LINKED_TABLE_DEFS` 加 `'bank-deposit'`；`ALL_TABLE_KEYS` 追加 `'bank-deposit'` | ② |
| `src/renderer-dialogs.js` | 修改 | ② `LINKED_TABLE_LABELS` 加 `'bank-deposit':'银行对账单入金表'` | ② |

> facade（`database.js`）的 `replaceLinkedTable` / `listLinkedTableMeta` / `readLinkedTableRows` 已通用，走 `ALL_TABLE_KEYS` 自动含 bank-deposit，**入金表落库/读取不需新增 facade**。`preload.js` 复用现有 `linkedTable.import`，**不需改**。

---

## 三、需求 ①：Channel 枚举表

### 3.1 实现方案

仿现有 `linked-table-repository.js` / `channels-repository` 的「纯函数 `(db, ...)`」仓储范式，新建 `channel-enum-repository.js`，提供去重 upsert。schema 在 `migrations.js` 新增独立迁移函数 `ensureChannelEnumSupport`（与 40+ 现有 `ensureXxxSupport` 同构、幂等）。`database.js` 在 `init()` 调迁移 + 暴露 facade。`main.js` 在两处导入 handler 成功落 session 后调 facade，try-catch 包裹。

**为什么不用其他方案**：
- 不复用 `linked_table_meta` / 链接表机制：枚举是「值字典」非「整行表」，语义不同，单独建表更清晰。
- 不在导入 reader 内沉淀：reader（`bank-statement-io.js`）应保持纯读、无 DB 依赖；沉淀属编排职责，放 handler 层。

### 3.2 改动点

| 文件 | 位置 | 改动内容 |
|------|------|---------|
| `src/backend/database/migrations.js` | `module.exports` 前（约 :2454）| 新增 `function ensureChannelEnumSupport(db)`（DDL 见 §3.3）|
| `src/backend/database/migrations.js` | `module.exports`（:2455）| 追加导出 `ensureChannelEnumSupport` |
| `src/backend/database/channel-enum-repository.js` | 新建 | `recordValue` / `recordFromBankStatementRows` / `listChannelEnumValues`（签名见 §3.4）|
| `src/backend/database.js` | require 区（约 :47/:62）| `const { ensureChannelEnumSupport } = require('./database/migrations');`（并入现有解构）+ `const channelEnumRepository = require('./database/channel-enum-repository');` |
| `src/backend/database.js` | `init()`（约 :464，紧跟 `this.ensureLinkedTableSupport();`）| 加 `this.ensureChannelEnumSupport();` + 对应方法 |
| `src/backend/database.js` | facade 区（约 :1006~1027 链接表 facade 附近）| 加 `ensureChannelEnumSupport()` / `recordChannelEnumFromBankStatement(rows)` / `listChannelEnumValues(valueType)` |
| `src/main.js` | `bank-statement:import`（:3469 建 session 后、:3474 return 前）| 加 try-catch 沉淀钩子 |
| `src/main.js` | `bank-statement:batch-import`（bank-statement 分支，:11269 push ok 后、:11305 continue 前）| 加 try-catch 沉淀钩子（用本文件 `result.rows`，见 §3.5）|

### 3.3 DDL（migrations.js → `ensureChannelEnumSupport`）

🔴 **资金/数据红线说明**：纯新增审计字典表，无破坏性 DDL，CREATE IF NOT EXISTS 幂等。

```sql
CREATE TABLE IF NOT EXISTS channel_enum_values (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  value_type    TEXT NOT NULL CHECK (value_type IN ('channel', 'channel-region')),
  enum_value    TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  seen_count    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (value_type, enum_value)
);

CREATE INDEX IF NOT EXISTS idx_channel_enum_type ON channel_enum_values(value_type);
```

实现要点：
- 用 `db.exec('BEGIN'); try { ... db.exec('COMMIT'); } catch(e){ db.exec('ROLLBACK'); throw e; }` 包裹（与 `ensureLinkedTableSupport` 同范式，:2391）。
- `value_type` CHECK + `(value_type, enum_value)` UNIQUE 是去重 upsert 的基础，不可省。

### 3.4 仓储层函数签名（channel-enum-repository.js）

```js
// 文件头注释须标注：纯沉淀（仅 INSERT/UPDATE 枚举字典），不删除/不改写任何对账数据，非资金红线、属审计辅助。
// 纯函数 (db, ...) 风格，仿 linked-table-repository.js。

const VALUE_TYPE_CHANNEL = 'channel';
const VALUE_TYPE_CHANNEL_REGION = 'channel-region';

/**
 * upsert 单个枚举值。空值（trim 后为空）直接跳过、返回 false。
 * 新值 INSERT(first=last=now, count=delta)；已存在 UPDATE(last=now, count+=delta, first 不变)。
 * @param {*} db
 * @param {'channel'|'channel-region'} valueType
 * @param {string} enumValue
 * @param {string} now ISO 时间戳
 * @param {number} delta seen_count 增量（默认 1）
 * @returns {boolean} 是否实际写入
 */
function recordValue(db, valueType, enumValue, now, delta = 1) { /* dev 实现 */ }

/**
 * 从一批银行对账单行抽取并沉淀 Channel / Channel-地区 枚举值。
 *  - rows: 对象数组，每行 row['Channel'] / row['地区'] 可取值（readBankStatement 产物）
 *  - 进程内先 dedupe（Map<`${valueType} ${enumValue}`, count>）累计出现行数，再单事务批量 upsert。
 *  - 🔴 地区空只落 channel：Channel 非空且 地区 非空 → 记 channel + channel-region；
 *    Channel 非空但 地区 空 → 只记 channel；Channel 空 → 跳过整行。
 *  - 计数口径（§3.4 默认，PRD 待澄清项）：seen_count 累加「该批去重前出现的行数」
 *    （同批 3 行同 channel 值 → 该值 count +3）。channel-region 同理。
 * @returns {{channelCount:number, channelRegionCount:number}} 本批去重后新增/累加的不同值数量（供日志）
 */
function recordFromBankStatementRows(db, rows) { /* dev 实现 */ }

/**
 * 按 value_type 过滤列出枚举值（供后续引擎读库 + 审计）。
 * @returns {Array<{enumValue, firstSeenAt, lastSeenAt, seenCount}>} ORDER BY enum_value ASC
 */
function listChannelEnumValues(db, valueType) { /* dev 实现 */ }

module.exports = {
  VALUE_TYPE_CHANNEL,
  VALUE_TYPE_CHANNEL_REGION,
  recordValue,
  recordFromBankStatementRows,
  listChannelEnumValues
};
```

**upsert SQL 参考**（`recordValue` 内）：

```sql
INSERT INTO channel_enum_values (value_type, enum_value, first_seen_at, last_seen_at, seen_count)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(value_type, enum_value) DO UPDATE SET
  last_seen_at = excluded.last_seen_at,
  seen_count   = seen_count + excluded.seen_count;
```

> `excluded.seen_count` 取传入的 delta；`first_seen_at` 不在 UPDATE SET 内（自然保留首次值）。

**抽取与边界（`recordFromBankStatementRows` 伪代码）**：

```
counts = new Map()   // key = `${valueType} ${value}`, val = 出现行数
for row of rows:
  ch = String(row['Channel'] ?? '').trim()
  if (!ch) continue                       // Channel 空 → 跳过整行
  bump(counts, channel, ch)               // 记 channel
  region = String(row['地区'] ?? '').trim()
  if (region) {                           // 🔴 地区空 → 跳过 channel-region 拼接
    bump(counts, channel-region, `${ch}-${region}`)
  }
now = new Date().toISOString()
db.exec('BEGIN')
try {
  for ([key, cnt] of counts): recordValue(db, splitType(key), splitValue(key), now, cnt)
  db.exec('COMMIT')
} catch(e){ db.exec('ROLLBACK'); throw e }   // 🔴 抛给 handler，由 handler try-catch 吞掉
```

### 3.5 main.js 沉淀钩子（两处，try-catch 包裹）

🔴 **不阻断导入红线**：沉淀异常只记 warning 日志，不影响导入返回。

> 🔁 **Reverse-Sync（dev 已落地）**：项目禁止 `src/` 出现 raw console 调用（集成测试 `v2.1.9-sr-log-1` Case 6 强制 `src/` 0 个 raw console）。沉淀失败兜底**不能用 `console.warn`**，改用项目 sanctioned 的 `appendActivityLogEntry({ level:'warning', source:'main', domain:'channel-enum', ... })` 记 warning（语义等价：warning 级、不 rethrow、不阻断导入）。

**单选 `bank-statement:import`（:3469 建 session 后、:3474 return 前）**：

```js
// v2.1.16-beta.3 ①：导入成功后沉淀 Channel/Channel-地区 枚举（纯审计沉淀，失败不阻断导入）
try {
  database.recordChannelEnumFromBankStatement(result.rows);
} catch (enumErr) {
  appendActivityLogEntry({ level: 'warning', source: 'main', domain: 'channel-enum', message: `单选导入枚举沉淀失败（已忽略，不影响导入）：${enumErr && enumErr.message ? enumErr.message : enumErr}` });
}
```

**批量 `bank-statement:batch-import`（bank-statement 分支，:11269 `results.push({...ok})` 后、:11305 `continue` 前）**：

```js
// v2.1.16-beta.3 ①：本文件识别为 bank-statement 且导入成功 → 沉淀枚举（失败不阻断）
try {
  database.recordChannelEnumFromBankStatement(result.rows); // result.rows = 本文件行（merged.rows 已含历史，避免重复用 result.rows）
} catch (enumErr) {
  appendActivityLogEntry({ level: 'warning', source: 'main', domain: 'channel-enum', message: `批量导入枚举沉淀失败（已忽略，不影响导入）：${enumErr && enumErr.message ? enumErr.message : enumErr}` });
}
```

> 🔴 批量分支用 `result.rows`（本文件行）而非 `merged.rows`（合并累积行），避免追加合并时把历史文件行重复沉淀（虽 upsert 幂等不产脏数据，但会虚增 `seen_count`）。

### 3.6 注意事项

- 沉淀钩子放在 `status:'ok'` 之后，确保只对成功导入的文件沉淀。
- `recordFromBankStatementRows` 内部已有事务；handler 的 try-catch 是第二层保险（吞掉任何上抛）。
- 字段名严格用 `'Channel'` / `'地区'`（与 `BANK_STATEMENT_FIELDS` 索引 5/6 一致，大小写/中文敏感）。

---

## 四、需求 ②：银行对账单入金表

### 4.1 签名与候选集隔离（table-signatures.js）

🔴 **红线：`ALL_TABLE_SIGNATURES` 必须不含 `BANK_DEPOSIT_SIGNATURE`**。

```js
// 银行对账单入金表 — 模板=银行对账单.xlsx，44 列与 BANK_STATEMENT_SIGNATURE 同构。
// ⚠️ tableKey 与主表区分（'bank-deposit'），scope='linked'；
//    指纹列与主表完全相同（同一份模板）→ 绝不能与主表同进 ALL_TABLE_SIGNATURES（缺省候选 ambiguous）。
const BANK_DEPOSIT_SIGNATURE = Object.freeze({
  tableKey: 'bank-deposit',
  label: '银行对账单入金表',
  scope: 'linked',
  expectedHeaders: [...BANK_STATEMENT_FIELDS],
  signatureHeaders: ['ReconciliationId', 'Credit Amount', 'Debit Amount', '拆分信息', '关联大账号'],
  dateColumn: 'BillDate',
  minScore: 0.6,
  headerRowOffset: 0
});

// 链接表「导入按钮」候选集 = 现有 4 张 linked 签名 + 入金表签名。
//   🔴 仅此集合含 BANK_DEPOSIT_SIGNATURE；ALL_TABLE_SIGNATURES 维持原样不含它。
const LINKED_IMPORT_SIGNATURES = Object.freeze([
  ...LINKED_TABLE_SIGNATURES,
  BANK_DEPOSIT_SIGNATURE
]);

// ALL_TABLE_SIGNATURES 保持原定义（PREPROCESS + LINKED_TABLE_SIGNATURES），不加入金表！
// module.exports 追加：BANK_DEPOSIT_SIGNATURE, LINKED_IMPORT_SIGNATURES
```

> ⚠️ 实测核对：`BANK_STATEMENT_SIGNATURE`（主表）已在 `PREPROCESS_TABLE_SIGNATURES` → 进 `ALL_TABLE_SIGNATURES`。若入金表也进 ALL，则 ALL 内有两条同构签名 → 任何缺省 `detectTableType` ambiguous。生产无缺省调用（仅 11076/11199 传子集），但单测必须守护此不变量防回归（UT-D1）。

### 4.2 DDL（migrations.js → `ensureLinkedTableSupport` 事务内追加）

🔴 在现有 `ensureLinkedTableSupport`（:2391）事务内，紧跟 `linked_fx_settlement` 之后、:2446「待补一张表」注释处加：

```sql
-- 数据表 4：银行对账单入金表（键 reconciliation_id / 日期 bill_date，存 C~N+FundType 13 字段 raw_json）
CREATE TABLE IF NOT EXISTS linked_bank_deposit (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id TEXT,
  bill_date        TEXT,
  raw_json         TEXT NOT NULL,
  imported_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_linked_bank_deposit_recon ON linked_bank_deposit(reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_linked_bank_deposit_date  ON linked_bank_deposit(bill_date);
```

> 与现有 3 张链接表（gateway/mid-allocation/fx-settlement）同构。`ChannelOrderNo` 不单独建索引（PRD §2.3）。

### 4.3 仓储层定义（linked-table-repository.js）

`LINKED_TABLE_DEFS` 追加（约 :57 `fx-settlement` 之后、:59 `fx-option` 之前或之后均可）：

```js
'bank-deposit': {
  table: 'linked_bank_deposit',
  keyColumn: 'reconciliation_id',
  keyHeader: 'ReconciliationId', // BANK_STATEMENT_FIELDS 索引 11（驼峰，与网关全小写区分）
  dateColumn: 'bill_date',
  dateHeader: 'BillDate',        // BANK_STATEMENT_FIELDS 索引 3
  supported: true
},
```

`ALL_TABLE_KEYS`（:70）追加 `'bank-deposit'`：

```js
const ALL_TABLE_KEYS = ['gateway-bill', 'mid-allocation', 'fx-settlement', 'fx-option', 'bank-deposit'];
```

> 入金表排在末位 → 链接表弹窗渲染第 5 行（与 PRD UI Mockup 一致）。`replaceLinkedTable` / `listLinkedTableMeta` / `readLinkedTableRows` 全部走 `LINKED_TABLE_DEFS` / `ALL_TABLE_KEYS`，**无需改这三个函数本体**。

### 4.4 main.js 路由 + 裁列（linked-table:import handler）

**4.4.1 require 与候选集**：

```js
// 顶部 require table-signatures 处追加 LINKED_IMPORT_SIGNATURES（替换 11076 处用的 LINKED_TABLE_SIGNATURES）
```

- `main.js:11076`：`detectTableType(filePath, LINKED_TABLE_SIGNATURES)` → 改为 `detectTableType(filePath, LINKED_IMPORT_SIGNATURES)`。
- `getLinkedSignatureByKey`（:11110 使用处）：其内部签名查找表改用 `LINKED_IMPORT_SIGNATURES`（否则查不到 bank-deposit 签名 → 走 unsupported 兜底）。

**4.4.2 `LINKED_DETECTOR_TO_REPO_KEY` 追加**（detector tableKey → repo tableKey 映射）：

```js
// 'bank-deposit'(detector) → 'bank-deposit'(repo)
'bank-deposit': 'bank-deposit',
```

**4.4.3 裁列**（在 :11122~11124 `readLinkedRowsAsObjects` → `replaceLinkedTable` 之间）：

🔴 **裁列在 44 列校验之后；按字段名 pick，非索引切片**。

```js
// 入金表 13 字段白名单（与 BANK_STATEMENT_FIELDS 索引 2~13 + 25 对应；按字段名 pick 防列序漂移）
const BANK_DEPOSIT_FIELDS = [
  'BizId', 'BillDate', 'ValueDate', 'Channel', '地区', 'MerchantId', 'Currency',
  'Credit Amount', 'Debit Amount', 'ReconciliationId', 'ChannelOrderNo', 'CustomerRef', 'FundType'
];
// 启动期/模块加载断言：13 字段全部 ∈ BANK_STATEMENT_FIELDS（防常量漂移）
// console.assert / throw if (BANK_DEPOSIT_FIELDS.some(f => !BANK_STATEMENT_FIELDS.includes(f)))

// handler 内 matched 分支：
const rows = readLinkedRowsAsObjects(filePath, signature); // 44 字段对象（已过 detector L1/L2 + zip 校验）
let rowsToWrite = rows;
if (repoKey === 'bank-deposit') {
  rowsToWrite = rows.map((r) => {
    const picked = {};
    for (const f of BANK_DEPOSIT_FIELDS) picked[f] = r[f];
    return picked; // 仅 13 字段；replaceLinkedTable raw_json 天然只存这 13 字段
  });
}
const ret = database.replaceLinkedTable(repoKey, rowsToWrite, { sourceFileName: fileName });
```

> 其余分支（gateway-bill / mid-allocation / fx-settlement）`rowsToWrite = rows`（不裁），逻辑不变。`replaceLinkedTable` 用 `LINKED_TABLE_DEFS['bank-deposit']` 的 `keyHeader='ReconciliationId'` / `dateHeader='BillDate'` 取键列/日期列，裁列对象内这两字段都在 → 键列/日期范围正常。

### 4.5 renderer-dialogs.js（label）

`LINKED_TABLE_LABELS`（链接表弹窗映射，约 :6162 附近）追加：

```js
'bank-deposit': '银行对账单入金表',
```

> 弹窗按 `listLinkedTableMeta()` 返回的 tableKey 列表渲染行，label 取本映射；新增一行自适应，无布局改动。若链接表管理弹窗有 preview 入口，按 `workflow_frontend_previews` 重跑对应 preview。

### 4.6 注意事项

- detector 候选集隔离已验证（生产 2 调用点 11076/11199），改 11076 为 `LINKED_IMPORT_SIGNATURES` 不影响 11199（仍用 `PREPROCESS_TABLE_SIGNATURES`）。
- `replaceLinkedTable` 对 `bank-deposit` 的 `supported` 必须为 true（不像 fx-option 抛错）。
- 裁列后对象字段顺序无所谓（raw_json 按对象键序，下游按字段名读）。

---

## 五、单测用例清单

> 自动发现 `tests/unit/**/*.test.js`（`scripts/run-unit-tests.js`）。新增/改 4 个测试文件。

### 5.1 `tests/unit/.../channel-enum-repository.test.js`（新增，需求 ①）

| 编号 | 用例 | 断言 |
|------|------|------|
| UT-C1 | 单行 Channel+地区均非空 | 库内有 `channel='JPM'` 与 `channel-region='JPM-HK'` 两条 |
| UT-C2 | 🔴 地区空只落 channel | `Channel='JPM'`/`地区=''` → 有 `channel='JPM'`，**无** `channel-region='JPM-'` |
| UT-C3 | Channel 空跳过整行 | `Channel=''` 行 → 无任何记录 |
| UT-C4 | 去重幂等 | 同值导入两批 → 不重复行；`seen_count` 累加；`last_seen_at` 刷新；`first_seen_at` 不变 |
| UT-C5 | 🔴 13 字段常量 ∈ BANK_STATEMENT_FIELDS | `BANK_DEPOSIT_FIELDS.every(f => BANK_STATEMENT_FIELDS.includes(f))` 为 true（防漂移；放本文件或单独 detector 测）|
| UT-C6 | `listChannelEnumValues('channel')` 按 type 过滤 | 仅返回 channel 类，不含 channel-region |
| UT-C7 | 计数口径 | 同批 3 行同 channel 值 → 该值 `seen_count=3`（§3.4 口径）|
| UT-C8 | 多种地区组合 | `JPM-HK` / `JPM-US` 并存为两条独立 channel-region；channel 仅一条 `JPM` |
| UT-C9 | null / 纯空格归一 | `地区='   '`（空格）按空处理（跳过拼接）；`Channel` 前后空格 trim 后比较 |

### 5.2 `tests/unit/.../linked-table-repository-deposit.test.js`（新增，需求 ②）

| 编号 | 用例 | 断言 |
|------|------|------|
| UT-L1 | 整表覆盖 | 连续两次 `replaceLinkedTable('bank-deposit', ...)` → 表内仅第二批 |
| UT-L2 | 键列归一 | `reconciliation_id` 列 = `String(ReconciliationId).trim()`（含 number 入参归一）|
| UT-L3 | 日期范围 | `bill_date` 正确归一为 `YYYY-MM-DD`；meta `dataDateMin/Max` = BillDate min/max |
| UT-L4 | 🔴 raw_json 仅 13 字段 | 传入 13 字段对象 → 读回 raw_json 解析恰好 13 键，无多余列 |
| UT-L5 | `listLinkedTableMeta` 含 5 行 | 返回数组长度 5，末位 tableKey='bank-deposit' |
| UT-L6 | `ALL_TABLE_KEYS` 含 bank-deposit | 常量含 `'bank-deposit'` 且在末位 |
| UT-L7 | supported=true | `LINKED_TABLE_DEFS['bank-deposit'].supported === true`；`replaceLinkedTable` 不抛「模板缺失」|
| UT-L8 | `readLinkedTableRows('bank-deposit')` 还原 | 读回行为 13 字段对象数组，按 id ASC 保序 |

### 5.3 `tests/unit/main-process/table-type-detector.test.js`（改，需求 ②）

| 编号 | 用例 | 断言 |
|------|------|------|
| UT-D1 | 🔴 ALL 不含入金表 | `ALL_TABLE_SIGNATURES.some(s => s.tableKey === 'bank-deposit')` 为 **false**（守护防回归不变量）|
| UT-D2 | LINKED_IMPORT 含入金表 | `LINKED_IMPORT_SIGNATURES.some(s => s.tableKey === 'bank-deposit')` 为 **true** |
| UT-D3 | 链接候选集识别入金表 | `detectTableType(银行对账单.xlsx, LINKED_IMPORT_SIGNATURES)` → 唯一命中（非 ambiguous）。⚠️ 见下方备注 |
| UT-D4 | 预加工候选集识别为主表 | `detectTableType(银行对账单.xlsx, PREPROCESS_TABLE_SIGNATURES)` → `tableKey='bank-statement'`（不串）|
| UT-D5 | 非入金表链接文件不被入金表干扰 | `detectTableType(网关对账单.xlsx, LINKED_IMPORT_SIGNATURES)` → `tableKey='gateway-recon'` |

> ⚠️ **UT-D3 备注（dev 需关注）**：`银行对账单.xlsx` 同时满足主表与入金表两条签名，但二者**不同时**在 `LINKED_IMPORT_SIGNATURES` 里——该集合只有入金表签名（主表 `BANK_STATEMENT_SIGNATURE` 在 `PREPROCESS_TABLE_SIGNATURES`，不在 `LINKED_*`）。故在 `LINKED_IMPORT_SIGNATURES` 候选集内入金表是**唯一**同构匹配，不 ambiguous。这正是 §4.1 隔离设计成立的关键，UT-D3 须显式验证「唯一命中且 tableKey='bank-deposit'」。

### 5.4 handler 裁列断言（`tests/unit/.../bank-deposit-import.test.js` 或并入 io 测试，需求 ②）

| 编号 | 用例 | 断言 |
|------|------|------|
| UT-H1 | 命中后裁 13 字段 | 模拟 44 字段行 → 裁列函数输出对象恰好 13 键（字段名集合 = `BANK_DEPOSIT_FIELDS`）|
| UT-H2 | 🔴 44 列校验失败抛错 | 缺列 / 错位文件经 `readLinkedRowsAsObjects` → 抛 `FileValidationError` 或 detector 不命中，**不进裁列落库** |
| UT-H3 | 裁列保留键/日期字段 | 裁后对象含 `ReconciliationId` 与 `BillDate`（保证 `replaceLinkedTable` 取键列/日期不丢）|

> 测试可直接测裁列纯函数（建议把 §4.4.3 的 pick 逻辑抽成可导出小函数 `pickBankDepositFields(row)` 便于单测），handler 端到端走 §七 手测。

---

## 六、风险红线（Dev 实现必守）

| # | 红线 | 守护措施 | 验证 |
|---|------|---------|------|
| 1 | 🔴 入金表整表覆盖（重导旧数据全删）| 与现有链接表同语义；PRD §8 已标人工复核 | UT-L1 + 手测 7.1 整表覆盖 |
| 2 | 🔴 44 列严格校验必保留，裁列在校验之后 | 裁列发生在 `readLinkedRowsAsObjects` 返回之后；异构文件读不出 44 列对象 | UT-H2 + 手测 7.2 异构文件 |
| 3 | 🔴 `ALL_TABLE_SIGNATURES` 隔离（不含入金表）| 入金表只进 `LINKED_IMPORT_SIGNATURES`；ALL 维持原样 | UT-D1（防回归断言）|
| 4 | 🔴 裁列字段-列顺序解耦 | 按 13 字段名 pick，禁用 `slice` 索引切片；启动期/单测 assert 13 字段 ∈ `BANK_STATEMENT_FIELDS` | UT-C5 / UT-H1 |
| 5 | 🔴 沉淀不阻断导入 | 沉淀调用 handler 内 try-catch，catch 仅 `appendActivityLogEntry({level:'warning',...})` 记 warning 不 rethrow（🔁 禁 raw console，见 §3.5）| UT（注入异常）+ AC1-7 手测 7.2 |
| 6 | ⚠️ 批量沉淀用本文件行非合并行 | 批量分支用 `result.rows`（本文件）非 `merged.rows`（累积），防 `seen_count` 虚增 | 代码 review + 手测 7.2 重复累积 |

> 🔴 **重要变量关联**：本版触碰 `BANK_STATEMENT_FIELDS`（Critical，裁列依赖其顺序）、新增 SQLite 表 `channel_enum_values` / `linked_bank_deposit` + migration、`LINKED_TABLE_SIGNATURES` / `ALL_TABLE_SIGNATURES` 候选集。提 PR 前 / 版本 bump / 合并 main 前必须跑 `/check-vars`，出「⚠️ 关联功能 review」段落（详见 §N+5）。

---

## N+2、任务分解

> 每个 task 尽量小、可验证、可独立完成。批次 2=②，批次 3=①（彼此文件无重叠，仅 `migrations.js` 需按行段合并）。

| 序号 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|---------|---------|------|
| ②-1 | 新增 `BANK_DEPOSIT_SIGNATURE` + 导出 `LINKED_IMPORT_SIGNATURES`（ALL 不含）| `table-signatures.js` | UT-D1/D2 | todo |
| ②-2 | `ensureLinkedTableSupport` 加 `linked_bank_deposit` 表 + 2 索引 | `migrations.js` | 启动建表 / UT-L7 | todo |
| ②-3 | `LINKED_TABLE_DEFS` 加 bank-deposit + `ALL_TABLE_KEYS` 追加 | `linked-table-repository.js` | UT-L5/L6/L7/L8 | todo |
| ②-4 | handler：候选集改 `LINKED_IMPORT_SIGNATURES` + 映射追加 + bank-deposit 分支裁 13 字段 | `main.js` | UT-H1/H2/H3 + 手测 7.1 | todo |
| ②-5 | `LINKED_TABLE_LABELS` 加 label | `renderer-dialogs.js` | 手测弹窗 5 行（+ preview 回归如有）| todo |
| ①-1 | 新增 `ensureChannelEnumSupport` + export | `migrations.js` | 启动建表 / AC1-1 | todo |
| ①-2 | 新建 `channel-enum-repository.js`（3 函数）| `channel-enum-repository.js` | UT-C1~C9 | todo |
| ①-3 | `database.js` require + init 调迁移 + 3 facade | `database.js` | facade 可调 / AC1-8 | todo |
| ①-4 | 2 处导入 handler 加沉淀钩子（try-catch）| `main.js` | AC1-2/1-3/1-7 手测 | todo |

## N+3、实施计划（Commit 粒度）

| 序号 | Commit message | 涉及文件 | 需求 |
|------|---------------|---------|------|
| 1 | `[v2.1.16-beta.3] feat(②): 银行对账单入金表签名 + LINKED_IMPORT_SIGNATURES 隔离` | `table-signatures.js` | ② |
| 2 | `[v2.1.16-beta.3] feat(②): linked_bank_deposit 表 + 仓储定义 + ALL_TABLE_KEYS` | `migrations.js` `linked-table-repository.js` | ② |
| 3 | `[v2.1.16-beta.3] feat(②): 导入 handler 路由 + 13 字段裁列 + 弹窗 label` | `main.js` `renderer-dialogs.js` | ② |
| 4 | `[v2.1.16-beta.3] test(②): 入金表整表覆盖/裁列/ALL 隔离单测` | `tests/unit/**` | ② |
| 5 | `[v2.1.16-beta.3] feat(①): channel_enum_values 表 + 仓储 + facade` | `migrations.js` `channel-enum-repository.js` `database.js` | ① |
| 6 | `[v2.1.16-beta.3] feat(①): 导入成功沉淀枚举（try-catch 不阻断导入）` | `main.js` | ① |
| 7 | `[v2.1.16-beta.3] test(①): 枚举去重/地区空边界/不阻断导入单测` | `tests/unit/**` | ① |

## N+4、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识。

### 2026-06-07

- 动作：PM 起草 ①② TECH 设计（基于已批准实施计划 + 已核实代码事实）。
- 证据：核对 `bank-statement-fields.js`（44 列顺序，C~N=索引2~13、FundType=索引25）、`table-signatures.js`（签名结构 / `ALL_TABLE_SIGNATURES` 组成）、`linked-table-repository.js`（`replaceLinkedTable` 范式 / `LINKED_TABLE_DEFS` / `ALL_TABLE_KEYS`）、`migrations.js:2391`（`ensureLinkedTableSupport` 现状 + 待补表注释位）、`main.js`（3451/11059/11178 三 handler、11076/11199 detector 调用点、11122-11124 落库点）、`bank-statement-io.js:73`（`readBankStatement` rows 为对象数组）。
- 风险：见 §六 6 条红线；最高危为「ALL_TABLE_SIGNATURES 隔离」与「裁列字段-列顺序解耦」「沉淀不阻断导入」。
- 决策：`seen_count` 采「去重前出现行数累加」口径（PRD 待澄清项默认）；批量分支用 `result.rows` 防虚增。

### 可沉淀知识

- [ ] 「同构 44 列签名隔离」模式：同一模板派生两种用途（主表预加工 / 链接表入金）时，签名分别进不同候选集、缺省 `ALL` 集只留一份，避免 detector ambiguous —— 值得回写 `knowledge/`。

## N+5、Open Technical Questions

1. `seen_count` 累加口径（去重前行数累加 vs 按批 +1）—— 本 TECH 默认前者；若用户改口径只动 `recordFromBankStatementRows` 计数，schema 不变。
2. 入金表导入成功前端提示是否特殊化 —— 默认沿用现有 `linked-table:import` 结果提示。
3. `pickBankDepositFields` 是否抽为 `linked-table-repository.js` 导出函数（便于单测 UT-H1）vs 留在 `main.js` handler 内联 —— 建议抽出，dev 落地时定。
4. `/check-vars` 段落由 team-lead 在批次 4 生成（新表 + migration + 候选集变更为触发项）。
