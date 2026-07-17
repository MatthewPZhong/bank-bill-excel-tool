'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeCell } = require('../backend/file-service/common');
const { createRowFilter } = require('./toolbox');

const MAX_MULTI_SPLIT_GROUPS = 8;
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID_FILE_NAME_CHAR = /[<>:"/\\|?*\u0000-\u001f]/;

class ToolboxMultiSplitValidationError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'ToolboxMultiSplitValidationError';
    this.detailLines = Array.isArray(detailLines) ? detailLines.slice() : [];
  }
}

class ToolboxMultiSplitPublishError extends Error {
  constructor(message, detailLines = [], options = {}) {
    super(message);
    this.name = 'ToolboxMultiSplitPublishError';
    this.detailLines = Array.isArray(detailLines) ? detailLines.slice() : [];
    this.preserveTemporaryFiles = options.preserveTemporaryFiles === true;
  }
}

function normalizeSplitOutputFileName(input) {
  const raw = String(input == null ? '' : input);
  if (raw.trim() === '') {
    throw new ToolboxMultiSplitValidationError('文件名不能为空');
  }
  if (raw !== raw.trim()) {
    throw new ToolboxMultiSplitValidationError(`文件名「${raw}」不能以空格开头或结尾`);
  }
  if (INVALID_FILE_NAME_CHAR.test(raw)) {
    throw new ToolboxMultiSplitValidationError(`文件名「${raw}」包含系统不允许的字符`);
  }

  let baseName = raw;
  while (/\.xlsx$/i.test(baseName)) {
    baseName = baseName.slice(0, -5);
  }
  if (baseName === '' || /[.\s]$/.test(baseName)) {
    throw new ToolboxMultiSplitValidationError(`文件名「${raw}」不能以点或空格结尾`);
  }
  if (baseName === '.' || baseName === '..' || WINDOWS_RESERVED_BASENAME.test(baseName)) {
    throw new ToolboxMultiSplitValidationError(`文件名「${raw}」为系统保留名称`);
  }
  return `${baseName}.xlsx`;
}

function normalizeMultiSplitGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new ToolboxMultiSplitValidationError('请至少配置一个拆分文件分组');
  }
  if (groups.length > MAX_MULTI_SPLIT_GROUPS) {
    throw new ToolboxMultiSplitValidationError(`最多只能配置 ${MAX_MULTI_SPLIT_GROUPS} 个拆分文件分组`);
  }

  const seenNames = new Map();
  return groups.map((group, index) => {
    const number = index + 1;
    const fileName = normalizeSplitOutputFileName(group && group.fileName);
    const duplicateKey = fileName.toLocaleLowerCase('en-US');
    if (seenNames.has(duplicateKey)) {
      throw new ToolboxMultiSplitValidationError(
        `文件${number}与文件${seenNames.get(duplicateKey)}的文件名重复`,
        [`重复文件名：${fileName}`]
      );
    }
    seenNames.set(duplicateKey, number);

    const field = normalizeCell(group && group.field);
    if (!field) {
      throw new ToolboxMultiSplitValidationError(`文件${number}未选择拆分字段`);
    }
    const sourceValues = Array.isArray(group && group.values) ? group.values : [];
    const values = [];
    const seenValues = new Set();
    for (const sourceValue of sourceValues) {
      const value = normalizeCell(sourceValue);
      if (seenValues.has(value)) continue;
      seenValues.add(value);
      values.push(value);
    }
    if (values.length === 0) {
      throw new ToolboxMultiSplitValidationError(`文件${number}请至少选择一个值`);
    }
    return { fileName, field, values };
  });
}

function createMultipleRowFilters(normalizedHeaders, groups) {
  const headers = Array.isArray(normalizedHeaders) ? normalizedHeaders : [];
  return groups.map((group, index) => {
    const filter = createRowFilter(headers, group.field, group.values);
    if (!filter.fieldFound) {
      throw new ToolboxMultiSplitValidationError(
        `源文件中找不到字段「${group.field}」`,
        [`文件${index + 1}：${group.fileName}`, `源文件表头：${headers.join(' | ') || '（空）'}`]
      );
    }
    return { ...group, matches: filter.matches };
  });
}

