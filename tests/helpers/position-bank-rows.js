'use strict';

// 直接向平盘侧库写入银行行的测试夹具（列式存储，v3.2.22）：按字段对象写入交互字段，
// 并为所属原始文件登记版本号。只用于需要绕过导入流程、手工摆数据的测试。
const path = require('node:path');

const {
  BANK_RAW_FILE_KIND,
  BANK_VALUE_COLUMNS,
  RAW_FILE_STATUSES,
  bankValueColumnsFromFields,
  insertRawFileStatement,
  pickInteractionFields
} = require('../../src/main-process/position-reconciliation/bank-row-storage');

function text(value) {
  return value == null ? '' : String(value).trim();
}

function ensureRawFile(db, { filePath = '/tmp/bank.xlsx', fileName = '', sheetName = '渠道对账单' } = {}) {
  const resolved = path.resolve(filePath);
  const existing = db.prepare(`
    SELECT version FROM position_raw_files
    WHERE kind = ? AND original_path = ? AND status = ?
    ORDER BY version DESC LIMIT 1
  `).get(BANK_RAW_FILE_KIND, resolved, RAW_FILE_STATUSES.ACTIVE);
  if (existing) return Number(existing.version);
  return Number(insertRawFileStatement(db).run(
    BANK_RAW_FILE_KIND,
    fileName || path.basename(resolved),
    resolved,
    sheetName,
    0,
    '',
    RAW_FILE_STATUSES.ACTIVE,
    '',
    ''
  ).lastInsertRowid);
}

// fields：银行行字段对象（可以是完整 46 列，只取交互字段）。返回 { id, rawVersion }。
function insertBankRowFixture(db, {
  fields,
  monthKey,
  billDate,
  importOrder = 0,
  rowNumber = 2,
  status = '未处理',
  workingFundType = null,
  filePath,
  fileName
}) {
  const picked = pickInteractionFields(fields || {});
  const rawVersion = ensureRawFile(db, { filePath, fileName });
  const fundType = text(picked.FundType);
  const result = db.prepare(`
    INSERT INTO position_bank_rows(
      biz_id, channel, month_key, bill_date, status,
      raw_version, raw_row_number, import_order,
      original_fund_type, working_fund_type, hit_summary, hit_type, match_detail,
      ${BANK_VALUE_COLUMNS.join(', ')}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ${BANK_VALUE_COLUMNS.map(() => '?').join(', ')})
  `).run(
    text(picked.BizId),
    text(picked.Channel),
    monthKey,
    billDate || `${monthKey}-01`,
    status,
    rawVersion,
    rowNumber,
    importOrder,
    fundType,
    workingFundType === null ? fundType : text(workingFundType),
    ...bankValueColumnsFromFields(picked)
  );
  db.prepare('UPDATE position_raw_files SET row_count = row_count + 1 WHERE version = ?').run(rawVersion);
  return { id: Number(result.lastInsertRowid), rawVersion };
}

module.exports = {
  ensureRawFile,
  insertBankRowFixture
};
