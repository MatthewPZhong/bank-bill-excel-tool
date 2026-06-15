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
// v3.0.5 需求2：fx 主表 upsert 幂等键 = normalizeTransactionNo(交易编号)，单一真相下沉自 engine-utils
//   （与 builder 派生分组 / migration 键列回填同口径，防漂移）。engine-utils 无依赖纯 JS（零 require），不引入循环依赖。
const { normalizeTransactionNo } = require('../../main-process/scenario-engines/engine-utils');
// v3.0.0 块 B / PR-3：ADM 派生只需 Channel=ADM 子集 → 下推 SQL 过滤的取值常量（单一真相）。
const { CHANNEL_VALUE } = require('../../constants/adm-bank-deposit-fields');

// v2.1.16-beta.3 ②：银行对账单入金表落库字段白名单（按字段名 pick）。
//   🔴 裁列必须按字段名 pick（非 slice 索引切片），防 BANK_STATEMENT_FIELDS 列顺序变动裁错列。
//   v3.0.4 块 E（需求2）：13→14 —— 在 CustomerRef 与 FundType 之间插入 'Payment Detail'
//     （44 列契约 1-based 第 18 列 / 0-based idx 17，紧随 CustomerRef）。BOC 派生「银行单交易编号」从该字段提取，缺它则永远无法回填资金对账链接ID。
//     🔴 存量已导入的 bank-deposit 行 raw_json 无此字段、无法 migration 补 → 由 buildBocBankRows 识别为
//        missing-payment-detail 引导重导（见 boc-fx-link-builder.js / spec §2.4）。顺序保持与 BANK_STATEMENT_FIELDS 一致。
const BANK_DEPOSIT_FIELDS = Object.freeze([
  'BizId', 'BillDate', 'ValueDate', 'Channel', '地区', 'MerchantId', 'Currency',
  'Credit Amount', 'Debit Amount', 'ReconciliationId', 'ChannelOrderNo', 'CustomerRef', 'Payment Detail', 'FundType'
]);

// 模块加载期断言：全部字段 ∈ BANK_STATEMENT_FIELDS（防常量漂移；红线 §六-4）。
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
  },
  // v3.0.4 块 E（需求2）：BOC 链接表（隐藏表，由外汇交割表导入后物理行序分组派生）。
  //   🔴 入 LINKED_TABLE_DEFS 供专用仓储读写，但绝不进 ALL_TABLE_KEYS（前端 listLinkedTableMeta 不可见）。
  //   不走 replaceLinkedTable（其 INSERT 硬编码 4 列）；专用 replaceBocFxLink 走 8 列 INSERT，不写 linked_table_meta。
  'boc-fx-settlement': {
    table: 'linked_boc_fx_settlement',
    keyColumn: 'transaction_no',
    dateColumn: 'maturity_date',
    supported: true
  },
  // v3.0.4 块 E（需求2）：BOC 调拨银行对账单表（隐藏表，由银行对账单 Channel=BOC 行派生）。
  //   🔴 绝不进 ALL_TABLE_KEYS；专用 replaceBocBankDeposit 走 4 列 INSERT，不写 linked_table_meta。
  'boc-bank-deposit': {
    table: 'linked_boc_bank_deposit',
    keyColumn: 'bank_txn_no',
    dateColumn: 'bill_date',
    supported: true
  }
};

// 前端弹窗渲染顺序的全部 tableKey（listLinkedTableMeta 必须覆盖全部）。
//   v2.1.16-beta.3 ②：入金表排末位 → 链接表弹窗渲染第 5 行（与 PRD UI Mockup 一致）。
const ALL_TABLE_KEYS = ['gateway-bill', 'mid-allocation', 'fx-settlement', 'fx-option', 'bank-deposit'];

// v3.0.5 OPEN-7（T5c · Important）：命中标记读取 IN(?,...) 分批批量大小。
//   取 900（< SQLite 旧版默认 SQLITE_MAX_VARIABLE_NUMBER=999，留余量；新版上限 32766 更宽，900 仍安全）。
const HIT_MARKER_READ_CHUNK = 900;

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

// ============================================================================
// v3.0.1 需求1 / task2：网关对账单链接表「按 ReconBillBizId 幂等 upsert」专用仓储
//   🔴🔴 资金对账红线：不复用 replaceLinkedTable/replaceLinkedTableStreaming（那俩是「整表覆盖」
//      DELETE 全表语义，被 4 张表共用，绝不能破坏）。本组函数走「幂等累加」语义：
//      按 recon_bill_biz_id（UNIQUE，task1 迁移建）ON CONFLICT DO UPDATE，旧 bizId 行保留、
//      重复 bizId 行覆盖为最新值——多次导入不重复、不丢历史。
//   幂等键口径（必须与 migration 回填字节一致）：bizId = normalizeKey(obj.ReconBillBizId)
//      （精确大小写 ReconBillBizId；migration 回填用 TRIM(json_extract(...,'$.ReconBillBizId'))；
//       normalizeKey = String().trim() → 与 TRIM 字节一致）。空键拒入（与 migration 删空键同口径）。
//   meta 累加语义关键：累加后 rowCount / 日期范围不能用「单批增量」算，必须全表重算
//      （recomputeGatewayMeta：COUNT(*) 全表 + MIN/MAX(bill_date) 全表）。
//   数组版（同步）与流式版（async）共用内部 buildGatewayUpsertContext（upsertOne + counters + SQL），
//      避免两份 upsert 逻辑漂移（设计意图同 createInsertContext）。

// v3.0.5：upsert 内核「泛化」——gateway / bank-deposit / fx 共用同一份 upsertOne + counters + SQL，
//   避免复制第二份 upsert 内核（spec §3.1 明令；防三表口径漂移 = 静默资金事故）。
//   入参：
//     tableKey      → LINKED_TABLE_DEFS 键（取 def.table / def.keyColumn / def.dateColumn / def.keyHeader / def.dateHeader）
//     keyExtractor  → (obj) → 幂等键原始值（gateway: obj.ReconBillBizId / bank-deposit: obj.BizId）；内核内统一 normalizeKey 归一 + 空键拒入
//     idKeyColumn   → 幂等键 DB 列名（gateway: recon_bill_biz_id / bank-deposit: biz_id），即 ON CONFLICT 判定列（task1 迁移建 UNIQUE）
//   返回 { upsertOne, counters }（数组版 / 流式版共用，防口径漂移）。
//   🔴 DO UPDATE 不写 idKeyColumn 本身（它是 ON CONFLICT 的判定键，不变）。
//   counters.overwriteCount：本批命中已存在键（被覆盖）的次数；upsert 前用 existsStmt 判定
//     （.changes 区分不了 INSERT/UPDATE，故必须先 SELECT 1 判存在）。
function buildLinkedUpsertContext(db, tableKey, { keyExtractor, idKeyColumn }, importedAt) {
  const def = getDef(tableKey);
  const upsertSql = `
    INSERT INTO ${def.table} (${idKeyColumn}, ${def.keyColumn}, ${def.dateColumn}, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(${idKeyColumn}) DO UPDATE SET
      ${def.keyColumn} = excluded.${def.keyColumn},
      ${def.dateColumn} = excluded.${def.dateColumn},
      raw_json = excluded.raw_json,
      imported_at = excluded.imported_at
  `;
  const upsertStmt = db.prepare(upsertSql);
  const existsStmt = db.prepare(`SELECT 1 FROM ${def.table} WHERE ${idKeyColumn} = ? LIMIT 1`);
  const counters = { upserted: 0, overwriteCount: 0, rejectedEmptyCount: 0 };

  const upsertOne = (row) => {
    const obj = row && typeof row === 'object' ? row : {};
    const idKey = normalizeKey(keyExtractor(obj)); // 幂等键（精确大小写；normalizeKey = String().trim()，与 migration TRIM 字节一致）
    if (idKey === '') {
      counters.rejectedEmptyCount += 1; // 空键拒入（与 migration 删空键同口径）
      return;
    }
    const keyValue = normalizeKey(obj[def.keyHeader]); // 展示键列（gateway: reconciliationid / bank-deposit: ReconciliationId）
    const dateIso = normalizeDateForRange(obj[def.dateHeader]); // 日期列 → YYYY-MM-DD / null
    const rawJson = JSON.stringify(obj);
    const existed = existsStmt.get(idKey) !== undefined; // upsert 前先判（区分 INSERT/UPDATE）
    upsertStmt.run(idKey, keyValue, dateIso, rawJson, importedAt);
    if (existed) counters.overwriteCount += 1;
    counters.upserted += 1;
  };

  return { upsertOne, counters };
}

