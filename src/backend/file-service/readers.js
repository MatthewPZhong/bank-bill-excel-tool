const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const XLSX = require('xlsx');
const {
  FileValidationError,
  SUPPORTED_EXTENSIONS,
  isRowMeaningful,
  normalizeCell,
  trimTrailingEmptyCells
} = require('./common');

function ensureSupportedFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new FileValidationError('FILE_TYPE', '文件类型错误，请重新导入');
  }
}

function readPdfRows(filePath) {
  try {
    const workerScriptPath = path.join(__dirname, 'pdf-worker.js');
    const output = execFileSync(process.execPath, [workerScriptPath, filePath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      },
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8'
    });
    const payload = JSON.parse(output);
    return Array.isArray(payload.rows) ? payload.rows : [];
  } catch (error) {
    if (error instanceof FileValidationError) {
      throw error;
    }

    throw new FileValidationError('FILE_READ', 'PDF 文件无法识别或不可读，请重新导入');
  }
}

function parseCsvText(content, { blankrows = false } = {}) {
  const rows = [];
  let current = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"' && content[i + 1] === '"') {
        cell += '"';
        i += 2;
      } else if (ch === '"') {
        inQuotes = false;
        i++;
      } else {
        cell += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ',') {
      current.push(cell);
      cell = '';
      i++;
    } else if (ch === '\r' && content[i + 1] === '\n') {
      current.push(cell);
      cell = '';
      rows.push(current);
      current = [];
      i += 2;
    } else if (ch === '\n' || ch === '\r') {
      current.push(cell);
      cell = '';
      rows.push(current);
      current = [];
      i++;
    } else {
      cell += ch;
      i++;
    }
  }

  if (cell || current.length) {
    current.push(cell);
    rows.push(current);
  }

  if (blankrows) {
    return rows;
  }

  return rows.filter((row) => isRowMeaningful(row));
}

function readWorkbookRows(filePath, { blankrows = false } = {}) {
  ensureSupportedFile(filePath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  if (path.extname(filePath).toLowerCase() === '.pdf') {
    const rows = readPdfRows(filePath);
    return blankrows ? rows : rows.filter((row) => isRowMeaningful(row));
  }

  if (path.extname(filePath).toLowerCase() === '.csv') {
    try {
      const raw = fs.readFileSync(filePath);
      const content = raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF
        ? raw.subarray(3).toString('utf-8')
        : raw.toString('utf-8');
      return parseCsvText(content, { blankrows });
    } catch (error) {
      if (error instanceof FileValidationError) {
        throw error;
      }
      throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
    }
  }

  try {
    const workbook = XLSX.readFile(filePath, {
      cellDates: false,
      dense: true,
      raw: false
    });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
    }

    const sheet = workbook.Sheets[firstSheetName];
    return XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows,
      defval: ''
    });
  } catch (error) {
    if (error instanceof FileValidationError) {
      throw error;
    }

    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }
}

function readRows(filePath) {
  const rows = readWorkbookRows(filePath, { blankrows: false });

  if (!Array.isArray(rows) || rows.length === 0 || !rows.some(isRowMeaningful)) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  return rows;
}

function countNonEmptyCells(cells = []) {
  return cells.reduce((count, cell) => count + (normalizeCell(cell) !== '' ? 1 : 0), 0);
}

function getFirstNonEmptyCell(cells = []) {
  return cells.find((cell) => normalizeCell(cell) !== '') || '';
}

function isRepeatedMatchedHeader(cells, normalizedExpectedHeaders) {
  return cells.every((cell, headerIndex) => normalizeCell(cell) === normalizedExpectedHeaders[headerIndex]);
}

function shouldStopPdfMatchedRows(cells) {
  const meaningfulCount = countNonEmptyCells(cells);
  const firstCell = normalizeCell(getFirstNonEmptyCell(cells)).toLowerCase();

  if (meaningfulCount > 2 || !firstCell) {
    return false;
  }

  return [
    'named account',
    'account summary',
    'statement summary',
    'please review',
    'thank you',
    'nb:'
  ].some((keyword) => firstCell.includes(keyword));
}

function shouldSkipPdfMatchedRow(cells, expectedHeaderCount) {
  const meaningfulCount = countNonEmptyCells(cells);

  if (meaningfulCount === 0) {
    return true;
  }

  return meaningfulCount < Math.max(4, Math.min(5, expectedHeaderCount));
}

