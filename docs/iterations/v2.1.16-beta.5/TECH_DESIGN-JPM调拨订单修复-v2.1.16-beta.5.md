# TechDoc - 网银账单小助手 v2.1.16-beta.5「JPM 调拨订单修复」

| 项目 | 内容 |
|------|------|
| 版本 | v2.1.16-beta.5 |
| 日期 | 2026-06-08 |
| 作者 | team-lead（代 Dev 出设计稿，本版只设计不实现） |
| 状态 | 定稿（设计蓝本；10 条决策已由用户逐条确认，详见 PRD §九；进入实现版本以此为准） |
| 关联 PRD | `docs/iterations/v2.1.16-beta.5/PRD-JPM调拨订单修复-v2.1.16-beta.5.md`（22 条 AC；§九 已确认决议） |
| 依赖 | 网关 ReconID 修复链路（`recon-id-fix-engine.js` / `recon-id-fix-io.js` / C4 `c4-recon-id-fix.js`）、链接表仓储 `linked-table-repository.js`、`migrations.js`、范式引擎 `r5-refund-order-backfill.js` / `r5-fund-transfer-backfill.js`、`engine-utils.js` / `engine-date-utils.js`、`normalizers.js` |

> 🔴 本文件是**设计蓝本**，不含可直接合并的实现代码。文中 JS 片段为**设计示意（伪代码 / 骨架）**，标注「示意」，进入实现版本时由 dev 落地并补单测。**本版不碰 `src/`。**
>
> ✅ **10 条语义决策已全部确认**：本文按 PRD §九「已确认决议」为最终实现契约。进入实现版本直接以本文 + PRD §九 为准。
>
> ⚠️ 文中行号为核对时快照，dev 实现期须以 grep / Read 再次定位精确位置（`src/main.js` 含 NUL 字节，grep 须 `-a`）。

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §5.1 需求1 按钮改绑 | 可落地。`recon-id-fix:import/run/export` 已实装且支持 gateway 子模式，前端改绑 `reconIdFix.import({subMode:'gateway'})` / `export()` 即复用同一 session，后端零改动 |
| §5.2 需求2 改名 | 可落地。`LINKED_TABLE_LABELS['bank-deposit']` 单点改；`BANK_DEPOSIT_SIGNATURE.label` 同步改 |
| §5.3 需求3 ADM 派生 | 可落地。新建独立隐藏表 `linked_adm_bank_deposit` + 独立仓储 + 纯函数 `buildAdmRows`；派生挂 `linked-table:import` 的 bank-deposit 落库后 |
| §5.4 需求4 场景 seed | 可落地。仿 `ensureReconRoundBuiltinScenariosSeed` 独立 marker 幂等；category 已在 CHECK 内 |
| §5.5 需求5 引擎 | 可落地。新建独立引擎 `jpm-dispatch-order-fix.js`，在 `runReconIdFix` 按 `config.subCategory` 分流；金额分级 / 1v1 消费复用 `r5-*` 范式；导出复用 `writeReconIdFixOutput({subMode:'gateway'})` |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 🔴 | 跨表字段名假设同名必错：渠道账单 `merchantId`(小写) vs 网关账单 `MerchantId`(驼峰) vs ADM/银行 `MerchantId`(驼峰)；Type 列名超长且缺右括号 | §七 定义显式字段映射常量 `adm-bank-deposit-fields.js`，全程常量 pick；Type 用 `GATEWAY_BILL_FIELDS[8]` 引用 |
| R-2 🔴 | 金额汇总（步骤4）多笔浮点相加精度漂移 | 逐笔 `Math.round(v*100)` 转分再累加（**严禁先浮点累加后 round**），复用 `r5-fund-transfer-backfill.js` 的 `amountEqual` 口径，容差 0 |
| R-3 🔴 | CustomerRef↔渠道流水号「一对一唯一」两侧任一重复必须判冲突，不能任取一条 | §三 `matchAdmToMidAllocation` 建 `Map<渠道流水号,[midRow]>`；中台侧 bucket.length>1 或 ADM 侧同 CustomerRef 多行 → 冲突进报错 |
| R-4 🔴 | `replaceLinkedTable` 硬编码 4 列（keyColumn/dateColumn/raw_json/imported_at），ADM 表多 batch_no/channel_order_no 两列，不能复用 | §三 新写 `replaceAdmBankDeposit` 专用仓储函数 |
| R-5 🟠 | ADM 表暴露给前端弹窗会破坏「隐藏」语义 | 注册进 `LINKED_TABLE_DEFS` 供仓储读写，但**不进** `ALL_TABLE_KEYS` / `LINKED_TABLE_LABELS` |
| R-6 🟠 | JPM run 阶段改 ADM 表状态（与 C4「run 无副作用、export 才写」模型不同），重复 run 须幂等 | §四 ADM 标志整批幂等重写（基于「原始 ADM 行 + 本次计算」重算，非增量累加） |
| R-7 🟠 | ADM 重建清掉已有匹配标志（重导银行对账单表=标志归零）| §三 整表覆盖语义；UI 提示用户已有 JPM 匹配结果会清空 |
| R-8 🟡 | additionInfo 正则误匹配 JSON 内金额 | §四 正则用空白定界 `/(?:^|\s)(\d{2})\/(\d{2})\/(\d{2})(?:\s|$)/`，JSON 内 `2100000.00` 无斜杠不命中 |
| R-9 🟡 | `runReconIdFix` 现 2 参签名，加 admRows 须兼容旧调用 | §四 第三参 `opts={}` 默认值，business / 非 JPM gateway 路径不受影响 |
| R-10 🟡 | merchantId 6300156616 硬编码散落 | 收进 `scenario.config.merchantId`，引擎从 config 读 |

