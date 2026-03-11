const fs = require('node:fs');
const path = require('node:path');

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
    `错误代码：${payload.errorCode || 'N/A'}`
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
  const now = new Date();
  const date = formatLocalDate(now);
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const level = String(payload.level || 'INFO').toUpperCase();
  const message = String(payload.message || '').trim() || '未命名操作';
  const detailText = Array.isArray(payload.details)
    ? payload.details.map((line) => String(line || '').trim()).filter((line) => line !== '').join('；')
    : String(payload.details || '').trim();
  const bodyLine = detailText ? `${message} | ${detailText}` : message;
  const logFilePath = ensureActivityLogFile(filePath);
  const currentContent = fs.readFileSync(logFilePath, 'utf8');
  const dateHeader = `[${date}]`;
  const nextLines = [];

  if (!currentContent.includes(dateHeader)) {
    if (currentContent.trim() !== '') {
      nextLines.push('');
    }

    nextLines.push(dateHeader);
  }

  nextLines.push(`[${time}] [${level}] ${bodyLine}`);
  fs.appendFileSync(logFilePath, `${nextLines.join('\n')}\n`, 'utf8');
  return logFilePath;
}

module.exports = {
  appendLog,
  appendActivityRecord,
  ensureActivityLogFile,
  writeErrorReport
};
