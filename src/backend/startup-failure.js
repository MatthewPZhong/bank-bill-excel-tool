function normalizeErrorMessage(error) {
  if (!error) {
    return '未知错误';
  }

  if (typeof error.message === 'string' && error.message.trim() !== '') {
    return error.message.trim();
  }

  return String(error);
}

function buildStartupFailureDialogMessage(error, logFilePath) {
  const summary = normalizeErrorMessage(error);
  const lines = [
    `错误摘要：${summary}`
  ];
  const detailLines = error && Array.isArray(error.detailLines)
    ? error.detailLines.map((line) => String(line)).filter(Boolean).slice(0, 20)
    : [];
  const recoveryPaths = error && Array.isArray(error.recoveryPaths)
    ? [...new Set(error.recoveryPaths.map((filePath) => String(filePath)).filter(Boolean))]
    : [];

  if (detailLines.length > 0) {
    lines.push('处理明细：', ...detailLines);
  }
  if (recoveryPaths.length > 0) {
    lines.push('人工恢复路径：', ...recoveryPaths);
  }

  if (logFilePath) {
    lines.push(`日志文件：${logFilePath}`);
  }

  return lines.join('\n');
}

function reportStartupFailure({
  error,
  logFilePath = '',
  appendRecord = () => {},
  showErrorBox = () => {},
  exit = () => {}
}) {
  const summary = normalizeErrorMessage(error);
  const title = '清结算小助手启动失败';
  const message = buildStartupFailureDialogMessage(error, logFilePath);
  const detailLines = error && Array.isArray(error.detailLines)
    ? error.detailLines.map((line) => String(line)).filter(Boolean)
    : [];
  const recoveryPaths = error && Array.isArray(error.recoveryPaths)
    ? [...new Set(error.recoveryPaths.map((filePath) => String(filePath)).filter(Boolean))]
    : [];

  try {
    appendRecord(logFilePath, {
      level: 'error',
      message: '应用启动失败',
      details: [
        `错误摘要：${summary}`,
        ...detailLines,
        ...recoveryPaths.map((filePath) => `人工恢复路径：${filePath}`),
        ...(logFilePath ? [`日志文件：${logFilePath}`] : [])
      ]
    });
  } catch (_error) {
    // Ignore log write failures so we can still surface the startup error.
  }

  try {
    showErrorBox(title, message);
  } finally {
    exit(1);
  }

  return {
    title,
    message
  };
}

module.exports = {
  buildStartupFailureDialogMessage,
  reportStartupFailure
};
