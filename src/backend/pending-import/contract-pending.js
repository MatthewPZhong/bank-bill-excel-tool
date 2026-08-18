// 挂账 Pending 大表导入引擎契约模块（v3.0.4 块 B · PR-C · 🔴🔴 资金红线）
//
// 职责：把 pending 导入的「31 列契约 + 33 参 INSERT + 跨文件 sha 去重 + 6 表覆盖删除链 + 事务内月元数据收尾
//   + 空文件整批拒绝 + 行级错误 1000 上限带 cells」声明为引擎（big-table-import）可消费的契约，供
//   import-worker / engine require（路径 + contractOptions 可序列化）。
//   语义逐项 byte-for-byte 平移自现行 worker.js / month-repository.js 旧链路：
//     - expectedHeaders   ← pending-db/columns（31 列）
//     - validateHeaders   ← pending-import/validator.validateHeaders（纯函数，可 require）
//     - mapRow            ← worker.js 数据行处理：computeRowHash + createRowInserter 33 参（[yearMonth, rowHash, ...cells31]）
//     - insertSql         ← month-repository.createRowInserter 的 INSERT 语句逐字平移
//     - monthKeyOf        ← () => null（pending 行内无月份列，单月由 yearMonth 入参；引擎跨月校验旁路）
//     - deleteForOverwrite（E1）← month-repository.deleteMonth 6 条 SQL+参数+顺序逐字平移（🔴 R-1 红线顺序）
//     - finalizeForCommit（E2）← month-repository.upsertMonthMeta（与行 INSERT 同事务原子，R-3）
//     - rejectEmptyFiles + formatEmptyFileError（E3）← worker.js:148-151「文件为空或只有表头行」
//     - maxCollectedErrors:1000 + captureRowValues:true（E4）← worker.js:26/127
//     - dedupeKeyOf / formatDuplicateError（E5）← worker.js:118-132 跨文件 sha 去重 + 整批拒绝
//     - cellsOf（E5 cells 缺口补丁）← 写侧重复行错误从 33 参 params 逆推整行 cells（旧链路 worker.js:127 带 cells）
//
// 🔴 为何复制 SQL/逻辑而不 require 仓储（PR-H contract-flow 范式）：
//   回退路径（USE_BIG_TABLE_IMPORT_ENGINE_PENDING=false → worker.js → month-repository）必须保持
//   month-repository.js / worker.js 一字不改且仍被引用；契约模块独立平移其 SQL 与行变换逻辑，避免双向耦合。
//   任何对 deleteMonth 顺序 / createRowInserter 列序 / upsertMonthMeta 字段的修改都必须同步本文件
//   （已用 parity 集成脚本 pending-engine-migration.js byte-for-byte 锁死新旧两路一致）。
//
// 约束（引擎 worker require 安全性）：
//   - 仅 require pending-db/columns（纯常量）+ pending-import/validator（computeRowHash 纯函数，依赖链止于 crypto/columns）
//     ——均无 Electron / SQLite 依赖。
//   - 无模块级可变状态；yearMonth / archivePath / importedAt 等批级参数经 contractOptions（工厂入参）注入闭包，不读全局。

'use strict';

const PENDING_COLUMNS = require('../pending-db/columns');
const { freezePendingDatasetSeedV1 } = require('../pending-db/dataset-identity');
const { validateHeaders, computeRowHash } = require('./validator');

// 错误累积上限：与旧链路 worker.js MAX_ROW_ERRORS_EMITTED=1000 同口径（spec E4）。
const PENDING_MAX_COLLECTED_ERRORS = 1000;

// INSERT 语句逐字平移 month-repository.createRowInserter：
//   INSERT INTO pending_rows (year_month, row_hash, `col1`, ..., `col31`) VALUES (?, ?, ?...×31)
//   列序严格一致：year_month + row_hash + 31 列（反引号包裹中文列名）。
const PENDING_COL_LIST = PENDING_COLUMNS.map((c) => `\`${c}\``).join(', ');
const PENDING_PLACEHOLDERS = PENDING_COLUMNS.map(() => '?').join(', ');
const PENDING_INSERT_SQL =
  `INSERT INTO pending_rows (year_month, row_hash, ${PENDING_COL_LIST}) VALUES (?, ?, ${PENDING_PLACEHOLDERS})`;

