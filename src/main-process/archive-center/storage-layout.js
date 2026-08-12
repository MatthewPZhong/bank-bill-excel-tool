'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const STORAGE_LAYOUT_VERSION = 2;
const MAX_WINDOWS_PATH_LENGTH = 240;
const DEFAULT_FILE_NAME_LENGTH = 160;
const WINDOWS_INVALID_RE = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class StorageLayoutError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageLayoutError';
    this.code = code;
  }
}

function normalizeLocalDate(localDate) {
  const value = String(localDate || '');
  if (!LOCAL_DATE_RE.test(value)) {
    throw new StorageLayoutError('ARCHIVE_LAYOUT_DATE_INVALID', '目录日期必须为 YYYY-MM-DD');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new StorageLayoutError('ARCHIVE_LAYOUT_DATE_INVALID', '目录日期不是有效日历日期');
  }
  return value;
}

function batchDirectoryName(batchNumber) {
  const value = String(batchNumber || '');
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\u0000')) {
    throw new StorageLayoutError('ARCHIVE_LAYOUT_BATCH_INVALID', '批次号不能作为安全目录名');
  }
  return value;
}

function batchRelativeDirectory(batch) {
  const localDate = normalizeLocalDate(batch && batch.localDate);
  const batchNumber = batchDirectoryName(batch && batch.batchNumber);
  const year = localDate.slice(0, 4);
  const month = localDate.slice(0, 7);
  return [year, month, localDate, batchNumber].join('/');
}

function splitFileName(fileName) {
  const extension = path.extname(fileName);
  return {
    stem: extension ? fileName.slice(0, -extension.length) : fileName,
    extension
  };
}

function trimToLength(value, maxLength) {
  const source = String(value || '');
  let end = Math.min(source.length, Math.max(0, maxLength));
  if (end > 0
      && end < source.length
      && /[\uD800-\uDBFF]/.test(source[end - 1])
      && /[\uDC00-\uDFFF]/.test(source[end])) {
    end -= 1;
  }
  return source.slice(0, end);
}

function shortenFileName(fileName, maxLength, identity) {
  if (fileName.length <= maxLength) return fileName;
  const digest = crypto.createHash('sha256').update(String(identity || fileName)).digest('hex').slice(0, 8);
  const { stem, extension } = splitFileName(fileName);
  const suffix = `-${digest}`;
  const extensionBudget = Math.max(0, maxLength - suffix.length - 1);
  const safeExtension = trimToLength(extension, Math.min(extension.length, extensionBudget));
  const stemBudget = Math.max(1, maxLength - suffix.length - safeExtension.length);
  return `${trimToLength(stem, stemBudget)}${suffix}${safeExtension}`;
}

function sanitizeOriginalName(originalName, options = {}) {
  const raw = String(originalName || '').split(/[\\/]/).pop() || '未命名文件';
  let safe = raw.replace(WINDOWS_INVALID_RE, '_').replace(/[ .]+$/g, '');
  if (!safe || safe === '.' || safe === '..') safe = '未命名文件';
  if (WINDOWS_RESERVED_RE.test(safe)) safe = `_${safe}`;
  const maxLength = Number.isSafeInteger(options.maxLength) && options.maxLength >= 24
    ? options.maxLength
    : DEFAULT_FILE_NAME_LENGTH;
  return shortenFileName(safe, maxLength, options.identity || raw);
}

function addDuplicateSuffix(fileName, occurrence, maxLength, identity) {
  if (occurrence <= 1) return shortenFileName(fileName, maxLength, identity);
  const { stem, extension } = splitFileName(fileName);
  const suffix = ` (${occurrence})`;
  const extensionBudget = Math.max(0, maxLength - suffix.length - 1);
  const safeExtension = trimToLength(extension, Math.min(extension.length, extensionBudget));
  const stemBudget = Math.max(1, maxLength - safeExtension.length - suffix.length);
  const shortenedStem = stem.length > stemBudget
    ? shortenFileName(stem, stemBudget, identity)
    : stem;
  return `${shortenedStem}${suffix}${safeExtension}`;
}

