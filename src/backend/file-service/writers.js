const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { FileValidationError, normalizeCell } = require('./common');

function countSignificantDigitsFromString(str) {
  const cleaned = str.replace(/[^0-9]/g, '').replace(/^0+/, '');
  return cleaned.length;
}

function hasMoreThanTwoDecimalsFromString(str) {
  const dotIndex = str.indexOf('.');
  if (dotIndex < 0) return false;
  return str.length - dotIndex - 1 > 2;
}

function buildNumericCellValue(rawStringValue, parseNumericValue) {
  const str = String(rawStringValue || '');
  const sigDigits = countSignificantDigitsFromString(str);

  if (sigDigits > 15) {
    return { t: 's', v: str, z: '@' };
  }

  const numericValue = parseNumericValue(str);
  if (numericValue === null) {
    return null;
  }

  if (hasMoreThanTwoDecimalsFromString(str)) {
    return { t: 'n', v: numericValue };
  }
  return { t: 'n', v: numericValue, z: '0.00' };
}

function applyExportFieldFormats(worksheet, rows, {
  inferDateCellFormat,
  parseDateValue,
  parseNumericValue,
  toExcelSerial
}) {
  const headerRow = rows[0] || [];
  const fieldIndexMap = new Map();

  headerRow.forEach((header, index) => {
    const normalizedHeader = normalizeCell(header);

    if (!fieldIndexMap.has(normalizedHeader)) {
      fieldIndexMap.set(normalizedHeader, []);
    }

    fieldIndexMap.get(normalizedHeader).push(index);
  });

  const numericFields = ['Balance', 'Credit Amount', 'Debit Amount'];
  const dateFields = ['BillDate', 'ValueDate'];
  const textFields = ['MerchantId', 'Channel', 'Currency'];

  rows.slice(1).forEach((row, rowIndex) => {
    const sheetRowIndex = rowIndex + 1;

    numericFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const rawValue = row[columnIndex];
        if (rawValue === null || rawValue === undefined || rawValue === '') {
          return;
        }

        const cellValue = buildNumericCellValue(rawValue, parseNumericValue);
        if (!cellValue) {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = cellValue;
      });
    });

    dateFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const dateValue = parseDateValue(row[columnIndex]);

        if (!dateValue) {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = {
          t: 'n',
          v: toExcelSerial(dateValue),
          z: inferDateCellFormat(row[columnIndex])
        };
      });
    });

    textFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const textValue = row[columnIndex];

        if (textValue === null || textValue === undefined || textValue === '') {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = {
          t: 's',
          v: String(textValue),
          z: '@'
        };
      });
    });
  });
}

function applyBalanceFieldFormats(worksheet, headerFields, rows, {
  inferDateCellFormat,
  parseDateValue,
  parseNumericValue,
  toExcelSerial
}) {
  const fieldIndexMap = new Map();

  headerFields.forEach((header, index) => {
    const normalizedHeader = normalizeCell(header);

    if (!fieldIndexMap.has(normalizedHeader)) {
      fieldIndexMap.set(normalizedHeader, []);
    }

    fieldIndexMap.get(normalizedHeader).push(index);
  });

  const numericFields = ['期初余额', '期初可用余额', '期末余额', '期末可用余额'];
  const dateFields = ['账单日期'];
  const textFields = ['银行名称', '所在地', '币种', '银行账号'];

  rows.forEach((row, rowIndex) => {
    const sheetRowIndex = rowIndex + 1;

    numericFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const rawValue = row[columnIndex];
        if (rawValue === null || rawValue === undefined || rawValue === '') {
          return;
        }

        const cellValue = buildNumericCellValue(rawValue, parseNumericValue);
        if (!cellValue) {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = cellValue;
      });
    });

    dateFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const dateValue = parseDateValue(row[columnIndex]);

        if (!dateValue) {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = {
          t: 'n',
          v: toExcelSerial(dateValue),
          z: inferDateCellFormat(row[columnIndex])
        };
      });
    });

    textFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const textValue = row[columnIndex];

        if (textValue === null || textValue === undefined || textValue === '') {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = {
          t: 's',
          v: String(textValue),
          z: '@'
        };
      });
    });
  });
}

function writeWorkbookRows({ rows, outputFilePath, sheetName = 'COMMON' }, formatters) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  applyExportFieldFormats(worksheet, rows, formatters);

  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  XLSX.writeFile(workbook, outputFilePath);

  return outputFilePath;
}

function writeBalanceWorkbook({
  templateFilePath,
  records,
  templateFields = [],
  outputFilePath
}, formatters) {
  const workbook = XLSX.readFile(templateFilePath, {
    cellNF: true,
    cellStyles: true,
    raw: true
  });
  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    throw new FileValidationError('FILE_READ', '余额账单模板不可读，请重新确认');
  }

  const worksheet = workbook.Sheets[sheetName];
  const fallbackRows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    blankrows: false,
    defval: ''
  });
  const headerFields = templateFields.length
    ? templateFields
    : (fallbackRows[0] || []).map((value) => normalizeCell(value)).filter((value) => value !== '');

  if (!headerFields.length) {
    throw new FileValidationError('FILE_READ', '余额账单模板为空或不可读，请重新确认');
  }

  const columnCount = headerFields.length;
  const existingRange = worksheet['!ref']
    ? XLSX.utils.decode_range(worksheet['!ref'])
    : {
        s: { c: 0, r: 0 },
        e: { c: columnCount - 1, r: 0 }
      };

  for (let rowIndex = 1; rowIndex <= existingRange.e.r; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < Math.max(existingRange.e.c + 1, columnCount); columnIndex += 1) {
      delete worksheet[XLSX.utils.encode_cell({ c: columnIndex, r: rowIndex })];
    }
  }

  const normalizedRecords = records.map((row) => {
    const normalizedRow = Array.isArray(row) ? row.slice(0, columnCount) : [];

    while (normalizedRow.length < columnCount) {
      normalizedRow.push('');
    }

    return normalizedRow;
  });

  XLSX.utils.sheet_add_aoa(worksheet, normalizedRecords, { origin: 'A2' });
  applyBalanceFieldFormats(worksheet, headerFields, normalizedRecords, formatters);
  worksheet['!ref'] = `A1:${XLSX.utils.encode_col(columnCount - 1)}${Math.max(normalizedRecords.length + 1, 2)}`;

  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  XLSX.writeFile(workbook, outputFilePath);
  return outputFilePath;
}

module.exports = {
  applyBalanceFieldFormats,
  applyExportFieldFormats,
  writeBalanceWorkbook,
  writeWorkbookRows
};