### 1.3 与 PRD 的差异

- 无功能性差异。技术上把需求3/5 收敛为「字段映射常量 + 派生纯函数 + 引擎状态机 + 独立仓储」，行为与 PRD §5.3/§5.5 逐条等价（实现时以 PRD AC 为验收基线）。

---

## 二、涉及的文件清单（按 PR 规划，本版不落地）

| 文件 | 改动 | PR | 概要 |
|------|------|----|------|
| `src/backend/database/migrations.js` | 修改 | PR-1 / PR-3 | PR-1：`ensureAdmBankDepositSupport` 建 ADM 表；PR-3：`JPM_DISPATCH_ORDER_SCENARIO` + `ensureJpmDispatchOrderScenarioSeed` + 独立 marker 🔴 |
| `src/backend/database/linked-table-repository.js` | 修改 | PR-1 | ADM def 入 `LINKED_TABLE_DEFS`（**不进** `ALL_TABLE_KEYS`）+ `replaceAdmBankDeposit` / `readAdmBankDepositRows` / `writeAdmMatchFlags` 🔴 |
| `src/backend/database.js` | 修改 | PR-1 | 门面转发 ADM 仓储三函数 |
| `src/constants/adm-bank-deposit-fields.js` | 新增 | PR-1 | ADM 字段映射单一真相（ADM_FUND_TYPES / CHANNEL_VALUE / 6 新字段名 / 跨表映射）|
| `src/renderer-dialogs.js` | 修改 | PR-1 / PR-2 | PR-1：`LINKED_TABLE_LABELS['bank-deposit']` 改名；PR-2：ADM 创建成功 / 未匹配报错弹框 |
| `src/constants/table-signatures.js` | 修改 | PR-1 | `BANK_DEPOSIT_SIGNATURE.label` 改名 |
| `src/main-process/adm-bank-deposit-builder.js` | 新增 | PR-2 | 纯函数 `buildAdmRows(bankDepositRows, midAllocationRows)`（筛选 / 批次号 / 唯一匹配 / 部分成功）🔴 |
| `src/main.js` | 修改 | PR-2 / PR-3 | PR-2：`linked-table:import` bank-deposit 落库后派生 ADM；PR-3：`recon-id-fix:run` 注入 admRows。⚠️ 含 NUL，grep `-a` 🔴 |
| `src/main-process/scenario-engines/jpm-dispatch-order-fix.js` | 新增 | PR-3 | JPM 引擎 8 步状态机 🔴 |
| `src/main-process/recon-id-fix-engine.js` | 修改 | PR-3 | `runReconIdFix` 加第三参 `{admRows}` + JPM 分流 🔴 |
| `src/renderer.js` | 修改 | PR-4 | 需求1 三按钮改绑 + 《开始运行》入口 |
| `tests/unit/.../adm-bank-deposit-builder.test.js` | 新增 | PR-2 | 筛选 / 批次号 / 唯一匹配重复键 / 部分成功 |
| `tests/unit/.../jpm-dispatch-order-fix.test.js` | 新增 | PR-3 | 8 步状态机 / 金额汇总 / 批次 gating / Type 分支 |
| `tests/unit/.../linked-table-repository.test.js` | 修改 | PR-1 | ADM def 不暴露给 listLinkedTableMeta + ADM 仓储 round-trip |

---

## 三、需求3：ADM 隐藏表 + 中台调拨匹配（逻辑A）

### 3.1 schema（`migrations.js` 新增 `ensureAdmBankDepositSupport`，示意）

