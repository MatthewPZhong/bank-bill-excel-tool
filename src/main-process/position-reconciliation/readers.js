'use strict';

const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  AUDIT_HEADERS,
  POSITION_BANK_HEADERS,
  BANK_SHEET_NAME,
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('./constants');
const {
  PositionReconciliationError,
  text,
  isBlankRow,
  normalizeDate,
  monthOf,
  canonicalDecimal,
  stableHash
} = require('./common');
const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');

const POSITION_SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls']);

function normalizeFileInput(input) {
  const descriptor = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : { filePath: input };
  const filePath = path.resolve(String(descriptor.filePath || ''));
  const sourceFilePath = path.resolve(String(descriptor.sourceFilePath || filePath));
  return {
    filePath,
    sourceFilePath,
    sourceFileName: text(descriptor.sourceFileName) || path.basename(sourceFilePath),
    archivePath: descriptor.archivePath ? path.resolve(descriptor.archivePath) : filePath,
    stagingDir: descriptor.stagingDir ? path.resolve(descriptor.stagingDir) : ''
  };
}

function ensureReadableWorkbook(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new PositionReconciliationError('position-file-not-found', `文件不存在：${filePath || ''}`);
  }
  const extension = path.extname(filePath).toLowerCase();
  if (!POSITION_SUPPORTED_EXTENSIONS.has(extension)) {
    throw new PositionReconciliationError(
      'position-file-type-unsupported',
      `仅支持 .xlsx / .xls 文件：${path.basename(filePath)}`
    );
  }
  try {
    return XLSX.readFile(filePath, { cellDates: true, raw: true });
  } catch (error) {
    throw new PositionReconciliationError(
      'position-workbook-invalid',
      `无法读取 Excel：${path.basename(filePath)}`,
      [error && error.message ? error.message : String(error)]
    );
  }
}

function rowValues(sheet) {
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: true,
    blankrows: false
  });
}

function normalizeHeaderRow(row) {
  const values = Array.isArray(row) ? row.map((value) => text(value)) : [];
  while (values.length > 0 && values[values.length - 1] === '') values.pop();
  return values;
}

