// 通用大表导入引擎 — engine（入口编排）🔴🔴 资金红线（导入大事务 / 整批拒绝 / 跨月校验 / 覆盖导入 / checkpoint）
//
// 职责（spec §2.1 / §2.2 「import 主 worker 进程域」的可执行体 + §2.4 PRAGMA 第 5 处契约）：
//   importFiles({ db|dbPath, files, contractModulePath, contractOptions, mode, monthKey, parallel,
//     useWhitelist, onProgress, onLog }) →
//   1. validateContract 先行（三层白名单防护第 1 层；漏配必需列 → 拒绝启动，绝不带病运行）。
//   2. peek 预检：首文件首数据行 validateHeaders + monthKeyOf 提月份（跨月预检语义平移收单）。
//   3. 大事务：BEGIN → pipeline 多文件并行解析 + **按文件序单写** prepared INSERT（contract.insertSql）
//      → 错误累积（MAX_COLLECTED_ERRORS=100，超限或结束非空 → 整批 ROLLBACK 报错）
//      → 跨月校验（每行 monthKeyOf ≠ 入参/peek monthKey → 记错误）
//      → COMMIT → COMMIT 后 PRAGMA wal_checkpoint(TRUNCATE)（失败仅告警，对齐 acquiring W2）。
//   4. mode='overwrite'：事务内先按 contract.deleteSqlForOverwrite + 引擎参数 DELETE 再导。
//   5. DB 连接：接 db（外部 connection）直接用；接 dbPath 自开连接并按第 5 处 PRAGMA 契约执行 + verify。
//
// 拓扑落地形态（spec §2.2 注）：本 PR 的 engine.js 可在「import 主 worker 进程域」执行——
//   它持 DB（写循环）、调 pipeline 起解析子 worker（两级拓扑），自身**纯 Node 不依赖 Electron API**。
//   未来 PR-H 由主进程 dispatch（包一层 worker pool）拉起；engine-worker-entry.js 提供薄 worker 入口
//   让集成脚本以真实 worker 拓扑跑通全链。本 PR 不做主进程 dispatch 接线。
//
// 约束：本文件不得 require 任何业务模块；引擎自包含。

'use strict';

const path = require('node:path');
const { validateContract, ContractValidationError } = require('./contract');
const zipReader = require('./zip-reader');
const rowScanner = require('./row-scanner');
const pipeline = require('./pipeline');

const { CancelError, PipelineError } = pipeline;

// 错误累积上限默认值（spec §2.3）：与 import-worker / 收单同口径。
//   v3.0.4 PR-B E4：契约可声明 maxCollectedErrors 覆盖该默认值（如 pending/biz-op 用 1000）。
const MAX_COLLECTED_ERRORS = 100;

// ─────────────────────────────────────────────────────────────────
// PRAGMA 第 5 处契约（spec §2.4）—— 与 database.js / run-check-worker / run-check-multiworker-worker /
//   biz-op import-worker 完全一致的强制清单 + verify 映射（temp_store: 2）。将来要 grep 到此处对照。
//   清单顺序：foreign_keys → WAL → synchronous=NORMAL → cache_size=-65536 → mmap_size=268435456
//            → temp_store=MEMORY + busy_timeout 30s。
// ─────────────────────────────────────────────────────────────────
const PRAGMA_STATEMENTS = [
  'PRAGMA foreign_keys = ON;',
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA cache_size = -65536;',     // 64MB
  'PRAGMA mmap_size = 268435456;',   // 256MB
  'PRAGMA temp_store = MEMORY;',     // v3.0.3 块 D：临时表/排序驻内存（与主进程 PRAGMA 清单同步）
  'PRAGMA busy_timeout = 30000;'     // 30s —— 与主进程同库并发写时防 SQLITE_BUSY
];

// PRAGMA verify 预期值（与既有 4 处契约成员一致；temp_store=MEMORY 查询返回整数 2）。
const PRAGMA_EXPECTED = {
  foreign_keys: 1,
  journal_mode: 'wal',
  synchronous: 1,
  cache_size: -65536,
  mmap_size: 268435456,
  temp_store: 2,
  busy_timeout: 30000
};

// 自开 DB 连接（接 dbPath 时）：执行 PRAGMA 清单 + 严格 verify（fail-fast，对齐 run-check-worker 范式）。
function openDbWithPragma(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  for (const sql of PRAGMA_STATEMENTS) db.exec(sql);
  for (const name of Object.keys(PRAGMA_EXPECTED)) {
    const row = db.prepare(`PRAGMA ${name}`).get();
    const key = Object.keys(row)[0];
    const actual = row[key];
    const expected = PRAGMA_EXPECTED[name];
    const ok = typeof expected === 'string'
      ? String(actual).toLowerCase() === expected
      : Number(actual) === Number(expected);
    if (!ok) {
      try { db.close(); } catch (_e) { /* swallow */ }
      throw new PipelineError(`big-table-import PRAGMA verify 失败：${name} 期望 ${expected} 实际 ${actual}`);
    }
  }
  return db;
}

