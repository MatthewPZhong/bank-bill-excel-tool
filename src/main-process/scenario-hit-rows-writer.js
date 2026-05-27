// v2.1.9 N5 Phase 6 T24：场景命中行独立报表 writer（spec §5.1-5.3）
//
// 🔴 对外契约破坏性变更：
//   v2.1.8 PR #52 N3-2 将命中场景行写入主输出 xlsx 的 Sheet 3「命中场景行」
//   v2.1.9 撤除 Sheet 3，改独立报表（spec §5.4），落位 error-reports/{date}/
//   详 CHANGELOG / USER_GUIDE v2.1.9（Phase 9 收尾更新）
//
// 职责：
//   writeScenarioHitRows(modifiedRows, originalFilePath, opts)
//     → 落位 Documents/网银账单生成小助手/error-reports/{date}/
//     → 命名 `命中场景行-{原文件 basename}-{timestamp}.xlsx`（D15=a）
//     → 列结构（D17=b）：原 44 列银行账单 headers + 末尾 3 列
//        「匹配渠道」 = 命中场景所属渠道 label（D16=b，2026-05-27 用户拍板）
//           - 命中通用 → '通用'；命中专属 → 'name-ownerLocation'（如 '工商-上海'）
//           - 查不到 channels label / row._hitChannelId 缺 → 回退到 row._hitChannelKey
//             （向后兼容老 caller / dispatcher 单维路径）
//        「匹配状态」 = row._matchStatus（'命中' / '兜底'）
//        「命中场景」 = `[displayIndex] name`（与 N3-1 状态框文案统一）
//     → atomic write：tmp 文件 + rename（防半文件）
//     → 失败抛错；caller 负责 graceful 处理（不阻塞主对账流程）
//
// 4 种行结果矩阵（spec §2.2）：
//   - _matchStatus='命中' + _hitScenarioId≠null → 「命中, [N] 专属场景」
//   - _matchStatus='命中' + _hitScenarioId≠null（通用兜底） → 「命中, [N] 通用场景」
//   - _matchStatus='兜底' + _hitScenarioId≠null → 「兜底, [N] 通用场景」
//   - 未命中行（hit=null）不进 modifiedRows，不写本报表（详 spec §2.2）

const ExcelJS = require('exceljs');
const fs = require('node:fs');
const path = require('node:path');

const { BANK_STATEMENT_FIELDS } = require('../constants/bank-statement-fields');
const { applyWatermark } = require('./workbook-watermark');
const { buildTimestamp } = require('./bank-statement-io');

// 末尾 3 列固定表头（spec §5.2 + D17=b 列序）
const SUFFIX_HEADERS = ['匹配渠道', '匹配状态', '命中场景'];

// 报表 sheet 名（spec §5.3）
const REPORT_SHEET_NAME = '命中场景行';

// 缺省落位子目录（spec §5.1 + D14=a）
const DEFAULT_REPORT_SUBDIR = 'error-reports';