```sql
-- 【示意】独立 migration，紧邻 ensureLinkedTableSupport；独立 marker 或纯 CREATE IF NOT EXISTS 幂等
CREATE TABLE IF NOT EXISTS linked_adm_bank_deposit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id TEXT,          -- 复用 bank-deposit 键列（ReconciliationId）
  bill_date TEXT,                  -- 复用日期列（规范化 BillDate）
  batch_no TEXT,                   -- 批次号 = <规范化BillDate>-<ChannelOrderNo>
  channel_order_no TEXT,           -- 归批索引
  raw_json TEXT NOT NULL,          -- 13 银行字段 + 6 新字段整行
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_linked_adm_bank_deposit_batch ON linked_adm_bank_deposit(batch_no);
CREATE INDEX IF NOT EXISTS idx_linked_adm_bank_deposit_date  ON linked_adm_bank_deposit(bill_date);
```

- 6 新字段（批次号 / 调拨号 / Fundtransfer-in金额 / 资金对账ID / 是否与渠道账单匹配 / 是否与网关账单匹配）全部进 `raw_json`（与现有链接表「raw_json 存整行」范式一致）；批次号同时进 `batch_no` 列供 JPM 引擎按批 GROUP / 索引。
- 调用链：在 `database.js` 初始化序列里 `ensureLinkedTableSupport` 之后调用 `ensureAdmBankDepositSupport`。

### 3.2 仓储（`linked-table-repository.js`，示意）

```javascript
// 【示意】ADM def 入 LINKED_TABLE_DEFS（供仓储读写），但 ALL_TABLE_KEYS 不含 'adm-bank-deposit'（隐藏）
LINKED_TABLE_DEFS['adm-bank-deposit'] = {
  table: 'linked_adm_bank_deposit',
  keyColumn: 'reconciliation_id', keyHeader: 'ReconciliationId',
  dateColumn: 'bill_date', dateHeader: 'BillDate', supported: true
};

// 整表覆盖（6 列 INSERT，不能复用 replaceLinkedTable 的 4 列硬编码）
function replaceAdmBankDeposit(db, rows, options = {}) {
  // BEGIN → DELETE FROM linked_adm_bank_deposit → 批量 INSERT(reconciliation_id, bill_date,
  //   batch_no, channel_order_no, raw_json, imported_at) → COMMIT/ROLLBACK
  // raw_json = JSON.stringify(row 13+6 字段)；bill_date/batch_no/channel_order_no 取自 row 派生值
}

// 读回整行（仿 readLinkedTableRows，但走 ADM 表）
function readAdmBankDepositRows(db) {
  // SELECT raw_json FROM linked_adm_bank_deposit ORDER BY id ASC → JSON.parse 还原
}

// JPM run 阶段整批幂等重写匹配标志/资金对账ID（基于行 id 或 ReconciliationId+批次号 定位）
function writeAdmMatchFlags(db, admRows) {
  // 事务内逐行 UPDATE raw_json（资金对账ID/是否与渠道账单匹配/是否与网关账单匹配）；幂等可重入
}
```

> `database.js` 门面新增三函数转发（仿现有 `replaceLinkedTable` / `readLinkedTableRows` 转发风格）。

### 3.3 派生纯函数（`adm-bank-deposit-builder.js`，示意）

```javascript
// 【示意】buildAdmRows —— 纯函数，便于单测；不读 DB（rows 由 main.js 注入）
function buildAdmRows(bankDepositRows, midAllocationRows) {
  // 1) 筛选：Channel=ADM ∧ FundType∈ADM_FUND_TYPES（精确等于，大小写敏感）
  const admSource = bankDepositRows.filter(r =>
    normCell(r['Channel']) === CHANNEL_VALUE &&            // 'ADM'
    ADM_FUND_TYPES.includes(normCell(r['FundType'])));     // ['Fundtransfer-out','Fundtransfer-out&FX']

  // 2) 构造 ADM 行（13 字段 + 6 新字段初值）
  const admRows = admSource.map(r => ({ ...pick13(r),
    '批次号':'', '调拨号':'', 'Fundtransfer-in金额':'',
    '资金对账ID':'', '是否与渠道账单匹配':0, '是否与网关账单匹配':0 }));

  // 3) 批次号：按 ChannelOrderNo 分组，组内取首个可解析 BillDate 规范化
  assignBatchNo(admRows);   // 见 3.4

  // 4) 中台匹配（两侧任一重复=冲突）
  const { unmatched } = matchAdmToMidAllocation(admRows, midAllocationRows);  // 见 3.5

  return { admRows, unmatched, midEmpty: midAllocationRows.length === 0 };
}
```

### 3.4 批次号生成（决策细化，示意）

