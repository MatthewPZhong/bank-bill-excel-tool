'use strict';

// Worker 与主进程共用同一套 style-aware 过滤、写入和产物校验逻辑。
// 对外保留既有函数名与错误类，Worker 消息协议无需改变。
const {
  exportToolboxFilter,
  exportToolboxMultiFilters,
  peekToolboxSplitHeaders,
  ToolboxSplitFieldNotFoundError
} = require('../../main-process/toolbox-format-operations');

async function peekNormalizedHeaders(filePath, cancelToken) {
  return peekToolboxSplitHeaders(filePath, cancelToken || null);
}

async function exportFilter(options) {
  return exportToolboxFilter(options || {});
}

async function exportMultiFilters(options) {
  return exportToolboxMultiFilters(options || {});
}

module.exports = {
  exportFilter,
  exportMultiFilters,
  ToolboxSplitFieldNotFoundError,
  peekNormalizedHeaders
};
