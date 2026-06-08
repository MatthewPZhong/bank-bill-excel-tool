// v2.1.16 阶段一 A3：链接表持久化仓储层（纯函数 (db, ...) 风格，仿 channels-repository）
//
// 设计要点（A3 spec + team-lead 拍板）：
// - 混合存储：每张数据表 = 少数「提取键列」（join 键）+ 日期列 + raw_json（整行 JSON）+ imported_at
//   键列 / 日期列建索引，raw_json 存整行以便后续按行重建 / 导出。
// - schema（建表）在 migrations.js → ensureLinkedTableSupport；本仓储仅负责读写。
// - 4 个 tableKey：gateway-bill / mid-allocation / fx-settlement / fx-option
//     前 3 张有 assets 模板 → 列映射已从模板表头确认；
//     fx-option（外汇期权）模板缺失（PRD v2.1.14 §D ❌ 缺失待补）→ 本批次不建表：
//       · listLinkedTableMeta 仍返回 fx-option 的空 meta（前端弹窗渲染 4 行，期权行显示「—」）
//       · replaceLinkedTable('fx-option', ...) 抛明确错误（A4 导入识别也不会产出 fx-option，双保险）
//
// 输入契约（team-lead 决策2）：
//   replaceLinkedTable(db, tableKey, rows, ...) 的 rows = `{ [表头名]: 值 }` 对象数组
//   （与 import-repository raw_json 按 header 序列化一致；A4 桥接时把 reader 行转成此形态喂入）
//
// 归一化（team-lead 补充 + A3 现状核查发现）：
//   - 键列值可能是 number（如交割表「交易编号」926181062）→ 一律 String(value).trim() 存储
//   - 日期列值可能是 Excel 序列号 number（如交割表「交易日期」46155）或多种字符串格式
//     → 复用 normalizers.normalizeDateExportValue 解析，取其 .date（Date 对象）重格式化为统一
//       YYYY-MM-DD 字符串再做字符串 min/max（不能直接用 .value：其对 `2026/03/10` 保留斜杠，
//       与 `-` 格式混用会让字符串比较错乱）。解析失败 / 空值跳过，不参与 min/max。

const { normalizeDateExportValue } = require('../file-service/normalizers');
const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');

// v2.1.16-beta.3 ②：银行对账单入金表 13 字段白名单（C~N 列索引 2~13 + FundType 索引 25）。
//   🔴 裁列必须按字段名 pick（非 slice 索引切片），防 BANK_STATEMENT_FIELDS 列顺序变动裁错列。
const BANK_DEPOSIT_FIELDS = Object.freeze([
  'BizId', 'BillDate', 'ValueDate', 'Channel', '地区', 'MerchantId', 'Currency',
  'Credit Amount', 'Debit Amount', 'ReconciliationId', 'ChannelOrderNo', 'CustomerRef', 'FundType'
]);

// 模块加载期断言：13 字段全部 ∈ BANK_STATEMENT_FIELDS（防常量漂移；红线 §六-4）。
const __missingDepositFields = BANK_DEPOSIT_FIELDS.filter((f) => !BANK_STATEMENT_FIELDS.includes(f));
if (__missingDepositFields.length > 0) {
  throw new Error(
    `[linked-table-repository] BANK_DEPOSIT_FIELDS 含不在 BANK_STATEMENT_FIELDS 的字段：${__missingDepositFields.join(', ')}`
  );
}

// v2.1.16-beta.3 ②：按字段名 pick 出入金表 13 字段（裁列纯函数，便于单测 UT-H1/H3）。
//   入参为 44 字段对象（readLinkedRowsAsObjects 产物，已过 detector L1/L2 + zip 校验）；
//   输出仅含 13 字段，缺失字段取 undefined（不补默认值，保持与源行一致）。
function pickBankDepositFields(row) {
  const src = row && typeof row === 'object' ? row : {};
  const picked = {};
  for (const f of BANK_DEPOSIT_FIELDS) {
    picked[f] = src[f];
  }
  return picked;
}