```javascript
// 【示意】组内一致性 > 单行 BillDate（防同 ChannelOrderNo 因 BillDate 脏数据分裂）
function assignBatchNo(admRows) {
  const groupDate = new Map();              // channelOrderNo → 规范化 YYYY-MM-DD
  for (const a of admRows) {
    const con = normCell(a['ChannelOrderNo']);
    if (con === '' || groupDate.has(con)) continue;
    const d = normalizeDateExportValue(a['BillDate']);   // normalizers.js
    groupDate.set(con, d && d.date ? formatIso(d.date) : '');
  }
  for (const a of admRows) {
    const con = normCell(a['ChannelOrderNo']);
    a['批次号'] = con === '' ? '' : `${groupDate.get(con) || ''}-${con}`;
  }
}
```

### 3.5 中台匹配（决策9，两侧任一重复=冲突，示意）

```javascript
// 【示意】CustomerRef ↔ 渠道流水号 唯一匹配；normKey = String().trim()（大小写敏感）
function matchAdmToMidAllocation(admRows, midRows) {
  // 中台索引（保留多条以检测冲突）
  const midByRef = new Map();
  for (const m of midRows) {
    const key = normKey(m['渠道流水号']);
    if (key === '') continue;
    (midByRef.get(key) || midByRef.set(key, []).get(key)).push(m);
  }
  // ADM 侧重复检测（同 CustomerRef 多行 → 冲突）
  const admRefCount = new Map();
  for (const a of admRows) {
    const k = normKey(a['CustomerRef']);
    if (k !== '') admRefCount.set(k, (admRefCount.get(k) || 0) + 1);
  }

  const unmatched = [];
  for (const a of admRows) {
    const refKey = normKey(a['CustomerRef']);
    if (refKey === '')            { unmatched.push({ row:a, code:'empty-customerref' }); continue; }
    if (admRefCount.get(refKey) > 1) { unmatched.push({ row:a, code:'adm-duplicate' }); continue; }
    const bucket = midByRef.get(refKey) || [];
    if (bucket.length === 0)      { unmatched.push({ row:a, code:'no-mid-match' }); continue; }
    if (bucket.length > 1)        { unmatched.push({ row:a, code:'mid-duplicate',
                                      conflict: bucket.map(x=>x['调拨单号']) }); continue; }
    // clean：两侧都唯一 → 赋值
    const m = bucket[0];
    a['调拨号']              = normCell(m['调拨单号']);
    a['Fundtransfer-in金额'] = normCell(m['收款金额']);   // 原值落库，金额比较在 JPM 引擎做
  }
  return { unmatched };
}
```

### 3.6 import handler 接线（`main.js`，示意）

```javascript
// 【示意】linked-table:import 内 bank-deposit 落库成功后（约 main.js:11208 之后）
if (repoKey === 'bank-deposit') {
  const midRows = database.readLinkedTableRows('mid-allocation');
  const { admRows, unmatched, midEmpty } = buildAdmRows(
    database.readLinkedTableRows('bank-deposit'), midRows);
  database.replaceAdmBankDeposit(admRows);
  results.push({ admCreated:true, total:admRows.length,
    matched:admRows.length-unmatched.length, unmatched, midEmpty });
}
// 前端据 results 弹「ADM银行对账单链接表已创建」或部分成功报错框（见 PRD Mockup B/C）
```

---

## 四、需求5：JPM 调拨订单修复引擎（逻辑B）

### 4.1 函数签名与分流

```javascript
// 【示意】recon-id-fix-engine.js —— runReconIdFix 加第三参，兼容旧 2 参调用
function runReconIdFix(scenario, sheets, opts = {}) {
  if (scenario.category === 'gateway-recon-id-fix'
      && scenario.config && scenario.config.subCategory === 'jpm-dispatch-order-fix') {
    return runJpmDispatchOrderFix({ sheets, admRows: opts.admRows || [], scenario });
  }
  // 原路径：runC4Scenario(scenario, sheets, subMode)
}

// main.js recon-id-fix:run（约 :3990）注入 admRows
// runReconIdFix(scenario, clonedSheets, { admRows: database.readAdmBankDepositRows() })
```

### 4.2 引擎 8 步状态机（`jpm-dispatch-order-fix.js`，示意）

