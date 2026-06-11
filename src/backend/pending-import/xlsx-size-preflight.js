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

// 预检关注的 entry：sharedStrings（恒检——三个调用方都会 inflate 它）+ worksheet。
//   worksheet 检查范围由调用方按「实际 inflate 哪些 sheet」精确指定（见 assertXlsxEntriesUnderLimit
//   的 sheetEntryNames 参数）：
//   - streaming-xlsx-reader 硬编码只读 xl/worksheets/sheet1.xml → 只检 sheet1；
//   - vcc-op-calc-import/reader 逐 sheet inflate 直到表头匹配 → 缺省检全部 worksheet；
//   - biz-op-recon-import/reader-streamed 只 inflate locateFirstSheet 定位出的目标 sheet → 检该 sheet。
//   ⚠️ PR#71 二轮 codex review（P2，2026-06-11）修复：旧版对**全部** worksheet 检查，但 biz-op /
//     streaming 实际只 inflate 部分 sheet → 多 sheet 工作簿「目标 sheet 小 + 未用 tab 超限」会被误拒
//     （功能回归，旧链路本可正常导入）。改为调用方指定被检 sheet 集合，消除误伤。
const SHARED_STRINGS_ENTRY_NAME = 'xl/sharedStrings.xml';
const WORKSHEET_ENTRY_RE = /^xl\/worksheets\/sheet\d+\.xml$/;

const ENTRY_ERROR_CODE = 'XLSX_ENTRY_TOO_LARGE';

// 字节 → GB 文案（保留两位小数，与 spec 文案要素「约 X.XX GB」对齐）。
function bytesToGb(bytes) {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}

// 仅用 yauzl 读中央目录，收集 sharedStrings + 全部 worksheet 的 uncompressedSize。
//   不开启 lazyEntries（一次性枚举全部 entry 头），不 openReadStream（不解压、不读文件体）。
//   返回 Map<fileName, uncompressedSize>（收集全部候选 entry，由调用方按 sheetEntryNames 二次过滤要检的子集）；
//   任何失败由 caller 转 fail-open。
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

// 入口尺寸预检：在「inflate 目标 entry」之前调用（多数调用方在 JSZip.loadAsync 前，
//   biz-op 在 locateFirstSheet 定位出目标 sheet 后、scanWorksheet inflate 前）。
//   - 被检集合内任一 entry 的 uncompressedSize ≥ SIZE_LIMIT_BYTES → 抛 FileValidationError（中文指引）。
//   - 预检自身异常（zip 打不开 / 无 entry / yauzl 报错）→ 静默吞掉，return（fail-open 放行原链路）。
//   参数：
//     filePath        待导入 xlsx 的绝对路径。
//     errorCode       可选，覆盖默认错误码以对齐各调用方既有 errorCode。
//     sheetEntryNames 可选，要检的 worksheet entry 名集合（数组）。
//                     - 缺省（undefined/null）= 检中央目录里全部 worksheet（向后兼容，vcc 逐 sheet inflate 用此）；
//                     - 传数组 = 只检该集合内的 worksheet entry（streaming/biz-op 只 inflate 部分 sheet 用此）；
//                       不在集合内的 worksheet 即便超限也放行（它们不会被 inflate，不会撞 JSZip 崩点）。
//                     无论哪种模式，xl/sharedStrings.xml 恒检（三个调用方都会 inflate 它）。
async function assertXlsxEntriesUnderLimit(filePath, { errorCode = ENTRY_ERROR_CODE, sheetEntryNames = null } = {}) {
  let sizes;
  try {
    sizes = await collectEntrySizes(filePath);
  } catch (_err) {
    // fail-open：预检读不了中央目录 → 放行，让原链路报原错（含损坏 zip 的友好包装）。
    return;
  }

  // 确定被检 entry 集合：sharedStrings 恒检 + 调用方指定的 worksheet 子集（缺省 = 全部 worksheet）。
  const sheetWhitelist = Array.isArray(sheetEntryNames) ? new Set(sheetEntryNames) : null;
  const shouldCheck = (name) => {
    if (name === SHARED_STRINGS_ENTRY_NAME) return true;           // sharedStrings 恒检
    if (!WORKSHEET_ENTRY_RE.test(name)) return false;              // 非 worksheet（且非 sst）→ 不检
    return sheetWhitelist ? sheetWhitelist.has(name) : true;       // 有白名单按白名单，否则检全部 worksheet
  };

  // 找出超限 entry（取最大的一个作为报错主体，文案展示其解压尺寸）。
  let offending = null;
  for (const [name, size] of sizes) {
    if (!shouldCheck(name)) continue;
    if (typeof size === 'number' && Number.isFinite(size) && size >= SIZE_LIMIT_BYTES) {
      if (!offending || size > offending.size) offending = { name, size };
    }
  }
  if (!offending) return; // 被检集合全部在限内 → 放行

  const gb = bytesToGb(offending.size);
  // detailLines 带 entry 名与字节数，供日志/排查；所有被检且超限的 entry 都列出（便于定位 sheet 还是 sst）。
  const detailLines = [`文件：${filePath}`];
  for (const [name, size] of sizes) {
    if (!shouldCheck(name)) continue;
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