// 各表自包含定义（tableKey → { table, keyColumn, keyHeader, dateColumn, dateHeader, supported }）
//   keyHeader / dateHeader = rows 对象里的表头 key（中文/英文，按模板原表头）
//   keyColumn / dateColumn = DB 表里的列名（snake_case）
//   supported=false → 模板缺失，未建表，写入抛错（fx-option）
const LINKED_TABLE_DEFS = {
  'gateway-bill': {
    table: 'linked_gateway_bill',
    keyColumn: 'reconciliation_id',
    keyHeader: 'reconciliationid', // assets/网关对账单.xlsx 表头（idx 14）
    dateColumn: 'bill_date',
    dateHeader: 'Billdate', // assets/网关对账单.xlsx 表头（idx 0）
    supported: true
  },
  'mid-allocation': {
    table: 'linked_mid_allocation',
    keyColumn: 'allocation_no',
    keyHeader: '调拨单号', // assets/中台调拨订单.xlsx 表头（idx 0）
    // v2.1.16（用户确认）：数据日期范围用「交易时间」(idx 4，每行均有值)，不用「业务日期」(idx 18，空值率高 → 范围漏行)。
    //   与 table-signatures.js 的 dateColumn:'交易时间' 对齐。
    //   DB 列名已对齐交易时间（链接表 v2.1.16 新建无存量，建表即 transaction_date）；raw_json 存整行为数据真相，date 列仅供 min/max 范围与索引。
    dateColumn: 'transaction_date',
    dateHeader: '交易时间', // assets/中台调拨订单.xlsx 表头（idx 4）；DB 列 transaction_date 存该值
    supported: true
  },
  'fx-settlement': {
    table: 'linked_fx_settlement',
    keyColumn: 'transaction_no',
    keyHeader: '交易编号', // assets/外汇交割表.xls sheet「即期结售汇交易明细」表头第 2 行（idx 0）
    dateColumn: 'transaction_date',
    dateHeader: '交易日期', // 同上（idx 29）
    supported: true
  },
  // 外汇期权：模板缺失，本批次不建表（CREATE IF NOT EXISTS 未来零返工补）
  'fx-option': {
    table: 'linked_fx_option',
    keyColumn: null,
    keyHeader: null,
    dateColumn: null,
    dateHeader: null,
    supported: false
  },
  // v2.1.16-beta.3 ②：银行对账单入金表（模板=银行对账单.xlsx，存 C~N+FundType 13 字段 raw_json）。
  //   keyHeader='ReconciliationId'（驼峰，BANK_STATEMENT_FIELDS 索引 11，与网关全小写 reconciliationid 区分）。
  //   dateHeader='BillDate'（BANK_STATEMENT_FIELDS 索引 3，与 BANK_DEPOSIT_SIGNATURE.dateColumn 对齐）。
  'bank-deposit': {
    table: 'linked_bank_deposit',
    keyColumn: 'reconciliation_id',
    keyHeader: 'ReconciliationId',
    dateColumn: 'bill_date',
    dateHeader: 'BillDate',
    supported: true
  },
  // v2.1.16-beta.5 需求3：ADM 银行对账单链接表（隐藏表，由 bank-deposit Channel=ADM 行派生）。
  //   🔴 入 LINKED_TABLE_DEFS 供专用仓储读写，但绝不进 ALL_TABLE_KEYS（前端 listLinkedTableMeta 不可见）。
  //   表结构含 batch_no / channel_order_no 两列（replaceLinkedTable 4 列硬编码不适用 → 走 replaceAdmBankDeposit）。
  'adm-bank-deposit': {
    table: 'linked_adm_bank_deposit',
    keyColumn: 'reconciliation_id',
    keyHeader: 'ReconciliationId',
    dateColumn: 'bill_date',
    dateHeader: 'BillDate',
    supported: true
  }
};

// 前端弹窗渲染顺序的全部 tableKey（listLinkedTableMeta 必须覆盖全部）。
//   v2.1.16-beta.3 ②：入金表排末位 → 链接表弹窗渲染第 5 行（与 PRD UI Mockup 一致）。
const ALL_TABLE_KEYS = ['gateway-bill', 'mid-allocation', 'fx-settlement', 'fx-option', 'bank-deposit'];

function getDef(tableKey) {
  const def = LINKED_TABLE_DEFS[tableKey];
  if (!def) {
    throw new Error(`[linked-table-repository] 未知 tableKey：${tableKey}`);
  }
  return def;
}