```javascript
// 【示意】runJpmDispatchOrderFix({ sheets, admRows, scenario })
//   sheets：{ reconResult, businessBills(=网关账单), opponentBills(=渠道账单), fixTemplate }
//           — recon-id-fix-io.readReconIdFixFile(filePath,'gateway') 产出，key 沿用 C4 约定
//   返回：{ fixedRows, admUpdates, warnings, stats }
function runJpmDispatchOrderFix({ sheets, admRows, scenario }) {
  const MID = scenario.config.merchantId;                 // '6300156616'，从 config 读
  const channelRows = sheets.opponentBills, gwRows = sheets.businessBills;
  const warn = makeWarningCollector(scenario.id, scenario.name);

  // —— 阶段1：渠道账单匹配 ——
  const channels = channelRows.filter(r => normCell(r['merchantId']) === MID);   // 步骤1
  if (channels.length === 0) return { fixedRows:[], admUpdates:admRows, warnings:[/*提示*/], stats:{} };

  const usedChannel = new Set();
  for (const c of channels) {
    const billDate = extractBillDate(c['additionInfo']);  // 步骤2，见 4.3；null→跳过+warn
    if (!billDate) { warn.push({ code:'addition-date-not-found' }); continue; }

    // 步骤3：候选 = BillDate==出账日期 ∧ 是否与渠道账单匹配==0
    const group = admRows.filter(a =>
      normIso(a['BillDate']) === billDate && Number(a['是否与渠道账单匹配']) === 0);
    if (group.length === 0) { warn.push({ code:'channel-no-adm', billDate }); continue; }

    // 步骤4：整组 Fundtransfer-in金额 逐笔转分累加 === receiveAmount 分值（容差0）
    if (!sumEqualsReceive(group, c['receiveAmount'])) {    // 见 4.4
      warn.push({ code:'channel-amount-mismatch', billDate }); continue; }

    // 步骤5：命中 → 组内全赋 reconciliationId + 是否与渠道账单匹配=1；渠道账单 1v1 消费
    for (const a of group) {
      a['资金对账ID'] = normCell(c['reconciliationId']);
      a['是否与渠道账单匹配'] = 1;
    }
    usedChannel.add(c);
  }

  // —— 阶段2：批次 gating ——（步骤6）
  const byBatch = groupBy(admRows, a => a['批次号']);      // 同 ChannelOrderNo
  const readyBatches = [...byBatch.entries()].filter(([bn, rows]) =>
    bn !== '' && rows.every(a => Number(a['是否与渠道账单匹配']) === 1));

  // —— 阶段3：网关账单匹配 ——（步骤6/7）
  const gwUsed = new Set(), fixedRows = [];
  const TYPE = GATEWAY_BILL_FIELDS[8];                     // 超长缺括号 Type 列名，常量引用
  for (const [bn, batchRows] of readyBatches) {
    const reconFundId = batchRows[0]['资金对账ID'];         // 组内同值
    const type = batchRows.length > 1 ? 2 : 0;             // 决策8：仅标记多行聚合
    for (const a of batchRows) {                           // 每调拨号各匹配一个网关行（1v1）
      const alloc = normCell(a['调拨号']);
      if (alloc === '') continue;
      const cand = gwRows.filter(g => normCell(g['MerchantId']) === MID
        && normCell(g['OrderId']) === alloc && !gwUsed.has(g));
      if (cand.length === 0) { warn.push({ code:'gw-orderid-not-found', batch:bn, alloc }); continue; }
      if (cand.length > 1)   warn.push({ code:'gw-multi-match', batch:bn, alloc });   // 取第一+warn
      const g = cand[0];
      g['Reference'] = reconFundId;
      g[TYPE] = type;
      gwUsed.add(g);
      a['是否与网关账单匹配'] = 1;
    }
  }

  // 步骤8：网关账单中 Type ∧ Reference 有值的行 → fixedRows（复用 C4 buildOutputRow gateway）
  for (const g of gwRows) {
    if (normCell(g['Reference']) !== '' && normCell(g[TYPE]) !== '')
      fixedRows.push(buildOutputRow(g, {}, 'gateway'));    // 14 列 ORDER_REPAIR_FIELDS_GATEWAY
  }
  return { fixedRows, admUpdates: admRows, warnings: warn.list(), stats:{/* 各阶段计数 */} };
}
```

### 4.3 出账日期提取（步骤2，决策5，示意）

```javascript
// 【示意】additionInfo 内 ' YY/MM/DD '（空白定界）→ 20YY-MM-DD
const DATE_IN_ADDITION = /(?:^|\s)(\d{2})\/(\d{2})\/(\d{2})(?:\s|$)/;
function extractBillDate(additionInfo) {
  const s = String(additionInfo == null ? '' : additionInfo);
  const m = s.match(DATE_IN_ADDITION);
  if (!m) return null;
  const iso = `20${m[1]}-${m[2]}-${m[3]}`;     // 补世纪 20YY
  const d = toDate(iso);                        // engine-date-utils，校验 13月/32日
  return d ? formatIso(d) : null;
}
// 样例：'PAYDET=/ROC/ATS OF 26/05/04  {"...":{"amount":2100000.00}}' → '2026-05-04'
//   （JSON 内 2100000.00 无斜杠，不命中）
```

