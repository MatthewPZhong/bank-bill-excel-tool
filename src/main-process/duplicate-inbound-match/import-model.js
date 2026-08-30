'use strict';

const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');
const { FileValidationError } = require('../../backend/file-service/common');

function trimText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function pickBankFields(row) {
  return Object.fromEntries(BANK_STATEMENT_FIELDS.map((field) => [field, row[field] ?? '']));
}

function validateBizIds(rows) {
  const firstRowByBizId = new Map();
  const detailLines = [];
  for (let index = 0; index < rows.length; index += 1) {
    const excelRowNumber = index + 2;
    const bizId = trimText(rows[index].BizId);
    if (bizId === '') {
      detailLines.push(`第 ${excelRowNumber} 行：BizId 为空`);
      continue;
    }
    if (firstRowByBizId.has(bizId)) {
      detailLines.push(
        `第 ${excelRowNumber} 行：BizId「${bizId}」与第 ${firstRowByBizId.get(bizId)} 行重复`
      );
      continue;
    }
    firstRowByBizId.set(bizId, excelRowNumber);
  }
  if (detailLines.length > 0) {
    throw new FileValidationError(
      'duplicate-inbound-invalid-biz-id',
      `BizId 必须非空且全文件唯一（发现 ${detailLines.length} 处异常）`,
      { detailLines }
    );
  }
}

function prepareStoredBankRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Duplicate Bank Parser rows必须是数组');
  validateBizIds(rows);
  return rows.map((row, index) => Object.freeze({
    sourceOrdinal: index,
    excelRowNumber: index + 2,
    bizId: trimText(row.BizId),
    fundType: trimText(row.FundType),
    raw: Object.freeze(pickBankFields(row))
  }));
}

module.exports = {
  pickBankFields,
  prepareStoredBankRows,
  validateBizIds
};