function headersEqual(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function objectsFromRows(rows, headers) {
  const result = [];
  for (let index = 1; index < rows.length; index += 1) {
    const values = rows[index] || [];
    const row = {};
    headers.forEach((header, columnIndex) => {
      row[header] = values[columnIndex] ?? '';
    });
    if (isBlankRow(row, headers)) continue;
    result.push({ row, excelRowNumber: index + 1 });
  }
  return result;
}

function readBankFiles(filePaths) {
  const paths = Array.isArray(filePaths) ? filePaths : [];
  if (paths.length === 0) {
    throw new PositionReconciliationError('position-bank-files-empty', '请选择至少一份平盘银行对账单');
  }
  const bizIds = new Map();
  const records = [];
  const files = [];
  let importOrder = 0;

  for (const input of paths) {
    const descriptor = normalizeFileInput(input);
    const filePath = descriptor.filePath;
    const workbook = ensureReadableWorkbook(filePath);
    const sheet = workbook.Sheets[BANK_SHEET_NAME];
    if (!sheet) {
      throw new PositionReconciliationError(
        'position-bank-sheet-missing',
        `银行对账单缺少 sheet「${BANK_SHEET_NAME}」：${path.basename(filePath)}`,
        [`实际 sheets：${workbook.SheetNames.join(' / ')}`]
      );
    }
    const rows = rowValues(sheet);
    const actualHeaders = normalizeHeaderRow(rows[0]);
    let sourceHeaders;
    if (headersEqual(actualHeaders, BANK_STATEMENT_FIELDS)) {
      sourceHeaders = BANK_STATEMENT_FIELDS;
    } else if (headersEqual(actualHeaders, POSITION_BANK_HEADERS)) {
      sourceHeaders = POSITION_BANK_HEADERS;
    } else {
      throw new PositionReconciliationError(
        'position-bank-headers-invalid',
        `银行对账单表头不符合 46/49 列契约：${path.basename(filePath)}`,
        [
          `实际列数：${actualHeaders.length}`,
          `实际表头：${actualHeaders.join(' / ')}`
        ]
      );
    }

    const parsedRows = objectsFromRows(rows, sourceHeaders);
    const fileName = descriptor.sourceFileName;
    if (parsedRows.length === 0) {
      throw new PositionReconciliationError(
        'position-bank-empty',
        `银行对账单没有可导入的数据行：${fileName}`
      );
    }
    const scopes = new Set();
    for (const parsed of parsedRows) {
      const input = parsed.row;
      const bankRow = {};
      BANK_STATEMENT_FIELDS.forEach((header) => {
        bankRow[header] = input[header] ?? '';
      });
      const bizId = text(bankRow.BizId);
      const channel = text(bankRow.Channel);
      const billDate = normalizeDate(bankRow.BillDate);
      const monthKey = monthOf(bankRow.BillDate);
      const errors = [];
      if (!bizId) errors.push('BizId 为空');
      if (!channel) errors.push('Channel 为空');
      if (!billDate || !monthKey) errors.push(`BillDate 无法解析：${text(bankRow.BillDate) || '(空)'}`);
      if (bizId && bizIds.has(bizId)) {
        const previous = bizIds.get(bizId);
        errors.push(`BizId 与 ${previous.fileName} 第 ${previous.excelRowNumber} 行重复`);
      }
      if (errors.length > 0) {
        throw new PositionReconciliationError(
          'position-bank-row-invalid',
          `银行对账单存在非法行：${fileName} 第 ${parsed.excelRowNumber} 行`,
          errors
        );
      }
      bizIds.set(bizId, { fileName, excelRowNumber: parsed.excelRowNumber });
      scopes.add(`${channel}\u0000${monthKey}`);
      records.push({
        bizId,
        channel,
        monthKey,
        billDate,
        sourceFilePath: descriptor.sourceFilePath,
        sourceFileName: fileName,
        sourceSheet: BANK_SHEET_NAME,
        sourceRowNumber: parsed.excelRowNumber,
        importOrder,
        originalRow: bankRow,
        workingRow: { ...bankRow },
        audit: Object.fromEntries(AUDIT_HEADERS.map((header) => [header, '']))
      });
      importOrder += 1;
    }
    files.push({
      filePath: descriptor.sourceFilePath,
      archivePath: descriptor.archivePath,
      stagingDir: descriptor.stagingDir,
      fileName,
      rowCount: parsedRows.length,
      scopes: [...scopes]
    });
  }

  return {
    records,
    files,
    scopes: [...new Set(records.map((record) => `${record.channel}\u0000${record.monthKey}`))],
    contentHash: stableHash(records.map((record) => record.originalRow))
  };
}

function detectSourceSheet(workbook, fileName) {
  const matches = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = rowValues(sheet);
    const headers = normalizeHeaderRow(rows[0]);
    for (const [sourceType, definition] of Object.entries(SOURCE_DEFINITIONS)) {
      if (headersEqual(headers, definition.headers)) {
        matches.push({ sourceType, definition, sheetName, rows });
      }
    }
  }
  if (matches.length === 0) {
    throw new PositionReconciliationError(
      'position-source-unrecognized',
      `无法通过表头识别链接原始表：${fileName}`
    );
  }
  if (matches.length > 1) {
    throw new PositionReconciliationError(
      'position-source-ambiguous',
      `文件中存在多个可识别原始表，无法确定唯一来源：${fileName}`,
      matches.map((match) => `${match.sheetName} → ${match.definition.sourceName}`)
    );
  }
  return matches[0];
}

function requireDecimal(row, field, errors, { allowZero = true } = {}) {
  const value = canonicalDecimal(row[field]);
  if (!value) {
    errors.push(`${field} 不是合法金额：${text(row[field]) || '(空)'}`);
    return null;
  }
  if (!allowZero && value.units === 0n) errors.push(`${field} 不能为 0`);
  return value;
}