### 4.4 金额汇总（步骤4，决策6 + R-2，示意）

```javascript
// 【示意】逐笔转分再累加，严禁先浮点累加后 round
function sumEqualsReceive(admGroup, receiveAmount) {
  let cents = 0;
  for (const a of admGroup) {
    const v = parseNumber(a['Fundtransfer-in金额']);   // engine-utils
    if (v === null) return false;                       // 任一非数值 → 整组不匹配
    cents += Math.round(v * 100);                       // 🔴 先 round 再累加
  }
  const recv = parseNumber(receiveAmount);
  return recv !== null && cents === Math.round(recv * 100);   // 容差 0
}
```

### 4.5 导出与 ADM 回写

- **导出**：JPM `fixedRows` 列模板 = `ORDER_REPAIR_FIELDS_GATEWAY`（14 列），与 `writeReconIdFixOutput({subMode:'gateway'})` 一致，**复用现有 writer，不新写**。`recon-id-fix:export`（main.js:4009）按 `currentScenario.category==='gateway-recon-id-fix'` 推导 subMode='gateway'，天然走通。
- **ADM 副作用持久化**：`recon-id-fix:run` 成功后调 `database.writeAdmMatchFlags(result.admUpdates)` 落库（资金对账ID / 两个匹配标志）。整批幂等重写 → 重复 run 结果一致（R-6）。
- ⚠️ run 改 ADM 状态与 C4「run 无副作用」不同，TECH 标注；export 的 stale-snapshot 校验（main.js:4024 附近）对 JPM 仍生效。

---

## 五、需求4：写死场景 seed（`migrations.js`，示意）

```javascript
// 【示意】仿 ensureReconRoundBuiltinScenariosSeed 独立 marker 幂等
const JPM_DISPATCH_ORDER_SCENARIO = {
  category: 'gateway-recon-id-fix',          // CHECK 已含，无需扩枚举
  name: 'JPM调拨订单修复',
  priority: 3,                               // 兜底；待验证 compact 序号=1
  enabled: 0,                                // 决策10：默认休眠
  is_builtin: 1,
  config: { subCategory: 'jpm-dispatch-order-fix', merchantId: '6300156616' }  // 不带 funcCategory
};
const JPM_SCENARIO_SEEDED_MARKER = 'jpm_dispatch_order_scenario_seeded';
// ensureJpmDispatchOrderScenarioSeed(db)：marker 已写则短路 → config_json LIKE '%jpm-dispatch-order-fix%'
//   已存在则跳过 → 否则 INSERT → 写 marker；BEGIN/COMMIT/ROLLBACK
```

- 「功能类别」显示：不带 funcCategory → `getScenarioCategoryDisplay`（renderer-dialogs.js:5625）回退 `SCENARIO_CATEGORY_LABELS['gateway-recon-id-fix']` = 「网关对账单修复」。**前端零改动**。

---

## 六、需求1 / 需求2：前端接线 + 改名

### 6.1 需求1（`renderer.js:5199-5206`，示意）

```javascript
// 【示意】三按钮改绑（PR-4）
bankStatementGatewayReconImportBtn → () => handleReconIdFixImportGateway()  // 调 reconIdFix.import({subMode:'gateway'})
bankStatementGatewayReconRunBtn(新增/接线《开始运行》) → () => runEnabledGatewayScenario()  // 运行已启用 gateway-recon-id-fix 场景
bankStatementGatewayReconExportBtn → () => handleReconIdFixExport()         // 调 reconIdFix.export()（替换 showComingSoon）
```

- 复用既有 `handleReconIdFixImport/Run/Export`（renderer.js:5227-5235）或新建薄封装；session 与 ReconID 修复模块共用。
- 《开始运行》运行「已启用」场景：取 `scenarios.list()` 里 category='gateway-recon-id-fix' ∧ enabled=1 的场景调 `recon-id-fix:run`。UI 形态（新增按钮 vs 复用）实现时定。
- 改前端须回归 `npm run preview`（资金对账模块面板 preview）。

### 6.2 需求2（改名，PR-1）

```javascript
// renderer-dialogs.js:6172
LINKED_TABLE_LABELS['bank-deposit'] = '银行对账单表';   // 旧 '银行对账单入金表'
// table-signatures.js:185
BANK_DEPOSIT_SIGNATURE.label = '银行对账单表';
```

