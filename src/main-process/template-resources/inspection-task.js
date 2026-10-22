'use strict';

// 设置 → 模板文件：模板检查任务本体（ZIP 重新打包、契约检查、结构描述、运行时口径取值）。
//   正式环境只在受限 Worker（inspection-worker.js）中执行；拆成独立模块便于单测在进程内复用同一逻辑。

const JSZip = require('jszip');
const yauzl = require('yauzl');
const { MAX_IMPORT_BYTES, inspectContract } = require('./contracts');
const { describeWorkbook, parseRuntimeValues } = require('./workbook-structure');

// Worker 的堆上限不包括解压出的 Buffer 等外部内存；而且 ZIP 的中央目录与各条目的本地文件头可以写得互相矛盾，
//   解析库（JSZip 取本地文件头的名称，SheetJS 取本地文件头的大小）与任何预先计数看到的内容可能不同。
//   因此先用 yauzl 按中央目录逐条解压（计数，超过上限即停止；核对条目声明大小），再把解出的条目重新打包成
//   元信息一致的 ZIP：之后的契约检查、结构描述，以及保存为版本后主进程的读入，都只面对这份重新打包的文件。
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
// 固定条目时间，使同一份内容总是打包出相同的字节（重复导入可识别、已存版本可复核是否为本程序保存的格式）。
const CANONICAL_ENTRY_DATE = new Date(Date.UTC(1980, 0, 1));

class ZipRejectedError extends Error {
  constructor(label, detail) {
    super(detail);
    this.name = 'ZipRejectedError';
    this.label = label;
  }
}

// 按中央目录逐条解压，返回 [{ name, data }]（保持原顺序）。超过上限、条目重复、目录条目带内容时拒绝。
function extractEntries(buffer, limit = MAX_UNCOMPRESSED_BYTES) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      const entries = [];
      const names = new Set();
      let total = 0;
      let done = false;
      const stop = (settle, value) => {
        if (done) return;
        done = true;
        try { zip.close(); } catch (_error) { /* 已关闭 */ }
        settle(value);
      };
      const exceeded = (name) => new ZipRejectedError('文件大小', `解压后内容超过 ${limit / 1024 / 1024} MB 上限（${name}），请精简后再导入`);
      zip.on('error', (error) => stop(reject, error));
      zip.on('end', () => stop(resolve, entries));
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        // 条目名必须规范且无别名：带 . 段或空段（如 a/./b、a//b）的名称会被 JSZip 与 SheetJS 解释成不同部件；
        // 包内部件名按 OPC 规则不区分大小写，仅大小写不同的两个条目同样有歧义。拒绝而不改名（改名还要同步关系引用）。
        const segments = name.replace(/\/$/, '').split('/');
        if (segments.some((segment) => segment === '' || segment === '.')) {
          stop(reject, new ZipRejectedError('读取文件', `文件的条目名不规范（${name}），无法安全读取`));
          return;
        }
        const key = name.toLowerCase();
        if (names.has(key)) {
          stop(reject, new ZipRejectedError('读取文件', `文件包含重复或仅大小写不同的条目（${name}），无法安全读取`));
          return;
        }
        names.add(key);
        if (/\/$/.test(name)) {
          if (entry.uncompressedSize > 0 || entry.compressedSize > 0) {
            stop(reject, new ZipRejectedError('读取文件', `文件的目录条目带有内容（${name}），无法安全读取`));
            return;
          }
          zip.readEntry();
          return;
        }
        if (total + entry.uncompressedSize > limit) {
          stop(reject, exceeded(name));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            stop(reject, streamError);
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > limit) {
              stream.destroy();
              stop(reject, exceeded(name));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', (error) => stop(reject, error));
          stream.on('end', () => {
            if (done) return;
            entries.push({ name, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

// 重新打包：只包含按中央目录解出的条目，元信息由 JSZip 统一生成。
async function repackEntries(entries) {
  const zip = new JSZip();
  for (const { name, data } of entries) {
    zip.file(name, data, { date: CANONICAL_ENTRY_DATE, createFolders: false, binary: true });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

async function canonicalizeXlsx(buffer, limit = MAX_UNCOMPRESSED_BYTES) {
  return repackEntries(await extractEntries(buffer, limit));
}

function failedContract(label, detail) {
  const check = { group: 'file', label, status: 'fail', detail };
  return { checks: [check], ok: false, transient: false, message: `${label}：${detail}`, diff: { added: [], removed: [] } };
}

// 解压与重新打包；不通过时返回契约结果（不再交给 ExcelJS / SheetJS 读入）。
//   expectCanonical：复核已存版本时要求文件已是重新打包后的格式（早期保存的原始文件需重新导入）。
async function canonicalBytes(buffer, { expectCanonical = false } = {}) {
  let canonical;
  try {
    canonical = await canonicalizeXlsx(buffer);
  } catch (error) {
    if (error instanceof ZipRejectedError) return { failure: failedContract(error.label, error.message) };
    return { failure: failedContract('读取文件', `文件无法读取：${error && error.message ? error.message : '未知错误'}`) };
  }
  if (canonical.length > MAX_IMPORT_BYTES) {
    return { failure: failedContract('文件大小', `重新打包后超过 ${MAX_IMPORT_BYTES / 1024 / 1024} MB 上限，请精简后再导入`) };
  }
  if (expectCanonical && !canonical.equals(buffer)) {
    return { failure: failedContract('读取文件', '版本文件不是本程序保存的格式（早期版本保存），请重新导入') };
  }
  return { canonical };
}

function errorPayload(error) {
  return {
    message: error && error.message ? String(error.message) : '未知错误',
    code: error && error.code ? String(error.code) : '',
    syscall: error && typeof error.syscall === 'string' ? error.syscall : ''
  };
}

// payload：{ task: 'inspect' | 'values', resource: { id, type, headerRow }, bytes, context }
//   inspect 返回 { contract, structure, describeError, canonical }：canonical 为重新打包后的字节，导入时保存的就是它。
async function runInspectionTask({ task, resource, bytes, context = {} }) {
  const prepared = await canonicalBytes(Buffer.from(bytes), { expectCanonical: task === 'values' || context.expectCanonical === true });
  if (task === 'values') {
    if (prepared.failure) throw new Error(prepared.failure.message);
    return { values: parseRuntimeValues(resource.id, prepared.canonical) };
  }
  if (prepared.failure) return { contract: prepared.failure, structure: null, describeError: null, canonical: null };
  const { canonical } = prepared;
  const references = context.references || {};
  const contract = await inspectContract(resource.id, canonical, {
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
      structure = describeWorkbook(canonical, resource);
    } catch (error) {
      describeError = errorPayload(error);
    }
  }
  return { contract, structure, describeError, canonical };
}

module.exports = {
  MAX_UNCOMPRESSED_BYTES,
  canonicalizeXlsx,
  errorPayload,
  extractEntries,
  runInspectionTask
};
