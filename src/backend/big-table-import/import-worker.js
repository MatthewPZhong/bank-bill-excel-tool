// 通用大表导入引擎 — import-worker（解析子 worker · worker_threads 入口）🔴 资金红线相关（行变换产物入库前）
//
// 职责（spec §2.1 / §2.2 拓扑「解析子 worker ×N」）：
//   单文件「解析 + 契约行变换」纯 CPU 工作，**不碰任何 DB**。
//   收 init 消息（contractModulePath + contractOptions + valueColumnWhitelist 模式开关）→ require 契约模块
//   → zip-reader.openWorkbook 打开 xlsx → loadSharedStrings → row-scanner.scanSheetRows 单遍扫描
//   → 表头行 validateHeaders 校验、数据行逐行 contract.mapRow 变换（skip/error/params 三态）
//   → 产出「行批（{ params } 数组）+ 错误列表」回传上游（持 DB 的 pipeline/engine 侧）。
//
// 进程边界（与 run-check-worker.js / biz-op import-worker.js 一致）：
//   - 不访问 Electron API（app / dialog / BrowserWindow / Notification）；纯 Node。
//   - 不碰 DB（INSERT 由持 DB 的 pipeline 单写循环做，保「按文件序单写」=rowid 顺序契约）。
//   - 错误对象跨线程用 serialize-error.js（与 run-check-worker 同一套；保 detailLines / code / name）。
//
// Message 协议（worker_threads，postMessage 结构化克隆）：
//   主 → worker：
//     { type:'parse', jobId, fileIndex, filePath, contractModulePath, contractOptions,
//       useWhitelist }                       // useWhitelist=false 时强制 whitelist=null（全列解码）
//   worker → 主：
//     { type:'progress', jobId, fileIndex, importedCount }          // 每 1w 行节流（rowCount 视角）
//     { type:'parsed', jobId, fileIndex, batch:[{params}], errors:[{rowIndex,reason}],
//       importedCount, rowErrorTotal, truncated, monthKeys:[...],   // monthKeys=每行 monthKeyOf 结果（跨月校验上交 engine 做）
//       headerError:null|{message,detailLines} }
//     { type:'parse-error', jobId, fileIndex, error: serialized }    // 系统级失败（zip 损坏 / 契约模块加载失败等）
//
// 🔴 跨月校验 / 整批 ROLLBACK 决策不在本 worker 做——本 worker 只「解析 + 行变换 + 收集本文件错误 + 每行 monthKey」，
//    把判定权交给持 DB 的 engine（它要按文件序、跨所有文件做整批拒绝与跨月一致性，单文件 worker 看不到全局）。
//
// 约束：本文件不得 require 任何业务模块（收单/biz-op/pending/vcc 等），引擎自包含。

'use strict';

const path = require('node:path');
const { parentPort, isMainThread } = require('node:worker_threads');

const zipReader = require('./zip-reader');
const rowScanner = require('./row-scanner');
const { validateContract } = require('./contract');

// 错误累积上限（spec §2.3）：与收单 reader-handrolled / biz-op worker 同口径，防百万级行级错误撑爆消息体。
const MAX_COLLECTED_ERRORS = 100;

