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

const { validateContract, ContractValidationError } = require('./contract');
const zipReader = require('./zip-reader');
const rowScanner = require('./row-scanner');
const pipeline = require('./pipeline');

const { CancelError, PipelineError } = pipeline;

// 错误累积上限（spec §2.3）：与 import-worker / 收单同口径。
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

  // overwrite 模式必须声明删除语句（防误删全表）。
  if (mode === 'overwrite' && (!contractMod.deleteSqlForOverwrite || typeof contractMod.deleteSqlForOverwrite !== 'string')) {
    throw new ContractValidationError(
      "契约无效：mode='overwrite' 要求契约声明 deleteSqlForOverwrite（覆盖删除语句）",
      ['覆盖导入需明确删除范围，缺 deleteSqlForOverwrite 拒绝启动（防误删全表）']
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
    let totalErrorTotal = 0;          // 全量行级错误数（跨文件累加，含截断前总数）
    const collectedErrors = [];       // 截断到 MAX_COLLECTED_ERRORS 的错误样本
    const perFileErrorTotals = new Map(); // sourceFile → 行级错误总数（供契约 formatBatchError 精确计数，不受样本截断影响）
    let aborted = false;              // 整批拒绝标志（表头错 / 行级错 / 跨月）
    let abortError = null;            // 整批拒绝时的首要错误（表头错优先抛原始 BigTableImportError）
    let deletedCount = 0;

    // 记一条行级错误：累加跨文件总数 + 按文件计数 + 截断样本（统一入口，保证 perFileErrorTotals 与 totalErrorTotal 同步）。
    const recordRowError = (sourceFile, rowIndex, reason) => {
      totalErrorTotal += 1;
      perFileErrorTotals.set(sourceFile, (perFileErrorTotals.get(sourceFile) || 0) + 1);
      if (collectedErrors.length < MAX_COLLECTED_ERRORS) {
        collectedErrors.push({ sourceFile, rowIndex, reason });
      }
    };

    db.exec('BEGIN');
    // prepared INSERT（contract.insertSql；列即存储契约）。事务内一次 prepare，百万次复用。
    const insertStmt = db.prepare(contract.insertSql);

    // overwrite：事务内先 DELETE（contract.deleteSqlForOverwrite + 引擎参数）。
    //   删除参数约定：[baseMonthKey]（覆盖删除按月份；契约 deleteSqlForOverwrite 用 ? 占位 month_key）。
    //   契约可声明 deleteParamsFromMonthKey(monthKey)=>[...] 自定义参数；缺省用 [baseMonthKey]。
    if (mode === 'overwrite') {
      try {
        const delParams = typeof contractMod.deleteParamsFromMonthKey === 'function'
          ? contractMod.deleteParamsFromMonthKey(baseMonthKey)
          : [baseMonthKey];
        const delResult = db.prepare(contractMod.deleteSqlForOverwrite).run(...delParams);
        deletedCount = delResult && Number.isFinite(delResult.changes) ? delResult.changes : 0;
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

      // 累积本文件 mapRow 阶段行级错误（worker 内已截断样本到 100，rowErrorTotal 是全量真实数）。
      //   ⚠️ perFileErrorTotals 加 rowErrorTotal（全量），样本仅前若干条 —— 否则 formatBatchError 的「N 行」会少算。
      if (parsed.rowErrorTotal > 0) {
        totalErrorTotal += parsed.rowErrorTotal;
        perFileErrorTotals.set(
          parsed.sourceFile,
          (perFileErrorTotals.get(parsed.sourceFile) || 0) + parsed.rowErrorTotal
        );
        for (const e of (parsed.errors || [])) {
          if (collectedErrors.length < MAX_COLLECTED_ERRORS) {
            collectedErrors.push({ sourceFile: parsed.sourceFile, rowIndex: e.rowIndex, reason: e.reason });
          }
        }
      }

      // 跨月校验（每行 monthKeyOf ≠ baseMonthKey → 行级错误）+ 按文件序 INSERT。
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
        try {
          insertStmt.run(...batch[r].params);
        } catch (insErr) {
          // INSERT 失败（如 UNIQUE 冲突）→ 行级错误累积（语义平移收单 streamImportOneFile catch）。
          recordRowError(parsed.sourceFile, srcRowR, insErr && insErr.message ? insErr.message : String(insErr));
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

      // 错误累积达上限 → 提前置整批拒绝（与收单 MAX_COLLECTED_ERRORS 早退等价；DB 写已发生的部分由 ROLLBACK 撤销）。
      if (collectedErrors.length >= MAX_COLLECTED_ERRORS) {
        aborted = true;
      }
    };

    // 跑 pipeline（多文件并行解析 + 按文件序单写）。
    const controller = pipeline.runPipeline({
      files,
      contractModulePath,
      contractOptions,
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

    // 整批拒绝（表头错 / 行级错累计 / 跨月）→ ROLLBACK + 报错（不入任何行）。
    if (aborted || collectedErrors.length > 0 || totalErrorTotal > 0) {
      safeRollback(db);
      if (abortError) {
        // 表头错优先抛原始 BigTableImportError（带 detailLines）；契约声明 errorName 时改 name
        //   （收单契约 errorName='ImportValidationError'，让 session/handler 既有错误识别零改动 + byte-for-byte）。
        if (contractMod.errorName && typeof contractMod.errorName === 'string') {
          abortError.name = contractMod.errorName;
        }
        throw abortError;
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
        throw err;
      }
      // 引擎默认格式（无 formatBatchError 的契约，如集成测试契约）。
      const truncated = totalErrorTotal > collectedErrors.length;
      const detailLines = collectedErrors
        .slice(0, MAX_COLLECTED_ERRORS)
        .map((e) => `[${e.sourceFile}] 第 ${e.rowIndex} 行：${e.reason}`);
      if (truncated) detailLines.push(`共 ${totalErrorTotal} 条错误，仅列前 ${collectedErrors.length} 条`);
      throw new zipReader.BigTableImportError(
        `导入失败：${totalErrorTotal} 行存在错误，整批未导入`,
        detailLines
      );
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