// 键列归一化：number / 其它一律 String().trim()
function normalizeKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// 日期列归一化：解析为 Date 后重格式化成统一 YYYY-MM-DD；无效 / 空 → null（不参与 min/max）
function normalizeDateForRange(value) {
  const result = normalizeDateExportValue(value);
  if (!result || !result.date || Number.isNaN(result.date.getTime())) {
    return null;
  }
  const d = result.date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 空 meta（无记录 / 未建表的表）：行数 0 + 日期范围 null + 其它 null 字段
function emptyMeta(tableKey) {
  return {
    tableKey,
    dataDateMin: null,
    dataDateMax: null,
    rowCount: 0,
    sourceFileName: null,
    updatedAt: null
  };
}

function rowToMeta(row) {
  if (!row) return null;
  return {
    tableKey: row.table_key,
    dataDateMin: row.data_date_min === undefined ? null : row.data_date_min,
    dataDateMax: row.data_date_max === undefined ? null : row.data_date_max,
    rowCount: Number(row.row_count) || 0,
    sourceFileName: row.source_file_name === undefined ? null : row.source_file_name,
    updatedAt: row.updated_at === undefined ? null : row.updated_at
  };
}

// 读单个 tableKey 的元数据；无记录返回空 meta（null 字段）
function getLinkedTableMeta(db, tableKey) {
  getDef(tableKey); // 校验 tableKey 合法
  const row = db.prepare('SELECT * FROM linked_table_meta WHERE table_key = ?').get(tableKey);
  return row ? rowToMeta(row) : emptyMeta(tableKey);
}

// 读全部 4 个 tableKey 的元数据（前端弹窗渲染 4 行；无记录 / 未建表恒返回空 meta）
function listLinkedTableMeta(db) {
  return ALL_TABLE_KEYS.map((tableKey) => getLinkedTableMeta(db, tableKey));
}

// v3.0.0 块 B / PR-2：抽出的「整表覆盖落库共享内核」——replaceLinkedTable（数组，同步）与
//   replaceLinkedTableStreaming（流式喂行，async）共用同一份 INSERT 单行逻辑 + SQL 文本 + 日期范围累计，
//   保证两条路径值口径与 meta 计算字节一致（防大文件流式落库口径漂移 = 静默资金/数据事故）。
//   设计取舍（team-lead 拍板）：BEGIN/DELETE/COMMIT/ROLLBACK 这层不共用到一个 async 骨架里——
//     · 数组路径必须保持「同步函数同步返回」契约（所有既有调用方同步调用 replaceLinkedTable）；
//     · 流式路径必须 async（要 await readXlsxStreamed 整条流），事务跨 await 全程开启。
//     若强塞进同一个 async 骨架，数组路径就被迫返回 Promise → 破坏既有同步调用方。
//     故仅把「会漂移的部分」（INSERT 一行 + 算 key/date/min/max + SQL 文本 + meta 计算）抽进 createInsertContext，
//     两个公开函数各自写自己的 BEGIN/.../COMMIT（结构相同、各 6 行，重复极小、可读性更高）。
//   insertOne(rowObj)：把单行对象 INSERT 进 def.table（normalizeKey + normalizeDateForRange + raw_json），
//     累计实际写入行数与日期范围 min/max（边插边算，与原 replaceLinkedTable 逐行算法逐字节一致）。
function createInsertContext(db, def, importedAt) {
  const insertSql = `
    INSERT INTO ${def.table} (${def.keyColumn}, ${def.dateColumn}, raw_json, imported_at)
    VALUES (?, ?, ?, ?)
  `;
  const insertStmt = db.prepare(insertSql);
  const state = { dataDateMin: null, dataDateMax: null, rowCount: 0 };

  const insertOne = (row) => {
    const obj = row && typeof row === 'object' ? row : {};
    const keyValue = normalizeKey(obj[def.keyHeader]);
    const dateIso = normalizeDateForRange(obj[def.dateHeader]); // null = 不参与范围
    const rawJson = JSON.stringify(obj);
    insertStmt.run(keyValue, dateIso, rawJson, importedAt);
    if (dateIso) {
      if (state.dataDateMin === null || dateIso < state.dataDateMin) state.dataDateMin = dateIso;
      if (state.dataDateMax === null || dateIso > state.dataDateMax) state.dataDateMax = dateIso;
    }
    state.rowCount += 1;
  };

  return { insertOne, state };
}

// upsert linked_table_meta（两条路径共用同一 SQL；row_count = 实际写入行数）
function upsertLinkedTableMeta(db, tableKey, state, sourceFileName, importedAt) {
  const upsertMetaSql = `
    INSERT INTO linked_table_meta
      (table_key, data_date_min, data_date_max, row_count, source_file_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(table_key) DO UPDATE SET
      data_date_min = excluded.data_date_min,
      data_date_max = excluded.data_date_max,
      row_count = excluded.row_count,
      source_file_name = excluded.source_file_name,
      updated_at = excluded.updated_at
  `;
  db.prepare(upsertMetaSql).run(
    tableKey,
    state.dataDateMin,
    state.dataDateMax,
    state.rowCount,
    sourceFileName,
    importedAt
  );
}

function normalizeSourceFileName(options) {
  return options.sourceFileName === undefined || options.sourceFileName === null
    ? null
    : String(options.sourceFileName);
}

// 整表覆盖写入：事务内 DELETE 全表 + 单事务批量 INSERT（prepared）+ 算日期范围 + upsert meta
//   rows = `{ [表头名]: 值 }` 对象数组（整行）
//   options.sourceFileName = 来源文件名（落 meta）
//   caller 不需持有事务；本函数自带 BEGIN/COMMIT/ROLLBACK（与 import-repository.clearMonth 范式一致）
//   v3.0.0 块 B / PR-2：INSERT 单行逻辑 / SQL / meta 计算抽进 createInsertContext + upsertLinkedTableMeta（与流式路径共用）；
//     本函数保持「同步函数同步返回」契约不变，事务骨架 6 行同步直写，对外行为字节不变
//     （gateway-bill / mid-allocation / fx-settlement / bank-deposit 均用它；row_count = 喂入次数 = safeRows.length）。
function replaceLinkedTable(db, tableKey, rows, options = {}) {
  const def = getDef(tableKey);
  if (!def.supported) {
    // fx-option 模板缺失：明确拒绝（A4 也不会产出 fx-option，双保险）
    throw new Error('外汇期权表模板缺失，暂未支持');
  }
  const safeRows = Array.isArray(rows) ? rows : [];
  const sourceFileName = normalizeSourceFileName(options);
  const importedAt = new Date().toISOString();
  const { insertOne, state } = createInsertContext(db, def, importedAt);

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ${def.table}`).run();
    for (const row of safeRows) insertOne(row);
    upsertLinkedTableMeta(db, tableKey, state, sourceFileName, importedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return {
    tableKey,
    rowCount: state.rowCount,
    dataDateMin: state.dataDateMin,
    dataDateMax: state.dataDateMax,
    updatedAt: importedAt
  };
}

// v3.0.0 块 B / PR-2：整表覆盖**流式**写入——caller 通过 feedRows(insertOne) 在事务开启期间逐行喂入
//   （大文件链接表：上层用 readXlsxStreamed 边解压边喂，内存恒定，不把 65 万行先攒成数组）。
//   🔴🔴 数据红线：整表覆盖（DELETE 全表 + 单事务）；feedRows 中途任意 throw → ROLLBACK，
//     旧数据完好（表不留半空，已实测 657,757 行单事务回滚）。
//   🔴 事务跨 await：node:sqlite DatabaseSync 是同一进程单连接同步 API，BEGIN 开启的事务在
//     `await feedRows(...)` 期间（event loop 让出读盘/解压 stream）依然保持开启（无其它连接、连接未关）；
//     readXlsxStreamed 的 onRow 是同步回调，每行的 insertOne(INSERT) 都在 onRow 内同步执行。
//   值口径与 meta 计算与 replaceLinkedTable 共用 createInsertContext / upsertLinkedTableMeta → 字节一致。
//   行为契约对齐 replaceLinkedTable：返回 { tableKey, rowCount, dataDateMin, dataDateMax, updatedAt }，
//     row_count = 实际喂入 insertOne 的次数。
async function replaceLinkedTableStreaming(db, tableKey, feedRows, options = {}) {
  const def = getDef(tableKey);
  if (!def.supported) {
    throw new Error('外汇期权表模板缺失，暂未支持');
  }
  if (typeof feedRows !== 'function') {
    throw new Error('[linked-table-repository] replaceLinkedTableStreaming 需要 feedRows 回调');
  }
  const sourceFileName = normalizeSourceFileName(options);
  const importedAt = new Date().toISOString();
  const { insertOne, state } = createInsertContext(db, def, importedAt);

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ${def.table}`).run();
    await feedRows(insertOne); // 事务全程开启；caller 边流式读 xlsx 边逐行 insertOne
    upsertLinkedTableMeta(db, tableKey, state, sourceFileName, importedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return {
    tableKey,
    rowCount: state.rowCount,
    dataDateMin: state.dataDateMin,
    dataDateMax: state.dataDateMax,
    updatedAt: importedAt
  };
}

// v2.1.16-beta.2 T1：读回某 tableKey 全部整行（raw_json 还原为对象，字段名 = 真实表头）。
//   - getDef 校验 tableKey；fx-option（模板缺失，supported=false）直接返回 []（不查表，避免 no such table）。
//   - ORDER BY id ASC：还原导入原序（与 5 轮对账引擎按行顺序处理一致）。
//   - 损坏行（raw_json JSON 解析失败 / 解析结果非对象）跳过，不中断整批（与 replaceLinkedTable 容错一致）。
//   - 供编排器经 database.readLinkedTableRows('gateway-bill') 取网关数据源（structuredClone 后传入）。
function readLinkedTableRows(db, tableKey) {
  const def = getDef(tableKey);
  if (!def.supported) return [];
  const rows = db.prepare(`SELECT raw_json FROM ${def.table} ORDER BY id ASC`).all();
  const out = [];
  for (const r of rows) {
    try {
      const o = JSON.parse(r.raw_json);
      if (o && typeof o === 'object') out.push(o);
    } catch (_e) {
      /* 损坏行跳过，不抛错 */
    }
  }
  return out;
}

// ============================================================================
// v2.1.16-beta.5 需求3：ADM 银行对账单链接表（linked_adm_bank_deposit）专用仓储
//   🔴 不能复用 replaceLinkedTable（其 INSERT 硬编码 4 列：keyColumn/dateColumn/raw_json/imported_at）。
//      ADM 表多 batch_no / channel_order_no 两列，故新写 replaceAdmBankDeposit（6 列 INSERT）。
//   隐藏表：不进 ALL_TABLE_KEYS / 不进 linked_table_meta（前端弹窗不可见），故不写 meta。
//   字段对应（raw_json 字段 → DB 列）：
//     ReconciliationId → reconciliation_id（银行字段，整表覆盖时落列；恒有值）
//     BillDate         → bill_date（normalizeDateForRange 归一 YYYY-MM-DD）
//     批次号           → batch_no（派生阶段生成，可空）
//     ChannelOrderNo   → channel_order_no（归批索引）
//     整行 13+6 字段   → raw_json（数据真相）
// ============================================================================

const ADM_TABLE = 'linked_adm_bank_deposit';

// 整表覆盖写入 ADM 行：事务内 DELETE 全表 + 批量 INSERT 6 列（prepared）。
//   rows = ADM 行对象数组（13 银行字段 + 6 新字段，buildAdmRows 产物；PR-1 仓储不关心字段语义，整行存 raw_json）。
//   caller 不需持有事务；本函数自带 BEGIN/COMMIT/ROLLBACK（与 replaceLinkedTable 范式一致）。
//   🔴 重导银行对账单表 = ADM 重建 = 已有匹配标志归零（整表覆盖语义，UI 须提示 — 见 PRD §5.3.7 / R-7）。
function replaceAdmBankDeposit(db, rows, options = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const importedAt = new Date().toISOString();

  const insertSql = `
    INSERT INTO ${ADM_TABLE} (reconciliation_id, bill_date, batch_no, channel_order_no, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ${ADM_TABLE}`).run();

    const insertStmt = db.prepare(insertSql);
    for (const row of safeRows) {
      const obj = row && typeof row === 'object' ? row : {};
      const reconId = normalizeKey(obj.ReconciliationId);
      const billDate = normalizeDateForRange(obj.BillDate); // null = 不可解析（仍落库，仅日期列为 null）
      const batchNo = normalizeKey(obj['批次号']);
      const channelOrderNo = normalizeKey(obj.ChannelOrderNo);
      const rawJson = JSON.stringify(obj);
      insertStmt.run(reconId, billDate, batchNo, channelOrderNo, rawJson, importedAt);
    }

    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return {
    tableKey: 'adm-bank-deposit',
    rowCount: safeRows.length,
    updatedAt: importedAt
  };
}

