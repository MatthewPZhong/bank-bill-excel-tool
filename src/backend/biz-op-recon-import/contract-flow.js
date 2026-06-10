// 业务OP对账 流水（flow）大表导入引擎契约模块（v3.0.4 块 C · PR-D · 🔴 资金红线）
//
// 职责：把 biz-op「流水侧」导入的「28 列契约 + 30 参 INSERT（data_date,row_index + 28 列）
//   + date 级覆盖删除（2 条 clear，跨所有 BU）+ 逐行 validateFlowRow（出入方向/对账金额/账户编号）
//   + 行级错误 1000 上限带 rawRow（报告 xlsx 需要）+ 多文件清一次后续累加」声明为引擎（big-table-import）
//   可消费的契约，供 import-worker / engine require（路径 + contractOptions 可序列化）。
//   语义逐项 byte-for-byte 平移自现行 import-worker.js runFlowImport / reader-streamed.js（流水侧）/
//   flow-imports-repository.js / run-repository.clearRunsAndDiffsByDate 旧链路：
//     - expectedHeaders   ← biz-op-recon-db/columns.FLOW_HEADERS（28 列模板原始表头）
//     - validateHeaders   ← biz-op-recon-import/validator.validateFlowHeaders（纯函数，可 require）
//     - mapRow            ← 流水侧数据行处理：reader-streamed normalizeCell 逐格归一 + validateFlowRow 三态行级校验
//                            + flow-imports-repository INSERT 30 参（[data_date, row_index, ...28 DB 列]）
//     - insertSql         ← flow-imports-repository.makeRowInserter 的 INSERT 语句逐字平移
//     - monthKeyOf        ← () => null（流水行内无月份列，单日由 date 入参；引擎跨月校验旁路）
//     - deleteForOverwrite（E1）← clearRunsAndDiffsByDate(date) + flow-imports clearByDate(date) 2 条 SQL 平移
//                            （参数=入参 date 闭包，与行内容无关；多文件「清一次后续累加」= 引擎事务头清一次天然达成）
//     - maxCollectedErrors:1000 + captureRowValues:true（E4）← import-worker DEFAULT_MAX_ROW_ERRORS=1000
//                            + 失败报告 writeFlowErrorReportXlsx 需 rawRow（经引擎 captureRowValues 取 values + session 适配回 DB 列）
//
// 🔴 为何复制 SQL/逻辑而不 require 仓储（PR-H contract-flow / PR-C contract-pending 范式）：
//   回退路径（USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW=false → import-worker.js → flow-imports-repository / run-repository）
//   必须保持旧链路一字不改且仍被引用；契约模块独立平移其 SQL 与行变换逻辑，避免双向耦合。
//   任何对 clearRunsAndDiffsByDate / clearByDate 顺序、flow INSERT 列序、validateFlowRow 的修改都必须同步本文件
//   （已用 parity 集成脚本 bizop-flow-engine-migration.js byte-for-byte 锁死新旧两路一致）。
//
// 🔵 whitelist 结论（spec §5.2「流水入库列消费面待核，保守先 null + useWhitelist 对照」）：
//   flow 旧链路 INSERT 全部 28 列入库（flow-imports-repository.INSERT_SQL 含全部 FLOW_DB_COLUMNS），
//   且下游 getRowsByDate / 对账 / 报告 writer（flowRowToArray 按全部 28 列）逐列消费——无任何「裁列」空间。
//   故 valueColumnWhitelist = null（全列入库），与 pending 同决策；无 useWhitelist 优化收益，不做对照变体。
//
// 🔵 行内 date 与入参 date 一致性校验结论（spec §5.2「调研未见、待核」）：
//   核实 import-worker.js runFlowImport（流水侧）+ reader-streamed.js + validator.validateFlowRow 全链——
//   流水侧**不存在**任何「行内日期列 == 入参 date」的一致性校验：
//     - validateFlowRow 只校验 direction / recon_amount / account_no 三项，无日期校验；
//     - reader-streamed 不读行内日期与 date 比对；
//     - INSERT 的 data_date 恒取入参 date（flow-imports-repository.makeRowInserter 第 1 参），行内 bill_date_raw
//       仅作普通数据列入库，不参与任何校验。
//   故 mapRow 不平移任何 date 一致性校验（旧链路无 → 引擎无，保持 byte-for-byte）。
//
// 约束（引擎 worker require 安全性）：
//   - 仅 require biz-op-recon-db/columns（纯常量）+ biz-op-recon-import/validator（validateFlowHeaders/validateFlowRow
//     纯函数，依赖链止于 columns）+ file-service/common.normalizeCell（纯函数，String(x).trim()）——均无 Electron / SQLite 依赖。
//   - 无模块级可变状态；date 等批级参数经 contractOptions（工厂入参）注入闭包，不读全局。

