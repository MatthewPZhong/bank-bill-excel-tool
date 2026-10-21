'use strict';

// 设置 → 模板文件：模板检查任务本体（契约检查、结构描述、运行时口径取值）。
//   正式环境只在受限 Worker（inspection-worker.js）中执行；拆成独立模块便于单测在进程内复用同一逻辑。

const yauzl = require('yauzl');
const { inspectContract } = require('./contracts');
const { describeWorkbook, parseRuntimeValues } = require('./workbook-structure');

// Worker 的堆上限不包括解压出的 Buffer 等外部内存：ExcelJS 会把图片等条目完整解压，SheetJS 读 ZIP 也会分配外部缓冲区，
//   一个 100 KB 的文件就能解压出几百 MB。读入前先逐条流式解压并计数（只计字节，不保留内容），实际解压量超过上限即停止。
//   yauzl 同时核对条目声明的大小（validateEntrySizes），声明与实际不符的文件直接拒绝。
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

function measureUncompressed(buffer, limit = MAX_UNCOMPRESSED_BYTES) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      let total = 0;
      let done = false;
      const stop = (settle, value) => {
        if (done) return;
        done = true;
        try { zip.close(); } catch (_error) { /* 已关闭 */ }
        settle(value);
      };
      zip.on('error', (error) => stop(reject, error));
      zip.on('end', () => stop(resolve, { total, exceeded: null }));
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        if (total + entry.uncompressedSize > limit) {
          stop(resolve, { total: total + entry.uncompressedSize, exceeded: entry.fileName });
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            stop(reject, streamError);
            return;
          }
          stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > limit) {
              stream.destroy();
              stop(resolve, { total, exceeded: entry.fileName });
            }
          });
          stream.on('error', (error) => stop(reject, error));
          stream.on('end', () => {
            if (!done) zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function failedContract(label, detail) {
  const check = { group: 'file', label, status: 'fail', detail };
  return { checks: [check], ok: false, transient: false, message: `${label}：${detail}`, diff: { added: [], removed: [] } };
}

// 解压量检查：超出上限或 ZIP 结构无法读取时返回不通过的契约结果，不再交给 ExcelJS / SheetJS 读入。
async function zipBudgetFailure(buffer) {
  let measured;
  try {
    measured = await measureUncompressed(buffer);
  } catch (error) {
    return failedContract('读取文件', `文件无法读取：${error && error.message ? error.message : '未知错误'}`);
  }
  if (!measured.exceeded) return null;
  return failedContract('文件大小', `解压后内容超过 ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MB 上限（${measured.exceeded}），请精简后再导入`);
}

function errorPayload(error) {
  return {
    message: error && error.message ? String(error.message) : '未知错误',
    code: error && error.code ? String(error.code) : '',
    syscall: error && typeof error.syscall === 'string' ? error.syscall : ''
  };
}

// payload：{ task: 'inspect' | 'values', resource: { id, type, headerRow }, bytes, context }
async function runInspectionTask({ task, resource, bytes, context = {} }) {
  const buffer = Buffer.from(bytes);
  const budgetFailure = await zipBudgetFailure(buffer);
  if (task === 'values') {
    if (budgetFailure) throw new Error(budgetFailure.message);
    return { values: parseRuntimeValues(resource.id, buffer) };
  }
  if (budgetFailure) return { contract: budgetFailure, structure: null, describeError: null };
  const references = context.references || {};
  const contract = await inspectContract(resource.id, buffer, {
    builtinSheetNames: context.builtinSheetNames,
    currentValues: context.currentValues || [],
    references: {
      fundTypeValues: new Set(references.fundTypeValues || []),
      gatewayFields: new Set(references.gatewayFields || [])
    }
  });
  // 结构描述只在契约检查通过时进行：未通过的文件不会被保存，也就不再多读一遍。
  let structure = null;
  let describeError = null;
  if (context.describe && contract.ok) {
    try {
      structure = describeWorkbook(buffer, resource);
    } catch (error) {
      describeError = errorPayload(error);
    }
  }
  return { contract, structure, describeError };
}

module.exports = {
  MAX_UNCOMPRESSED_BYTES,
  errorPayload,
  measureUncompressed,
  runInspectionTask
};