function publishPreparedSplitFiles(preparedFiles, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const plans = Array.isArray(preparedFiles) ? preparedFiles : [];
  if (plans.length === 0) {
    throw new ToolboxMultiSplitPublishError('没有可发布的拆分文件');
  }

  const targetKeys = new Set();
  for (const plan of plans) {
    if (!plan || !plan.temporaryPath || !plan.targetPath || !fsImpl.existsSync(plan.temporaryPath)) {
      throw new ToolboxMultiSplitPublishError('拆分文件生成不完整，未发布任何文件');
    }
    const temporaryStat = (typeof fsImpl.lstatSync === 'function' ? fsImpl.lstatSync : fs.lstatSync)(plan.temporaryPath);
    if (!temporaryStat.isFile()) {
      throw new ToolboxMultiSplitPublishError('拆分临时产物不是可发布文件，未发布任何文件');
    }
    if (fsImpl.existsSync(plan.targetPath)) {
      const targetStat = (typeof fsImpl.lstatSync === 'function' ? fsImpl.lstatSync : fs.lstatSync)(plan.targetPath);
      if (!targetStat.isFile()) {
        throw new ToolboxMultiSplitPublishError(
          `目标路径「${plan.targetPath}」不是可覆盖的普通文件，未发布任何文件`
        );
      }
    }
    const key = path.resolve(plan.targetPath).toLocaleLowerCase('en-US');
    if (targetKeys.has(key)) {
      throw new ToolboxMultiSplitPublishError('拆分文件目标路径重复，未发布任何文件');
    }
    targetKeys.add(key);
  }

  const backups = [];
  const published = [];
  try {
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      if (!fsImpl.existsSync(plan.targetPath)) continue;
      const backupPath = `${plan.temporaryPath}.existing-${index}`;
      fsImpl.renameSync(plan.targetPath, backupPath);
      backups.push({ targetPath: plan.targetPath, backupPath });
    }

    for (const plan of plans) {
      fsImpl.renameSync(plan.temporaryPath, plan.targetPath);
      published.push(plan.targetPath);
    }

    for (const backup of backups) {
      try { fsImpl.rmSync(backup.backupPath, { force: true }); } catch (_e) { /* temp dir cleanup is the final fallback */ }
    }
    return plans.map((plan) => ({
      filePath: plan.targetPath,
      fileName: plan.fileName || path.basename(plan.targetPath),
      matchedCount: Number(plan.matchedCount) || 0
    }));
  } catch (error) {
    const rollbackErrors = [];
    for (let index = published.length - 1; index >= 0; index -= 1) {
      try { fsImpl.rmSync(published[index], { force: true }); } catch (rollbackError) {
        rollbackErrors.push(`删除本批文件失败：${published[index]}（${rollbackError.message}）`);
      }
    }
    for (let index = backups.length - 1; index >= 0; index -= 1) {
      const backup = backups[index];
      try {
        if (fsImpl.existsSync(backup.targetPath)) {
          fsImpl.rmSync(backup.targetPath, { force: true });
        }
        if (fsImpl.existsSync(backup.backupPath)) {
          fsImpl.renameSync(backup.backupPath, backup.targetPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`恢复原文件失败：${backup.targetPath}（${rollbackError.message}）`);
      }
    }
    const recoveryFiles = backups
      .filter((backup) => fsImpl.existsSync(backup.backupPath))
      .map((backup) => backup.backupPath);
    throw new ToolboxMultiSplitPublishError(
      rollbackErrors.length === 0 ? '批量发布失败，已恢复原文件' : '批量发布失败，部分原文件恢复失败',
      [
        `原始错误：${error && error.message ? error.message : String(error)}`,
        ...rollbackErrors,
        ...recoveryFiles.map((filePath) => `原文件备份保留于：${filePath}`)
      ],
      { preserveTemporaryFiles: recoveryFiles.length > 0 }
    );
  }
}

module.exports = {
  MAX_MULTI_SPLIT_GROUPS,
  ToolboxMultiSplitValidationError,
  ToolboxMultiSplitPublishError,
  normalizeSplitOutputFileName,
  normalizeMultiSplitGroups,
  createMultipleRowFilters,
  publishPreparedSplitFiles
};