'use strict';

const {
  FLOW_HEADERS,
  FLOW_DB_COLUMNS
} = require('../biz-op-recon-db/columns');
const { validateFlowHeaders, validateFlowRow } = require('./validator');
const { normalizeCell } = require('../file-service/common');

// 错误累积上限：与旧链路 import-worker.js DEFAULT_MAX_ROW_ERRORS=1000 同口径（spec E4 / R-7）。
const FLOW_MAX_COLLECTED_ERRORS = 1000;

// 流水主表名（与 flow-imports-repository.TABLE 逐字一致）。
const FLOW_TABLE = 'biz_op_recon_flow_imports';

// INSERT 语句逐字平移 flow-imports-repository.buildInsertSql：
//   INSERT INTO biz_op_recon_flow_imports (data_date, row_index, <28 DB 列>) VALUES (?, ?, ?...×28)
//   列序严格一致：data_date + row_index + 28 列（snake_case DB 列名，不加反引号——与旧链路逐字相同）。
const FLOW_INSERT_COLS = ['data_date', 'row_index', ...FLOW_DB_COLUMNS].join(', ');
const FLOW_INSERT_PLACEHOLDERS = ['?', '?', ...FLOW_DB_COLUMNS.map(() => '?')].join(', ');
const FLOW_INSERT_SQL =
  `INSERT INTO ${FLOW_TABLE} (${FLOW_INSERT_COLS}) VALUES (${FLOW_INSERT_PLACEHOLDERS})`;

// reader-streamed 流水侧逐格映射：values（28 列原始 cell，表头序）→ DB 行对象（snake_case key），
//   每格经 normalizeCell（= String(x).trim()）归一——与 reader-streamed.js:220 `obj[dbColumns[i]] = normalizeCell(cells[i])`
//   逐字一致（旧链路在 reader 内 trim；引擎 row-scanner 取原值不 trim，故必须在 contract 侧补 trim 保 byte-for-byte）。
//   _rowIndex 取引擎传入的 rowR（Excel 真实行号，与 reader-streamed obj._rowIndex 同语义）。
function buildFlowDbRow(values, rowR) {
  const row = {};
  for (let i = 0; i < FLOW_DB_COLUMNS.length; i++) {
    row[FLOW_DB_COLUMNS[i]] = normalizeCell(values[i]);
  }
  row._rowIndex = rowR;
  return row;
}

