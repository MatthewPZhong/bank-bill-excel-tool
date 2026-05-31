const fs = require('node:fs');
const path = require('node:path');
// v2.0.0-beta.4：error-report 加「可能原因」行（口语化）
const { errorCodeToCause } = require('./file-service/error-causes');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLocalTimestamp(date) {
  return `${formatLocalDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatCompactLocalTimestamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sanitizeFileNamePart(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'error';
}

function appendLog(logRoot, error) {
  const now = new Date();
  const date = formatLocalDate(now);
  const time = formatLocalTimestamp(now);
  const targetDir = path.join(logRoot, 'logs');
  const targetFile = path.join(targetDir, `${date}.log`);

  fs.mkdirSync(targetDir, { recursive: true });
  fs.appendFileSync(
    targetFile,
    `[${time}] ${error.stack || error.message || String(error)}\n`,
    'utf8'
  );

  return targetFile;
}

function writeErrorReport(reportRoot, payload = {}) {
  const now = new Date();
  const date = formatLocalDate(now);
  const time = formatLocalTimestamp(now);
  const safeStep = sanitizeFileNamePart(payload.step || 'unknown-step');
  const safeTemplateName = sanitizeFileNamePart(
    payload.templateName ||
      payload.context?.templateName ||
      payload.context?.moduleName ||
      'APP'
  );
  const targetDir = path.join(reportRoot, 'error-reports', date);
  const targetFile = path.join(
    targetDir,
    `${formatCompactLocalTimestamp(now)}-${safeTemplateName}-${safeStep}.txt`
  );
  const detailLines = Array.isArray(payload.detailLines)
    ? payload.detailLines.filter((line) => String(line || '').trim() !== '')
    : [];
  const sections = [
    `报错时间：${time}`,
    `错误步骤：${payload.step || '未说明'}`,
    `错误类型：${payload.errorType || '业务校验错误'}`,
    `错误摘要：${payload.message || '未提供错误摘要'}`,
    `错误代码：${payload.errorCode || 'N/A'}`,
    `可能原因：${errorCodeToCause(payload.errorCode)}`
  ];

  if (detailLines.length) {
    sections.push('', '详细说明：', ...detailLines.map((line) => `- ${line}`));
  }

  if (payload.context && Object.keys(payload.context).length) {
    sections.push('', '上下文信息：', JSON.stringify(payload.context, null, 2));
  }

  if (payload.originalError) {
    sections.push('', '原始异常：', payload.originalError.stack || payload.originalError.message || String(payload.originalError));
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, `${sections.join('\n')}\n`, 'utf8');

  return {
    filePath: targetFile,
    fileName: path.basename(targetFile),
    createdAt: time
  };
}

function ensureActivityLogFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', 'utf8');
  }

  return filePath;
}

function appendActivityRecord(filePath, payload = {}) {
  // v2.1.12 SR-log-1：移除 app_activity_log.txt 旧双写，仅保留新结构 JSON Lines。
  //   - filePath 历史上是 <storageRoot>/app_activity_log.txt，现仅用于推导 storageRoot（dirname）
  //   - 旧文件不再创建/写入；已存在的历史文件保留不动（用户可继续查阅，见 USER_GUIDE）
  //   - 失败处理：交由 caller 兜底（appendActivityLogEntry / appendModuleLog 均有 stderr graceful）
  const now = new Date();
  const storageRoot = path.dirname(filePath);
  return appendStructuredLog(storageRoot, payload, now);
}

// v2.1.9 SR-log-1 (T32j)：新日志结构路径函数（spec §15.2 D29=a-修订）
//   - 目录结构：<storageRoot>/logs/{YYYY-MM}/{MM-DD}/{level}.log
//   - 月+日两层归档；跨年自然分组（D32 永久保留搭配）
//   - level 取值：error / warning / info（spec §15.3 D30=a 仅 3 类）；其他值兜底 'info'
//   - 自动 mkdirSync recursive（首次告警按需创建）
function getLogFilePath(storageRoot, level, date = new Date()) {
  const safeLevel = ['error', 'warning', 'info'].includes(String(level).toLowerCase())
    ? String(level).toLowerCase()
    : 'info';
  const yyyyMm = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  const mmDd = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const logsDir = path.join(storageRoot, 'logs', yyyyMm, mmDd);
  fs.mkdirSync(logsDir, { recursive: true });
  return path.join(logsDir, `${safeLevel}.log`);
}

// v2.1.9 SR-log-1 (T32j)：JSON Lines 写入函数（spec §15.3 D31）
//   - 每行一个 JSON 对象（无逗号、无外层 array），便于流式 append + cat | jq 解析
//   - 字段 schema（spec §15.3）：
//       ts (ISO 8601 with TZ) / level / source / domain / message / details[] / stack?
//   - 兜底默认值：ts=now / level='info' / source='unknown' / domain='unknown' / details=[]
//   - 时区附加：ISO 标准 toISOString 是 UTC（Z 结尾），保持与 spec 示例 +08:00 兼容性 → 写本地时区 offset
function formatIsoWithLocalTz(date) {
  const tzOffsetMin = -date.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(tzOffsetMin);
  const tzH = pad(Math.floor(absMin / 60));
  const tzM = pad(absMin % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${String(date.getMilliseconds()).padStart(3, '0')}${sign}${tzH}:${tzM}`;
}