// mapRow 与 dedupeKeyOf 共算一次 hash（spec：避免双算）。
//   import-worker 对每个数据行先后调 mapRow({values}) 与 dedupeKeyOf({values})，传入同一 values 引用。
//   用「上一次 values 引用 → hash」单条 memo：同一行两次调用复用，跨行（引用变化）自动失效重算。
//   纯函数语义不变（computeRowHash 仅依赖 cells 内容），仅省一次 sha1。
let lastHashValuesRef = null;
let lastHashValue = null;
function rowHashFor(values) {
  if (values === lastHashValuesRef && lastHashValue !== null) return lastHashValue;
  const h = computeRowHash(values);
  lastHashValuesRef = values;
  lastHashValue = h;
  return h;
}

// 契约工厂：contractOptions = { yearMonth, archivePath, importedAt }
//   - yearMonth：单月 key（UI 入参；mapRow 第 1 参 + INSERT year_month + deleteForOverwrite 条件 + 月元数据主键）
//   - archivePath：留底 xlsx 路径（session 在 dispatch 前算好；写进 pending_months.archive_path，可 null）
//   - importedAt：本批导入时间戳（写进 pending_months.imported_at；session 用 new Date().toISOString() 算好传入，
//                 与旧链路 upsertMonthMeta 内部现算等价——经闭包注入保证事务内收尾不依赖运行环境时钟）
//   返回引擎契约对象（schema 见 big-table-import/contract.js）。
function createContract(options = {}) {
  const opts = options || {};
  const yearMonth = opts.yearMonth != null ? String(opts.yearMonth) : '';
  const archivePath = opts.archivePath != null ? String(opts.archivePath) : null;
  const importedAt = opts.importedAt != null ? String(opts.importedAt) : '';
  const datasetSeed = freezePendingDatasetSeedV1(opts.datasetSeed);

  return {
    expectedHeaders: PENDING_COLUMNS,        // 31 列
    valueColumnWhitelist: null,              // 全列入库，无可裁（spec §4.2）
    requiredColumns: [],                     // mapRow 消费全部 31 列但不依赖单列索引校验；whitelist=null 时第 1 层防护旁路

    // 表头校验：复用 pending validator.validateHeaders（纯函数，返回 { ok } | { ok:false, error }）。
    //   引擎 import-worker 把 message 加 `${sourceFile}：` 前缀（与旧链路 worker.js 表头错文案
    //   `{ file: fileName, message: hdr.error }` 在 session 适配层还原对齐——见 pending-session 适配）。
    //
    //   F3（PR #71 SR）尾随多列截断对齐：引擎 row-scanner 表头行**全列收集不截断**（row-scanner.js:15/32），
    //     而旧链路 pending reader（streaming-xlsx-reader.parseRowXml）固定 `colCount=31`，colIdx>=31 的列被丢弃
    //     （streaming-xlsx-reader.js:64/76）——即「表头带尾随多列（如 33 列：31 正确 + 2 尾随空列，Excel 常见）」
    //     的文件，旧链路只见前 31 列 → validateHeaders 通过；新引擎全列传入 → validator.js:18 `length !== 31` 拒绝。
    //     这是「旧过新拒」回归。修法：契约包装层按 expectedHeaders.length（31）截断 cells 再交核心 validator——
    //     语义 = 旧 reader 的列丢弃，core 校验函数本体不动（validator.js 仍严格 31 列，被本包装层喂入恰好 31 列）。
    //   ⚠️ 仅 pending 同病同修：flow 旧 reader（reader-streamed.js:195-214）**不截断**、反而显式检测尾部多列并
    //     拒绝（「表头列数超出模板」）——故 contract-flow 不加截断（加了反破坏 flow 旧语义 byte-for-byte）。
    validateHeaders(cells) {
      const arr = Array.isArray(cells) ? cells : [];
      const truncated = arr.length > PENDING_COLUMNS.length ? arr.slice(0, PENDING_COLUMNS.length) : arr;
      return validateHeaders(truncated);
    },

    // monthKey：pending 行内无月份列，单月由 yearMonth 入参；引擎跨月校验旁路（monthKeyOf 返回 null
    //   ⇒ engine.js baseMonthKey 为 null 时整体跳过跨月分支，所有行入库不被跨月拦截）。
    monthKeyOf() {
      return null;
    },

    // 行变换：逐字平移 worker.js 数据行处理 + createRowInserter 33 参绑定。
    //   cells = 引擎解析出的整行 31 列字符串数组（whitelist=null ⇒ values 即全列）。
    //   rowHash = computeRowHash(cells)（与 dedupeKeyOf 共算一次，rowHashFor memo）。
    //   params 列序严格对齐 PENDING_INSERT_SQL：[year_month, row_hash, ...cells31]。
    //   ⚠️ 旧链路 createRowInserter 对 cells 长度做断言（必须 === 31）；引擎解析按 expectedHeaders 长度产出 31 列，
    //     此处不再重复断言（表头校验已保证列数；引擎 row-scanner 按 31 列归一），与 mapRow 三态契约一致。
    mapRow({ values }) {
      const rowHash = rowHashFor(values);
      const cells = values.slice();
      return { params: [yearMonth, rowHash, ...cells] };
    },

    insertSql: PENDING_INSERT_SQL,

    // ── E1 多语句覆盖删除：deleteMonth 6 条 SQL+参数+顺序逐字平移（🔴 R-1 Codex PR #55 Finding 1 红线）──
    //   顺序敏感：pending_removal_matches → diff_rows → diff_runs → removed_pending_rows → pending_rows → pending_months。
    //   参数形态：①②（pending_removal_matches / diff_rows 子查询）2 参 [yearMonth, yearMonth]；
    //            ③（diff_runs）2 参 [yearMonth, yearMonth]；④⑤⑥（removed/rows/months）1 参 [yearMonth]。
    //   对照 month-repository.js:77-93 逐字（含子查询 SELECT id FROM diff_runs WHERE upper_month=? OR lower_month=?）。
    deleteForOverwrite() {
      return [
        {
          sql: 'CREATE TEMP TABLE IF NOT EXISTS pending_month_head_guard (ok INTEGER NOT NULL CHECK (ok = 1))',
          params: []
        },
        {
          sql: 'DELETE FROM pending_month_head_guard',
          params: []
        },
        {
          sql: `INSERT INTO pending_month_head_guard (ok)
    SELECT CASE WHEN (
      (? IS NULL AND NOT EXISTS (
        SELECT 1 FROM pending_months WHERE year_month = ?
      )) OR (? IS NOT NULL AND EXISTS (
        SELECT 1 FROM pending_months
        WHERE year_month = ? AND dataset_id = ? AND dataset_version = ?
      ))
    ) THEN 1 ELSE 0 END`,
          params: [
            datasetSeed.expectedDatasetId,
            yearMonth,
            datasetSeed.expectedDatasetId,
            yearMonth,
            datasetSeed.expectedDatasetId,
            datasetSeed.expectedDatasetVersion
          ]
        },
        // 1) 先删 pending_removal_matches（依赖 diff_runs.id；必须在删 diff_runs 之前）
        {
          sql: `DELETE FROM pending_removal_matches WHERE run_id IN (
    SELECT id FROM diff_runs WHERE upper_month = ? OR lower_month = ?
  )`,
          params: [yearMonth, yearMonth]
        },
        // 2) 删该月相关 diff_rows（diff_rows.run_id 依赖 diff_runs.id，先删 rows）
        {
          sql: `DELETE FROM diff_rows WHERE run_id IN (
    SELECT id FROM diff_runs WHERE upper_month = ? OR lower_month = ?
  )`,
          params: [yearMonth, yearMonth]
        },
        // 3) 删该月 diff_runs
        {
          sql: 'DELETE FROM diff_runs WHERE upper_month = ? OR lower_month = ?',
          params: [yearMonth, yearMonth]
        },
        // 4) 删该月移除归档行（Codex PR #55 Finding 1：旧归档基于旧数据应失效）
        {
          sql: 'DELETE FROM removed_pending_rows WHERE year_month = ?',
          params: [yearMonth]
        },
        // 5) removed 行被覆盖删除时，其 dataset head 同事务删除，不能留下幽灵来源。
        {
          sql: 'DELETE FROM pending_removed_months WHERE year_month = ?',
          params: [yearMonth]
        },
        // 6) 删该月 pending 行
        {
          sql: 'DELETE FROM pending_rows WHERE year_month = ?',
          params: [yearMonth]
        },
        // 7) 删该月月元数据
        {
          sql: 'DELETE FROM pending_months WHERE year_month = ?',
          params: [yearMonth]
        }
      ];
    },

    // ── E2 事务内收尾：upsertMonthMeta（与行 INSERT 同事务原子，R-3 防有行无月元数据中间态）──
    //   SQL 逐字平移 month-repository.upsertMonthMeta：INSERT ... ON CONFLICT(year_month) DO UPDATE。
    //   rowCount = totalImported（引擎写入侧累计真实行数，经 finalizeForCommit 入参传入）。
    //   sourceFiles = 引擎传入的 sourceFiles（文件名数组；旧链路 files.map(basename)，引擎 finalizeForCommit
    //     入参 sourceFiles 已是 path.basename 结果，对齐）。
    //   archivePath / importedAt 经 contractOptions 闭包注入。
    finalizeForCommit({ totalImported, sourceFiles }) {
      const sf = Array.isArray(sourceFiles) ? sourceFiles : [];
      return [
        {
          sql: `INSERT INTO pending_months (
       year_month, imported_at, row_count, source_files, archive_path,
       dataset_id, producer_task_run_id, dataset_version, archive_contract_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(year_month) DO UPDATE SET
       imported_at = excluded.imported_at,
       row_count = excluded.row_count,
       source_files = excluded.source_files,
       archive_path = excluded.archive_path,
       dataset_id = excluded.dataset_id,
       producer_task_run_id = excluded.producer_task_run_id,
       dataset_version = excluded.dataset_version,
       archive_contract_version = excluded.archive_contract_version`,
          params: [
            yearMonth,
            importedAt,
            Number(totalImported) || 0,
            JSON.stringify(sf),
            archivePath || null,
            datasetSeed.datasetId,
            datasetSeed.producerTaskRunId,
            datasetSeed.expectedDatasetVersion + 1,
            1
          ]
        }
      ];
    },

    // ── E3 空文件整批拒绝 ──
    //   文案逐字平移 worker.js:148-151：旧链路是 `{ severity:'fatal', file: fileName, message:'文件为空或只有表头行' }`，
    //   引擎批级错误 message 加 `${sourceFile}：` 前缀（与表头错前缀一致）；session 适配层还原 file/message 分离。
    rejectEmptyFiles: true,
    formatEmptyFileError(sourceFile) {
      return `${sourceFile}：文件为空或只有表头行`;
    },

    // ── E4 行级错误捕获增强 ──
    maxCollectedErrors: PENDING_MAX_COLLECTED_ERRORS,   // 1000（旧链路同口径）
    captureRowValues: true,                             // 错误记录附整行 cells（报错 xlsx 需要）

    // ── E5 写侧跨文件去重 ──
    //   key = computeRowHash(cells)（与 mapRow rowHash 同源，rowHashFor memo 共算一次）。
    //   引擎 writer 维护 Set，命中 → 行级错误不 INSERT（旧链路 worker.js:119-130 同语义）。
    dedupeKeyOf({ values }) {
      return rowHashFor(values);
    },
    // 文案逐字平移 worker.js:126：`发现重复行（hash xxxxxxxx...）`（hash 取前 8 位 hex + '...'）。
    //   引擎 formatDuplicateError 入参 { key }，key 即 dedupeKeyOf 返回的完整 sha1 hex（40 字符）。
    formatDuplicateError({ key }) {
      const k = key == null ? '' : String(key);
      return `发现重复行（hash ${k.slice(0, 8)}...）`;
    },

    // ── E5 cells 缺口补丁：写侧重复行错误从 33 参 params 逆推整行 cells ──
    //   旧链路 worker.js:127 重复行错误带 `cells: cells.slice()`；引擎写侧 batch 项只有 params（拿不到原始 cells）。
    //   params = [year_month, row_hash, ...cells31] ⇒ cells = params.slice(2)（去掉前 2 个引擎补的 year_month/row_hash）。
    cellsOf({ params }) {
      if (!Array.isArray(params)) return [];
      return params.slice(2);   // 去 year_month + row_hash，余 31 列 cells
    },

    // 表头错 / 空文件错的对外错误类名（引擎据此设 error.name）。
    //   旧链路错误对象无 name 字段（均为 plain { severity, file, message }）；session 适配层不依赖 name，
    //   但引擎抛错时统一设此 name 便于识别，session 解析时只取 message/cells，不漂移。
    errorName: 'PendingImportValidationError'
  };
}

module.exports = {
  createContract,
  // 供单测 / parity 脚本直接驱动（不起 worker）。
  PENDING_INSERT_SQL,
  PENDING_MAX_COLLECTED_ERRORS
};
