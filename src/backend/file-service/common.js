const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const FIXED_FIELD_VALUE_PREFIX = '__FIXED__:';

class FileValidationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'FileValidationError';
    this.code = code;
    this.detailLines = Array.isArray(options.detailLines) ? options.detailLines.slice() : [];
    this.context = options.context && typeof options.context === 'object' ? { ...options.context } : {};
  }
}

function normalizeCell(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function isRowMeaningful(row) {
  return Array.isArray(row) && row.some((cell) => normalizeCell(cell) !== '');
}

function trimTrailingEmptyCells(row) {
  if (!Array.isArray(row)) {
    return [];
  }

  const lastMeaningfulIndex = row.reduce((index, cell, currentIndex) => {
    return normalizeCell(cell) !== '' ? currentIndex : index;
  }, -1);

  if (lastMeaningfulIndex < 0) {
    return [];
  }

  return row.slice(0, lastMeaningfulIndex + 1);
}

module.exports = {
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  SUPPORTED_EXTENSIONS,
  isRowMeaningful,
  normalizeCell,
  trimTrailingEmptyCells
};