// meta 全表重算「泛化」（🔴 累加语义关键）：rowCount / 日期范围必须全表重算，不能用单批增量。
//   rowCount = COUNT(*) 全表（含 dateColumn 为 null 的行）；
//   日期范围 = MIN/MAX(dateColumn) 全表（排除 null / 空串）。
function recomputeLinkedMeta(db, tableKey, sourceFileName, importedAt) {
  const def = getDef(tableKey);
  const rowCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${def.table}`).get().c) || 0;
  const range = db.prepare(
    `SELECT MIN(${def.dateColumn}) AS mn, MAX(${def.dateColumn}) AS mx FROM ${def.table} WHERE ${def.dateColumn} IS NOT NULL AND ${def.dateColumn} != ''`
  ).get();
  const state = {
    rowCount,
    dataDateMin: range && range.mn != null ? range.mn : null,
    dataDateMax: range && range.mx != null ? range.mx : null
  };
  upsertLinkedTableMeta(db, tableKey, state, sourceFileName, importedAt);
  return state;
}

// 构造网关 upsert 内核（薄封装，委托泛化内核）：返回 { upsertOne, counters }（数组版 / 流式版共用）。
//   upsertOne(row) 逐行：取 ReconBillBizId 幂等键 → 空键拒入 → ON CONFLICT DO UPDATE 覆盖。
//   🔴 v3.0.5 泛化重构：行为字节不变（idKeyColumn='recon_bill_biz_id'、keyExtractor=obj.ReconBillBizId），
//     既有 v3.0.1 单测 parity 为锁。
function buildGatewayUpsertContext(db, importedAt) {
  return buildLinkedUpsertContext(
    db,
    'gateway-bill',
    { keyExtractor: (obj) => obj.ReconBillBizId, idKeyColumn: 'recon_bill_biz_id' },
    importedAt
  );
}

// 网关 meta 全表重算（薄封装，委托泛化内核）。🔴 v3.0.5 泛化重构：行为字节不变。
function recomputeGatewayMeta(db, sourceFileName, importedAt) {
  return recomputeLinkedMeta(db, 'gateway-bill', sourceFileName, importedAt);
}

// v3.0.5 OPEN-4（T6a · parity 锁）：按数据日期闭区间「将删行匹配」的统一 WHERE 子句生成器——count 预览与
//   delete 实删必须共用同一份 WHERE（否则「预览将删 N 行 / 实删 N' 行」= 资金红线下的删除行数失真）。
//   口径与既有 deleteGatewayBillByDateRange 的 DELETE WHERE 逐字节一致：纯 `dateColumn BETWEEN ? AND ?`
//     （SQLite BETWEEN 含端点；dateColumn=NULL 行返回 NULL 不命中；dateColumn='' 空串在 ISO 日期下界下字典序最小亦不命中）。
//   🔴 不擅自加 `IS NOT NULL AND != ''`——原 gateway count/delete 均未加，加了虽对现有数据结果集等价但破坏「字节不变」承诺；
//     保持纯 BETWEEN 确保 gateway parity 严格字节不变 + 三表 count/delete WHERE 完全对齐。
function buildDateRangeWhere(dateColumn) {
  return `${dateColumn} BETWEEN ? AND ?`;
}

// 按数据日期闭区间统计将删行数「泛化」内核——三表（gateway/fx/bank-deposit）共用。
//   dateColumn 取自 getDef(tableKey).dateColumn（gateway=bill_date / fx=transaction_date / bank-deposit=bill_date）。
function countLinkedByDateRange(db, tableKey, startDate, endDate) {
  const def = getDef(tableKey);
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM ${def.table} WHERE ${buildDateRangeWhere(def.dateColumn)}`
  ).get(String(startDate), String(endDate));
  return Number(row && row.c) || 0;
}

// v3.0.1 需求1（D4）：按 bill_date 闭区间统计将删行数（只读，前端删除弹框预览「将删约 N 行」）。
//   闭区间 [start,end]（SQLite BETWEEN 含端点）；bill_date 为 null 的行无日期、不计入（也删不到）。
//   🔴 v3.0.5 泛化重构：薄封装委托 countLinkedByDateRange(db,'gateway-bill',...)，行为字节不变（既有 UT-DEL-1 parity 锁）。
function countGatewayBillByDateRange(db, startDate, endDate) {
  return countLinkedByDateRange(db, 'gateway-bill', startDate, endDate);
}

// v3.0.5 OPEN-4（T6a）：按 transaction_date 闭区间统计 fx 将删行数（委托泛化内核）。
function countFxByDateRange(db, startDate, endDate) {
  return countLinkedByDateRange(db, 'fx-settlement', startDate, endDate);
}

// v3.0.5 OPEN-4（T6a）：按 bill_date 闭区间统计 bank-deposit 将删行数（委托泛化内核）。
function countBankDepositByDateRange(db, startDate, endDate) {
  return countLinkedByDateRange(db, 'bank-deposit', startDate, endDate);
}