// peek 预检（不进事务，async）：打开首文件，扫到表头行 validateHeaders + 首个数据行 monthKeyOf 提月份后早退。
//   语义平移收单 peekMonthKeyFromFile + 表头校验：表头不合法 → 抛 BigTableImportError；
//   返回 { monthKey }（首个数据行的 monthKeyOf 结果；用于跨月预检/覆盖删除条件）。
//   ⚠️ 防呆归一（review 修复）：本函数是导出 API，外部调用方（如收单 session peekImportTarget）可能传
//     原始契约（valueColumnWhitelist 为数组）——row-scanner 要求 Set，未归一直接崩 `.has is not a function`。
//     importFiles 内部路径传入的已是 validateContract 归一产物（Set），instanceof 守卫下跳过、零重复开销。
async function peekFirstFile({ filePath, contract: rawContract }) {
  const wl = rawContract && rawContract.valueColumnWhitelist;
  const contract = (wl && !(wl instanceof Set)) ? validateContract(rawContract) : rawContract;
  try {
    return await peekFirstFileInner({ filePath, contract });
  } catch (err) {
    // errorName 下沉（review 修复）：本函数是导出 API，单独调用（收单 session peekImportTarget）时
    //   错误 name 也须与收单 reader peek 一致（契约 errorName='ImportValidationError'，smoke H3 锁 name 契约）；
    //   importFiles 调用路径外层的同款改名幂等不冲突。CancelError 不改名（取消语义独立）。
    if (err && err.name !== 'CancelError'
      && rawContract && rawContract.errorName && typeof rawContract.errorName === 'string') {
      err.name = rawContract.errorName;
    }
    throw err;
  }
}

async function peekFirstFileInner({ filePath, contract }) {
  const wb = await zipReader.openWorkbook(filePath);
  let headerError = null;
  let peekedMonthKey = null;
  try {
    const sharedStrings = await zipReader.loadSharedStrings(wb.zip, wb.sharedStringsEntry);
    let headerValidated = false;
    await new Promise((resolve, reject) => {
      wb.zip.openReadStream(wb.sheetEntry, (streamErr, stream) => {
        if (streamErr) return reject(streamErr);
        rowScanner.scanSheetRows({
          stream,
          expectedHeaders: contract.expectedHeaders,
          sharedStrings,
          // contract.valueColumnWhitelist 经 validateContract 已归一化为 Set；scanSheetRows 内部用 .has() → 传 Set。
          valueColumnWhitelist: contract.valueColumnWhitelist || null,
          onRow: ({ rowR, values, hasAnyCellText }) => {
            if (rowR === 1) {
              const hr = contract.validateHeaders(values.map((v) => (v == null ? '' : String(v))));
              if (!hr || !hr.ok) {
                // message 加 `${sourceFile}：` 前缀，与 import-worker 表头错 + 收单 reader peek/import byte-for-byte 一致。
                headerError = new zipReader.BigTableImportError(
                  `${wb.sourceFile}：${(hr && hr.error) ? hr.error : '表头校验失败'}`,
                  (hr && Array.isArray(hr.detailLines)) ? hr.detailLines : []
                );
                const stop = new Error('header invalid'); stop.__stopParsing = true; stop.__stopValue = null; throw stop;
              }
              headerValidated = true;
              return;
            }
            if (!hasAnyCellText) return;   // 空行跳过，继续找首个有效数据行
            if (!headerValidated) {
              headerError = new zipReader.BigTableImportError(`${wb.sourceFile}：xlsx 缺少表头行（r=1）`, []);
              const stop = new Error('missing header'); stop.__stopParsing = true; stop.__stopValue = null; throw stop;
            }
            // 首个数据行：提 monthKey 后早退（peek 只看首行）。
            const mk = contract.monthKeyOf({ values });
            peekedMonthKey = mk == null ? null : String(mk);
            const stop = new Error('peek done'); stop.__stopParsing = true; stop.__stopValue = '__PEEKED__'; throw stop;
          }
        }).then(resolve, reject);
      });
    });
  } finally {
    wb.close();
  }
  if (headerError) throw headerError;
  return { monthKey: peekedMonthKey };
}

// 安全 ROLLBACK（吞 "no active transaction"，对齐收单 safeRollback）。
function safeRollback(db) {
  try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
}