function validateSourceRow(sourceType, row) {
  const definition = SOURCE_DEFINITIONS[sourceType];
  const errors = [];
  const businessKey = definition.keyField ? text(row[definition.keyField]) : '';
  const eventDate = definition.dateField ? normalizeDate(row[definition.dateField]) : '';
  const monthKey = definition.dateField ? monthOf(row[definition.dateField]) : '';

  if (definition.keyField && !businessKey) errors.push(`${definition.keyField} 为空`);
  if (definition.dateField && !eventDate) {
    errors.push(`${definition.dateField} 无法解析：${text(row[definition.dateField]) || '(空)'}`);
  }

  if (sourceType === SOURCE_TYPES.BANK_ACCOUNT) {
    if (text(row['账户状态']) === '正常') {
      if (!text(row['币种'])) errors.push('币种为空');
      if (!text(row['账户性质'])) errors.push('账户性质为空');
      if (!text(row['银行账号']) && !text(row['系统账号'])) errors.push('银行账号、系统账号不能同时为空');
    }
  } else if (sourceType === SOURCE_TYPES.FUND_TRANSFER) {
    if (!text(row['付款币种'])) errors.push('付款币种为空');
    if (!text(row['收款币种'])) errors.push('收款币种为空');
    requireDecimal(row, '付款金额', errors);
    requireDecimal(row, '收款金额', errors);
  } else if (sourceType === SOURCE_TYPES.TEST_PAYMENT) {
    if (!text(row['源币种'])) errors.push('源币种为空');
    if (!text(row['目标币种'])) errors.push('目标币种为空');
    requireDecimal(row, '源金额', errors);
    requireDecimal(row, '目标金额', errors);
  } else if (sourceType === SOURCE_TYPES.GATEWAY_INBOUND) {
    if (!text(row.currency)) errors.push('currency 为空');
  } else if (sourceType === SOURCE_TYPES.GATEWAY_OUTBOUND) {
    if (!text(row['币种'])) errors.push('币种为空');
  }

  return { errors, businessKey, eventDate, monthKey };
}

function readSourceFile(input) {
  const descriptor = normalizeFileInput(input);
  const filePath = descriptor.filePath;
  const workbook = ensureReadableWorkbook(filePath);
  const fileName = descriptor.sourceFileName;
  const detected = detectSourceSheet(workbook, fileName);
  const parsedRows = objectsFromRows(detected.rows, detected.definition.headers);
  if (parsedRows.length === 0) {
    throw new PositionReconciliationError(
      'position-source-empty',
      `链接原始表没有数据行：${fileName} / ${detected.sheetName}`
    );
  }
  const seen = new Map();
  const records = [];
  let collapsedDuplicateCount = 0;

  for (const parsed of parsedRows) {
    if (
      detected.sourceType === SOURCE_TYPES.BANK_ACCOUNT
      && text(parsed.row['账户状态']) !== '正常'
    ) {
      continue;
    }
    const validation = validateSourceRow(detected.sourceType, parsed.row);
    if (validation.errors.length > 0) {
      throw new PositionReconciliationError(
        'position-source-row-invalid',
        `链接原始表存在非法行：${fileName} / ${detected.sheetName} 第 ${parsed.excelRowNumber} 行`,
        validation.errors
      );
    }
    const rowHash = stableHash(parsed.row);
    if (detected.definition.keyField) {
      const previous = seen.get(validation.businessKey);
      if (previous) {
        if (previous.rowHash === rowHash) {
          collapsedDuplicateCount += 1;
          continue;
        }
        throw new PositionReconciliationError(
          'position-source-key-conflict',
          `同一文件存在业务主键冲突：${fileName}`,
          [
            `${detected.definition.keyField}=${validation.businessKey}`,
            `第 ${previous.excelRowNumber} 行与第 ${parsed.excelRowNumber} 行内容不同`
          ]
        );
      }
      seen.set(validation.businessKey, {
        rowHash,
        excelRowNumber: parsed.excelRowNumber
      });
    }
    records.push({
      sourceType: detected.sourceType,
      businessKey: validation.businessKey || `snapshot-row-${parsed.excelRowNumber}`,
      eventDate: validation.eventDate,
      monthKey: validation.monthKey,
      sourceFilePath: descriptor.sourceFilePath,
      sourceFileName: fileName,
      sourceSheet: detected.sheetName,
      sourceRowNumber: parsed.excelRowNumber,
      rowHash,
      row: parsed.row
    });
  }

  if (
    detected.sourceType === SOURCE_TYPES.BANK_ACCOUNT
    && records.length === 0
  ) {
    throw new PositionReconciliationError(
      'position-bank-account-empty',
      '清结算银行账户表没有账户状态为“正常”的有效行，旧快照未被覆盖'
    );
  }

  return {
    sourceType: detected.sourceType,
    sourceName: detected.definition.sourceName,
    linkedName: detected.definition.linkedName,
    filePath: descriptor.sourceFilePath,
    archivePath: descriptor.archivePath,
    stagingDir: descriptor.stagingDir,
    fileName,
    sheetName: detected.sheetName,
    records,
    rowCount: records.length,
    collapsedDuplicateCount,
    contentHash: stableHash(records.map((record) => record.row))
  };
}

