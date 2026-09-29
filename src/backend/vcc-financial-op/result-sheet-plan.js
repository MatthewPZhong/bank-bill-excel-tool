'use strict';

const { createHash } = require('node:crypto');

const RESULT_WORKBOOK_LAYOUT = 'subject-sheets-v1';
const RESULT_SUFFIX = '-结果表';
const PENDING_SUFFIX = '-移除归档Pending发生额计算表';
const MAX_SHEET_NAME_LENGTH = 31;

function truncateSheetName(value, maxLength) {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
}

function allocateSheetName(subject, kind, occupied) {
  const suffix = kind === 'result-main' ? RESULT_SUFFIX : PENDING_SUFFIX;
  const clean = subject.replace(/[\\/:*?\[\]\u0000-\u001f\u007f-\u009f]/g, '_')
    .replace(/^[\s']+|[\s']+$/g, '') || '主体';
  let name = `${clean}${suffix}`;
  let attempt = 0;
  // upper 与 workbook-parts 的读取规则一致，涵盖 ß → SS 等 Unicode 大写展开。
  // lower 保留 ExcelJS 回读的兼容规则；例如 ß/ẞ 只按 upper 判断仍会重名。
  while (name.length > MAX_SHEET_NAME_LENGTH || occupied.upper.has(name.toUpperCase())
      || occupied.lower.has(name.toLowerCase())
      || name.toUpperCase() === 'HISTORY') {
    const digest = createHash('sha256').update(JSON.stringify([subject, kind, attempt++])).digest('hex').slice(0, 8);
    const ending = `~${digest}${suffix}`;
    name = `${truncateSheetName(clean, MAX_SHEET_NAME_LENGTH - ending.length)}${ending}`;
  }
  occupied.upper.add(name.toUpperCase());
  occupied.lower.add(name.toLowerCase());
  return name;
}

function createResultWorkbookSheetPlan({ subjects, runId, resultRevision, inputFingerprint, maxSheets = 4096 }) {
  if (!Array.isArray(subjects) || subjects.length < 1
      || subjects.some((subject) => typeof subject !== 'string' || !subject.trim() || !subject.isWellFormed())
      || new Set(subjects).size !== subjects.length) {
    throw new TypeError('正式结果主体身份不能为空或重复');
  }
  if (!Number.isSafeInteger(maxSheets) || maxSheets < 2 || maxSheets > 4096
      || subjects.length * 2 > maxSheets) {
    throw Object.assign(new Error('正式结果工作表数量超过读取预算'), { code: 'vcc-result-export-resource-limit' });
  }
  const occupied = { upper: new Set(), lower: new Set() };
  const sheets = ['result-main', 'result-pending'].flatMap((kind) => subjects.map((subject, subjectIndex) => (
    Object.freeze({ ordinal: (kind === 'result-main' ? 0 : subjects.length) + subjectIndex,
      subjectIndex, kind, subject, name: allocateSheetName(subject, kind, occupied) })
  )));
  return Object.freeze({ layout: RESULT_WORKBOOK_LAYOUT, kind: 'result', runId, resultRevision, inputFingerprint,
    artifactCount: 1, subjectCount: subjects.length, sheetCount: sheets.length,
    subjectOrder: Object.freeze([...subjects]), sheets: Object.freeze(sheets) });
}

function quoteSheetName(name) { return `'${String(name).replace(/'/g, "''")}'`; }

module.exports = { RESULT_WORKBOOK_LAYOUT, createResultWorkbookSheetPlan, quoteSheetName, truncateSheetName };