// 入口编排。
//   入参（spec §2.3 + 任务）：
//     db | dbPath          — 二选一；接 db 用外部 connection（caller 负责生命周期），接 dbPath 自开（本函数 close）
//     files               — string[] 文件绝对路径（写入顺序 = rowid 顺序契约）
//     contractModulePath  — 契约模块路径（pipeline 的解析子 worker require）
//     contractOptions     — 契约工厂入参（可序列化）
//     mode                — 'append'（默认）| 'overwrite'
//     monthKey            — 期望月份（跨月校验基准）；缺省时用 peek 出的首文件首行 monthKey
//     parallel            — 期望并行度（默认 min(4, cpus-2)，内存闸再降 1）
//     useWhitelist        — false 强制全列解码（byte-for-byte 对照组）；默认 true（契约白名单）
//     onProgress          — ({ sourceFile, importedCount }) 每 1w 行节流（对齐收单现状）
//     onLog               — ({ level, message }) 日志透传
//     cancelToken         — { cancelled } 可选；置位 → ROLLBACK 整批
//   返回 { monthKey, fileCount, totalImported, deletedCount(overwrite), maxParallel }。
async function importFiles({
  db: externalDb,
  dbPath,
  files,
  contractModulePath,
  contractOptions,
  mode = 'append',
  monthKey,
  parallel,
  useWhitelist,
  batchContext,
  onProgress,
  onLog,
  cancelToken
}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new PipelineError('importFiles：files 必须是非空数组');
  }
  if (!contractModulePath || typeof contractModulePath !== 'string') {
    throw new PipelineError('importFiles：contractModulePath 必填（可序列化的契约模块路径）');
  }
  if (mode !== 'append' && mode !== 'overwrite') {
    throw new PipelineError(`importFiles：mode 非法（${mode}），仅 'append' | 'overwrite'`);
  }

  // ── 第 1 层防护：validateContract 先行（漏配必需列 → 拒绝启动，绝不带病运行）──
  //   engine 侧也 require 一次契约做本地校验（peek 需要 validateHeaders/monthKeyOf 在主侧跑）。
  //   ⚠️ 这是引擎调用方提供的契约模块，主侧 require 合法（契约模块自身不 require 业务模块由其作者保证）。
  // eslint-disable-next-line global-require, import/no-dynamic-require
  let contractMod = require(contractModulePath);
  if (typeof contractMod === 'function') contractMod = contractMod(contractOptions || {});
  else if (contractMod && typeof contractMod.createContract === 'function') {
    contractMod = contractMod.createContract(contractOptions || {});
  }
  const contract = validateContract(contractMod);   // throw ContractValidationError 即拒绝启动

  // overwrite 模式必须声明删除范围（防误删全表）。
  //   v3.0.4 PR-B E1：多语句覆盖删除 deleteForOverwrite（函数）与单串 deleteSqlForOverwrite（string）互斥共存、
  //     函数式优先；两者皆缺才拒绝启动。
  const hasMultiDelete = typeof contractMod.deleteForOverwrite === 'function';
  const hasSingleDelete = typeof contractMod.deleteSqlForOverwrite === 'string' && contractMod.deleteSqlForOverwrite.length > 0;
  if (mode === 'overwrite' && !hasMultiDelete && !hasSingleDelete) {
    throw new ContractValidationError(
      "契约无效：mode='overwrite' 要求契约声明 deleteForOverwrite（多语句）或 deleteSqlForOverwrite（单串）",
      ['覆盖导入需明确删除范围，二者皆缺拒绝启动（防误删全表）']
    );
  }

  // ── DB 连接 ──
  let db = externalDb || null;
  let ownDb = false;
  if (!db) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new PipelineError('importFiles：必须提供 db（外部连接）或 dbPath（自开连接）');
    }
    db = openDbWithPragma(dbPath);   // 第 5 处 PRAGMA 契约
    ownDb = true;
  }

  try {
    // 取消快路径。
    if (cancelToken && cancelToken.cancelled) {
      throw new CancelError('导入已取消（importFiles 启动前）', { stage: 'before-start' });
    }

    // ── peek 预检（不进事务）：表头校验 + 提首文件首行 monthKey ──
    //   peek 阶段错误（表头错 / 缺表头 / zip 损坏）契约声明 errorName 时改 name（收单 → ImportValidationError），
    //   byte-for-byte 对齐收单 reader peek 抛 ImportValidationError；message/detailLines 已由 validateHeaders 同源保证。
    let peekedMonthKey = null;
    try {
      const peeked = await peekFirstFile({ filePath: files[0], contract });
      peekedMonthKey = peeked.monthKey;
    } catch (peekErr) {
      if (peekErr && peekErr.name !== 'CancelError'
        && contractMod.errorName && typeof contractMod.errorName === 'string') {
        peekErr.name = contractMod.errorName;
      }
      throw peekErr;
    }
    // 跨月基准：入参 monthKey 优先；否则用 peek 出的（与收单覆盖路径 detectedMonthKey 平移）。
    const baseMonthKey = monthKey || peekedMonthKey || null;

    // ── 大事务 ──
    // E4：错误样本上限（契约声明 maxCollectedErrors 覆盖默认 100；与 worker 侧同口径）。
    const maxErrors = (contract.maxCollectedErrors && contract.maxCollectedErrors > 0)
      ? contract.maxCollectedErrors : MAX_COLLECTED_ERRORS;
    // E3：空文件整批拒绝开关（worker parsed.importedCount===0 = 「文件为空或只有表头行」 ⇒ 批级错误）。
    //   ⚠️ per-file 语义：任一文件无数据行即拒（pending 旧链路 worker.js:148-151 逐文件判）。
    const rejectEmptyFiles = contract.rejectEmptyFiles === true;
    // F1（v3.0.4 PR #71 SR）：批级空数据整批拒绝开关（写循环结束后 totalImported===0 ⇒ 批级错误）。
    //   ⚠️ 与 E3 rejectEmptyFiles（per-file）语义区分：rejectEmptyBatch 是「批级全空才拒」（部分文件空不拒），
    //     对齐 flow 旧链路 import-worker.js:356-365「dataRowCount===0（跨所有文件总和）→ ROLLBACK」。
    //   🔴 必须由引擎在 COMMIT 前判：overwrite 模式事务头已 DELETE，若 session 事后判空文件返回 rejected，
    //     则删除已 COMMIT 而无新数据净入 = 数据丢失回归（biz-op flow 全空 overwrite 导入）。引擎置批级错误
    //     走既有整批 ROLLBACK 路径，DELETE 与 INSERT 在同一事务原子撤销，与 flow 旧链路数据净零变化 byte-for-byte。
    //   不声明 ⇒ 行为零变化（收单/pending 不声明）。
    const rejectEmptyBatch = contract.rejectEmptyBatch === true;
    // E5：写侧跨文件去重 Set（契约声明 dedupeKeyOf 时维护；命中 → 行级错误不 INSERT）。
    const hasDedupe = typeof contractMod.dedupeKeyOf === 'function';
    const seenDedupeKeys = hasDedupe ? new Set() : null;
    // E5 cells 缺口补丁：写侧行级错误（去重命中 / INSERT 失败）从 batch 项 params 逆推 cells，
    //   让 captureRowValues 时写侧行级错误也带原始整行 cells（pending 重复行报错 xlsx 需要，对齐旧链路 worker.js:127）。
    //   仅 captureRowValues 开启 + 契约声明 cellsOf 时启用；未声明 ⇒ 写侧行级错误不带 cells（行为零变化）。
    const captureRowValuesWrite = contract.captureRowValues === true;
    const cellsOfFn = (captureRowValuesWrite && typeof contractMod.cellsOf === 'function')
      ? contractMod.cellsOf : null;
    // 从 batch 项安全逆推 cells（cellsOf 抛错不应中断导入；失败 → 不带 cells，退化为现状）。
    const deriveCellsFromParams = (params) => {
      if (!cellsOfFn) return undefined;
      try {
        const c = cellsOfFn({ params });
        return Array.isArray(c) ? c : undefined;
      } catch (_e) {
        return undefined;
      }
    };

    let totalErrorTotal = 0;          // 全量行级错误数（跨文件累加，含截断前总数）
    const collectedErrors = [];       // 截断到 maxErrors 的错误样本
    const perFileErrorTotals = new Map(); // sourceFile → 行级错误总数（供契约 formatBatchError 精确计数，不受样本截断影响）
    let aborted = false;              // 整批拒绝标志（表头错 / 行级错 / 跨月 / 空文件 / 空批）
    let abortError = null;            // 整批拒绝时的首要错误（表头错优先抛原始 BigTableImportError）
    let emptyFileError = null;        // E3：空文件批级错误（{message, detailLines}），整批 ROLLBACK
    // F2（v3.0.4 PR #71 SR）：空文件 fatal 错误清单（收集**全部**空文件，非仅首个）。
    //   旧链路 pending worker.js:148-151 逐文件 push `{ severity:'fatal', file, message }` 与行级错误并列；
    //   引擎在此把每个空文件累积为 { file, message }，最终挂到 error.structuredImportErrors.fatalErrors，
    //   session restore 还原为旧形态 `{ severity:'fatal', file, message }` 条目与行级错误并列。
    //   ⚠️ rejectEmptyFiles 下，空文件不再短路 aborted（继续扫后续文件收集行级错误 + 其余空文件），
    //     整批拒绝由「fatalErrors 非空 || 行级错误」在写循环后统一判定。
    const fatalErrors = [];           // [{ file, message }]（空文件 / 系统错），整批 ROLLBACK
    let emptyBatchError = null;       // F1：批级空数据错误（{message, detailLines}），整批 ROLLBACK
    let deletedCount = 0;

    // 记一条行级错误：累加跨文件总数 + 按文件计数 + 截断样本（统一入口，保证 perFileErrorTotals 与 totalErrorTotal 同步）。
    //   E4：可附 cells（捕获增强；不传时记录形态与现状一致）。
    const recordRowError = (sourceFile, rowIndex, reason, cells) => {
      totalErrorTotal += 1;
      perFileErrorTotals.set(sourceFile, (perFileErrorTotals.get(sourceFile) || 0) + 1);
      if (collectedErrors.length < maxErrors) {
        const e = { sourceFile, rowIndex, reason };
        if (cells !== undefined) e.cells = cells;
        collectedErrors.push(e);
      }
    };

    db.exec('BEGIN');
    // prepared INSERT（contract.insertSql；列即存储契约）。事务内一次 prepare，百万次复用。
    const insertStmt = db.prepare(contract.insertSql);

    // overwrite：事务内先 DELETE。
    //   v3.0.4 PR-B E1：函数式 deleteForOverwrite(deleteKey)=>Array<{sql,params}> 优先（多语句、顺序敏感，
    //     如 pending 6 表覆盖删除链）——引擎大事务内按返回顺序逐条 prepare+run，deletedCount=各语句 changes 之和；
    //     否则回退既有单串 deleteSqlForOverwrite + deleteParamsFromMonthKey（缺省参数 [baseMonthKey]），行为一字不变。
    if (mode === 'overwrite') {
      try {
        if (typeof contractMod.deleteForOverwrite === 'function') {
          const stmts = contractMod.deleteForOverwrite(baseMonthKey);
          if (!Array.isArray(stmts)) {
            throw new Error('deleteForOverwrite 必须返回 Array<{sql,params}>');
          }
          for (const s of stmts) {
            if (!s || typeof s.sql !== 'string' || !s.sql) {
              throw new Error('deleteForOverwrite 返回项缺 sql 字符串');
            }
            const params = Array.isArray(s.params) ? s.params : [];
            const r = db.prepare(s.sql).run(...params);
            deletedCount += (r && Number.isFinite(r.changes)) ? r.changes : 0;
          }
        } else {
          const delParams = typeof contractMod.deleteParamsFromMonthKey === 'function'
            ? contractMod.deleteParamsFromMonthKey(baseMonthKey)
            : [baseMonthKey];
          const delResult = db.prepare(contractMod.deleteSqlForOverwrite).run(...delParams);
          deletedCount = delResult && Number.isFinite(delResult.changes) ? delResult.changes : 0;
        }
      } catch (delErr) {
        safeRollback(db);
        throw new PipelineError(`覆盖导入：DELETE 失败 — ${delErr && delErr.message ? delErr.message : String(delErr)}`, []);
      }
    }

    // onProgress 节流：worker 每 1w 行上报「该文件内 importedCount」；engine 维护跨文件累计后按 1w 节流对外。
    //   对外形状 { sourceFile, importedCount }（对齐收单 acquiring session）——importedCount = 全局累计已写入行数。
    let writtenTotal = 0;
    let lastReportedBucket = 0;

    // 写入回调（持 DB 的单写循环；pipeline 按文件序调用）。
    //   parsed = { batch, errors, importedCount, rowErrorTotal, truncated, monthKeys, headerError, sourceFile }
    //   🔴 整批拒绝语义平移收单：表头错/行级错/跨月 → 记标志，事务结束后统一 ROLLBACK（不在此 throw 半途，
    //     但需停止后续 INSERT；用 aborted 短路）。
    const writeBatch = (fileIndex, parsed) => {
      if (aborted) return;   // 已决整批拒绝 → 不再写（pipeline 会继续 drain 但本函数空转）

      // 表头错（解析子 worker 已判）→ 整批拒绝（保留原始 message + detailLines）。
      if (parsed.headerError) {
        aborted = true;
        abortError = new zipReader.BigTableImportError(
          parsed.headerError.message,
          Array.isArray(parsed.headerError.detailLines) ? parsed.headerError.detailLines : []
        );
        return;
      }

      // E3 空文件整批拒绝：表头合法但本文件无数据行（worker parsed.importedCount===0 = 「文件为空或只有表头行」，
      //   语义平移 pending worker.js:148-151）。契约声明 rejectEmptyFiles 时 → 批级错误（整批 ROLLBACK）。
      //   ⚠️ 必须用 parsed.importedCount（解析侧 mapRow 通过的数据行数），不能用「写入后行数」——
      //     后者会把「行全被去重/跨月拒绝」误判为空文件（那是行级错误路径，非空文件）。
      //   F2（PR #71 SR）：收集**全部**空文件（不短路 aborted）——旧链路 worker.js:148-151 逐文件 push fatal
      //     与行级错误并列；多个空文件应各出一条。本文件记一条空文件 fatal 后继续 return（无数据行无须再走 INSERT），
      //     后续文件继续扫描收集其余空文件 + 行级错误。整批拒绝由写循环后「fatalErrors 非空 || 行级错」统一判。
      if (rejectEmptyFiles && (parsed.importedCount || 0) === 0) {
        const msg = typeof contractMod.formatEmptyFileError === 'function'
          ? contractMod.formatEmptyFileError(parsed.sourceFile)
          : `${parsed.sourceFile}：文件为空或只有表头行`;
        fatalErrors.push({ file: parsed.sourceFile, message: msg });
        // 兼容既有抛错路径：emptyFileError 仍保留「首个空文件」消息（无行级错误时作主消息）。
        if (!emptyFileError) emptyFileError = { message: msg, detailLines: [] };
        return;
      }

      // 累积本文件 mapRow 阶段行级错误（worker 内已截断样本到 maxErrors，rowErrorTotal 是全量真实数）。
      //   ⚠️ perFileErrorTotals 加 rowErrorTotal（全量），样本仅前若干条 —— 否则 formatBatchError 的「N 行」会少算。
      if (parsed.rowErrorTotal > 0) {
        totalErrorTotal += parsed.rowErrorTotal;
        perFileErrorTotals.set(
          parsed.sourceFile,
          (perFileErrorTotals.get(parsed.sourceFile) || 0) + parsed.rowErrorTotal
        );
        for (const e of (parsed.errors || [])) {
          if (collectedErrors.length < maxErrors) {
            // E4：worker 错误记录带 cells 时透传（captureRowValues 声明），否则形态与现状一致。
            const ce = { sourceFile: parsed.sourceFile, rowIndex: e.rowIndex, reason: e.reason };
            if (e.cells !== undefined) ce.cells = e.cells;
            collectedErrors.push(ce);
          }
        }
      }

      // 跨月校验（每行 monthKeyOf ≠ baseMonthKey → 行级错误）+ E5 写侧去重 + 按文件序 INSERT。
      const batch = parsed.batch || [];
      const monthKeys = parsed.monthKeys || [];
      for (let r = 0; r < batch.length; r++) {
        const mk = monthKeys[r];
        // 🔴 行级错误行号用源 xlsx 真实行号 batch[r].rowR（不是 batch 内 0-based 索引 r）——
        //   对齐收单 reader 行级错误 `第 ${rowR} 行` 语义（byte-for-byte 命门）。
        const srcRowR = Number.isFinite(batch[r].rowR) ? batch[r].rowR : r;
        if (baseMonthKey && mk !== baseMonthKey) {
          recordRowError(parsed.sourceFile, srcRowR, `跨月份混杂：期望 ${baseMonthKey}，实际 ${mk}`);
          continue;   // 跨月行不入库
        }
        // E5 写侧跨文件去重（契约声明 dedupeKeyOf 时）：key 命中 Set → 行级错误不 INSERT；
        //   未命中 → add 后 INSERT。按文件序单写 ⇒ 与旧串行去重结果确定性一致。
        if (seenDedupeKeys) {
          const k = batch[r].dedupeKey;
          if (k != null && seenDedupeKeys.has(k)) {
            const msg = typeof contractMod.formatDuplicateError === 'function'
              ? contractMod.formatDuplicateError({ key: k })
              : `发现重复行（key ${k}）`;
            // E5 cells 缺口：captureRowValues + cellsOf 时附整行 cells（pending 报错 xlsx 需要）。
            recordRowError(parsed.sourceFile, srcRowR, msg, deriveCellsFromParams(batch[r].params));
            continue;   // 重复行不入库
          }
          if (k != null) seenDedupeKeys.add(k);
        }
        try {
          insertStmt.run(...batch[r].params);
        } catch (insErr) {
          // INSERT 失败（如 UNIQUE 冲突）→ 行级错误累积（语义平移收单 streamImportOneFile catch）。
          // E5 cells 缺口：captureRowValues + cellsOf 时附整行 cells（pending 报错 xlsx 需要）。
          recordRowError(
            parsed.sourceFile, srcRowR,
            insErr && insErr.message ? insErr.message : String(insErr),
            deriveCellsFromParams(batch[r].params)
          );
          continue;
        }
        writtenTotal += 1;
        // 每 1w 行节流对外 onProgress。
        if (typeof onProgress === 'function') {
          const bucket = Math.floor(writtenTotal / 10000);
          if (bucket > lastReportedBucket) {
            lastReportedBucket = bucket;
            try { onProgress({ sourceFile: parsed.sourceFile, importedCount: writtenTotal }); } catch (_e) { /* swallow */ }
          }
        }
      }

      // 错误累积达上限 → 提前置整批拒绝（与收单 maxErrors 早退等价；DB 写已发生的部分由 ROLLBACK 撤销）。
      if (collectedErrors.length >= maxErrors) {
        aborted = true;
      }
    };

    // 跑 pipeline（多文件并行解析 + 按文件序单写）。
    const controller = pipeline.runPipeline({
      files,
      contractModulePath,
      contractOptions,
      batchContext,
      useWhitelist,
      writeBatch,
      parallel,
      onProgress: null,    // 进度由 engine 在 writeBatch 内按全局累计节流（worker 的 per-file progress 不直接透传，避免回退）
      onLog,
      cancelToken
    });

    try {
      await controller.promise;
    } catch (pipeErr) {
      // pipeline 失败（cancel / worker 崩 / writeBatch 抛错）→ ROLLBACK 整批。
      safeRollback(db);
      throw pipeErr;
    }

    // F1（PR #71 SR）批级空数据整批拒绝：契约声明 rejectEmptyBatch 且写入总行数==0 → 批级错误（整批 ROLLBACK）。
    //   🔴 必须在 COMMIT 前判（此处仍在大事务内）：overwrite 模式事务头已 DELETE，若漏判则 DELETE 随空批 COMMIT
    //     = 数据丢失（flow 全空 overwrite 导入回归）。置 emptyBatchError 走下方既有整批 ROLLBACK 路径，
    //     DELETE 与（零行）INSERT 同事务原子撤销 = flow 旧链路 dataRowCount===0 → ROLLBACK 的数据净零变化。
    //   ⚠️ 仅当无其它整批拒绝原因（表头错/空文件/行级错）时才独立成因——若有行级错等更具体原因，按既有优先级抛。
    //   writtenTotal===0 含「全文件空」与「有数据行但全被跨月/去重拒绝（已计行级错走 formatBatchError）」两态；
    //     后者 totalErrorTotal>0 会优先走行级错误分支，emptyBatchError 仅在纯空批（无任何行级错）时生效。
    if (rejectEmptyBatch && writtenTotal === 0
      && !abortError && fatalErrors.length === 0 && totalErrorTotal === 0 && !emptyFileError) {
      const msg = typeof contractMod.formatEmptyBatchError === 'function'
        ? contractMod.formatEmptyBatchError()
        : '文件无有效数据行';
      emptyBatchError = { message: msg, detailLines: [] };
    }

    // 整批拒绝（表头错 / 行级错累计 / 跨月 / E3 空文件 / F2 fatalErrors / F1 空批）→ ROLLBACK + 报错（不入任何行）。
    if (aborted || collectedErrors.length > 0 || totalErrorTotal > 0
      || emptyFileError || fatalErrors.length > 0 || emptyBatchError) {
      safeRollback(db);
      // 结构化错误元数据（附到抛出的 error 上，供消费方按需还原行级错误形态）：
      //   v3.0.4 PR-C：pending session 需把引擎错误还原为现行 lastImportErrors 形态（severity/file/sheetRow/message/cells
      //   + rowErrorTotal/rowErrorTruncated）以驱动报错 xlsx 导出。引擎在此把样本截断后的 collectedErrors（可带 cells）
      //   + 真实总数 + 截断标志统一挂到 error.structuredImportErrors，纯附加字段——不读取者（如收单）完全无感。
      const rowErrorTruncated = totalErrorTotal > collectedErrors.length;
      // kind（PR #71 SR F2）：整批拒绝的**主要成因类别**，供 session restore 精确分流（不靠 collectedErrors 是否非空猜）。
      //   'header'（表头错） / 'emptyBatch'（F1 批级空） / 'emptyFile'（E3 空文件） / 'row'（行级错误）。
      //   多文件混批（一文件表头错 + 另一文件行级错）时：abortError 优先抛但 collectedErrors 非空，
      //   session 据 kind==='header' 保旧 status:'error'+detailLines 形态（不被行级 rejected 分支误降级）。
      const attachStructured = (err, kind) => {
        try {
          err.structuredImportErrors = {
            collectedErrors: collectedErrors.slice(),
            rowErrorTotal: totalErrorTotal,
            rowErrorTruncated,
            // F2（PR #71 SR）：空文件 / 系统级 fatal 错误清单（{file, message}），与行级错误并列还原。
            //   旧链路 pending worker.js:148-151 逐文件 fatal 与行级错误同 errors[] 数组；session restore 据此
            //   把 fatalErrors 还原为 `{severity:'fatal', file, message}` 条目与 row 级条目并列，不丢空文件信息。
            //   纯附加字段——不读取者（如收单/flow rejected 行级路径）完全无感。
            fatalErrors: fatalErrors.slice(),
            kind: kind || 'row'
          };
        } catch (_e) { /* swallow */ }
        return err;
      };
      if (abortError) {
        // 表头错优先抛原始 BigTableImportError（带 detailLines）；契约声明 errorName 时改 name
        //   （收单契约 errorName='ImportValidationError'，让 session/handler 既有错误识别零改动 + byte-for-byte）。
        if (contractMod.errorName && typeof contractMod.errorName === 'string') {
          abortError.name = contractMod.errorName;
        }
        throw attachStructured(abortError, 'header');
      }
      // F1（PR #71 SR）批级空数据错误（无表头错/空文件/行级错时——纯空批是整批拒绝原因；flow 全空 overwrite 路径）。
      if (emptyBatchError) {
        const err = new zipReader.BigTableImportError(
          emptyBatchError.message,
          Array.isArray(emptyBatchError.detailLines) ? emptyBatchError.detailLines : []
        );
        if (contractMod.errorName && typeof contractMod.errorName === 'string') err.name = contractMod.errorName;
        throw attachStructured(err, 'emptyBatch');
      }
      // E3 空文件批级错误（无行级错误时优先抛——空文件本身就是整批拒绝原因）。
      if (emptyFileError) {
        const err = new zipReader.BigTableImportError(
          emptyFileError.message,
          Array.isArray(emptyFileError.detailLines) ? emptyFileError.detailLines : []
        );
        if (contractMod.errorName && typeof contractMod.errorName === 'string') err.name = contractMod.errorName;
        throw attachStructured(err, 'emptyFile');
      }
      // 契约声明 formatBatchError → 由业务契约决定错误文案（message/detailLines/name），引擎保持通用不内联业务文案。
      //   收单契约据此产出 `${sourceFile}：导入失败 N 行（...）` + `第 N 行：reason`，byte-for-byte 平移 reader。
      if (typeof contractMod.formatBatchError === 'function') {
        const formatted = contractMod.formatBatchError({ collectedErrors, errorTotal: totalErrorTotal, perFileErrorTotals });
        const err = new zipReader.BigTableImportError(
          formatted && formatted.message ? formatted.message : `导入失败：${totalErrorTotal} 行存在错误，整批未导入`,
          formatted && Array.isArray(formatted.detailLines) ? formatted.detailLines : []
        );
        if (formatted && formatted.name) err.name = formatted.name;
        throw attachStructured(err);
      }
      // 引擎默认格式（无 formatBatchError 的契约，如集成测试契约）。
      const truncated = totalErrorTotal > collectedErrors.length;
      const detailLines = collectedErrors
        .slice(0, maxErrors)
        .map((e) => `[${e.sourceFile}] 第 ${e.rowIndex} 行：${e.reason}`);
      if (truncated) detailLines.push(`共 ${totalErrorTotal} 条错误，仅列前 ${collectedErrors.length} 条`);
      throw attachStructured(new zipReader.BigTableImportError(
        `导入失败：${totalErrorTotal} 行存在错误，整批未导入`,
        detailLines
      ));
    }

    // ── E2 事务内收尾（COMMIT 前）：契约声明 finalizeForCommit 时，在大事务内执行收尾语句（与行 INSERT 原子）。
    //   不暴露 db 句柄给契约——契约只返回 Array<{sql,params}>，引擎逐条 prepare+run。
    //   收尾失败 → ROLLBACK 整批（资金敏感：避免有行无月元数据中间态，spec R-3）。
    if (typeof contractMod.finalizeForCommit === 'function') {
      try {
        const sourceFiles = files.map((f) => path.basename(f));
        const stmts = contractMod.finalizeForCommit({ totalImported: writtenTotal, sourceFiles });
        if (!Array.isArray(stmts)) {
          throw new Error('finalizeForCommit 必须返回 Array<{sql,params}>');
        }
        for (const s of stmts) {
          if (!s || typeof s.sql !== 'string' || !s.sql) {
            throw new Error('finalizeForCommit 返回项缺 sql 字符串');
          }
          const params = Array.isArray(s.params) ? s.params : [];
          db.prepare(s.sql).run(...params);
        }
      } catch (finErr) {
        safeRollback(db);
        throw new PipelineError(`事务内收尾失败 — ${finErr && finErr.message ? finErr.message : String(finErr)}`, []);
      }
    }

    // ── COMMIT ──
    db.exec('COMMIT');

    // COMMIT 后 wal_checkpoint(TRUNCATE)（失败仅告警，对齐 acquiring W2）。
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (cpErr) {
      if (typeof onLog === 'function') {
        onLog({
          level: 'warning',
          message: '[big-table-import] wal_checkpoint 失败（不影响导入结果）',
          details: [cpErr && cpErr.message ? cpErr.message : String(cpErr)]
        });
      }
    }

    return {
      monthKey: baseMonthKey,
      fileCount: files.length,
      totalImported: writtenTotal,
      deletedCount,
      maxParallel: controller.maxParallel
    };
  } finally {
    if (ownDb) {
      try { db.close(); } catch (_e) { /* swallow */ }
    }
  }
}

module.exports = {
  importFiles,
  // 以下供单测 / engine-worker-entry / 集成脚本复用
  openDbWithPragma,
  peekFirstFile,
  PRAGMA_STATEMENTS,
  PRAGMA_EXPECTED,
  MAX_COLLECTED_ERRORS,
  CancelError,
  ContractValidationError
};