function readSourceFiles(filePaths) {
  const paths = Array.isArray(filePaths) ? filePaths : [];
  if (paths.length === 0) {
    throw new PositionReconciliationError('position-source-files-empty', '请选择至少一份链接原始表');
  }
  const acceptedKeys = new Map();
  const acceptedAccountSnapshots = [];
  const results = [];
  for (const input of paths) {
    const descriptor = normalizeFileInput(input);
    try {
      const parsed = readSourceFile(descriptor);
      const conflicting = [];
      if (
        parsed.sourceType === SOURCE_TYPES.BANK_ACCOUNT
        && acceptedAccountSnapshots.length > 0
      ) {
        throw new PositionReconciliationError(
          'position-source-cross-file-snapshot-conflict',
          `同一次导入只能选择一份清结算银行账户表：${parsed.fileName}`,
          [`已选择：${acceptedAccountSnapshots[0]}`]
        );
      }
      if (SOURCE_DEFINITIONS[parsed.sourceType].keyField) {
        for (const record of parsed.records) {
          const batchKey = `${parsed.sourceType}\u0000${record.businessKey}`;
          const previous = acceptedKeys.get(batchKey);
          if (previous) {
            conflicting.push(
              `${record.businessKey} 已在 ${previous.fileName} 第 ${previous.sourceRowNumber} 行出现`
            );
          }
        }
      }
      if (conflicting.length > 0) {
        throw new PositionReconciliationError(
          'position-source-cross-file-conflict',
          `后续文件存在跨文件业务主键冲突，整份文件已拒绝：${parsed.fileName}`,
          conflicting
        );
      }
      for (const record of parsed.records) {
        acceptedKeys.set(`${parsed.sourceType}\u0000${record.businessKey}`, {
          rowHash: record.rowHash,
          fileName: parsed.fileName,
          sourceRowNumber: record.sourceRowNumber
        });
      }
      if (parsed.sourceType === SOURCE_TYPES.BANK_ACCOUNT) {
        acceptedAccountSnapshots.push(parsed.fileName);
      }
      results.push({ status: 'ok', ...parsed });
    } catch (error) {
      results.push({
        status: 'failed',
        filePath: descriptor.sourceFilePath,
        archivePath: descriptor.archivePath,
        stagingDir: descriptor.stagingDir,
        fileName: descriptor.sourceFileName,
        code: error && error.code ? error.code : 'position-source-import-failed',
        message: error && error.message ? error.message : String(error),
        detailLines: Array.isArray(error && error.detailLines) ? error.detailLines : []
      });
    }
  }
  return results;
}

module.exports = {
  readBankFiles,
  readSourceFile,
  readSourceFiles,
  normalizeHeaderRow,
  headersEqual,
  rowValues
};