- 🔴 波及面（PRD §5.2）：退款回填命中详情文案 `r5-refund-order-backfill.js` + 单测、场景 involvedFiles `migrations.js` + seed 单测含 '银行对账单入金表'。**本版口径（决策2）**：用户可见文本（UI 表库名 + 导入识别 label）统一改；退款回填导出文案 / involvedFiles 是否同步改 → 实现时确认（若改须同步更新对应单测断言）。dev 实现前先 `grep -rn 银行对账单入金表 src/ tests/` 全量列出再逐一定位。

---

## 七、跨表字段映射常量（`adm-bank-deposit-fields.js`，单一真相，示意）

```javascript
// 【示意】ADM 派生 + JPM 引擎共用；全程常量 pick，绝不假设同名
const CHANNEL_VALUE = 'ADM';                                  // 需求3 筛选
const ADM_FUND_TYPES = ['Fundtransfer-out', 'Fundtransfer-out&FX'];  // ⚠️ 实现时核对 assets/FundType枚举值.xlsx
const ADM_EXTRA_FIELDS = ['批次号','调拨号','Fundtransfer-in金额','资金对账ID','是否与渠道账单匹配','是否与网关账单匹配'];
const ADM_MERCHANT_ID = '6300156616';                         // JPM 默认商户号（也存 scenario.config.merchantId）

// 跨表字段映射（显式，含大小写差异）
const FIELD_MAP = {
  // 银行/ADM（驼峰）
  admChannel: 'Channel', admFundType: 'FundType', admBillDate: 'BillDate',
  admChannelOrderNo: 'ChannelOrderNo', admCustomerRef: 'CustomerRef',
  // 中台调拨（中文）
  midAllocationNo: '调拨单号', midChannelSerial: '渠道流水号', midReceiveAmount: '收款金额',
  // 渠道账单（小写 m）
  chMerchantId: 'merchantId', chReconId: 'reconciliationId', chReceiveAmount: 'receiveAmount', chAdditionInfo: 'additionInfo',
  // 网关账单（驼峰 M；Type 用索引引用）
  gwMerchantId: 'MerchantId', gwOrderId: 'OrderId', gwReference: 'Reference', gwTypeIndex: 8  // GATEWAY_BILL_FIELDS[8]
};
```

| 概念 | 渠道账单 | 网关账单 | ADM 表 | 中台调拨 |
|------|---------|---------|--------|---------|
| 商户号 | `merchantId` | `MerchantId` | `MerchantId` | — |
| 对账ID | `reconciliationId` | `reconciliationId` | `资金对账ID` | — |
| 金额 | `receiveAmount` | `Amount` | `Fundtransfer-in金额` | `收款金额` |
| 附加信息 | `additionInfo` | — | — | — |
| 订单/调拨号 | — | `OrderId` | `调拨号` | `调拨单号` |
| 引用 | — | `Reference` | — | — |
| 类型 | — | `GATEWAY_BILL_FIELDS[8]` | — | — |
| 客户参考/流水 | — | — | `CustomerRef` | `渠道流水号` |

---

## 八、PR 拆分与依赖

| PR | 范围 | 依赖 | 验证 |
|----|------|------|------|
| **PR-1** 地基/数据层 | 需求2 改名 + ADM 表 schema/仓储/常量骨架（空跑不影响现网）| 无 | unit：建表幂等、ADM def 不暴露给 listLinkedTableMeta、ADM 仓储 round-trip |
| **PR-2** ADM 派生 | `buildAdmRows` + import 接线 + 报错/成功弹框 | PR-1 | unit：筛选/批次号/唯一匹配重复键/部分成功；integration：导 bank-deposit→派生→readAdmBankDepositRows |
| **PR-3** JPM 场景+引擎 | seed + 引擎 + 分流 + ADM 回写 | PR-1,2 | unit：8 步/金额汇总/批次 gating/Type 分支；smoke：fixture 端到端 |
| **PR-4** 按钮复用 | 需求1 前端接线 + 《开始运行》 | 独立（放最后）| preview 回归 |

- 版本 bump 到 2.1.16-beta.5 + 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）放最后一个 PR。
- bump 前跑 `/check-vars`（命中 merchantId / 金额 / 对账ID / FundType / Channel 等）+ `npm run scan:vars`。
- 每 PR 跑 `npm run release-check`（PASS/FAIL 源）。

---

## 九、测试矩阵

### 9.1 Unit（最重）