function buildDateDir(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 拼末尾「命中场景」列值（spec §5.2 + 与 N3-1 状态框文案统一）
//   带 displayIndex + name → `[N] name`
//   缺任一字段（如 dispatcher 未注入）→ ''（不抛错，graceful）
function buildHitScenarioLabel(row) {
  if (!row || row._hitScenarioId === undefined || row._hitScenarioId === null) return '';
  const di = row._hitScenarioDisplayIndex;
  const nm = row._hitScenarioName;
  if ((di === null || di === undefined) || !nm) return '';
  return `[${di}] ${nm}`;
}

// v2.1.9 D16=b（2026-05-27 用户拍板）：把 caller 传入的 channels 列表归一化为 Map<id, label>
//   入参 channels 支持两种形态：
//     - Array<{ id, label, ... }>（生产 caller：channelsRepository.listChannels(db) 结果）
//     - Map<channelId, label-or-channel-obj>（测试 caller 可直接 Map 注入）
//     - null/undefined → 返回 null（writer 走「回退 _hitChannelKey」分支）
//   label 优先级：channel.label（生产 rowToChannel 已生成 '通用' / 'name-ownerLocation'）→
//                 fallback `${name}-${ownerLocation}`（防御性兜底，避免 caller 传 raw row 时崩）
function normalizeChannelsToLabelMap(channels) {
  if (channels === null || channels === undefined) return null;
  // Map<id, channel-obj or string>
  if (channels instanceof Map) {
    const m = new Map();
    for (const [id, v] of channels.entries()) {
      if (v == null) continue;
      if (typeof v === 'string') { m.set(id, v); continue; }
      const label = v.label != null ? v.label : (v.name && v.ownerLocation ? `${v.name}-${v.ownerLocation}` : (v.name || ''));
      m.set(id, label);
    }
    return m;
  }
  // Array<channel-obj>
  if (Array.isArray(channels)) {
    const m = new Map();
    for (const c of channels) {
      if (!c || c.id == null) continue;
      const label = c.label != null ? c.label : (c.name && c.ownerLocation ? `${c.name}-${c.ownerLocation}` : (c.name || ''));
      m.set(c.id, label);
    }
    return m;
  }
  // 其他形态（object 等）→ 安全回退 null
  return null;
}

// 拼「匹配渠道」列值（D16=b）
//   有 channelsLabelMap + row._hitChannelId 命中 → channels label
//   无 channelsLabelMap（caller 未传 opts.channels，老 caller 兼容）→ 回退 row._hitChannelKey
//   有 channelsLabelMap 但 row._hitChannelId 缺 / 查不到（未命中行）→ '' 兜底
function buildHitChannelLabel(row, channelsLabelMap) {
  if (!row) return '';
  // 未传 channels → 老 caller 兼容回退（保留 D16=a 行为：写原始 channelKey）
  if (channelsLabelMap === null) {
    return (row._hitChannelKey != null) ? row._hitChannelKey : '';
  }
  // 已传 channels：只有命中场景的行（_hitChannelId != null）才能查到 label
  const hitChannelId = row._hitChannelId;
  if (hitChannelId === null || hitChannelId === undefined) return '';
  const label = channelsLabelMap.get(hitChannelId);
  return label != null ? label : '';
}

// 计算原文件 basename（去扩展名）
//   缺省值兜底：originalFilePath 缺失 → 'unknown'
//   sanitizeFileName 由 caller 已保证（路径来自 IPC saveDialog / 导入文件）；本函数仅 basename
function buildOriginalBaseName(originalFilePath) {
  if (!originalFilePath || typeof originalFilePath !== 'string') return 'unknown';
  const ext = path.extname(originalFilePath);
  const base = path.basename(originalFilePath, ext);
  return base || 'unknown';
}

// writeScenarioHitRows
//   入参：
//     modifiedRows: Array<row>（dispatcher 注入 _hitChannelKey / _matchStatus / _hitChannelId / _hitScenario* 等 metadata）
//     originalFilePath: string（原银行对账单文件绝对路径，用于派生 basename）
//     opts: {
//       exportRoot?: string                              — 替代 Documents/网银账单生成小助手 根目录（测试注入）
//       reportDir?: string                               — 直接指定报表目录（绕过 exportRoot/error-reports/{date} 拼接，测试用）
//       timestamp?: string                               — 替代 buildTimestamp() 输出（测试用，确保文件名稳定）
//       headers?: string[]                               — 替代 BANK_STATEMENT_FIELDS（测试用，避免 44 列冗余）
//       channels?: Array<channel>|Map<id, channel|label> — v2.1.9 D16=b：渠道列表
//                                                          生产 caller 传 channelsRepository.listChannels(db)；
//                                                          缺省（不传）→ 「匹配渠道」列回退 row._hitChannelKey（向后兼容）
//     }
//   返回：{ status: 'ok', filePath, fileName, rowCount }
//   行为：
//     - modifiedRows 为空数组 → 仍输出含表头空 sheet（与 Sheet 2 v2.1.7 F8 round 3 行为一致）
//     - atomic write：tmp 文件 + rename
//     - 异常抛 Error；caller 负责 try-catch + graceful（spec §5.4 失败不阻塞对账主流程）
async function writeScenarioHitRows(modifiedRows, originalFilePath, opts = {}) {
  if (!Array.isArray(modifiedRows)) {
    throw new Error('writeScenarioHitRows: modifiedRows 必须是数组');
  }

  const headers = Array.isArray(opts.headers) && opts.headers.length > 0
    ? opts.headers
    : BANK_STATEMENT_FIELDS;
  const timestamp = typeof opts.timestamp === 'string' && opts.timestamp
    ? opts.timestamp
    : buildTimestamp();
  const baseName = buildOriginalBaseName(originalFilePath);
  const fileName = `命中场景行-${baseName}-${timestamp}.xlsx`;

  // v2.1.9 D16=b：归一化 channels → Map<id, label>；null = caller 未传，writer 回退 _hitChannelKey
  const channelsLabelMap = normalizeChannelsToLabelMap(opts.channels);

  // 计算报表目录（spec §5.1）
  //   opts.reportDir 优先（测试 / 自定义路径）；否则 opts.exportRoot + DEFAULT_REPORT_SUBDIR + {date}
  let reportDir;
  if (typeof opts.reportDir === 'string' && opts.reportDir) {
    reportDir = opts.reportDir;
  } else {
    if (!opts.exportRoot || typeof opts.exportRoot !== 'string') {
      throw new Error('writeScenarioHitRows: opts.exportRoot 必填（生产由 caller 注入 app.getPath("documents")/网银账单生成小助手）');
    }
    reportDir = path.join(opts.exportRoot, DEFAULT_REPORT_SUBDIR, buildDateDir());
  }
  fs.mkdirSync(reportDir, { recursive: true });

  const finalPath = path.join(reportDir, fileName);
  const tmpPath = `${finalPath}.tmp`;

  // 构造 workbook + sheet
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(REPORT_SHEET_NAME);

  // 表头（原 N 列 headers + 末尾 3 列）
  const fullHeaders = headers.concat(SUFFIX_HEADERS);
  sheet.addRow(fullHeaders);
  sheet.getRow(1).font = { bold: true, size: 10 };

  // 数据行：投影 headers + 末尾 3 列值（_ 前缀字段不入 headers → 自动过滤）
  //   v2.1.9 D16=b：「匹配渠道」列改用 _hitChannelId 查 channels label（命中场景所属渠道）
  //   未传 opts.channels → 回退 _hitChannelKey（向后兼容老 caller / dispatcher 单维路径）
  for (const row of modifiedRows) {
    const baseValues = headers.map((h) => (row && row[h] !== undefined ? row[h] : ''));
    const channelLabel = buildHitChannelLabel(row, channelsLabelMap);
    const matchStatus = (row && row._matchStatus != null) ? row._matchStatus : '';
    const hitLabel = buildHitScenarioLabel(row);
    sheet.addRow(baseValues.concat([channelLabel, matchStatus, hitLabel]));
  }

  applyWatermark(workbook);

  // atomic write：先写 tmp 再 rename（spec §5.3 不留半文件）
  try {
    await workbook.xlsx.writeFile(tmpPath);
    fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    // 清理 tmp（best-effort，失败忽略）
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    throw new Error(`writeScenarioHitRows 失败（path=${finalPath}）: ${e.message}`);
  }

  return {
    status: 'ok',
    filePath: finalPath,
    fileName,
    rowCount: modifiedRows.length
  };
}

module.exports = {
  writeScenarioHitRows,
  // 辅助函数 export（unit test 直查）
  buildHitScenarioLabel,
  buildOriginalBaseName,
  buildDateDir,
  // v2.1.9 D16=b 新增辅助函数 export
  buildHitChannelLabel,
  normalizeChannelsToLabelMap,
  // 常量 export（unit test / caller 引用）
  SUFFIX_HEADERS,
  REPORT_SHEET_NAME,
  DEFAULT_REPORT_SUBDIR
};