function collectMatchedRows({
  meaningfulRows,
  matchedRowIndex,
  matchedColumnIndex,
  normalizedExpectedHeaders,
  isPdfFile = false
}) {
  const expectedHeaderCount = normalizedExpectedHeaders.length;
  const rows = [];
  const rowNumbers = [];
  const headerBreaks = [];
  const summaryLabels = ['总收入笔数', '总收入金额', '总支出笔数', '总支出金额'];

  for (const [index, row] of meaningfulRows.slice(matchedRowIndex).entries()) {
    const normalizedCells = row.cells.slice(matchedColumnIndex, matchedColumnIndex + expectedHeaderCount);

    while (normalizedCells.length < expectedHeaderCount) {
      normalizedCells.push('');
    }

    if (
      index > 0 &&
      summaryLabels.some((label) => normalizeCell(normalizedCells[0]).includes(label))
    ) {
      break;
    }

    if (index > 0 && isRepeatedMatchedHeader(normalizedCells, normalizedExpectedHeaders)) {
      headerBreaks.push(row.rowNumber);
      continue;
    }

    if (index > 0 && !isRowMeaningful(normalizedCells)) {
      continue;
    }

    if (index > 0 && isPdfFile) {
      if (shouldStopPdfMatchedRows(normalizedCells)) {
        break;
      }

      if (shouldSkipPdfMatchedRow(normalizedCells, expectedHeaderCount)) {
        continue;
      }
    }

    rows.push(normalizedCells);
    rowNumbers.push(row.rowNumber);
  }

  return {
    rows,
    rowNumbers,
    headerBreaks
  };
}

function readRowsWithMetadata(filePath, expectedHeaders = []) {
  const rawRows = readWorkbookRows(filePath, { blankrows: true });
  const normalizedExpectedHeaders = Array.isArray(expectedHeaders)
    ? expectedHeaders.map((header) => normalizeCell(header)).filter((header) => header !== '')
    : [];
  const meaningfulRows = rawRows
    .map((row, index) => ({
      rowNumber: index + 1,
      cells: trimTrailingEmptyCells(Array.isArray(row) ? row : [])
    }))
    .filter((row) => isRowMeaningful(row.cells));

  if (!meaningfulRows.length) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  if (!normalizedExpectedHeaders.length) {
    return {
      rows: meaningfulRows.map((row) => row.cells),
      rowNumbers: meaningfulRows.map((row) => row.rowNumber)
    };
  }

  const expectedHeaderCount = normalizedExpectedHeaders.length;
  let matchedRowIndex = -1;
  let matchedColumnIndex = -1;

  meaningfulRows.some((row, rowIndex) => {
    const maximumStartIndex = row.cells.length - expectedHeaderCount;

    for (let startIndex = 0; startIndex <= maximumStartIndex; startIndex += 1) {
      const candidateHeaders = row.cells
        .slice(startIndex, startIndex + expectedHeaderCount)
        .map((cell) => normalizeCell(cell));

      if (candidateHeaders.every((cell, index) => cell === normalizedExpectedHeaders[index])) {
        matchedRowIndex = rowIndex;
        matchedColumnIndex = startIndex;
        return true;
      }
    }

    return false;
  });

  if (matchedRowIndex < 0 || matchedColumnIndex < 0) {
    throw new FileValidationError(
      'FILE_READ',
      '当前导入文件未匹配到所选模板的表头，请确认模板或原始网银账单是否正确'
    );
  }

  return collectMatchedRows({
    meaningfulRows,
    matchedRowIndex,
    matchedColumnIndex,
    normalizedExpectedHeaders,
    isPdfFile: path.extname(filePath).toLowerCase() === '.pdf'
  });
}

function extractHeaders(filePath) {
  const rows = readRows(filePath);
  const headerRow = rows[0];

  if (!isRowMeaningful(headerRow)) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  const lastMeaningfulIndex = headerRow.reduce((index, cell, currentIndex) => {
    return normalizeCell(cell) !== '' ? currentIndex : index;
  }, -1);

  if (lastMeaningfulIndex < 0) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  return headerRow.slice(0, lastMeaningfulIndex + 1).map((cell) => normalizeCell(cell));
}

function loadEnumValues(enumFilePath) {
  const rows = readRows(enumFilePath);
  const firstRow = rows[0] || [];
  const shouldSkipFirstRow =
    firstRow.filter((cell) => normalizeCell(cell) !== '').length === 1 &&
    ['common字段', '映射字段', '枚举值'].includes(normalizeCell(firstRow[0]).toLowerCase());
  const values = [];
  const seen = new Set();

  rows.forEach((row, rowIndex) => {
    if (rowIndex === 0 && shouldSkipFirstRow) {
      return;
    }

    const value = normalizeCell(row[0]);

    if (!value || seen.has(value)) {
      return;
    }

    seen.add(value);
    values.push(value);
  });

  return values;
}

function extractEnumValuesFromImportedFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);

  if (extension !== '.xlsx' || !fileName.includes('枚举')) {
    throw new FileValidationError('FILE_TYPE', '请导入文件名带有“枚举”的xlsx文件');
  }

  const values = loadEnumValues(filePath);

  if (!values.length) {
    throw new FileValidationError('FILE_READ', '枚举表为空或不可读，请重新导入');
  }

  return values;
}

module.exports = {
  collectMatchedRows,
  ensureSupportedFile,
  extractEnumValuesFromImportedFile,
  extractHeaders,
  loadEnumValues,
  readRows,
  readRowsWithMetadata
};
