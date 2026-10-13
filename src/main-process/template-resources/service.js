'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { EXCLUDED_TEMPLATE_FILES, TEMPLATE_RESOURCES } = require('./catalog');

// 当前只提供内置版本；用户版本的存储、导入预检与启用待后端接入后由同一服务返回。
const BUILTIN_VERSION_ID = 'v1';
const IMPORT_UNAVAILABLE_REASON = '版本导入尚未开放';

function cellText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function trimTail(values) {
  const copy = [...values];
  while (copy.length && copy[copy.length - 1] === '') copy.pop();
  return copy;
}

// SheetJS 以 <dimension> 声明作为 !ref；部分模板的声明小于实际单元格（如 VCC 结果表），按实际单元格重算范围。
function sheetRows(sheet) {
  let lastRow = -1;
  let lastColumn = -1;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue;
    const { r, c } = XLSX.utils.decode_cell(key);
    if (r > lastRow) lastRow = r;
    if (c > lastColumn) lastColumn = c;
  }
  if (lastRow < 0) return [];
  const range = { s: { r: 0, c: 0 }, e: { r: lastRow, c: lastColumn } };
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true, range })
    .map((row) => trimTail(row.map(cellText)));
}

// 枚举口径与 src/constants/fund-type-enum.js 一致：第 1 个 Sheet 第 1 列，跳过表头，去空去重保序。
function firstColumnValues(rows) {
  const values = [];
  const seen = new Set();
  for (const row of rows.slice(1)) {
    const value = row[0] || '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

// 合并单元格只在左上角保存值；其覆盖的行在 Excel 中同样显示内容，计数时一并计入。
function filledRowCount(sheet, rows, headerIndex) {
  const filled = new Set();
  rows.forEach((row, index) => {
    if (row.length > 0) filled.add(index);
  });
  for (const merge of sheet['!merges'] || []) {
    if (!(rows[merge.s.r] || [])[merge.s.c]) continue;
    for (let index = merge.s.r; index <= merge.e.r; index += 1) filled.add(index);
  }
  return [...filled].filter((index) => index > headerIndex).length;
}

function describeWorkbook(bytes, resource) {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: false, cellHTML: false, cellText: false });
  const headerIndex = resource.headerRow - 1;
  let enumValues = null;
  const sheets = workbook.SheetNames.map((name, index) => {
    const sheet = workbook.Sheets[name];
    const rows = sheetRows(sheet);
    if (resource.type === 'enum' && index === 0) enumValues = firstColumnValues(rows);
    return {
      name,
      headerRow: resource.headerRow,
      headers: rows[headerIndex] || [],
      dataRows: filledRowCount(sheet, rows, headerIndex)
    };
  });
  return { sheets, enumValues };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createTemplateResourceService({
  appRoot,
  appVersion = '',
  readFile = fs.promises.readFile,
  stat = fs.promises.stat,
  writeFile = fs.promises.writeFile
} = {}) {
  if (!appRoot) throw new Error('模板文件服务缺少应用目录');
  const inspections = new Map();

  const findResource = (resourceId) => TEMPLATE_RESOURCES.find((item) => item.id === String(resourceId || '')) || null;
  const absolutePath = (resource) => path.join(appRoot, ...resource.path.split('/'));
  const fileNameOf = (resource) => path.posix.basename(resource.path);

  // 内置文件只读；按大小与修改时间复用解析结果，开发环境改动文件后会重新读取。
  // 失败不缓存：权限、占用等临时错误解除后文件签名通常不变，下次请求需重新读取。
  async function inspect(resource) {
    const filePath = absolutePath(resource);
    let info;
    try {
      info = await stat(filePath);
    } catch (_error) {
      return { error: '文件不存在或无法访问' };
    }
    const signature = `${info.size}:${info.mtimeMs}`;
    const cached = inspections.get(resource.id);
    if (cached && cached.signature === signature) return cached;
    try {
      const bytes = await readFile(filePath);
      const record = { signature, size: bytes.length, sha256: sha256(bytes), ...describeWorkbook(bytes, resource) };
      inspections.set(resource.id, record);
      return record;
    } catch (error) {
      return { signature, size: info.size, error: `文件读取失败：${error && error.message ? error.message : '未知错误'}` };
    }
  }

  function builtinVersion(resource, record) {
    return {
      id: BUILTIN_VERSION_ID,
      label: 'V1',
      source: 'builtin',
      current: true,
      fileName: fileNameOf(resource),
      size: Number.isFinite(record.size) ? record.size : null,
      appVersion,
      tasks: []
    };
  }

  function summary(resource, record) {
    const fileName = fileNameOf(resource);
    return {
      id: resource.id,
      name: fileName.replace(/\.xlsx?$/i, ''),
      fileName,
      path: resource.path,
      type: resource.type,
      readMode: resource.readMode,
      bindings: resource.bindings.map((item) => ({ ...item })),
      sheets: record.sheets || [],
      enumValues: record.enumValues || null,
      readError: record.error || '',
      cache: resource.cache,
      failure: resource.failure,
      effect: resource.effect,
      twin: resource.twin,
      currentTemplate: resource.currentTemplate,
      current: builtinVersion(resource, record),
      capabilities: {
        saveAs: !record.error,
        importVersion: false,
        importReason: resource.replace.allowed ? IMPORT_UNAVAILABLE_REASON : resource.replace.reason,
        setCurrent: false,
        deleteVersion: false,
        restoreDefault: false
      }
    };
  }

  async function list() {
    const resources = [];
    for (const resource of TEMPLATE_RESOURCES) resources.push(summary(resource, await inspect(resource)));
    return {
      status: 'success',
      resources,
      excluded: EXCLUDED_TEMPLATE_FILES.map((item) => ({
        fileName: path.posix.basename(item.path),
        modules: [...item.modules]
      }))
    };
  }

  async function get(resourceId) {
    const resource = findResource(resourceId);
    if (!resource) return { status: 'failed', message: '模板不存在' };
    const record = await inspect(resource);
    const item = summary(resource, record);
    const current = { ...item.current, sha256: record.sha256 || '' };
    return { status: 'success', resource: { ...item, current, versions: [current], tasks: [] } };
  }

  function resolveVersion({ resourceId, versionId } = {}) {
    const resource = findResource(resourceId);
    if (!resource) return { status: 'failed', message: '模板不存在' };
    if (versionId && versionId !== BUILTIN_VERSION_ID) return { status: 'failed', message: '版本不存在' };
    const fileName = fileNameOf(resource);
    return { status: 'success', filePath: absolutePath(resource), fileName, extension: path.extname(fileName).slice(1).toLowerCase() };
  }

  async function exportVersion({ resourceId, versionId, targetPath } = {}) {
    const target = resolveVersion({ resourceId, versionId });
    if (target.status !== 'success') return target;
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) return { status: 'failed', message: '保存位置无效' };
    if (path.resolve(targetPath) === path.resolve(target.filePath)) return { status: 'failed', message: '不能覆盖内置模板' };
    try {
      await writeFile(targetPath, await readFile(target.filePath));
    } catch (error) {
      return { status: 'failed', message: `保存失败：${error && error.message ? error.message : '未知错误'}` };
    }
    return { status: 'success', filePath: targetPath, fileName: path.basename(targetPath) };
  }

  return Object.freeze({ list, get, resolveVersion, exportVersion });
}

module.exports = { BUILTIN_VERSION_ID, createTemplateResourceService };