function availableFileName(originalName, usedNames, options = {}) {
  const maxLength = options.maxLength || DEFAULT_FILE_NAME_LENGTH;
  const baseName = sanitizeOriginalName(originalName, { ...options, maxLength });
  let occurrence = 1;
  while (true) {
    const candidate = addDuplicateSuffix(baseName, occurrence, maxLength, options.identity || originalName);
    const lookup = candidate.toLocaleLowerCase('en-US');
    if (!usedNames.has(lookup)) {
      usedNames.add(lookup);
      return candidate;
    }
    occurrence += 1;
  }
}

function fileNameLengthForRoot(rootDir, batchRelativeDir) {
  const prefixLength = path.resolve(rootDir).length
    + 1
    + batchRelativeDir.split('/').join(path.sep).length
    + 1;
  const available = MAX_WINDOWS_PATH_LENGTH - prefixLength;
  if (available < 24) {
    throw new StorageLayoutError(
      'ARCHIVE_LAYOUT_PATH_TOO_LONG',
      '存档根路径过长，无法生成 Windows 可用的批次文件路径'
    );
  }
  return Math.min(DEFAULT_FILE_NAME_LENGTH, available);
}

function resolveManagedRelative(rootDir, relativePath) {
  const value = String(relativePath || '');
  if (!value || path.isAbsolute(value) || value.includes('\\')) {
    throw new StorageLayoutError('ARCHIVE_LAYOUT_PATH_INVALID', '目录相对路径非法');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) {
    throw new StorageLayoutError('ARCHIVE_LAYOUT_PATH_INVALID', '目录相对路径越界');
  }
  const rootPath = path.resolve(rootDir);
  const targetPath = path.resolve(rootPath, ...normalized.split('/'));
  const relation = path.relative(rootPath, targetPath);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new StorageLayoutError('ARCHIVE_LAYOUT_PATH_INVALID', '目录相对路径越界');
  }
  return targetPath;
}

function assignLayoutNames(rootDir, batch, artifacts) {
  const batchDir = batchRelativeDirectory(batch);
  const maxLength = fileNameLengthForRoot(rootDir, batchDir);
  const ordered = [...artifacts].sort((left, right) => {
    const leftOrder = left.artifactOrder == null ? Number.MAX_SAFE_INTEGER : Number(left.artifactOrder);
    const rightOrder = right.artifactOrder == null ? Number.MAX_SAFE_INTEGER : Number(right.artifactOrder);
    return leftOrder - rightOrder || Number(left.id) - Number(right.id);
  });
  const usedNames = new Set();
  const assignments = [];
  for (const artifact of ordered) {
    const persistedName = artifact.safeFileName ? sanitizeOriginalName(artifact.safeFileName, {
      maxLength,
      identity: artifact.artifactKey || artifact.id
    }) : '';
    let safeFileName = persistedName;
    if (safeFileName && !usedNames.has(safeFileName.toLocaleLowerCase('en-US'))) {
      usedNames.add(safeFileName.toLocaleLowerCase('en-US'));
    } else {
      safeFileName = availableFileName(artifact.originalName, usedNames, {
        maxLength,
        identity: artifact.artifactKey || artifact.id
      });
    }
    const storageRelativePath = `${batchDir}/${safeFileName}`;
    const absolutePath = resolveManagedRelative(rootDir, storageRelativePath);
    if (absolutePath.length > MAX_WINDOWS_PATH_LENGTH) {
      throw new StorageLayoutError(
        'ARCHIVE_LAYOUT_PATH_TOO_LONG',
        '存档文件路径超过 Windows 安全预算'
      );
    }
    assignments.push({
      artifactId: Number(artifact.id),
      artifactOrder: Number(artifact.artifactOrder),
      safeFileName,
      storageRelativePath,
      storageLayoutVersion: STORAGE_LAYOUT_VERSION
    });
  }
  return assignments;
}

module.exports = {
  DEFAULT_FILE_NAME_LENGTH,
  MAX_WINDOWS_PATH_LENGTH,
  STORAGE_LAYOUT_VERSION,
  StorageLayoutError,
  assignLayoutNames,
  availableFileName,
  batchRelativeDirectory,
  resolveManagedRelative,
  sanitizeOriginalName
};