// v3.0.1 需求1（D4）🔴 资金红线：按 bill_date 闭区间删除网关对账单行（不可逆）。
//   单事务 BEGIN/COMMIT/ROLLBACK；删后 recomputeGatewayMeta 全表重算 rowCount/日期范围；
//   保留既有 source_file_name（删除非导入，不改来源名）。bill_date=null 行不被范围匹配（删不到）。
function deleteGatewayBillByDateRange(db, startDate, endDate, options = {}) {
  const def = getDef('gateway-bill');
  const existingMeta = getLinkedTableMeta(db, 'gateway-bill');
  const sourceFileName = existingMeta && existingMeta.sourceFileName != null ? existingMeta.sourceFileName : null; // 沿用既有来源名（rowToMeta 字段：sourceFileName）
  const importedAt = new Date().toISOString();
  db.exec('BEGIN');
  let deleted = 0;
  let metaState;
  try {
    deleted = db.prepare(`DELETE FROM ${def.table} WHERE ${def.dateColumn} BETWEEN ? AND ?`)
      .run(String(startDate), String(endDate)).changes;
    metaState = recomputeGatewayMeta(db, sourceFileName, importedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }
  return { deleted, rowCount: metaState.rowCount, dataDateMin: metaState.dataDateMin, dataDateMax: metaState.dataDateMax, updatedAt: importedAt };
}

// ============================================================================
// v3.0.5 OPEN-4（T6a）🔴🔴 资金红线：bank-deposit / fx 按日期范围删除（三表化 + fx 联动删 BOC）
//   spec §3.3：删除不可逆 + 派生表联动。本批只做仓储层 + 单测，handler 路由/前端在 T6b/T6c。
//   口径全仿 deleteGatewayBillByDateRange：单事务 BEGIN/COMMIT/ROLLBACK；删后 recomputeLinkedMeta 全表重算；
//     保留既有 source_file_name（删除非导入，不改来源名）；DELETE WHERE 与 count 预览共用 buildDateRangeWhere（预览=实删）。
//   🔴 删除必须返回联动键集（deletedBizIds / deletedTxnNos）——删前同事务收集（删后行已不在无法补查，T6b 派生联动重建要用）。
// ============================================================================

// v3.0.5 OPEN-4（T6a）🔴 资金红线：按 bill_date 闭区间删除银行对账单入金表行（不可逆，单事务）。
//   删前同事务 SELECT biz_id（normalizeKey 去空 + 去重）→ deletedBizIds（T6b 用于清 OPEN-7 命中标记 / 派生重建）。
//   DELETE FROM linked_bank_deposit WHERE bill_date BETWEEN（与 countBankDepositByDateRange 同 WHERE）→ 删后全表重算 meta。
//   bill_date=null / '' 行不被范围匹配（删不到，与 gateway 同口径）。
//   返回 { deleted, deletedBizIds, rowCount, dataDateMin, dataDateMax, updatedAt }。
function deleteBankDepositByDateRange(db, startDate, endDate, options = {}) {
  const def = getDef('bank-deposit');
  const existingMeta = getLinkedTableMeta(db, 'bank-deposit');
  const sourceFileName = existingMeta && existingMeta.sourceFileName != null ? existingMeta.sourceFileName : null; // 沿用既有来源名（删除非导入）
  const importedAt = new Date().toISOString();
  const where = buildDateRangeWhere(def.dateColumn);
  db.exec('BEGIN');
  let deleted = 0;
  let deletedBizIds = [];
  let metaState;
  try {
    // 🔴 删前同事务收集联动键（删后行已不在无法补查）：取 biz_id 幂等键列（upsert 落库时已 normalizeKey 归一），
    //   再 normalizeKey 去空 + Set 去重（与 clearBankDepositHitMarkersByBizIds / upsert 幂等键字节同口径）。
    const bizRows = db.prepare(`SELECT biz_id FROM ${def.table} WHERE ${where}`).all(String(startDate), String(endDate));
    deletedBizIds = [...new Set(bizRows.map((r) => normalizeKey(r.biz_id)).filter((k) => k !== ''))];
    deleted = db.prepare(`DELETE FROM ${def.table} WHERE ${where}`).run(String(startDate), String(endDate)).changes;
    metaState = recomputeLinkedMeta(db, 'bank-deposit', sourceFileName, importedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }
  return {
    deleted,
    deletedBizIds,
    rowCount: metaState.rowCount,
    dataDateMin: metaState.dataDateMin,
    dataDateMax: metaState.dataDateMax,
    updatedAt: importedAt
  };
}

// v3.0.5 OPEN-4（T6a）🔴🔴 资金红线：按 transaction_date 闭区间删除外汇交割表行（不可逆，单事务）+ 联动删 BOC 派生表。
//   删前同事务 SELECT transaction_no（normalizeKey 去空 + 去重）→ deletedTxnNos（fx 主表 transaction_no 列已是
//     normalizeKey(normalizeTransactionNo(...)) 产物，与 BOC 表 transaction_no 列同口径，字节对齐可直接作 IN 匹配键）。
//   DELETE FROM linked_fx_settlement WHERE transaction_date BETWEEN（与 countFxByDateRange 同 WHERE）。
//   🔴 联动删 BOC：DELETE FROM linked_boc_fx_settlement WHERE transaction_no IN (deletedTxnNos)，分 chunk ≤ HIT_MARKER_READ_CHUNK
//      规避 SQLite IN(?,...) 参数上限；⚠️⚠️ 绝不按 maturity_date / 日期删 BOC（BOC 日期列是到期日，与删除日期范围无关，按日期删会误删/漏删）。
//   🔴 删主表 + 删 BOC 同一事务：中途任意 throw → 全 ROLLBACK，两表回到删前态（禁止「删了主表、BOC stale」中间态）。
//   删后 fx 主表 recomputeLinkedMeta 全表重算；transaction_date=null/'' 行不被范围匹配（删不到）。
//   返回 { deleted, deletedTxnNos, bocDeleted, rowCount, dataDateMin, dataDateMax, updatedAt }。
//   ⚠️ 本批只删 BOC 行；删后 BOC「全量重匹配 + 重编号」编排在 T6b（main.js handler，复用 §3.2.2 第 3/4 步），仓储层只做原子删除。
function deleteFxByDateRange(db, startDate, endDate, options = {}) {
  const def = getDef('fx-settlement');
  const bocDef = getDef('boc-fx-settlement');
  const existingMeta = getLinkedTableMeta(db, 'fx-settlement');
  const sourceFileName = existingMeta && existingMeta.sourceFileName != null ? existingMeta.sourceFileName : null; // 沿用既有来源名（删除非导入）
  const importedAt = new Date().toISOString();
  const where = buildDateRangeWhere(def.dateColumn);
  db.exec('BEGIN');
  let deleted = 0;
  let deletedTxnNos = [];
  let bocDeleted = 0;
  let metaState;
  try {
    // 🔴 删前同事务收集联动键（删后行已不在无法补查）：取 fx 主表 transaction_no 幂等键列（落库时已归一），
    //   再 normalizeKey 去空 + Set 去重 → 与 BOC 表 transaction_no 列同口径（字节对齐）。
    const txnRows = db.prepare(`SELECT transaction_no FROM ${def.table} WHERE ${where}`).all(String(startDate), String(endDate));
    deletedTxnNos = [...new Set(txnRows.map((r) => normalizeKey(r.transaction_no)).filter((k) => k !== ''))];
    // 删 fx 主表
    deleted = db.prepare(`DELETE FROM ${def.table} WHERE ${where}`).run(String(startDate), String(endDate)).changes;
    // 🔴 联动删 BOC 派生表：严格按 transaction_no IN(被删行的交易编号)，分 chunk ≤900 规避 IN 参数上限；
    //   ⚠️ 绝不按 maturity_date / 日期删 BOC（到期日与删除日期范围无关）。
    if (deletedTxnNos.length > 0) {
      const delBocSqlPrefix = `DELETE FROM ${bocDef.table} WHERE transaction_no IN (`;
      for (let i = 0; i < deletedTxnNos.length; i += HIT_MARKER_READ_CHUNK) {
        const chunk = deletedTxnNos.slice(i, i + HIT_MARKER_READ_CHUNK);
        const placeholders = chunk.map(() => '?').join(', ');
        bocDeleted += db.prepare(`${delBocSqlPrefix}${placeholders})`).run(...chunk).changes;
      }
    }
    metaState = recomputeLinkedMeta(db, 'fx-settlement', sourceFileName, importedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }
  return {
    deleted,
    deletedTxnNos,
    bocDeleted,
    rowCount: metaState.rowCount,
    dataDateMin: metaState.dataDateMin,
    dataDateMax: metaState.dataDateMax,
    updatedAt: importedAt
  };
}

// 网关对账单幂等 upsert（数组路径，同步）：按 ReconBillBizId 累加，不整表覆盖。
//   rows = `{ [表头名]: 值 }` 对象数组；options.sourceFileName = 来源文件名（落 meta）。
//   自带 BEGIN/COMMIT/ROLLBACK；返回计数 + 全表重算 meta。
//   🔴 调用方须先 ensureLinkedTableSupport（含 recon_bill_biz_id + UNIQUE）；否则 ON CONFLICT 无目标列。
function upsertLinkedGatewayBill(db, rows, options = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const sourceFileName = normalizeSourceFileName(options);
  const importedAt = new Date().toISOString();
  const { upsertOne, counters } = buildGatewayUpsertContext(db, importedAt);

  db.exec('BEGIN');
  let metaState;
  try {
    for (const row of safeRows) upsertOne(row);
    metaState = recomputeGatewayMeta(db, sourceFileName, importedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return {
    tableKey: 'gateway-bill',
    upserted: counters.upserted,
    overwriteCount: counters.overwriteCount,
    rejectedEmptyCount: counters.rejectedEmptyCount,
    rowCount: metaState.rowCount,
    dataDateMin: metaState.dataDateMin,
    dataDateMax: metaState.dataDateMax,
    updatedAt: importedAt
  };
}

// 网关对账单幂等 upsert（流式，async）：caller 经 feedRows(upsertOne) 在事务内逐行喂入，内存恒定。
//   🔴🔴 资金红线（R-4）：单事务跨 await 全程开启；feedRows 中途任意 throw → ROLLBACK，
//     表保持调用前状态（已成功的本批 upsert 也回滚，旧累加数据完好）。
//   结构照抄 replaceLinkedTableStreaming（line 297）：去掉 DELETE、insertOne→upsertOne、meta 换全表重算。
//   feedRows 不是函数即守卫抛错（与 replace 流式版一致）。
async function upsertLinkedGatewayBillStreaming(db, feedRows, options = {}) {
  if (typeof feedRows !== 'function') {
    throw new Error('[linked-table-repository] upsertLinkedGatewayBillStreaming 需要 feedRows 回调');
  }
  const sourceFileName = normalizeSourceFileName(options);
  const importedAt = new Date().toISOString();
  const { upsertOne, counters } = buildGatewayUpsertContext(db, importedAt);

  db.exec('BEGIN');
  let metaState;
  try {
    await feedRows(upsertOne); // 事务全程开启；caller 边流式读 xlsx 边逐行 upsertOne
    metaState = recomputeGatewayMeta(db, sourceFileName, importedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return {
    tableKey: 'gateway-bill',
    upserted: counters.upserted,
    overwriteCount: counters.overwriteCount,
    rejectedEmptyCount: counters.rejectedEmptyCount,
    rowCount: metaState.rowCount,
    dataDateMin: metaState.dataDateMin,
    dataDateMax: metaState.dataDateMax,
    updatedAt: importedAt
  };
}

// ============================================================================
// v3.0.5 需求1：银行对账单入金表链接表「按 BizId 幂等 upsert」专用仓储（仿网关 v3.0.1）
//   🔴🔴 资金对账红线：不复用 replaceLinkedTable/replaceLinkedTableStreaming（整表覆盖 DELETE 全表语义）。
//      本组函数走「幂等累加」：按 biz_id（UNIQUE，T1 迁移建）ON CONFLICT DO UPDATE，旧 BizId 行保留、
//      重复 BizId 行覆盖为最新值——多次导入不重复、不丢历史。
//   幂等键口径（必须与 migration 回填字节一致）：bizId = normalizeKey(obj.BizId)
//      （精确大小写 BizId = BANK_DEPOSIT_FIELDS[0]；migration 回填用 TRIM(json_extract(...,'$.BizId'))；
//       normalizeKey = String().trim() → 与 TRIM 字节一致）。空键拒入（与 migration 删空键同口径）。
//   ⚠️ 上层 caller 须先 pickBankDepositFields 裁列（main.js handler），本仓储不再裁列（与现状 replace 双路一致）。
//   meta 累加语义：累加后 rowCount / 日期范围全表重算（recomputeLinkedMeta：COUNT(*) 全表 + MIN/MAX(bill_date) 全表）。
//   数组版（同步）与流式版（async）共用泛化内核 buildLinkedUpsertContext，与网关同一份（防口径漂移）。

// 银行对账单入金表幂等 upsert（数组路径，同步）：按 BizId 累加，不整表覆盖。
//   rows = `{ [表头名]: 值 }` 对象数组（caller 已 pickBankDepositFields 裁列）；options.sourceFileName 落 meta。
//   自带 BEGIN/COMMIT/ROLLBACK；返回计数 + 全表重算 meta。
//   🔴 调用方须先 ensureLinkedTableSupport（含 biz_id + UNIQUE）；否则 ON CONFLICT 无目标列。
function upsertLinkedBankDeposit(db, rows, options = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const sourceFileName = normalizeSourceFileName(options);
  const importedAt = new Date().toISOString();
  const { upsertOne, counters } = buildLinkedUpsertContext(
    db,
    'bank-deposit',
    { keyExtractor: (obj) => obj.BizId, idKeyColumn: 'biz_id' },
    importedAt
  );

  db.exec('BEGIN');
  let metaState;
  try {
    for (const row of safeRows) upsertOne(row);
    metaState = recomputeLinkedMeta(db, 'bank-deposit', sourceFileName, importedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return {
    tableKey: 'bank-deposit',
    upserted: counters.upserted,
    overwriteCount: counters.overwriteCount,
    rejectedEmptyCount: counters.rejectedEmptyCount,
    rowCount: metaState.rowCount,
    dataDateMin: metaState.dataDateMin,
    dataDateMax: metaState.dataDateMax,
    updatedAt: importedAt
  };
}

// 银行对账单入金表幂等 upsert（流式，async）：caller 经 feedRows(upsertOne) 在事务内逐行喂入，内存恒定。
//   🔴🔴 资金红线（R-6）：65.7 万行物理单 sheet .xlsx 走此路；单事务跨 await 全程开启；
//     feedRows 中途任意 throw → ROLLBACK，表保持调用前状态（旧累加数据完好）。
//   🔴 node:sqlite DatabaseSync 单进程单连接同步 API，BEGIN 开启的事务在 `await feedRows(...)`（event loop 让出读盘/解压
//     stream）期间依然保持开启（现状 replaceLinkedTableStreaming 已实测 657,757 行单事务回滚）。不得退化为逐行自动提交。
//   结构照抄 upsertLinkedGatewayBillStreaming（去掉 DELETE、insertOne→upsertOne、meta 全表重算）。
//   feedRows 不是函数即守卫抛错（与网关流式版一致）。
async function upsertLinkedBankDepositStreaming(db, feedRows, options = {}) {
  if (typeof feedRows !== 'function') {
    throw new Error('[linked-table-repository] upsertLinkedBankDepositStreaming 需要 feedRows 回调');
  }
  const sourceFileName = normalizeSourceFileName(options);
  const importedAt = new Date().toISOString();
  const { upsertOne, counters } = buildLinkedUpsertContext(
    db,
    'bank-deposit',
    { keyExtractor: (obj) => obj.BizId, idKeyColumn: 'biz_id' },
    importedAt
  );

  db.exec('BEGIN');
  let metaState;
  try {
    await feedRows(upsertOne); // 事务全程开启；caller 边流式读 xlsx 边逐行 upsertOne
    metaState = recomputeLinkedMeta(db, 'bank-deposit', sourceFileName, importedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return {
    tableKey: 'bank-deposit',
    upserted: counters.upserted,
    overwriteCount: counters.overwriteCount,
    rejectedEmptyCount: counters.rejectedEmptyCount,
    rowCount: metaState.rowCount,
    dataDateMin: metaState.dataDateMin,
    dataDateMax: metaState.dataDateMax,
    updatedAt: importedAt
  };
}

// ============================================================================
// v3.0.5 需求（OPEN-7 / T5a）：银行对账单入金表「跨期重复命中提醒」命中标记读写仓储
//   载体 = linked_bank_deposit 专用列 last_hit_run / last_hit_at（T1a migration 加列；绝不动 65.7 万行 raw_json）；
//     键 = biz_id（OPEN-1 幂等键 = BANK_DEPOSIT_FIELDS[0]，UNIQUE）。归一口径 normalizeKey（String().trim()）与
//     migration 回填 / upsert 幂等键字节一致。
//   🔴🔴 资金红线（spec 硬约束）：本组三函数只读/置标记列，绝不碰 raw_json / biz_id / 其它业务列；标记是观测增强（非资金数据），
//     与 upsert ON CONFLICT SET（buildLinkedUpsertContext 4 列）天然隔离——重导覆盖同 BizId 不洗 last_hit。
//   ⚠️ 本批（T5a）只交付 3 个读写函数 + facade 转发；命中回写时机（export 成功后）/ 提醒注入在 T5b；
//      clearBankDepositHitMarkersByBizIds 本批只交付函数不接线（OPEN-4 删除联动批次4 才接入）。

// 读命中标记：bizIds → Map<bizId, { last_hit_run, last_hit_at }>。
//   bizIds 经 normalizeKey 归一 + 去空 + 去重后查；空入参 → 空 Map；未命中 BizId 不在 Map（不补默认值）。
//   只 SELECT 标记列（不读 raw_json，省 65 万行级反序列化）。
//   🔴 T5c Important：按 chunk 分批查询（每批 ≤ HIT_MARKER_READ_CHUNK 个 key），规避 SQLite IN(?,...) 参数上限
//     （默认 SQLITE_MAX_VARIABLE_NUMBER 在不同版本为 999 / 32766；命中 BizId 可能上千）；各批结果合并进同一 Map。
function readBankDepositHitMarkers(db, bizIds) {
  const result = new Map();
  if (!Array.isArray(bizIds) || bizIds.length === 0) return result;
  const keys = [...new Set(bizIds.map((id) => normalizeKey(id)).filter((k) => k !== ''))];
  if (keys.length === 0) return result;
  for (let i = 0; i < keys.length; i += HIT_MARKER_READ_CHUNK) {
    const chunk = keys.slice(i, i + HIT_MARKER_READ_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT biz_id, last_hit_run, last_hit_at FROM linked_bank_deposit WHERE biz_id IN (${placeholders})`
    ).all(...chunk);
    for (const r of rows) {
      result.set(r.biz_id, {
        last_hit_run: r.last_hit_run === undefined ? null : r.last_hit_run,
        last_hit_at: r.last_hit_at === undefined ? null : r.last_hit_at
      });
    }
  }
  return result;
}

// 写命中标记：bizIds 批量 UPDATE last_hit_run=runId / last_hit_at=atIso（单事务）。
//   🔴 仅 UPDATE 已存在行（WHERE biz_id=?），绝不 INSERT——缺失 BizId 的 UPDATE .changes=0 安全 no-op（不凭空造行）。
//   bizIds 经 normalizeKey 归一 + 去空 + 去重；空入参 / 全空键 → no-op 返回 { marked: 0 }（不开事务）。
//   marked = 实际改动行数之和（缺失 BizId 不计入）。
function markBankDepositHits(db, bizIds, runId, atIso) {
  if (!Array.isArray(bizIds) || bizIds.length === 0) return { marked: 0 };
  const keys = [...new Set(bizIds.map((id) => normalizeKey(id)).filter((k) => k !== ''))];
  if (keys.length === 0) return { marked: 0 };
  const stmt = db.prepare('UPDATE linked_bank_deposit SET last_hit_run = ?, last_hit_at = ? WHERE biz_id = ?');
  let marked = 0;
  db.exec('BEGIN');
  try {
    for (const k of keys) {
      marked += stmt.run(runId, atIso, k).changes;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }
  return { marked };
}

// 清命中标记：bizIds 批量置 last_hit_run=NULL / last_hit_at=NULL（单事务）。
//   仅 UPDATE 已存在行（缺失 BizId .changes=0 no-op）；绝不碰 raw_json / biz_id / 其它列。
//   bizIds 经 normalizeKey 归一 + 去空 + 去重；空入参 / 全空键 → no-op 返回 { cleared: 0 }。
//   ⚠️ 本批只交付函数不接线（OPEN-4 删除联动批次4：删 bank-deposit 行后清指向被删 BizId 的标记，防悬挂）。
function clearBankDepositHitMarkersByBizIds(db, bizIds) {
  if (!Array.isArray(bizIds) || bizIds.length === 0) return { cleared: 0 };
  const keys = [...new Set(bizIds.map((id) => normalizeKey(id)).filter((k) => k !== ''))];
  if (keys.length === 0) return { cleared: 0 };
  const stmt = db.prepare('UPDATE linked_bank_deposit SET last_hit_run = NULL, last_hit_at = NULL WHERE biz_id = ?');
  let cleared = 0;
  db.exec('BEGIN');
  try {
    for (const k of keys) {
      cleared += stmt.run(k).changes;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }
  return { cleared };
}

// ============================================================================
// v3.0.5 需求2：外汇交割表链接表「按交易编号幂等 upsert」专用仓储（仿网关 v3.0.1 / bank-deposit 需求1）
//   🔴🔴 资金对账红线：不复用 replaceLinkedTable/replaceLinkedTableStreaming（整表覆盖 DELETE 全表语义）。
//      本组函数走「幂等累加」：按 transaction_no（UNIQUE，T1 迁移建）ON CONFLICT DO UPDATE，旧交易编号行保留、
//      重复交易编号行覆盖为最新值——多次导入不重复、不丢历史。
//   幂等键口径（必须与 migration 回填字节一致）：txnNo = normalizeKey(normalizeTransactionNo(obj['交易编号']))
//      （normalizeTransactionNo 单一真相 = engine-utils，与 builder 派生分组 / migration JS 层回填同口径；
//       归一为空 = 合计/页脚/非数字行 → 空键拒入 + 计数，与 migration 删空键同口径）。
//      ⚠️ normalizeTransactionNo 产物已是纯数字串/'' → 外层 normalizeKey(String().trim()) 是冗余安全（与泛化内核统一口径）。
//   ⚠️ fx 主表无「调拨单号」列（table-signatures.js FX 签名不含此列；调拨单号是 BOC 派生/中台字段）→ 空键判据用「交易编号归一为空」
//      （=幂等键本身为空，与 gateway/bank-deposit 同口径；合计行交易编号列为 "生成日期:..." 文本，normalizeTransactionNo 返回 ''）。
//   🔴 仅数组版（fx 永不走流式，main.js repoKey !== 'fx-settlement' 守卫保持——BOC 分组需物理行号断档）；无流式版。
//   meta 累加语义：累加后 rowCount / 日期范围全表重算（recomputeLinkedMeta：COUNT(*) 全表 + MIN/MAX(transaction_date) 全表）。
//   ⚠️ 本批次（2a）只改 fx 主表 + normalizeTransactionNo 下沉；BOC 派生表整表覆盖（replaceBocFxLink）/ 全量重算下批次（2b）才改。

// 外汇交割表幂等 upsert（数组路径，同步）：按交易编号累加，不整表覆盖。
//   rows = `{ [表头名]: 值 }` 对象数组（main.js handler 经 readLinkedRowsAsObjectsWithMeta 产出，未裁列，整行存 raw_json）。
//   options.sourceFileName 落 meta；自带 BEGIN/COMMIT/ROLLBACK；返回计数 + 全表重算 meta。
//   🔴 调用方须先 ensureLinkedTableSupport（含 transaction_no UNIQUE）；否则 ON CONFLICT 无目标列。
function upsertLinkedFx(db, rows, options = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const sourceFileName = normalizeSourceFileName(options);
  const importedAt = new Date().toISOString();
  const { upsertOne, counters } = buildLinkedUpsertContext(
    db,
    'fx-settlement',
    { keyExtractor: (obj) => normalizeTransactionNo(obj['交易编号']), idKeyColumn: 'transaction_no' },
    importedAt
  );

  db.exec('BEGIN');
  let metaState;
  try {
    for (const row of safeRows) upsertOne(row);
    metaState = recomputeLinkedMeta(db, 'fx-settlement', sourceFileName, importedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return {
    tableKey: 'fx-settlement',
    upserted: counters.upserted,
    overwriteCount: counters.overwriteCount,
    rejectedEmptyCount: counters.rejectedEmptyCount,
    rowCount: metaState.rowCount,
    dataDateMin: metaState.dataDateMin,
    dataDateMax: metaState.dataDateMax,
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

// v3.0.0 块 B / PR-3（R-3/O-3）：ADM 派生只需 bank-deposit 里 Channel=ADM 的候选子集。
//   现状 readLinkedTableRows('bank-deposit') 把整表（实测 65.7 万行 → ~1.2GB RSS 尖峰）全量读回内存，
//   仅为筛出极小的 Channel=ADM 子集（实测真实样本该子集=0 行）。本函数把 Channel='ADM' 过滤下推到 SQL
//   （json_extract），只物化候选子集，消除尖峰。
//   🔴 资金红线安全：SQL 仅过滤高选择性的 Channel='ADM'（buildAdmRows 完整 Channel∧FundType 条件的**超集**，
//     绝不比 JS 过滤更窄 → 不漏任何 ADM 行）；FundType 由 buildAdmRows 内部过滤把关（最终权威）。
//   值与 buildAdmRows 的 normCell(Channel)==='ADM' 等价：落库时已 normalizeCell（String().trim()），
//     raw_json 内 Channel 为已 trim 字符串，json_extract 精确等于 'ADM' 与之一致。
function readBankDepositAdmCandidates(db) {
  const def = getDef('bank-deposit');
  if (!def.supported) return [];
  const rows = db.prepare(
    `SELECT raw_json FROM ${def.table} WHERE json_extract(raw_json, '$.Channel') = ? ORDER BY id ASC`
  ).all(CHANNEL_VALUE);
  const out = [];
  for (const r of rows) {
    try {
      const o = JSON.parse(r.raw_json);
      if (o && typeof o === 'object') out.push(o);
    } catch (_e) {
      /* 损坏行跳过，不抛错（与 readLinkedTableRows 容错一致） */
    }
  }
  return out;
}

// v3.0.0 块 B / PR-3：轻量探测某链接表是否有任意数据行（EXISTS，命中首行即停，不物化整表）。
//   替代「readLinkedTableRows(tableKey).length > 0」——后者为判存在性把整表读回内存（大文件同样撞尖峰）。
function hasLinkedTableRows(db, tableKey) {
  const def = getDef(tableKey);
  if (!def.supported) return false;
  const r = db.prepare(`SELECT EXISTS(SELECT 1 FROM ${def.table}) AS e`).get();
  return !!(r && r.e);
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

// ============================================================================
// v3.0.4 块 E（需求2）：BOC 链接表两张隐藏表（linked_boc_fx_settlement / linked_boc_bank_deposit）专用仓储
//   🔴 不复用 replaceLinkedTable（其 INSERT 硬编码 4 列）；两表列数不同，各写专用 replace。
//   隐藏表：不进 ALL_TABLE_KEYS / 不写 linked_table_meta（前端弹窗不可见，与 ADM 同范式）。
//   🔴 避免循环依赖：本仓储不 require boc-fx-link-builder / boc-fx-link-fields（后者 require 本文件），
//      内部辅助键名以字面量定义（须与 boc-fx-link-builder.js 的 KEY_TXN_NO 等保持一致）。
// ============================================================================

const BOC_FX_TABLE = 'linked_boc_fx_settlement';
const BOC_BANK_TABLE = 'linked_boc_bank_deposit';

// 与 boc-fx-link-builder.js 一致的内部辅助键名（落库前从 raw_json 业务行剥到热列）。
const BOC_KEY_TXN_NO = '__txnNo';
const BOC_KEY_MATURITY_ISO = '__maturityIso';
const BOC_KEY_SOURCE_ROW = '__sourceRow';
// v3.0.5 批次2b：原始组号辅助键（与 boc-fx-link-builder.js KEY_ORIG_GROUP 一致；落库剥到 orig_group_no 热列，
//   读回时从 orig_group_no 列注入此键供 rematchAllBocGroups 聚合）。
const BOC_KEY_ORIG_GROUP = '__origGroup';
// BOC 链接表 3 新字段 / 银行字段名（与 boc-fx-link-fields.FIELD_MAP 一致，本文件就地内联防循环依赖）。
const BOC_FIELD_GROUP = '分组';
const BOC_FIELD_ALLOCATION_NO = '调拨单号';
const BOC_FIELD_RECON_LINK_ID = '资金对账不平表链接ID';
const BOC_FIELD_TXN_NO = '交易编号';
const BOC_FIELD_BANK_TXN_NO = '银行单交易编号';
const BOC_FIELD_RECON_ID = 'ReconciliationId';
const BOC_FIELD_BILL_DATE = 'BillDate';

// 银行对账单 Channel=BOC 候选子集（json_extract 下推，仅物化候选；地区/币种/金额终审在 builder）。
//   与 readBankDepositAdmCandidates 同范式：SQL 仅过滤高选择性 Channel='BOC'（builder 完整条件的超集），不漏行。
function readBankDepositBocCandidates(db) {
  const def = getDef('bank-deposit');
  if (!def.supported) return [];
  const rows = db.prepare(
    `SELECT raw_json FROM ${def.table} WHERE json_extract(raw_json, '$.Channel') = ? ORDER BY id ASC`
  ).all('BOC');
  const out = [];
  for (const r of rows) {
    try {
      const o = JSON.parse(r.raw_json);
      if (o && typeof o === 'object') out.push(o);
    } catch (_e) {
      /* 损坏行跳过，不抛错（与 readLinkedTableRows 容错一致） */
    }
  }
  return out;
}

// 整表覆盖写入 BOC链接表行：事务内 DELETE 全表 + 批量 INSERT OR REPLACE 9 列（prepared）。
//   rows = scanFxGroups/matchBocToMidAllocation 后的链接行（33 命名字段 + 3 新字段 + 内部辅助键）。
//   热列从内部辅助键 / 3 新字段取；raw_json 存「剥掉辅助键」后的纯业务行（33+3 字段，数据真相）。
//   caller 不需持有事务；本函数自带 BEGIN/COMMIT/ROLLBACK（与 replaceAdmBankDeposit 范式一致）。
//   🔴🔴 I2 修复（codex review）：批次2b 起 BOC 表有 transaction_no UNIQUE + orig_group_no 列。本函数非生产路径
//     （main.js fx 派生已走 upsertBocFxLink），但删除联动（批次4）会用到，故升级与新 schema 兼容：
//       · 写 orig_group_no 列（从 __origGroup 取，无则回退「分组」当前值，与 upsertBocFxLink 同口径——
//         否则 orig_group_no=NULL → 后续 rematch 读出空 __origGroup → 组聚类坍缩成一个大组）；
//       · raw_json 剥 __origGroup（不入业务字段）；
//       · transaction_no 用 last-wins（INSERT OR REPLACE：同批重复键后者覆盖前者，避免撞 UNIQUE 抛错）；
//       · 空键拒入（transaction_no 归一为空 → 跳过，与 upsertBocFxLink 同口径）。
function replaceBocFxLink(db, rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const importedAt = new Date().toISOString();

  // INSERT OR REPLACE：同批含重复 transaction_no 时 last-wins（不撞 UNIQUE）；整表覆盖语义下 id 不稳定无影响（已 DELETE 全表重建）。
  const insertSql = `
    INSERT OR REPLACE INTO ${BOC_FX_TABLE}
      (transaction_no, group_no, allocation_no, recon_link_id, maturity_date, source_row, orig_group_no, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  let written = 0;
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ${BOC_FX_TABLE}`).run();

    const insertStmt = db.prepare(insertSql);
    for (const row of safeRows) {
      const obj = row && typeof row === 'object' ? row : {};
      // 热列取值：交易编号优先用辅助键（已归一化纯数字），缺失回退原字段归一
      const txnNo = normalizeKey(obj[BOC_KEY_TXN_NO] !== undefined ? obj[BOC_KEY_TXN_NO] : obj[BOC_FIELD_TXN_NO]);
      if (txnNo === '') continue; // 空键拒入（与 upsertBocFxLink 同口径）
      const groupNo = normalizeKey(obj[BOC_FIELD_GROUP]);
      const allocationNo = normalizeKey(obj[BOC_FIELD_ALLOCATION_NO]);
      const reconLinkId = normalizeKey(obj[BOC_FIELD_RECON_LINK_ID]);
      const maturityIso = obj[BOC_KEY_MATURITY_ISO] !== undefined
        ? normalizeKey(obj[BOC_KEY_MATURITY_ISO])
        : normalizeDateForRange(obj['到期日']);
      const sourceRowRaw = obj[BOC_KEY_SOURCE_ROW];
      const sourceRow = (sourceRowRaw === undefined || sourceRowRaw === null || sourceRowRaw === '')
        ? null
        : Number(sourceRowRaw);
      // orig_group_no 优先用辅助键 __origGroup，缺失回退「分组」当前值（防 NULL → rematch 组聚类坍缩）。
      const origGroupNo = normalizeKey(
        obj[BOC_KEY_ORIG_GROUP] !== undefined ? obj[BOC_KEY_ORIG_GROUP] : obj[BOC_FIELD_GROUP]
      );
      // raw_json 剥掉内部辅助键（仅存纯业务字段）
      const business = { ...obj };
      delete business[BOC_KEY_TXN_NO];
      delete business[BOC_KEY_MATURITY_ISO];
      delete business[BOC_KEY_SOURCE_ROW];
      delete business[BOC_KEY_ORIG_GROUP];
      const rawJson = JSON.stringify(business);
      insertStmt.run(txnNo, groupNo, allocationNo, reconLinkId, maturityIso || null, sourceRow, origGroupNo || null, rawJson, importedAt);
      written += 1;
    }

    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  // rowCount = 实际写入行数（空键拒入后；last-wins 同批重复键最终行数可能少于喂入数）。
  const rowCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${BOC_FX_TABLE}`).get().c) || 0;
  return { tableKey: 'boc-fx-settlement', rowCount, written, updatedAt: importedAt };
}

// ============================================================================
// v3.0.5 批次2b：BOC 链接表「增量进组 + DB 全量重匹配 + 重编号」专用仓储
//   🔴🔴 资金红线（spec §3.2.2 / OPEN-3 / OPEN-5）：从「单文件内存派生 + replaceBocFxLink 整表覆盖」
//      改为「scan 本文件 upsert 进库（按 transaction_no 幂等）→ 读全库 → rematchAllBocGroups（builder 纯函数，
//      重编号 + 全库重匹配，逻辑零改动）→ 按 id 批量回写」。编排在 main.js fx 派生块（仓储不 require builder，避免
//      linked-table-repository ↔ boc-fx-link-builder ↔ boc-fx-link-fields 循环依赖）；本组函数只提供原子读写。
//   🔴 replaceBocFxLink（整表覆盖）保留不删——删除联动 / 异常回退 / 既有单测仍可能用；新写入路径走 upsertBocFxLink。
// ============================================================================

// 取现有最大 orig_group_no（offset 续编用）：SELECT MAX(CAST(orig_group_no AS INTEGER))。
//   空表 / 全 null → 0（scan offset=0，组号从 1 起）。CAST 防字符串比较把 '10' 排在 '9' 前。
function getMaxBocFxOrigGroupNo(db) {
  const r = db.prepare(
    `SELECT MAX(CAST(orig_group_no AS INTEGER)) AS mx FROM ${BOC_FX_TABLE} WHERE orig_group_no IS NOT NULL AND orig_group_no != ''`
  ).get();
  return Number(r && r.mx) || 0;
}

// BOC链接表幂等 upsert（数组路径，同步）：按 transaction_no 累加，不整表覆盖（spec §3.2.2 第2步）。
//   rows = scanFxGroups 产物（33 命名字段 + 3 新字段 + 内部辅助键 __txnNo/__maturityIso/__sourceRow/__origGroup）。
//   🔴 同键覆盖（ON CONFLICT(transaction_no) DO UPDATE）：id 不变 → 行序稳定（rematch 按 id ASC 重编号的前提）；
//      DO UPDATE 写全部热列 + raw_json（含 orig_group_no = 本次 scan 续编后组号——spec「同键后者覆盖前者，按文件顺序」），
//      但不写 transaction_no 本身（ON CONFLICT 判定列）。新键追加（AUTOINCREMENT 新 id）。
//   🔴 orig_group_no 由本次 scan 写入；「永不被改写」红线指的是 rematchAllBocGroups（2.2/2.3）不改它，
//      不是 upsert 不能更新（同一交易编号重导时其物理分组以最新文件为准，与主表 fx upsert 同键覆盖语义一致）。
//   空键拒入（transaction_no 归一为空 → 跳过 + 计数；scan 已过滤空交易编号行，此处双保险）。
//   caller 不需持有事务；自带 BEGIN/COMMIT/ROLLBACK。
//   🔴 调用方须先 ensureBocFxLinkSupport（含 orig_group_no 列 + transaction_no UNIQUE）；否则 ON CONFLICT 无目标列。
function upsertBocFxLink(db, rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const importedAt = new Date().toISOString();

  const upsertSql = `
    INSERT INTO ${BOC_FX_TABLE}
      (transaction_no, group_no, allocation_no, recon_link_id, maturity_date, source_row, orig_group_no, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_no) DO UPDATE SET
      group_no = excluded.group_no,
      allocation_no = excluded.allocation_no,
      recon_link_id = excluded.recon_link_id,
      maturity_date = excluded.maturity_date,
      source_row = excluded.source_row,
      orig_group_no = excluded.orig_group_no,
      raw_json = excluded.raw_json,
      imported_at = excluded.imported_at
  `;

  let upserted = 0;
  let overwriteCount = 0;
  let rejectedEmptyCount = 0;

  db.exec('BEGIN');
  try {
    const upsertStmt = db.prepare(upsertSql);
    const existsStmt = db.prepare(`SELECT 1 FROM ${BOC_FX_TABLE} WHERE transaction_no = ? LIMIT 1`);
    for (const row of safeRows) {
      const obj = row && typeof row === 'object' ? row : {};
      // 交易编号优先用辅助键（已归一化纯数字），缺失回退原字段归一。
      const txnNo = normalizeKey(obj[BOC_KEY_TXN_NO] !== undefined ? obj[BOC_KEY_TXN_NO] : obj[BOC_FIELD_TXN_NO]);
      if (txnNo === '') {
        rejectedEmptyCount += 1; // 空键拒入（与 fx 主表 upsert 同口径）
        continue;
      }
      const groupNo = normalizeKey(obj[BOC_FIELD_GROUP]);
      const allocationNo = normalizeKey(obj[BOC_FIELD_ALLOCATION_NO]);
      const reconLinkId = normalizeKey(obj[BOC_FIELD_RECON_LINK_ID]);
      const maturityIso = obj[BOC_KEY_MATURITY_ISO] !== undefined
        ? normalizeKey(obj[BOC_KEY_MATURITY_ISO])
        : normalizeDateForRange(obj['到期日']);
      const sourceRowRaw = obj[BOC_KEY_SOURCE_ROW];
      const sourceRow = (sourceRowRaw === undefined || sourceRowRaw === null || sourceRowRaw === '')
        ? null
        : Number(sourceRowRaw);
      // orig_group_no 优先用辅助键 __origGroup（scan 续编值），缺失回退「分组」当前值（双保险）。
      const origGroupNo = normalizeKey(
        obj[BOC_KEY_ORIG_GROUP] !== undefined ? obj[BOC_KEY_ORIG_GROUP] : obj[BOC_FIELD_GROUP]
      );
      // raw_json 剥掉内部辅助键（仅存纯业务字段）。
      const business = { ...obj };
      delete business[BOC_KEY_TXN_NO];
      delete business[BOC_KEY_MATURITY_ISO];
      delete business[BOC_KEY_SOURCE_ROW];
      delete business[BOC_KEY_ORIG_GROUP];
      const rawJson = JSON.stringify(business);
      const existed = existsStmt.get(txnNo) !== undefined; // upsert 前先判（区分 INSERT/UPDATE）
      upsertStmt.run(txnNo, groupNo, allocationNo, reconLinkId, maturityIso || null, sourceRow, origGroupNo || null, rawJson, importedAt);
      if (existed) overwriteCount += 1;
      upserted += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return { tableKey: 'boc-fx-settlement', upserted, overwriteCount, rejectedEmptyCount, updatedAt: importedAt };
}

// 读回 BOC链接表全部行供「全量重匹配」：[{ id, row }]（row = raw_json 还原对象 + 从热列注入两个辅助键）。
//   🔴 ORDER BY id ASC = 行序优先口径（rematchAllBocGroups 重编号 + matchBocToMidAllocation 行序优先取首的前提）。
//   与 readBocFxLinkRowsWithIds（2.5 回填用，不带辅助键）区分：本函数额外注入——
//     · __origGroup（来自 orig_group_no 热列）：rematchAllBocGroups 按此聚合重编号；
//     · __maturityIso（来自 maturity_date 热列）：🔴 matchBocToMidAllocation 的 2.2/2.3 日期匹配热依赖此键
//       （boc-fx-link-builder.js:167/207），而 raw_json 已剥掉 __maturityIso → 不从热列恢复则全库重匹配日期恒不命中 = 调拨单号全空（资金事故）。
//   损坏行跳过不中断（与 readBocFxLinkRows 容错一致）。
function readBocFxLinkRowsForRematch(db) {
  const rows = db.prepare(`SELECT id, orig_group_no, maturity_date, raw_json FROM ${BOC_FX_TABLE} ORDER BY id ASC`).all();
  const out = [];
  for (const r of rows) {
    try {
      const o = JSON.parse(r.raw_json);
      if (o && typeof o === 'object') {
        // 从热列注入辅助键（raw_json 不含 orig_group_no / __maturityIso；rematch 重匹配热依赖）。
        o[BOC_KEY_ORIG_GROUP] = r.orig_group_no === undefined || r.orig_group_no === null ? '' : String(r.orig_group_no);
        o[BOC_KEY_MATURITY_ISO] = r.maturity_date === undefined || r.maturity_date === null ? '' : String(r.maturity_date);
        out.push({ id: r.id, row: o });
      }
    } catch (_e) {
      /* 损坏行跳过，不抛错 */
    }
  }
  return out;
}

// 全量重匹配后按 id 批量回写「分组」/「调拨单号」热列 + raw_json（rematchAllBocGroups 产物落库）。
//   rowsWithIds = rematchAllBocGroups 返回的 [{ id, row }]（row 已重编号分组 + 重匹配调拨单号，含 __origGroup 辅助键）。
//   🔴 资金红线：仅回写 group_no / allocation_no 热列 + raw_json（剥辅助键）；transaction_no / orig_group_no / maturity_date /
//      source_row / recon_link_id 列保持不变（recon_link_id 由 2.5 writeBocFxLinkReconIds 负责，本函数不碰）。
//      id 缺失行跳过（不误写）。单事务 BEGIN/COMMIT/ROLLBACK。
function writeBocFxLinkGroupRematch(db, rowsWithIds) {
  const list = Array.isArray(rowsWithIds) ? rowsWithIds : [];
  const updateSql = `UPDATE ${BOC_FX_TABLE} SET group_no = ?, allocation_no = ?, raw_json = ? WHERE id = ?`;

  db.exec('BEGIN');
  try {
    const updateStmt = db.prepare(updateSql);
    for (const item of list) {
      if (!item || item.id === undefined || item.id === null) continue;
      const obj = item.row && typeof item.row === 'object' ? item.row : {};
      const groupNo = normalizeKey(obj[BOC_FIELD_GROUP]);
      const allocationNo = normalizeKey(obj[BOC_FIELD_ALLOCATION_NO]);
      // raw_json 剥内部辅助键（__origGroup 由 readBocFxLinkRowsForRematch 注入，回写不可落进 raw_json）。
      const business = { ...obj };
      delete business[BOC_KEY_TXN_NO];
      delete business[BOC_KEY_MATURITY_ISO];
      delete business[BOC_KEY_SOURCE_ROW];
      delete business[BOC_KEY_ORIG_GROUP];
      updateStmt.run(groupNo, allocationNo, JSON.stringify(business), item.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return { tableKey: 'boc-fx-settlement', rowCount: list.length };
}

// 读回 BOC链接表全部业务行（raw_json → 对象，字段名 = 真实表头 + 3 新字段）。ORDER BY id ASC 保派生原序。
//   供 BOC 修复引擎（后续）经 database.readBocFxLinkRows() 取数据源。损坏行跳过不中断。
function readBocFxLinkRows(db) {
  const rows = db.prepare(`SELECT raw_json FROM ${BOC_FX_TABLE} ORDER BY id ASC`).all();
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

// 读回 BOC链接表全部行（携带 DB id）：[{ id, row }]（供 2.5 backfill 按 id 精确回写，避免位置配对错位）。
function readBocFxLinkRowsWithIds(db) {
  const rows = db.prepare(`SELECT id, raw_json FROM ${BOC_FX_TABLE} ORDER BY id ASC`).all();
  const out = [];
  for (const r of rows) {
    try {
      const o = JSON.parse(r.raw_json);
      if (o && typeof o === 'object') out.push({ id: r.id, row: o });
    } catch (_e) {
      /* 损坏行跳过，不抛错 */
    }
  }
  return out;
}

// 2.5 回填：按 id UPDATE raw_json + recon_link_id 列（比 ADM 位置配对更稳，无并发重建错位风险）。
//   rowsWithIds = backfillBocReconLinkIds 产物 [{ id, row }]（row 已回填「资金对账不平表链接ID」）。
//   🔴 资金红线：仅整批幂等重写命中行的 raw_json + recon_link_id 热列（id 缺失的行跳过，不误写）。
function writeBocFxLinkReconIds(db, rowsWithIds) {
  const list = Array.isArray(rowsWithIds) ? rowsWithIds : [];
  const updateSql = `UPDATE ${BOC_FX_TABLE} SET raw_json = ?, recon_link_id = ? WHERE id = ?`;

  db.exec('BEGIN');
  try {
    const updateStmt = db.prepare(updateSql);
    for (const item of list) {
      if (!item || item.id === undefined || item.id === null) continue;
      const obj = item.row && typeof item.row === 'object' ? item.row : {};
      const reconLinkId = normalizeKey(obj[BOC_FIELD_RECON_LINK_ID]);
      updateStmt.run(JSON.stringify(obj), reconLinkId, item.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return { tableKey: 'boc-fx-settlement', rowCount: list.length };
}

// 整表覆盖写入 BOC调拨银行对账单行：事务内 DELETE 全表 + 批量 INSERT 5 列（prepared）。
//   rows = buildBocBankRows 产物（银行字段 + 「银行单交易编号」）。raw_json 存整行（数据真相）。
//   caller 不需持有事务；自带 BEGIN/COMMIT/ROLLBACK。无可用数据时也应被 caller 调用以重建空表防 stale。
function replaceBocBankDeposit(db, rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const importedAt = new Date().toISOString();

  const insertSql = `
    INSERT INTO ${BOC_BANK_TABLE} (bank_txn_no, reconciliation_id, bill_date, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ${BOC_BANK_TABLE}`).run();

    const insertStmt = db.prepare(insertSql);
    for (const row of safeRows) {
      const obj = row && typeof row === 'object' ? row : {};
      const bankTxnNo = normalizeKey(obj[BOC_FIELD_BANK_TXN_NO]);
      const reconId = normalizeKey(obj[BOC_FIELD_RECON_ID]);
      const billDate = normalizeDateForRange(obj[BOC_FIELD_BILL_DATE]); // null = 不可解析（仍落库）
      const rawJson = JSON.stringify(obj);
      insertStmt.run(bankTxnNo, reconId, billDate, rawJson, importedAt);
    }

    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return { tableKey: 'boc-bank-deposit', rowCount: safeRows.length, updatedAt: importedAt };
}

// 读回 BOC调拨银行对账单表全部行（raw_json → 对象）。ORDER BY id ASC；损坏行跳过。
function readBocBankDepositRows(db) {
  const rows = db.prepare(`SELECT raw_json FROM ${BOC_BANK_TABLE} ORDER BY id ASC`).all();
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
  // v3.0.1 需求1 / task2：网关对账单「按 ReconBillBizId 幂等 upsert」（累加不整表覆盖；数组版 + 流式版）
  upsertLinkedGatewayBill,
  upsertLinkedGatewayBillStreaming,
  // v3.0.5 需求1：银行对账单入金表「按 BizId 幂等 upsert」（累加不整表覆盖；数组版 + 流式版，复用泛化内核）
  upsertLinkedBankDeposit,
  upsertLinkedBankDepositStreaming,
  // v3.0.5 需求2：外汇交割表「按交易编号幂等 upsert」（累加不整表覆盖；仅数组版，复用泛化内核；fx 永不流式）
  upsertLinkedFx,
  // v3.0.5 需求（OPEN-7 / T5a）：银行对账单入金表「跨期重复命中提醒」命中标记读写（专用列 last_hit_run/last_hit_at，不动 raw_json）
  readBankDepositHitMarkers,
  markBankDepositHits,
  clearBankDepositHitMarkersByBizIds,
  // v3.0.1 需求1 / task4：网关对账单「按数据日期范围统计 / 删除」（只读计数 + 闭区间删除 + meta 全表重算）
  countGatewayBillByDateRange,
  deleteGatewayBillByDateRange,
  // v3.0.5 OPEN-4（T6a）：删除三表化——fx / bank-deposit 按数据日期范围统计 / 删除（fx 删除联动删 BOC 派生表）
  countFxByDateRange,
  countBankDepositByDateRange,
  deleteFxByDateRange,
  deleteBankDepositByDateRange,
  readLinkedTableRows,
  // v3.0.0 块 B / PR-3：ADM 派生内存优化（Channel=ADM 下推过滤 + 轻量存在性探测）
  readBankDepositAdmCandidates,
  hasLinkedTableRows,
  // v2.1.16-beta.5 需求3：ADM 银行对账单隐藏表专用仓储（6 列 INSERT / 整批幂等重写）
  replaceAdmBankDeposit,
  readAdmBankDepositRows,
  writeAdmMatchFlags,
  // v3.0.4 块 E 需求2：BOC 链接表两张隐藏表专用仓储（Channel=BOC 下推 / 8 列 + 5 列 INSERT / 按 id 回写）
  readBankDepositBocCandidates,
  replaceBocFxLink,
  readBocFxLinkRows,
  readBocFxLinkRowsWithIds,
  writeBocFxLinkReconIds,
  replaceBocBankDeposit,
  readBocBankDepositRows,
  // v3.0.5 批次2b：BOC 链接表「增量进组 + 全量重匹配 + 重编号」原子读写（编排在 main.js，避免循环依赖）
  getMaxBocFxOrigGroupNo,
  upsertBocFxLink,
  readBocFxLinkRowsForRematch,
  writeBocFxLinkGroupRematch
};