| 用例 | 覆盖 |
|------|------|
| buildAdmRows-筛选 | Channel=ADM ∧ FundType∈集合；含 `Fundtransfer-out&FX`；大小写/前后空格负例 |
| buildAdmRows-批次号 | 同 ChannelOrderNo 组统一 BillDate；Excel 序列号/混格式不分裂；ChannelOrderNo 空→批次号空 |
| buildAdmRows-唯一匹配 | clean 赋值；中台侧重复→mid-duplicate；ADM 侧重复→adm-duplicate；无中台→no-mid-match；空 ref→empty-customerref；中台空→midEmpty |
| jpm-提取出账日期 | 样例 `ATS OF 26/05/04`→2026-05-04；JSON 金额不误匹配；缺失→null+warn；非法日期(13月)→null |
| jpm-金额汇总 | 逐笔转分累加=receiveAmount；浮点 0.1+0.2 类；任一非数值→不匹配 |
| jpm-批次 gating | 同批次号全为1 才进网关；部分匹配不进 |
| jpm-网关匹配+Type | OrderId↔调拨号 1v1；批次行数=1→Type=0、>1→Type=2；fixedRows=Type∧Reference 有值 |
| jpm-merchantId 不命中 | 渠道无 6300156616→空 fixedRows |
| migration 幂等 | ensureAdmBankDepositSupport 多次 no-op；JPM seed 独立 marker、删除终态不复活、CHECK 含 gateway-recon-id-fix |

### 9.2 Integration

- `linked-table:import` 导 bank-deposit → 自动派生 ADM → `readAdmBankDepositRows` 校验；再导 mid-allocation 验证调拨号回填。
- `recon-id-fix:run`（gateway, JPM 场景）端到端：import fixture → run → fixedRows + ADM 标志落库 → export 复用 gateway writer。

### 9.3 Smoke（`npm run smoke`）

- 造 fixture：bank-deposit 含 Channel=ADM + 同 ChannelOrderNo 多行 + CustomerRef；mid-allocation 渠道流水号对得上（含一个重复负例）；渠道账单 merchantId=6300156616 + additionInfo 含 ` 26/05/04 `；网关账单 OrderId 对得上调拨号 → 跑全链路生成网关对账单修复文件。

### 9.4 不测项与原因

- 真实 FundType 枚举字面值、真实 additionInfo 出账日期格式变体：依赖 `assets/FundType枚举值.xlsx` 与真实样本，实现版本手测核对。

---

## 十、风险清单（资金/对账/状态机，必须人工复核）

| 风险 | 缓解 |
|------|------|
| 🔴 金额浮点多笔汇总漂移 | 逐笔 `Math.round(v*100)` 转分再累加，严禁先浮点累加后 round（§4.4）|
| 🔴 唯一匹配重复键误配 | CustomerRef↔渠道流水号、OrderId↔调拨号，两侧任一重复判冲突/报错，不任取（§3.5）|
| 🔴 跨表字段名大小写 / Type 超长缺括号列名 | 全用常量引用（§七），Type 用 `GATEWAY_BILL_FIELDS[8]` |
| 🔴 ADM 表覆盖清掉已有匹配 | 重导=ADM 重建=标志归零，UI 提示（§3.1/R-7）|
| 🟠 JPM run 副作用幂等 | 整批幂等重写 ADM 标志，可重入（§4.5/R-6）|
| 🟠 ADM 隐藏性 | 不进 ALL_TABLE_KEYS/LINKED_TABLE_LABELS，单测守护（§3.2/R-5）|
| 🟠 merchantId 硬编码 | 收进 scenario.config.merchantId（R-10）|
| 🟡 runReconIdFix 旧调用兼容 | 第三参默认 `{}`（§4.1/R-9）|

---

## 十一、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-08 | 初稿 = 定稿：JPM 调拨订单修复 TECH 设计（ADM 隐藏表 schema/仓储/派生伪代码 + JPM 引擎 8 步状态机 + 分流 + 跨表字段映射常量 + PR 拆分 + 测试矩阵 + 10 风险）|
| 2026-06-08 | **本版已实现落地**（PR-1~4 + 布局修订，release-check 三层全绿）。实现期偏离（Reverse Sync）：①PR-2 批次号用 `normalizeDateExportValue().date` 本地分量格式化（非 `.value`，防同 ChannelOrderNo 因日期格式分裂）；②PR-3 步骤8 `buildOutputRow` 用 `{Type,Reference}` overrides（gateway 输出列 Type 是短名、源行写超长缺括号名，空 overrides 取不到值）；③PR-4 需求1 布局按用户反馈从「导入不平表/开始运行/不平校验导出」三联→「导入不平表/导出文件」两按钮 + row1《开始运行》按 `state.bankStatementProcessRunMode` 智能路由复用（仅 'gateway' 模式走网关引擎，否则 R1-R5）；`recon-id-fix:run` return 透传 warnings 供前端显示警告数；④需求4 场景操作列保护收窄到 `is_builtin && category==='gateway-recon-id-fix'`（只命中 JPM，C2/C3/builtin-fixed 零回归）|
