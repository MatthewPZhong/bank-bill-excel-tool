// xlsx 入口尺寸预检（v3.0.4 块 A · A1 止血）
//
// 背景（backlog B9，2026-06-10 实证）：JSZip 3.10.1 DataReader.js readInt 用有符号 32 位累加，
//   entry 解压尺寸 ≥ 2^31（2.147GB）被读成负数 → compressedObject.js 解压校验必不等 →
//   抛天书 `Bug : uncompressed data size mismatch`，用户完全无法理解。
//
// 本预检在 JSZip.loadAsync 之前用 yauzl 读「中央目录」的无符号 uncompressedSize：
//   - yauzl 走中央目录（恒有真值，正解 zip64 + data descriptor），不整文件读入内存（只读目录区）。
//   - 检查目标 sheet XML 与 xl/sharedStrings.xml 的解压尺寸；任一 ≥ 上限 → 抛 FileValidationError
//     给出可执行的中文指引（拆分文件分批导入），不再让 JSZip 抛天书。
//
// 铁律（spec §七 R-8，防误伤）：
//   - 只拦「中央目录尺寸确定 ≥ 上限」；预检自身任何异常（zip 打不开 / 找不到 entry / yauzl 报错）
//     一律 **fail-open 放行**，让原链路按原方式报原错——预检绝不引入新的误伤面。

const yauzl = require('yauzl');
const { FileValidationError } = require('../file-service/common');

// 上限 = 2^31 整（2147483648）。spec OPEN-3 拍板：精确对应 JSZip 崩点。
const SIZE_LIMIT_BYTES = 2147483648;

// 预检关注的 entry：sharedStrings + 所有 worksheet（vcc/biz-op 的目标 sheet 在解析后才确定，
//   这里覆盖全部 worksheet，命中任一 ≥ 上限即拦截，确保 loadAsync 不会先撞崩）。
const SHARED_STRINGS_ENTRY_NAME = 'xl/sharedStrings.xml';
const WORKSHEET_ENTRY_RE = /^xl\/worksheets\/sheet\d+\.xml$/;

const ENTRY_ERROR_CODE = 'XLSX_ENTRY_TOO_LARGE';

// 字节 → GB 文案（保留两位小数，与 spec 文案要素「约 X.XX GB」对齐）。
function bytesToGb(bytes) {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}

// 仅用 yauzl 读中央目录，收集需要校验的 entry 的 uncompressedSize。
//   不开启 lazyEntries（一次性枚举全部 entry 头），不 openReadStream（不解压、不读文件体）。
//   返回 Map<fileName, uncompressedSize>；任何失败由 caller 转 fail-open。
function collectEntrySizes(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: false, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      const sizes = new Map();
      let settled = false;
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        if (name === SHARED_STRINGS_ENTRY_NAME || WORKSHEET_ENTRY_RE.test(name)) {
          // yauzl 的 uncompressedSize 为无符号读取（中央目录 32 位字段，zip64 时取 64 位 extra field）。
          sizes.set(name, entry.uncompressedSize);
        }
      });
      zip.on('end', () => {
        if (!settled) {
          settled = true;
          resolve(sizes);
        }
      });
      zip.on('error', (e) => {
        if (!settled) {
          settled = true;
          try { zip.close(); } catch (_) {}
          reject(e);
        }
      });
    });
  });
}

// 入口尺寸预检：在 JSZip.loadAsync 之前调用。
//   - 任一关注 entry 的 uncompressedSize ≥ SIZE_LIMIT_BYTES → 抛 FileValidationError（中文指引）。
//   - 预检自身异常（zip 打不开 / 无 entry / yauzl 报错）→ 静默吞掉，return（fail-open 放行原链路）。
//   filePath：待导入 xlsx 的绝对路径。errorCode：可选，覆盖默认错误码以对齐各调用方既有 errorCode。
async function assertXlsxEntriesUnderLimit(filePath, { errorCode = ENTRY_ERROR_CODE } = {}) {
  let sizes;
  try {
    sizes = await collectEntrySizes(filePath);
  } catch (_err) {
    // fail-open：预检读不了中央目录 → 放行，让原链路报原错（含损坏 zip 的友好包装）。
    return;
  }

  // 找出超限 entry（取最大的一个作为报错主体，文案展示其解压尺寸）。
  let offending = null;
  for (const [name, size] of sizes) {
    if (typeof size === 'number' && Number.isFinite(size) && size >= SIZE_LIMIT_BYTES) {
      if (!offending || size > offending.size) offending = { name, size };
    }
  }
  if (!offending) return; // 全部在限内 → 放行

  const gb = bytesToGb(offending.size);
  // detailLines 带 entry 名与字节数，供日志/排查；所有超限 entry 都列出（便于定位 sheet 还是 sst）。
  const detailLines = [`文件：${filePath}`];
  for (const [name, size] of sizes) {
    if (typeof size === 'number' && size >= SIZE_LIMIT_BYTES) {
      detailLines.push(`超限内容：${name}（解压后 ${size} 字节，约 ${bytesToGb(size)} GB）`);
    }
  }

  throw new FileValidationError(
    errorCode,
    `文件数据量过大：表格内容解压后约 ${gb} GB，超出当前导入通道单文件上限（2GB）`,
    {
      detailLines: [
        ...detailLines,
        '请将文件拆分为多个较小文件分批导入（参考：约 80 万行以内/文件）。'
      ],
      context: { filePath, entryName: offending.name, uncompressedSize: offending.size, limitBytes: SIZE_LIMIT_BYTES }
    }
  );
}

module.exports = {
  assertXlsxEntriesUnderLimit,
  SIZE_LIMIT_BYTES,
  ENTRY_ERROR_CODE,
  // 供单测复用
  collectEntrySizes,
  SHARED_STRINGS_ENTRY_NAME,
  WORKSHEET_ENTRY_RE
};
