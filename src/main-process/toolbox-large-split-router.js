// v3.0.9 T5：工具箱「按字段值拆分」大文件隔离 worker 通道 —— 路由判定。
//
// 职责：决定一个待拆分的源文件该走「大文件隔离 worker 通道」还是「现有普通通道」。
//   shouldUseLargeChannel(filePath) → Promise<boolean>
//     true  = 走大通道（多 sheet / 单 worksheet 解压 ≥1.5GB 的 .xlsx）
//     false = 回普通通道（fail-closed：小文件 / .csv / .xls / 探针异常 一律 false，保小文件零回归）
//
// 探针选型（🔴 红线，TechDoc §五 / R-4）：
//   只用 xlsx-size-preflight 的 collectEntrySizes —— 它用 yauzl 读 zip「中央目录」，
//   lazyEntries:false 一次性枚举 entry 头，**不 openReadStream、不解压、不读文件体** →
//   对 800MB 级文件自身不会 OOM；返回 Map<fileName, uncompressedSize>，含全部 worksheet entry
//   （/^xl\/worksheets\/sheet\d+\.xml$/）+ xl/sharedStrings.xml，足够判 worksheet 数与单 worksheet 解压尺寸。
//
//   🔴 **禁用 readers.js 的 readXlsxSheetMetaLite**：它走 fs.promises.readFile(整文件 buffer) +
//   JSZip.loadAsync(buffer)，其注释「不 OOM」仅对 65 万行（压缩 buffer 小）成立；对 800MB 压缩文件
//   读整 buffer 仍 OOM —— 探针自身绝不能 OOM，故此处一律不碰它。
//
//   🔴 隔离铁律：本模块绝不 require / 触碰 streaming-xlsx-reader.js（银行/Pending/链接表导入复用，
//   触它=全回归资金红线）。本模块仅依赖 collectEntrySizes 这一个纯 Node（yauzl）能力。
//
// 注：通过模块对象 sizePreflight.collectEntrySizes(...) 调用（而非顶部解构成局部常量），
//   以便单测覆盖该导出来构造任意 Map（如无法真实造出的 ≥1.5GB 场景），同时保持「只依赖这一个导出」。

const sizePreflight = require('../backend/pending-import/xlsx-size-preflight');

// 单 worksheet 解压尺寸 ≥ 该阈值 → 判为大文件（即便物理只有 1 个 sheet）。
//   1.5GB = 1610612736 字节。具名常量便于实施期按真实数据微调（TechDoc OPEN-T4）。
const SINGLE_WORKSHEET_LARGE_BYTES = 1610612736; // 1.5 GB

// worksheet entry 名匹配（与 collectEntrySizes 内部口径一致：xl/worksheets/sheetN.xml）。
const WORKSHEET_ENTRY_RE = /^xl\/worksheets\/sheet\d+\.xml$/;

// .xlsx 扩展名判定（仅 .xlsx 才可能走大通道；.csv / .xls fail-closed）。
const XLSX_EXT_RE = /\.xlsx$/i;

/**
 * 判定源文件是否应走大文件隔离 worker 通道。
 *
 * 判定（仅当为 .xlsx 时）：worksheet 数 ≥2 **或** 单 worksheet 解压尺寸 ≥ SINGLE_WORKSHEET_LARGE_BYTES → true。
 * fail-closed：非 .xlsx / 单 sheet 小文件 / collectEntrySizes 抛异常 → 一律 false（回普通通道，小文件零回归）。
 *
 * @param {string} filePath 待拆分源文件的绝对路径
 * @returns {Promise<boolean>} true=大通道，false=普通通道
 */
async function shouldUseLargeChannel(filePath) {
  // .csv / .xls / 空路径 → fail-closed（普通通道，行为不变）。
  if (!filePath || !XLSX_EXT_RE.test(filePath)) return false;

  let sizes;
  try {
    // 只用 collectEntrySizes：读中央目录、不解压、不读文件体 → 探针自身不 OOM。
    sizes = await sizePreflight.collectEntrySizes(filePath);
  } catch (_e) {
    // 探针异常（zip 打不开 / yauzl 报错 / 无中央目录等）→ fail-closed 放行普通通道。
    return false;
  }

  // sizes 形态防御：collectEntrySizes 正常返回 Map；异常形态当作判不出 → fail-closed。
  if (!sizes || typeof sizes.entries !== 'function') return false;

  const worksheets = [...sizes.entries()].filter(([name]) => WORKSHEET_ENTRY_RE.test(name));

  // 多 sheet（≥2 worksheet）→ 大通道（现有普通通道对多 sheet 会 SheetJS 全量读 → 大文件 OOM）。
  if (worksheets.length >= 2) return true;

  // 单 worksheet：解压尺寸 ≥1.5GB → 大通道；否则（含尺寸非数字 / 0 个 worksheet）fail-closed。
  const onlySize = worksheets.length === 1 ? worksheets[0][1] : 0;
  if (typeof onlySize === 'number' && Number.isFinite(onlySize) && onlySize >= SINGLE_WORKSHEET_LARGE_BYTES) {
    return true;
  }

  // 单 sheet 小文件 → fail-closed（普通通道，🔴 关键回归锁：小文件零回归）。
  return false;
}

module.exports = {
  shouldUseLargeChannel,
  // 具名常量 / 正则导出供单测断言与实施期微调。
  SINGLE_WORKSHEET_LARGE_BYTES,
  WORKSHEET_ENTRY_RE,
  XLSX_EXT_RE
};
