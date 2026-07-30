'use strict';

// Worker 与主进程共用同一套 style-aware 拆分扫描逻辑。
// 本模块保留原导出名，避免调度协议和调用方发生无关变化。
const {
  scanToolboxSplitFields
} = require('../../main-process/toolbox-format-operations');

async function scanFields(filePath, cancelToken) {
  return scanToolboxSplitFields(filePath, cancelToken || null, { boundedValues: true });
}

module.exports = {
  scanFields
};