// 契约工厂：contractOptions = { date }
//   - date：单日 key（UI 入参；INSERT data_date + deleteForOverwrite 条件）。流水不分 BU，按 date 级覆盖。
//   返回引擎契约对象（schema 见 big-table-import/contract.js）。
function createContract(options = {}) {
  const opts = options || {};
  const date = opts.date != null ? String(opts.date) : '';

  return {
    expectedHeaders: FLOW_HEADERS,           // 28 列
    valueColumnWhitelist: null,              // 全列入库，无可裁（见头部 whitelist 结论）
    requiredColumns: [],                     // mapRow 消费全部 28 列；whitelist=null 时第 1 层防护旁路（同 pending）

    // 表头校验：复用 validator.validateFlowHeaders（纯函数，返回 { ok } | { ok:false, error, detailLines }）。
    //   引擎 import-worker 把 message 加 `${sourceFile}：` 前缀；session 适配层还原对齐旧链路 header-error 形态。
    validateHeaders(cells) {
      return validateFlowHeaders(cells);
    },

    // monthKey：流水行内无月份列，单日由 date 入参；引擎跨月校验旁路（monthKeyOf 返回 null
    //   ⇒ engine.js baseMonthKey 为 null 时整体跳过跨月分支，所有行入库不被跨月拦截）。
    monthKeyOf() {
      return null;
    },

    // 行变换（三态）：逐字平移 reader-streamed 流水侧归一 + validateFlowRow + flow INSERT 30 参绑定。
    //   values = 引擎解析出的整行 28 列字符串数组（whitelist=null ⇒ values 即全列，表头序，未 trim）。
    //   ① 逐格 normalizeCell 归一 → DB 行对象（snake_case key + _rowIndex=rowR）——对齐 reader-streamed 输出。
    //   ② validateFlowRow（出入方向严格∈{入,出} / 对账金额数值 / 账户编号非空）：
    //        不过 → 返回 { error: { rowIndex, reason } }（三态行级错误；reason 逐字平移 validator）。
    //   ③ 过 → 返回 { params: [date, row_index, ...28 DB 列值] }，列序严格对齐 FLOW_INSERT_SQL。
    //   ⚠️ 多文件来源文件名前缀（旧链路 multiFile 时 reason 加 `[sourceFile] `）由引擎/session 适配层处理：
    //      引擎对每个 sourceFile 独立解析，行级错误 reason 不含文件名前缀；session 还原错误时不再补前缀，
    //      改由错误记录的 sourceFile 字段承载文件定位（与 pending 同适配策略）。parity 脚本据此对齐两路文案。
    mapRow({ rowR, values }) {
      const dbRow = buildFlowDbRow(values, rowR);
      const result = validateFlowRow(dbRow);
      if (!result.ok) {
        return { error: { rowIndex: rowR, reason: result.reason } };
      }
      // INSERT 参数：data_date=date + row_index=_rowIndex + 28 DB 列（null→'' 已由 normalizeCell 归一为字符串）。
      const params = [date, dbRow._rowIndex == null ? 0 : dbRow._rowIndex];
      for (const col of FLOW_DB_COLUMNS) {
        params.push(dbRow[col] == null ? '' : String(dbRow[col]));
      }
      return { params };
    },

    insertSql: FLOW_INSERT_SQL,

    // ── E1 多语句覆盖删除：flow date 级 clear 2 条 SQL+参数平移（跨所有 BU，与行内容无关）──
    //   逐字平移旧链路 runFlowImport「首个数据行事务内 clear」：
    //     1) run-repository.clearRunsAndDiffsByDate(date)：先删 diff_rows（run_id IN 该 date 的 runs），再删 runs；
    //     2) flow-imports-repository.clearByDate(date)：删 biz_op_recon_flow_imports 该 date 全部行。
    //   🔴 顺序敏感：必须先清 runs/diff_rows（依赖旧流水算出的对账结果失效），再清流水主表（与旧链路调用序一致）。
    //   多文件「清一次后续累加」语义 = 引擎在大事务头执行一次 deleteForOverwrite（mode='overwrite'），
    //   后续所有文件的行在同一事务内累加 INSERT，不再 clear——与旧链路 `cleared` 函数级单次 clear byte-for-byte 等价。
    deleteForOverwrite() {
      return [
        // 1a) 先删该 date 的 diff_rows（run_id IN 该 date 的 runs；FK 顺序，先 rows 后 runs）
        {
          sql: `DELETE FROM biz_op_recon_diff_rows
    WHERE run_id IN (
      SELECT id FROM biz_op_recon_runs
      WHERE data_date = ?
    )`,
          params: [date]
        },
        // 1b) 删该 date 的 runs（跨所有 BU；旧 run 的对账结果基于旧流水，重导后失效）
        {
          sql: `DELETE FROM biz_op_recon_runs
    WHERE data_date = ?`,
          params: [date]
        },
        // 2) 删该 date 的流水主表行（flow-imports clearByDate）
        {
          sql: `DELETE FROM ${FLOW_TABLE} WHERE data_date = ?`,
          params: [date]
        }
      ];
    },

    // ── E4 行级错误捕获增强 ──
    maxCollectedErrors: FLOW_MAX_COLLECTED_ERRORS,   // 1000（旧链路同口径）
    captureRowValues: true,                          // 错误记录附整行 cells（失败报告 xlsx 需要 rawRow）

    // ── E4 cells 缺口补丁：写侧 INSERT 失败错误从 30 参 params 逆推整行 28 列 cells ──
    //   flow 无跨文件去重（E5 不声明）；唯一可能的写侧行级错误是 INSERT 抛错（NOT NULL 等，理论上被 validateFlowRow 前置拦截）。
    //   引擎写侧 batch 项只有 params（拿不到原始 cells）；若 INSERT 失败需带 cells 入报告，从 params 逆推：
    //     params = [data_date, row_index, ...28 列] ⇒ cells = params.slice(2)（去 data_date/row_index，余 28 列）。
    //   返回的 cells 是「表头序的 28 列归一值」，与 mapRow 阶段 values 经 normalizeCell 后的列值一致——
    //   session 适配层据此重建 rawRow（按 FLOW_DB_COLUMNS 配对）供 writeFlowErrorReportXlsx。
    cellsOf({ params }) {
      if (!Array.isArray(params)) return [];
      return params.slice(2);   // 去 data_date + row_index，余 28 列 cells
    },

    // 表头错的对外错误类名（引擎据此设 error.name）；session 适配层只取 message/detailLines，不依赖 name。
    errorName: 'BizOpFlowImportValidationError'
  };
}

module.exports = {
  createContract,
  // 供单测 / parity 脚本直接驱动（不起 worker）。
  FLOW_INSERT_SQL,
  FLOW_MAX_COLLECTED_ERRORS,
  buildFlowDbRow
};