// 单文件解析（纯函数，便于单测在主线程直接驱动，不必起 worker）。
//   入参：
//     filePath              — xlsx 绝对路径
//     contract              — 已 validateContract 归一化的契约（{ expectedHeaders, valueColumnWhitelist(Set|null),
//                              requiredColumns, validateHeaders, mapRow, insertSql, monthKeyOf, ... }）
//     useWhitelist          — false 时强制全列解码（whitelist=null，byte-for-byte 对照组用）；true 用契约白名单
//     onProgress            — ({ importedCount }) 每 1w 有效行回调（节流由本函数做）
//   返回 { batch:[{params}], errors:[{rowIndex,reason}], importedCount, rowErrorTotal, truncated,
//          monthKeys:[...], headerError:null|{message,detailLines} }
//
//   语义平移自收单 streamImportOneFile（逐项对齐，见各分支注释）：
//     ① 表头行（rowR===1）：全列收集后 validateHeaders；不 ok → headerError（engine 据此整批拒绝），停止解析。
//     ② 缺表头行：首个数据行到来前 headerValidated 仍 false → 视作「xlsx 缺少表头行」错误。
//     ③ 空行（!hasAnyCellText）：静默跳过（不计 importedCount、不进 batch）。
//     ④ 数据行：contract.mapRow({ rowR, values, ctx }) → { params } 入 batch + monthKeyOf 入 monthKeys；
//        { skip:true } 跳过；{ error } 累积（达上限早退）。
//     ⑤ monthKey 提取由 contract.monthKeyOf 做；跨月一致性「不在此」判（engine 做全局判定）。
async function parseFile({ filePath, contract, useWhitelist, onProgress }) {
  const sourceFile = path.basename(filePath);
  // 逐行行变换上下文（spec §2.3 ctx）：本文件固定的 sourceFile（mapRow 据此填 INSERT source_file 列）。
  //   逐文件动态 → 不能走 contractOptions（contractOptions 全批共享，无法承载逐文件值）。
  const ctx = { sourceFile };
  const expectedHeaders = contract.expectedHeaders;
  const valueColumnWhitelist = useWhitelist ? (contract.valueColumnWhitelist || null) : null;

  const batch = [];
  const errors = [];
  const monthKeys = [];
  let importedCount = 0;
  let rowErrorTotal = 0;
  let headerValidated = false;
  let headerError = null;

  const wb = await zipReader.openWorkbook(filePath);
  try {
    const sharedStrings = await zipReader.loadSharedStrings(wb.zip, wb.sharedStringsEntry);

    await new Promise((resolve, reject) => {
      wb.zip.openReadStream(wb.sheetEntry, (streamErr, stream) => {
        if (streamErr) return reject(streamErr);
        rowScanner.scanSheetRows({
          stream,
          expectedHeaders,
          sharedStrings,
          // whitelist：Set|null（contract.valueColumnWhitelist 经 validateContract 已归一化为 Set；
          //   scanSheetRows 内部用 .has() → 必须传 Set，不可转数组）。
          valueColumnWhitelist,
          onRow: ({ rowR, values, hasAnyCellText }) => {
            // ① 表头行：全列收集 → validateHeaders（不截断到 expectedHeaders.length，让 validator 检测「列多」）。
            if (rowR === 1) {
              const headerCells = values.map((v) => (v == null ? '' : String(v)));
              const hr = contract.validateHeaders(headerCells);
              if (!hr || !hr.ok) {
                // message 加 `${sourceFile}：` 前缀，与「缺表头行」分支 + 收单 reader streamImportOneFile
                //   `${sourceFile}：${headerResult.error}` byte-for-byte 一致（contract.validateHeaders 返回的
                //   error 是纯错误描述，不含文件名）。对所有模块均为合理定位信息。
                headerError = {
                  message: `${sourceFile}：${(hr && hr.error) ? hr.error : '表头校验失败'}`,
                  detailLines: (hr && Array.isArray(hr.detailLines)) ? hr.detailLines : []
                };
                // 停止解析（peek 早退范式）：抛 __stopParsing，scanSheetRows resolve(__stopValue)。
                const stopErr = new Error('header invalid');
                stopErr.__stopParsing = true;
                stopErr.__stopValue = '__HEADER_ERROR__';
                throw stopErr;
              }
              headerValidated = true;
              return;
            }

            // ② 缺表头行：首个数据行到来前未通过表头校验。
            if (!headerValidated) {
              headerError = {
                message: `${sourceFile}：第 ${rowR} 行：xlsx 缺少表头行（r=1）`,
                detailLines: []
              };
              const stopErr = new Error('missing header');
              stopErr.__stopParsing = true;
              stopErr.__stopValue = '__HEADER_ERROR__';
              throw stopErr;
            }

            // ③ 空行：静默跳过（与收单 allEmpty=!hasAnyCellText 等价）。
            if (!hasAnyCellText) return;

            // ④ 数据行：契约行变换。
            //   ctx（spec §2.3）：逐文件动态上下文（sourceFile 逐文件不同，不能走 contractOptions）。
            //   收单契约 mapRow 用 ctx.sourceFile 填 INSERT 的 source_file 列（byte-for-byte 对齐 insertFlowRow/insertBillRow）。
            let mapped;
            try {
              mapped = contract.mapRow({ rowR, values, ctx });
            } catch (mapErr) {
              rowErrorTotal += 1;
              recordError(errors, { rowIndex: rowR, reason: mapErr && mapErr.message ? mapErr.message : String(mapErr) });
              if (errors.length >= MAX_COLLECTED_ERRORS) throwErrorsLimit();
              return;
            }
            if (mapped && mapped.skip) return;
            if (mapped && mapped.error) {
              rowErrorTotal += 1;
              const e = mapped.error;
              recordError(errors, {
                rowIndex: Number.isFinite(e.rowIndex) ? e.rowIndex : rowR,
                reason: e.reason || '行校验失败'
              });
              if (errors.length >= MAX_COLLECTED_ERRORS) throwErrorsLimit();
              return;
            }
            if (!mapped || !Array.isArray(mapped.params)) {
              // 契约 mapRow 返回非法形态（既非 skip/error 也无 params）→ 当行级错误（防静默丢数据）。
              rowErrorTotal += 1;
              recordError(errors, { rowIndex: rowR, reason: 'mapRow 返回值非法（缺 params/skip/error）' });
              if (errors.length >= MAX_COLLECTED_ERRORS) throwErrorsLimit();
              return;
            }

            // ⑤ monthKey 提取（跨月一致性由 engine 全局判）。
            const monthKey = contract.monthKeyOf({ values });
            // batch 带源 xlsx 真实行号 rowR：engine 写入侧 INSERT 失败 / 跨月校验的行级错误行号据此对齐
            //   收单 reader `第 ${rowR} 行` 语义（不能用 batch 内 0-based 索引）。
            batch.push({ params: mapped.params, rowR });
            monthKeys.push(monthKey == null ? null : String(monthKey));
            importedCount += 1;
            if (onProgress && importedCount % 10000 === 0) {
              onProgress({ importedCount });
            }
          }
        }).then(resolve, reject);
      });
    });
  } finally {
    wb.close();
  }

  return {
    batch,
    errors,
    importedCount,
    rowErrorTotal,
    truncated: rowErrorTotal > errors.length,
    monthKeys,
    headerError
  };
}