function appendStructuredLog(storageRoot, payload = {}, now = new Date()) {
  const level = String(payload.level || 'info').toLowerCase();
  const filePath = getLogFilePath(storageRoot, level, now);
  const record = {
    ts: payload.ts || formatIsoWithLocalTz(now),
    level,
    source: payload.source || 'unknown',
    domain: payload.domain || 'unknown',
    message: String(payload.message || '').trim() || '未命名操作',
    details: Array.isArray(payload.details)
      ? payload.details.map((line) => String(line || '').trim()).filter((line) => line !== '')
      : []
  };
  if (payload.stack) {
    record.stack = String(payload.stack);
  }
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
  return filePath;
}

// v2.1.9 SR-log-1 (T32h)：main-process / backend 模块便捷写日志入口
//   - 设计目标：解决 backend / main-process 各模块没有 storageRoot 上下文的痛点
//     （database.js / migrations.js / usage-stats.js / template-repository.js 等都不知道 Documents 路径）
//   - 实现：由 main.js 启动时调 setActivityLogStorageRoot(root) 一次注入到 module-level
//   - caller 体验：与 main.js appendActivityLogEntry 完全一致，无需传 storageRoot
//   - 走 appendActivityRecord 双写（旧 txt + 新 JSON Lines）
//   - 异常 graceful（吞掉错误避免拖崩业务模块）；storageRoot 未注入时 silent skip
//
// ⚠️ 资金红线：与 main.js initializeActivityLog 必须同源 storageRoot（getStorageRoot 返回值），
//    否则会出现「main.js 写一处 + module 写另一处」的日志分裂。
let _moduleLogStorageRoot = null;

function setActivityLogStorageRoot(root) {
  _moduleLogStorageRoot = root || null;
}

function appendModuleLog(payload = {}) {
  try {
    if (!_moduleLogStorageRoot) return; // 启动期未注入或未启用 → silent skip
    const legacyPath = path.join(_moduleLogStorageRoot, 'app_activity_log.txt');
    appendActivityRecord(legacyPath, payload);
  } catch (_error) {
    try {
      process.stderr.write(`[appendModuleLog fallback] ${_error && _error.message ? _error.message : String(_error)}\n`);
    } catch (_e) {}
  }
}

module.exports = {
  appendLog,
  appendActivityRecord,
  ensureActivityLogFile,
  writeErrorReport,
  // v2.1.9 SR-log-1 (T32j)：新日志结构 API（供 main.js 直接调用或 test 验证）
  getLogFilePath,
  appendStructuredLog,
  // v2.1.9 SR-log-1 (T32h)：main-process / backend 模块便捷写日志入口
  appendModuleLog,
  setActivityLogStorageRoot
};
