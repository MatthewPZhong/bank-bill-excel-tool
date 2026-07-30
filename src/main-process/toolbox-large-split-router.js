// v3.0.9 T5：工具箱「按字段值拆分」大文件隔离 worker 通道 —— 路由判定。
//
// 职责：决定一个待拆分的源文件该走「大文件隔离 worker 通道」还是「现有普通通道」。
//   shouldUseLargeChannel(filePath) → Promise<boolean>
//     true  = 走大通道（多 sheet / 单 worksheet 解压 ≥1.5GB 的 .xlsx）
//     false = 回普通通道（fail-closed：小文件 / .csv / .xls / 探针异常 一律 false，保小文件零回归）
//
// 探针选型（🔴 红线，TechDoc §五 / R-4）：
//   真实文件用工具箱专用 relationship-aware 轻量探针：yauzl 只枚举中央目录，并只解压有
//   16MB 上限的 workbook.xml / workbook.xml.rels。worksheet 必须按 workbook relationship 的
//   完整 Type + Target 定位，不能猜 sheetN.xml；合法 customA.xml 同样要进入 Worker。
//   单测的虚拟路径继续用 xlsx-size-preflight.collectEntrySizes 注入，保持旧边界测试可控。
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

const path = require('node:path');
const sizePreflight = require('../backend/pending-import/xlsx-size-preflight');
const {
  openZipWithEntries
} = require('../backend/big-table-import/zip-reader');
const {
  findRelationshipEntry,
  parseWorkbookRelationships,
  parseWorkbookXml,
  readToolboxMetadataEntryAsString
} = require('../backend/toolbox-format/xlsx-pass');
const { detectToolboxInputKind } = require('./toolbox-input-kind');

// 单 worksheet 解压尺寸 ≥ 该阈值 → 判为大文件（即便物理只有 1 个 sheet）。
//   1.5GB = 1610612736 字节。具名常量便于实施期按真实数据微调（TechDoc OPEN-T4）。
const SINGLE_WORKSHEET_LARGE_BYTES = 1610612736; // 1.5 GB

// 单 sheet 文件的 sharedStrings.xml 解压尺寸 ≥ 该阈值 → 也判为大文件（codex P2 修复）。
//   阈值对齐 large-split-worker 的 SHARED_STRINGS_UNCOMPRESSED_LIMIT（1.2GB），理由见 shouldUseLargeChannel 内注释。
const SHARED_STRINGS_LARGE_BYTES = 1288490188; // ~1.2 GB（= worker SST 护栏阈值）

// sharedStrings entry 名（与 collectEntrySizes / large-split-worker 口径一致）。
const SHARED_STRINGS_ENTRY = 'xl/sharedStrings.xml';

// 仅供“虚拟路径 + stub Map”旧单测 fallback；真实文件绝不再按文件名猜 worksheet。
const WORKSHEET_ENTRY_RE = /^xl\/worksheets\/sheet\d+\.xml$/;

const WORKBOOK_ENTRY = 'xl/workbook.xml';
const WORKBOOK_RELS_ENTRY = 'xl/_rels/workbook.xml.rels';
const ROUTE_METADATA_LIMIT_BYTES = 16 * 1024 * 1024;
const WORKSHEET_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet'
]);

// .xlsx 扩展名判定（仅 .xlsx 才可能走大通道；.csv / .xls fail-closed）。
const XLSX_EXT_RE = /\.xlsx$/i;

function entryUncompressedSize(entry, entryName) {
  const size = Number(entry && entry.uncompressedSize);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`xlsx 中央目录的 entry 尺寸无效：${entryName}`);
  }
  return size;
}

