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

  try {
    appendRecord(logFilePath, {
      level: 'error',
      message: '应用启动失败',
      details: [
        `错误摘要：${summary}`,
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
