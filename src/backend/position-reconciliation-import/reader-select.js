'use strict';

const path = require('node:path');

const {
  PositionReconciliationError
} = require('../../main-process/position-reconciliation/common');
const { streamPositionXlsRows } = require('./xls-reader');
const { streamPositionXlsxRows } = require('./xlsx-reader');

// 按扩展名选择流式读取器；预检、写入与单遍导入共用。
function readerFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.xlsx') return streamPositionXlsxRows;
  if (extension === '.xls') return streamPositionXlsRows;
  throw new PositionReconciliationError(
    'position-file-type-unsupported',
    `仅支持 .xlsx / .xls 文件：${path.basename(filePath)}`
  );
}

module.exports = { readerFor };