// 读回 ADM 表全部整行（raw_json 还原为对象，字段名 = 真实表头）。
//   ORDER BY id ASC：还原派生原序（与 readLinkedTableRows 同范式）；损坏行跳过不中断。
//   供 JPM 引擎（PR-3）经 database.readAdmBankDepositRows() 取 ADM 数据源做三段匹配。
function readAdmBankDepositRows(db) {
  const rows = db.prepare(`SELECT raw_json FROM ${ADM_TABLE} ORDER BY id ASC`).all();
  const out = [];
  for (const r of rows) {
    try {
      const o = JSON.parse(r.raw_json);
      if (o && typeof o === 'object') out.push(o);
    } catch (_e) {
      /* 损坏行跳过，不抛错 */
    }
  }
  return out;
}

// JPM run 阶段整批幂等重写 ADM 行匹配标志 / 资金对账ID（供 PR-3 引擎回写）。
//   admRows = 「读 → 算 → 写回」的完整 ADM 行数组（基于 readAdmBankDepositRows 读出的同一批行计算后回传）。
//   定位策略（整批幂等重写）：取 DB 全部 id（ORDER BY id ASC）与 admRows 按下标严格配对逐行 UPDATE raw_json。
//     readAdmBankDepositRows 用 ORDER BY id ASC，读出顺序 = DB id 顺序 = 回传顺序 → 下标即对应 DB 行。
//   🔴 资金对账状态机：仅整批重写 raw_json（资金对账ID / 是否与渠道账单匹配 / 是否与网关账单匹配 等新字段）；
//      幂等可重入（基于「原始行 + 本次计算」整批重算，非增量累加）。
//   行数保护：DB 行数 ≠ admRows 行数 → 抛错（说明 ADM 表已被 replaceAdmBankDeposit 并发重建，按位置写回会错位污染资金数据）。
//   reconciliation_id / batch_no / channel_order_no 列保持不变（仅 raw_json 整行重写；这三列由派生阶段写定）。
function writeAdmMatchFlags(db, admRows) {
  const safeRows = Array.isArray(admRows) ? admRows : [];
  const updateSql = `UPDATE ${ADM_TABLE} SET raw_json = ? WHERE id = ?`;

  db.exec('BEGIN');
  try {
    const ids = db.prepare(`SELECT id FROM ${ADM_TABLE} ORDER BY id ASC`).all().map((r) => r.id);
    if (ids.length !== safeRows.length) {
      throw new Error(
        `[linked-table-repository] writeAdmMatchFlags 行数不一致：DB ${ids.length} 行 vs 入参 ${safeRows.length} 行（ADM 表疑似被并发重建）`
      );
    }
    const updateStmt = db.prepare(updateSql);
    for (let i = 0; i < ids.length; i += 1) {
      const obj = safeRows[i] && typeof safeRows[i] === 'object' ? safeRows[i] : {};
      updateStmt.run(JSON.stringify(obj), ids[i]);
    }

    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return { tableKey: 'adm-bank-deposit', rowCount: safeRows.length };
}

module.exports = {
  LINKED_TABLE_DEFS,
  ALL_TABLE_KEYS,
  // v2.1.16-beta.3 ②：入金表 13 字段白名单 + 裁列纯函数
  BANK_DEPOSIT_FIELDS,
  pickBankDepositFields,
  listLinkedTableMeta,
  getLinkedTableMeta,
  replaceLinkedTable,
  // v3.0.0 块 B / PR-2：大文件链接表流式整表覆盖（事务跨 await 逐行喂入，内存恒定）
  replaceLinkedTableStreaming,
  readLinkedTableRows,
  // v2.1.16-beta.5 需求3：ADM 银行对账单隐藏表专用仓储（6 列 INSERT / 整批幂等重写）
  replaceAdmBankDeposit,
  readAdmBankDepositRows,
  writeAdmMatchFlags
};