async function collectRelationshipAwareRouteMetadata(filePath) {
  const sourceFile = path.basename(filePath);
  const { zip, entries } = await openZipWithEntries(sourceFile, filePath, {
    rejectDuplicateEntries: true
  });
  try {
    const workbookEntry = entries.get(WORKBOOK_ENTRY);
    const relsEntry = entries.get(WORKBOOK_RELS_ENTRY);
    if (!workbookEntry || !relsEntry) {
      throw new Error('xlsx 缺少 workbook.xml 或 workbook.xml.rels');
    }
    const workbookBytes = entryUncompressedSize(workbookEntry, WORKBOOK_ENTRY);
    const relsBytes = entryUncompressedSize(relsEntry, WORKBOOK_RELS_ENTRY);
    if (workbookBytes > ROUTE_METADATA_LIMIT_BYTES || relsBytes > ROUTE_METADATA_LIMIT_BYTES) {
      return {
        forceLarge: true,
        worksheetEntries: [],
        sharedStringsSize: 0
      };
    }

    const [workbookXml, relsXml] = await Promise.all([
      readToolboxMetadataEntryAsString(zip, workbookEntry, {
        sourceFile,
        partName: WORKBOOK_ENTRY,
        limitBytes: ROUTE_METADATA_LIMIT_BYTES
      }),
      readToolboxMetadataEntryAsString(zip, relsEntry, {
        sourceFile,
        partName: WORKBOOK_RELS_ENTRY,
        limitBytes: ROUTE_METADATA_LIMIT_BYTES
      })
    ]);
    const workbook = parseWorkbookXml(workbookXml);
    const relationships = parseWorkbookRelationships(relsXml);
    if (!Array.isArray(workbook.sheets) || workbook.sheets.length === 0) {
      throw new Error('xlsx 未声明任何 worksheet');
    }

    const usedTargets = new Set();
    const worksheetEntries = workbook.sheets.map((sheet) => {
      const relationship = relationships.get(sheet.relationshipId);
      if (!relationship ||
          !WORKSHEET_RELATIONSHIP_TYPES.has(relationship.type) ||
          relationship.targetMode === 'External' ||
          !relationship.target ||
          !entries.has(relationship.target) ||
          usedTargets.has(relationship.target)) {
        throw new Error(`xlsx 工作表关系无效：${sheet.name || sheet.relationshipId}`);
      }
      usedTargets.add(relationship.target);
      const entry = entries.get(relationship.target);
      return {
        entryName: relationship.target,
        uncompressedSize: entryUncompressedSize(entry, relationship.target)
      };
    });

    const sharedStringsEntry = findRelationshipEntry(
      entries,
      relationships,
      'sharedStrings',
      SHARED_STRINGS_ENTRY,
      { sourceFile, relationshipLabel: 'sharedStrings' }
    );
    return {
      forceLarge: false,
      worksheetEntries,
      sharedStringsSize: sharedStringsEntry
        ? entryUncompressedSize(sharedStringsEntry, sharedStringsEntry.fileName || SHARED_STRINGS_ENTRY)
        : 0
    };
  } finally {
    try { zip.close(); } catch (_error) { /* ignore */ }
  }
}

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
  if (!filePath) return false;
  let inputKind;
  let detectedFromRealFile = false;
  try {
    // 生产文件统一 magic-first：扩展名写成 .xls/.csv 的 OOXML 仍可进入隔离 Worker，
    // OLE2 即使误写成 .xlsx 也不会被当 ZIP 探测。
    inputKind = detectToolboxInputKind(filePath);
    detectedFromRealFile = true;
  } catch (_error) {
    // 单测注入虚拟路径及损坏 .xlsx 仍沿用旧的扩展名 fail-closed 探针语义。
    inputKind = XLSX_EXT_RE.test(filePath) ? 'xlsx' : null;
  }
  if (inputKind !== 'xlsx') return false;

  let worksheets;
  let sharedStringsSize;
  if (detectedFromRealFile) {
    try {
      const metadata = await collectRelationshipAwareRouteMetadata(filePath);
      if (metadata.forceLarge) return true;
      worksheets = metadata.worksheetEntries.map((entry) => [
        entry.entryName,
        entry.uncompressedSize
      ]);
      sharedStringsSize = metadata.sharedStringsSize;
    } catch (_error) {
      // 严格探针无法解释的损坏文件交回普通入口，由正式 reader 输出完整格式错误。
      return false;
    }
  } else {
    let sizes;
    try {
      // 虚拟路径单测 fallback：只读 stub 的中央目录 Map。
      sizes = await sizePreflight.collectEntrySizes(filePath);
    } catch (_error) {
      return false;
    }
    if (!sizes || typeof sizes.entries !== 'function') return false;
    worksheets = [...sizes.entries()].filter(([name]) => WORKSHEET_ENTRY_RE.test(name));
    sharedStringsSize = sizes.get(SHARED_STRINGS_ENTRY);
  }

  // 多 sheet（≥2 worksheet）→ 大通道（现有普通通道对多 sheet 会 SheetJS 全量读 → 大文件 OOM）。
  if (worksheets.length >= 2) return true;

  // 单 worksheet：解压尺寸 ≥1.5GB → 大通道；否则（含尺寸非数字 / 0 个 worksheet）继续判 sharedStrings。
  const onlySize = worksheets.length === 1 ? worksheets[0][1] : 0;
  if (typeof onlySize === 'number' && Number.isFinite(onlySize) && onlySize >= SINGLE_WORKSHEET_LARGE_BYTES) {
    return true;
  }

  // 单 sheet 但 sharedStrings 解压尺寸超阈值（高基数长文本）→ 也走大通道（codex P2 修复）。
  //   否则该文件落普通通道：单 sheet .xlsx 走 streaming-xlsx-reader（JSZip 全量载 sharedStrings.xml）→
  //   GB 级 SST 直接 OOM / 撞 JSZip 2³¹ 崩（B9 类），且【永不到达】worker 的 SST 护栏（可解释拒绝）。
  //   阈值对齐 worker 的 SHARED_STRINGS_UNCOMPRESSED_LIMIT（1.2GB）：SST ≥ 此值 → 路由到 worker，
  //   由其护栏「文件文本量过大」可解释拒绝（OPEN-2 文档化的 v1 行为），而非进程静默消失。
  if (typeof sharedStringsSize === 'number' && Number.isFinite(sharedStringsSize)
    && sharedStringsSize >= SHARED_STRINGS_LARGE_BYTES) {
    return true;
  }

  // 单 sheet 小文件 → fail-closed（普通通道，🔴 关键回归锁：小文件零回归）。
  return false;
}

module.exports = {
  shouldUseLargeChannel,
  // 具名常量 / 正则导出供单测断言与实施期微调。
  SINGLE_WORKSHEET_LARGE_BYTES,
  SHARED_STRINGS_LARGE_BYTES,
  SHARED_STRINGS_ENTRY,
  WORKSHEET_ENTRY_RE,
  XLSX_EXT_RE,
  ROUTE_METADATA_LIMIT_BYTES,
  collectRelationshipAwareRouteMetadata
};
