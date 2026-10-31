'use strict';

// 平盘导入表头不一致时的差异明细：链接原始表按全部来源表结构找最接近的一张，银行对账单按 46/49 列契约比较。
// Main 与导入 Worker 共用。

const { describeHeaderMismatch } = require('../../backend/file-service/header-structure-diff');
const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');
const { POSITION_BANK_HEADERS, SOURCE_DEFINITIONS } = require('./constants');

// sheets：[{ name, headers }]；definitions 缺省为内置来源表结构，传入时为本次导入使用的当前版本结构。
function sourceHeaderMismatchLines(sheets, definitions = SOURCE_DEFINITIONS) {
  return describeHeaderMismatch({
    sheets,
    candidates: Object.values(definitions).map((definition) => ({
      name: definition.sourceName,
      headers: definition.headers,
      versionLabel: definition.versionLabel
    }))
  });
}

// 银行对账单结构不可在模板文件中替换，不附加导入新版本的提示。
function bankHeaderMismatchLines(headers) {
  return describeHeaderMismatch({
    sheets: [{ name: '', headers }],
    candidates: [
      { name: '平盘银行对账单 46 列', headers: BANK_STATEMENT_FIELDS },
      { name: '平盘结果回导 49 列', headers: POSITION_BANK_HEADERS }
    ],
    hint: null
  });
}

module.exports = {
  bankHeaderMismatchLines,
  sourceHeaderMismatchLines
};