// 累积行级错误：只保留前 MAX_COLLECTED_ERRORS 条（rowErrorTotal 仍计全量）。
function recordError(errors, entry) {
  if (errors.length < MAX_COLLECTED_ERRORS) errors.push(entry);
}

// 达错误上限 → 抛 __stopParsing 早退（scanSheetRows 停 stream + resolve）。
function throwErrorsLimit() {
  const stopErr = new Error('errors limit reached');
  stopErr.__stopParsing = true;
  stopErr.__stopValue = '__ERRORS_LIMIT__';
  throw stopErr;
}

// ─────────────────────────────────────────────────────────────────
// worker-only 副作用：仅 isMainThread=false 时执行（避免单测主线程 require 时启动消息循环）。
// ─────────────────────────────────────────────────────────────────
if (!isMainThread && parentPort) {
  // 静默 SQLite ExperimentalWarning（与 run-check-worker 一致；本 worker 虽不用 sqlite，统一防御）。
  process.on('warning', (warning) => {
    try {
      const name = warning && warning.name ? String(warning.name) : '';
      const msg = warning && warning.message ? String(warning.message) : '';
      if (name === 'ExperimentalWarning' && (msg.includes('SQLite') || msg.includes('node:sqlite'))) return;
      process.stderr.write(`(node:big-table-import-worker) ${name}: ${msg}\n`);
    } catch (_e) { /* swallow */ }
  });

  // 错误序列化复用生产 serialize-error.js（保 detailLines / code / name 跨线程）。
  //   ⚠️ 引擎不得 require 业务模块；serialize-error.js 是 main-process 通用工具（无业务依赖），可复用。
  let serializeError;
  try {
    serializeError = require('../../main-process/serialize-error').serializeError;
  } catch (_e) {
    serializeError = function fallback(err) {
      if (!err) return null;
      return {
        name: err.name || 'Error',
        message: err.message || String(err),
        stack: err.stack || null,
        code: err.code != null ? String(err.code) : null,
        detailLines: Array.isArray(err.detailLines) ? err.detailLines.slice() : null
      };
    };
  }

  parentPort.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object' || msg.type !== 'parse') return;
    const { jobId, fileIndex, filePath, contractModulePath, contractOptions, useWhitelist } = msg;
    try {
      // require 契约模块（必须可序列化定位：路径 + options）。模块导出可为对象或 (options)=>对象 工厂。
      // eslint-disable-next-line global-require, import/no-dynamic-require
      let contractMod = require(contractModulePath);
      if (typeof contractMod === 'function') contractMod = contractMod(contractOptions || {});
      else if (contractMod && typeof contractMod.createContract === 'function') {
        contractMod = contractMod.createContract(contractOptions || {});
      }
      const contract = validateContract(contractMod);

      const result = await parseFile({
        filePath,
        contract,
        useWhitelist: useWhitelist !== false,   // 默认走契约白名单；显式 false 才全列
        onProgress: ({ importedCount }) => {
          try {
            parentPort.postMessage({ type: 'progress', jobId, fileIndex, importedCount });
          } catch (_e) { /* swallow */ }
        }
      });

      parentPort.postMessage({
        type: 'parsed',
        jobId,
        fileIndex,
        batch: result.batch,
        errors: result.errors,
        importedCount: result.importedCount,
        rowErrorTotal: result.rowErrorTotal,
        truncated: result.truncated,
        monthKeys: result.monthKeys,
        headerError: result.headerError
      });
    } catch (err) {
      parentPort.postMessage({ type: 'parse-error', jobId, fileIndex, error: serializeError(err) });
    }
  });
}

// 测试 / pipeline 用导出（主线程 require 时使用；worker 进程内同名可用）。
module.exports = {
  parseFile,
  MAX_COLLECTED_ERRORS,
  __workerScriptPath: __filename
};
