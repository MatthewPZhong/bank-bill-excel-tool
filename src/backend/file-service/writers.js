const fs = require('node:fs');
const path = require('node:path');
// v1.5.3 R3：切换到 xlsx-js-style 以支持写入单元格样式（cell.s.font 等）
// 仅 writers.js 内部切换，其它文件仍用 xlsx（减少打包体积）
const XLSX = require('xlsx-js-style');
const { FileValidationError, isWorksheetWritableText, normalizeCell } = require('./common');
const { applyWatermark } = require('../../main-process/workbook-watermark');

// v1.5.3 R3：给表头行（第 1 行）每个单元格注入 Courier New 字体
// 决策 D14：字体名写死 'Courier New'，不加可选参数、不加回退链
// v2.0.0：字号固定为 10pt（之前未显式设置，继承 xlsx-js-style 默认 Calibri 11pt）
// 只改 font.name 和 font.sz，保留单元格原有其它样式（颜色、粗体等）
function applyHeaderRowFont(worksheet, headerRowIndex = 0) {
  if (!worksheet || !worksheet['!ref']) {
    return;
  }

  const range = XLSX.utils.decode_range(worksheet['!ref']);
  if (headerRowIndex < range.s.r || headerRowIndex > range.e.r) {
    return;
  }

  for (let c = range.s.c; c <= range.e.c; c += 1) {
    const addr = XLSX.utils.encode_cell({ r: headerRowIndex, c });
    const cell = worksheet[addr];
    if (!cell) continue;
    const existingStyle = cell.s || {};
    const existingFont = existingStyle.font || {};
    cell.s = {
      ...existingStyle,
      font: { ...existingFont, name: 'Courier New', sz: 10 }
    };
  }
}

const WORKSHEET_LITERAL_ESCAPE_PATTERN = /_(?=[xX][0-9A-Fa-f]{4})/g;
const UNWRITABLE_TEXT_DETAIL_LIMIT = 20;

// v3.2.22 B113：写出器把控制字符编码成 _xHHHH_，却不转义文本里字面的 _xHHHH_；Excel 与读取库读取时所有 _xHHHH_ 都按转义
//   还原（FEE_x0041_ 读成 FEEA；REF_x0041 后接回车时与回车的写出编码 _x000d_ 拼成 _x0041_），两个不同的流水号、参考号可能
//   变成同一个值。写出前把文本中「_ 后接 x + 4 位十六进制」的下划线写成 _x005F_（OOXML 对下划线本身的转义），读回即为原文。
//   只改即将写出的工作表对象（含表头与模板原有的文本），不改调用方的行数据；数值、日期单元格不受影响。
//   同时核对文本能否原样写入：含 U+FFFE、U+FFFF（XML 1.0 禁止，工作表无法解析）或未配对代理项（写出后变成「�」）时整份拒绝，
//   列出行号与列名（不写文件名：内部文件名可能含账号），不交付无法打开或被改写的文件（网银账单生成已在映射阶段按源行拒绝，
//   这里兜底其他调用方）。
function prepareWorkbookTextForWrite(workbook) {
  const unwritable = [];
  (workbook.SheetNames || []).forEach((sheetName) => {
    const worksheet = workbook.Sheets && workbook.Sheets[sheetName];
    if (!worksheet) return;
    Object.keys(worksheet).forEach((address) => {
      if (address[0] === '!') return;
      const cell = worksheet[address];
      if (!cell || typeof cell.v !== 'string') return;
      if (!isWorksheetWritableText(cell.v)) {
        const { r, c } = XLSX.utils.decode_cell(address);
        const headerCell = worksheet[XLSX.utils.encode_cell({ r: 0, c })];
        const header = r > 0 && headerCell && typeof headerCell.v === 'string' && isWorksheetWritableText(headerCell.v)
          ? `「${headerCell.v}」列`
          : `${XLSX.utils.encode_col(c)} 列`;
        unwritable.push({ r, c, label: `第 ${r + 1} 行${header}` });
        return;
      }
      if (cell.v.includes('_')) cell.v = cell.v.replace(WORKSHEET_LITERAL_ESCAPE_PATTERN, '_x005F_');
    });
  });
  if (!unwritable.length) return;
  unwritable.sort((left, right) => left.r - right.r || left.c - right.c);
  const detailLines = unwritable.slice(0, UNWRITABLE_TEXT_DETAIL_LIMIT).map((item) => item.label);
  if (unwritable.length > UNWRITABLE_TEXT_DETAIL_LIMIT) {
    detailLines.push(`另有 ${unwritable.length - UNWRITABLE_TEXT_DETAIL_LIMIT} 处，共 ${unwritable.length} 处`);
  }
  throw new FileValidationError(
    'FILE_READ',
    `${unwritable[0].label}的值含无法写入 Excel 的字符（U+FFFE、U+FFFF 或不完整的 Unicode 字符）${unwritable.length > 1 ? `等 ${unwritable.length} 处` : ''}，请修正后重新生成`,
    { detailLines }
  );
}

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
  applyHeaderRowFont(worksheet, 0);

  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  prepareWorkbookTextForWrite(workbook);
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  applyWatermark(workbook);
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
  applyHeaderRowFont(worksheet, 0);
  prepareWorkbookTextForWrite(workbook);

  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  applyWatermark(workbook);
  XLSX.writeFile(workbook, outputFilePath);
  return outputFilePath;
}

module.exports = {
  applyBalanceFieldFormats,
  applyExportFieldFormats,
  buildNumericCellValue,
  prepareWorkbookTextForWrite,
  writeBalanceWorkbook,
  writeWorkbookRows
};
