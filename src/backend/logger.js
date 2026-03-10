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
  const targetDir = path.join(reportRoot, 'error-reports', date);
  const targetFile = path.join(
    targetDir,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${safeStep}.txt`
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

module.exports = {
  appendLog,
  writeErrorReport
};
