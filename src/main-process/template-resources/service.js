'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { EXCLUDED_TEMPLATE_FILES, TEMPLATE_RESOURCES } = require('./catalog');
const {
  MAX_IMPORT_BYTES,
  collectScenarioReferences,
  hasContract,
  inspectContract,
  usageChecks,
  verdictOf
} = require('./contracts');
const { CUSTOM_VALUE_SENTINEL } = require('../../constants/gateway-recon-headers-loader');
const { ALL_CELLS, sheetCells } = require('../../constants/sheetjs-sparse-cells');
const { writeFileAtomicDurable } = require('../background-execution/durable-file');

// 内置版本固定为 v1、随应用打包只读；用户版本 v2 起存 {userData}/template-resources/<resourceId>/<versionId>.xlsx，
// 元数据、当前版本指针与变更记录由 store（主库）维护。
const BUILTIN_VERSION_ID = 'v1';
const VERSION_ROOT_NAME = 'template-resources';
const VERSION_FILE_PATTERN = /^v(\d+)\.xlsx$/;
const STORE_UNAVAILABLE_REASON = '版本存储不可用';
const IMPORT_TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_IMPORTS = 4;
const MAX_CHANGES = 200;
const SETTINGS_HINT = '请在 设置 → 模板文件 恢复默认或重新导入';

function cellText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function trimTail(values) {
  const copy = [...values];
  while (copy.length && copy[copy.length - 1] === '') copy.pop();
  return copy;
}

// SheetJS 以 <dimension> 声明作为 !ref；部分模板的声明小于实际单元格（如 VCC 结果表），这里按全部实际单元格计算（从 A1 起）。
//   只遍历有值的单元格，不展开矩形：一个落在 XFD1048576 的零散单元格不会让主进程按整张表分配内存。
function textCells(sheet) {
  return sheetCells(sheet, ALL_CELLS)
    .map((cell) => ({ r: cell.r, c: cell.c, text: cellText(cell.value) }))
    .filter((cell) => cell.text);
}

// 某一行从 A 列起的文本（中间空列保留为空串，末尾空列去掉）。
function rowTexts(cells, rowIndex) {
  const row = [];
  for (const cell of cells) {
    if (cell.r === rowIndex) row[cell.c] = cell.text;
  }
  return trimTail(Array.from(row, (value) => value || ''));
}

// 枚举口径与 src/constants/fund-type-enum.js 一致：第 1 个 Sheet 第 1 列，跳过表头，去空去重保序。
function firstColumnValues(cells) {
  const values = [];
  const seen = new Set();
  for (const cell of cells) {
    if (cell.c !== 0 || cell.r === 0 || seen.has(cell.text)) continue;
    seen.add(cell.text);
    values.push(cell.text);
  }
  return values;
}

// 表头以下有内容的行数。合并单元格只在左上角保存值；其覆盖的行在 Excel 中同样显示内容，计数时一并计入。
//   按行区间求并集计数，不逐行展开（合并区域可以覆盖上百万行）。
function filledRowCount(sheet, cells, headerIndex) {
  const textAt = new Set(cells.map((cell) => `${cell.r}:${cell.c}`));
  const intervals = cells.map((cell) => [cell.r, cell.r]);
  for (const merge of sheet['!merges'] || []) {
    if (textAt.has(`${merge.s.r}:${merge.s.c}`)) intervals.push([merge.s.r, merge.e.r]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let count = 0;
  let counted = headerIndex;
  for (const [start, end] of intervals) {
    const from = Math.max(start, counted + 1);
    if (end < from) continue;
    count += end - from + 1;
    counted = end;
  }
  return count;
}

function describeWorkbook(bytes, resource) {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: false, cellHTML: false, cellText: false });
  const headerIndex = resource.headerRow - 1;
  let enumValues = null;
  const sheets = workbook.SheetNames.map((name, index) => {
    const sheet = workbook.Sheets[name];
    const cells = textCells(sheet);
    if (resource.type === 'enum' && index === 0) enumValues = firstColumnValues(cells);
    return {
      name,
      headerRow: resource.headerRow,
      headers: rowTexts(cells, headerIndex),
      dataRows: filledRowCount(sheet, cells, headerIndex)
    };
  });
  return { sheets, enumValues };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function errorText(error) {
  return error && error.message ? String(error.message) : '未知错误';
}

function localTimeText(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 枚举类模板与当前版本比较的取值：FundType 为第 1 列取值，网关为表头字段（与运行时 loader 同口径）。
function comparableValues(resource, structure) {
  if (resource.type === 'enum') return structure.enumValues || [];
  if (resource.id === 'gateway-recon') {
    const headers = (structure.sheets && structure.sheets[0] && structure.sheets[0].headers) || [];
    return [...new Set(headers.map(cellText).filter((value) => value && value !== CUSTOM_VALUE_SENTINEL))];
  }
  return [];
}

class TemplateResourceUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TemplateResourceUnavailableError';
    this.code = 'template-resource-unavailable';
    Object.assign(this, details);
  }
}

function createTemplateResourceService({
  appRoot,
  appVersion = '',
  userDataRoot = '',
  store = null,
  log = () => {},
  onChanged = () => {},
  now = () => new Date(),
  readFile = fs.promises.readFile,
  stat = fs.promises.stat,
  writeFile = fs.promises.writeFile,
  rename = fs.promises.rename,
  rm = fs.promises.rm,
  writeVersionFile = (filePath, bytes) => writeFileAtomicDurable(filePath, bytes)
} = {}) {
  if (!appRoot) throw new Error('模板文件服务缺少应用目录');
  const versioning = Boolean(store && userDataRoot);
  const versionRoot = versioning ? path.join(userDataRoot, VERSION_ROOT_NAME) : '';
  const inspections = new Map();
  const userInspections = new Map();
  const compatibility = new Map();
  const pickedFiles = new Set();
  const pendingImports = new Map();
  const leases = new Map();
  let leaseSequence = 0;
  let mutationQueue = Promise.resolve();
  let swept = false;

  const findResource = (resourceId) => TEMPLATE_RESOURCES.find((item) => item.id === String(resourceId || '')) || null;
  const absolutePath = (resource) => path.join(appRoot, ...resource.path.split('/'));
  const fileNameOf = (resource) => path.posix.basename(resource.path);
  const replaceable = (resource) => resource.replace.allowed === true && hasContract(resource.id);
  const versionPath = (resourceId, versionId) => path.join(versionRoot, resourceId, `${versionId}.xlsx`);
  const labelOf = (versionId) => `V${String(versionId).replace(/^v/, '')}`;

  function serialize(task) {
    const run = mutationQueue.then(task, task);
    mutationQueue = run.catch(() => {});
    return run;
  }

  function notify(resourceId) {
    try { onChanged({ resourceId }); } catch (_error) { /* 通知失败不影响已提交的变更 */ }
  }

  function readStore() {
    if (!versioning) return { versions: new Map(), states: new Map() };
    const versions = new Map();
    for (const row of store.listTemplateResourceVersions()) {
      if (!versions.has(row.resourceId)) versions.set(row.resourceId, []);
      versions.get(row.resourceId).push(row);
    }
    const states = new Map(store.listTemplateResourceStates().map((row) => [row.resourceId, row]));
    return { versions, states };
  }

  function stateOf(snapshot, resourceId) {
    const versions = snapshot.versions.get(resourceId) || [];
    const state = snapshot.states.get(resourceId);
    const currentVersionId = state && (state.currentVersionId === BUILTIN_VERSION_ID
      || versions.some((version) => version.versionId === state.currentVersionId))
      ? state.currentVersionId
      : BUILTIN_VERSION_ID;
    return { versions, currentVersionId, nextVersionNo: state ? state.nextVersionNo : 2 };
  }

  // 清扫库中没有记录的版本文件（提交写库失败、删除时删文件失败留下的孤儿）与写入临时文件；只处理已知模板目录。
  async function sweepOrphans() {
    if (swept || !versioning) return;
    swept = true;
    const snapshot = readStore();
    for (const resource of TEMPLATE_RESOURCES) {
      const directory = path.join(versionRoot, resource.id);
      let names;
      try {
        names = await fs.promises.readdir(directory);
      } catch (_error) {
        continue;
      }
      const referenced = new Set((snapshot.versions.get(resource.id) || []).map((version) => `${version.versionId}.xlsx`));
      for (const name of names) {
        if (referenced.has(name)) continue;
        if (!VERSION_FILE_PATTERN.test(name) && !/^v\d+\.xlsx\.tmp-/.test(name)) continue;
        try {
          await rm(path.join(directory, name), { force: true });
        } catch (error) {
          log({ level: 'warn', message: '模板文件：清理孤儿版本文件失败', details: [path.join(directory, name), errorText(error)] });
        }
      }
    }
  }

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
      return { signature, size: info.size, error: `文件读取失败：${errorText(error)}` };
    }
  }

  // 契约复核只取决于文件内容与当前代码，按内容哈希缓存。
  // 运行环境导致的失败（临时目录不可写、文件被占用等）不代表模板不兼容，不缓存，下次复核重试。
  async function contractOf(resource, bytes, digest) {
    const key = `${resource.id}:${digest}`;
    if (compatibility.has(key)) return compatibility.get(key);
    const builtin = await inspect(resource);
    const result = await inspectContract(resource.id, bytes, {
      builtinSheetNames: (builtin.sheets || []).map((sheet) => sheet.name)
    });
    const verdict = { ok: result.ok, message: result.message, transient: result.transient === true };
    if (!verdict.transient) compatibility.set(key, verdict);
    return verdict;
  }

  // 用户版本：核对文件存在、SHA-256 与当前代码契约；任一不满足即视为不可用（保留为当前版本并报错，不自动切回内置）。
  async function inspectUserVersion(resource, version) {
    const filePath = versionPath(resource.id, version.versionId);
    let info;
    try {
      info = await stat(filePath);
    } catch (_error) {
      return { filePath, ok: false, message: '版本文件缺失' };
    }
    const signature = `${info.size}:${info.mtimeMs}`;
    const cacheKey = `${resource.id}:${version.versionId}`;
    const cached = userInspections.get(cacheKey);
    if (cached && cached.signature === signature && cached.sha256 === version.sha256) return cached;
    let bytes;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      return { filePath, ok: false, message: `版本文件读取失败：${errorText(error)}` };
    }
    const digest = sha256(bytes);
    let record;
    if (digest !== version.sha256) {
      record = { filePath, signature, sha256: version.sha256, ok: false, message: '版本文件已被修改（SHA-256 不一致）' };
    } else {
      const contract = await contractOf(resource, bytes, digest);
      let message = '';
      if (!contract.ok) message = contract.transient ? `兼容复核未完成：${contract.message}` : `与本版程序不兼容：${contract.message}`;
      record = { filePath, signature, sha256: version.sha256, ok: contract.ok, transient: contract.transient, message };
    }
    if (!record.transient) userInspections.set(cacheKey, record);
    return { ...record, bytes };
  }

  function leaseTasks(resourceId, versionId = null) {
    return [...leases.values()]
      .filter((lease) => lease.resourceId === resourceId && (!versionId || lease.versionId === versionId))
      .map((lease) => ({ id: lease.label, state: '运行中', moduleId: lease.moduleId, versionId: lease.versionId }));
  }

  function builtinVersion(resource, record, currentVersionId) {
    return {
      id: BUILTIN_VERSION_ID,
      label: 'V1',
      source: 'builtin',
      current: currentVersionId === BUILTIN_VERSION_ID,
      fileName: fileNameOf(resource),
      size: Number.isFinite(record.size) ? record.size : null,
      appVersion,
      sha256: record.sha256 || '',
      tasks: leaseTasks(resource.id, BUILTIN_VERSION_ID)
    };
  }

  async function userVersionDto(resource, version, currentVersionId) {
    const inspected = await inspectUserVersion(resource, version);
    const structure = version.structure || {};
    return {
      id: version.versionId,
      label: labelOf(version.versionId),
      source: 'user',
      current: version.versionId === currentVersionId,
      fileName: version.fileName,
      size: version.sizeBytes,
      appVersion: version.appVersion,
      sha256: version.sha256,
      createdAt: localTimeText(version.createdAt),
      location: inspected.filePath,
      // failed：不兼容（契约不符、文件缺失或被改动）；unverified：运行环境异常导致复核未完成，下次复核重试。
      validation: inspected.ok ? version.validation : (inspected.transient ? 'unverified' : 'failed'),
      validationMessage: inspected.ok ? '' : inspected.message,
      sheets: Array.isArray(structure.sheets) ? structure.sheets : [],
      enumValues: Array.isArray(structure.enumValues) ? structure.enumValues : null,
      tasks: leaseTasks(resource.id, version.versionId)
    };
  }

  async function resourceView(resource, snapshot) {
    const record = await inspect(resource);
    const { versions, currentVersionId } = stateOf(snapshot, resource.id);
    const userVersions = [];
    for (const version of versions) userVersions.push(await userVersionDto(resource, version, currentVersionId));
    const allVersions = [...userVersions, builtinVersion(resource, record, currentVersionId)];
    const current = allVersions.find((version) => version.current);
    const fileName = fileNameOf(resource);
    const allowed = versioning && replaceable(resource);
    const importReason = !resource.replace.allowed
      ? resource.replace.reason
      : (allowed ? '' : STORE_UNAVAILABLE_REASON);
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
      current,
      versions: allVersions,
      tasks: leaseTasks(resource.id),
      capabilities: {
        saveAs: current.source === 'user' ? current.validationMessage !== '版本文件缺失' : !record.error,
        importVersion: allowed,
        importReason,
        setCurrent: allowed,
        deleteVersion: allowed,
        restoreDefault: allowed && current.source !== 'builtin'
      }
    };
  }

  async function list() {
    await sweepOrphans();
    const snapshot = readStore();
    const resources = [];
    for (const resource of TEMPLATE_RESOURCES) {
      const view = await resourceView(resource, snapshot);
      const { versions: _versions, ...summary } = view;
      resources.push(summary);
    }
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
    await sweepOrphans();
    return { status: 'success', resource: await resourceView(resource, readStore()) };
  }

  function resolveVersion({ resourceId, versionId } = {}) {
    const resource = findResource(resourceId);
    if (!resource) return { status: 'failed', message: '模板不存在' };
    const { versions, currentVersionId } = stateOf(readStore(), resource.id);
    const targetId = versionId || currentVersionId;
    if (targetId === BUILTIN_VERSION_ID) {
      const fileName = fileNameOf(resource);
      return { status: 'success', filePath: absolutePath(resource), fileName, extension: path.extname(fileName).slice(1).toLowerCase() };
    }
    const version = versions.find((item) => item.versionId === targetId);
    if (!version) return { status: 'failed', message: '版本不存在' };
    const fileName = version.fileName;
    return {
      status: 'success',
      filePath: versionPath(resource.id, version.versionId),
      fileName,
      extension: path.extname(fileName).slice(1).toLowerCase() || 'xlsx'
    };
  }

  async function exportVersion({ resourceId, versionId, targetPath } = {}) {
    const target = resolveVersion({ resourceId, versionId });
    if (target.status !== 'success') return target;
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) return { status: 'failed', message: '保存位置无效' };
    if (path.resolve(targetPath) === path.resolve(target.filePath)) {
      const builtin = path.resolve(target.filePath) === path.resolve(absolutePath(findResource(resourceId)));
      return { status: 'failed', message: builtin ? '不能覆盖内置模板' : '不能覆盖模板版本文件' };
    }
    // 先写同目录临时文件再替换：用户确认覆盖已有文件时，写出或替换失败不会截断原文件。
    const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, await readFile(target.filePath));
      await rename(temporaryPath, targetPath);
    } catch (error) {
      try { await rm(temporaryPath, { force: true }); } catch (_cleanupError) {}
      return { status: 'failed', message: `保存失败：${errorText(error)}` };
    }
    return { status: 'success', filePath: targetPath, fileName: path.basename(targetPath) };
  }

  // 运行时读取当前版本。返回的租约在任务结束前保护该版本不被删除，并在“版本/使用方”中显示为任务使用中；
  // 用户版本不可用（缺失、被修改、不兼容）时抛错，导出中止。
  async function acquire(resourceId, { moduleId = '', label = '', withBytes = false } = {}) {
    const resource = findResource(resourceId);
    if (!resource) throw new TypeError(`未知模板：${resourceId}`);
    const { versions, currentVersionId } = stateOf(readStore(), resource.id);
    // 读出当前版本后、任何等待之前登记租约：复核需要读文件、试写，期间切换并删除该版本会被租约拦下。
    leaseSequence += 1;
    const leaseId = leaseSequence;
    leases.set(leaseId, { resourceId: resource.id, versionId: currentVersionId, moduleId, label: label || `任务 ${leaseId}` });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      leases.delete(leaseId);
    };
    const name = fileNameOf(resource).replace(/\.xlsx?$/i, '');
    let result;
    try {
      if (currentVersionId === BUILTIN_VERSION_ID) {
        const filePath = absolutePath(resource);
        let bytes = null;
        if (withBytes) {
          try {
            bytes = await readFile(filePath);
          } catch (error) {
            throw new TemplateResourceUnavailableError(`模板「${name}」内置版本读取失败：${errorText(error)}`, { resourceId });
          }
        }
        result = { filePath, versionId: BUILTIN_VERSION_ID, label: 'V1', source: 'builtin', sha256: bytes ? sha256(bytes) : '', bytes };
      } else {
        const version = versions.find((item) => item.versionId === currentVersionId);
        const inspected = await inspectUserVersion(resource, version);
        const versionLabel = labelOf(version.versionId);
        if (!inspected.ok) {
          // 复核未完成（运行环境异常）时提示稍后重试，不引导用户恢复默认或重新导入。
          throw new TemplateResourceUnavailableError(
            `模板「${name}」当前版本 ${versionLabel} 不可用：${inspected.message}${inspected.transient ? '' : `。${SETTINGS_HINT}`}`,
            { resourceId, versionId: version.versionId }
          );
        }
        const bytes = withBytes ? (inspected.bytes || await readFile(inspected.filePath)) : null;
        if (bytes && sha256(bytes) !== version.sha256) {
          throw new TemplateResourceUnavailableError(
            `模板「${name}」当前版本 ${versionLabel} 不可用：版本文件已被修改（SHA-256 不一致）。${SETTINGS_HINT}`,
            { resourceId, versionId: version.versionId }
          );
        }
        result = { filePath: inspected.filePath, versionId: version.versionId, label: versionLabel, source: 'user', sha256: version.sha256, bytes };
        log({
          level: 'info',
          message: `模板文件：${name} 使用用户版本 ${versionLabel}`,
          details: [`模块：${moduleId || '-'}`, `SHA-256：${version.sha256.slice(0, 12)}`]
        });
      }
    } catch (error) {
      release();
      throw error;
    }
    return Object.freeze({ ...result, release });
  }

  // 供各模块注入：只暴露 acquire，不让模块持有整个服务。
  function source(resourceId, moduleId) {
    if (!findResource(resourceId)) throw new TypeError(`未知模板：${resourceId}`);
    return Object.freeze({
      acquire: (options = {}) => acquire(resourceId, { moduleId, ...options })
    });
  }

  // 缓存读取类（枚举 / 网关表头）：当前为内置时返回 builtin，由调用方沿用原路径逻辑；用户版本不可用时返回 unavailable。
  async function resolveCurrentFile(resourceId) {
    const resource = findResource(resourceId);
    if (!resource) throw new TypeError(`未知模板：${resourceId}`);
    const { versions, currentVersionId } = stateOf(readStore(), resource.id);
    if (currentVersionId === BUILTIN_VERSION_ID) return { status: 'builtin', filePath: absolutePath(resource) };
    const version = versions.find((item) => item.versionId === currentVersionId);
    const inspected = await inspectUserVersion(resource, version);
    if (!inspected.ok) return { status: 'unavailable', message: inspected.message, versionId: version.versionId };
    return { status: 'user', filePath: inspected.filePath, versionId: version.versionId };
  }

  function requireReplaceable(resourceId) {
    const resource = findResource(resourceId);
    if (!resource) return { error: { status: 'failed', message: '模板不存在' } };
    if (!resource.replace.allowed) return { error: { status: 'failed', message: resource.replace.reason || '该模板不支持替换' } };
    if (!versioning || !replaceable(resource)) return { error: { status: 'failed', message: STORE_UNAVAILABLE_REASON } };
    return { resource };
  }

  function rememberPickedFile(filePath) {
    pickedFiles.add(path.resolve(filePath));
  }

  // 暂存的导入字节只在内存中保留 30 分钟、最多 4 份；新的预检需要空位时淘汰最早的一份。
  function prunePendingImports({ keepSlot = true } = {}) {
    const cutoff = now().getTime() - IMPORT_TOKEN_TTL_MS;
    for (const [token, pending] of pendingImports) {
      if (pending.createdAt < cutoff) pendingImports.delete(token);
    }
    while (keepSlot && pendingImports.size >= MAX_PENDING_IMPORTS) {
      pendingImports.delete(pendingImports.keys().next().value);
    }
  }

  function versionLabelInfo(snapshot, resourceId, versionId) {
    if (versionId === BUILTIN_VERSION_ID) return { label: 'V1', source: 'builtin' };
    const exists = (snapshot.versions.get(resourceId) || []).some((version) => version.versionId === versionId);
    return { label: exists ? labelOf(versionId) : versionId, source: 'user' };
  }

  async function prepareImport({ resourceId, filePath } = {}) {
    const { resource, error } = requireReplaceable(resourceId);
    if (error) return error;
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !pickedFiles.has(path.resolve(filePath))) {
      return { status: 'failed', message: '请通过“选择文件”重新选择要导入的文件' };
    }
    const fileName = path.basename(filePath);
    const checks = [];
    const add = (label, status, detail) => checks.push({ group: 'file', label, status, detail });
    const snapshot = readStore();
    const { versions, currentVersionId } = stateOf(snapshot, resource.id);
    const expected = versionLabelInfo(snapshot, resource.id, currentVersionId);
    const base = {
      status: 'success',
      expectedVersionId: currentVersionId,
      expectedVersionLabel: expected.label,
      expectedVersionSource: expected.source
    };
    const finish = (file, extra = {}) => ({
      ...base,
      file,
      verdict: verdictOf(checks),
      checks,
      diff: extra.diff || { added: [], removed: [] },
      ...(extra.importToken ? { importToken: extra.importToken } : {})
    });

    const extension = path.extname(fileName).slice(1).toLowerCase();
    if (extension !== 'xlsx') {
      add('文件格式', 'fail', `需为 .xlsx，当前为 .${extension || '未知'}`);
      return finish({ name: fileName, size: null });
    }
    add('文件格式', 'pass', 'XLSX');
    let bytes;
    try {
      const info = await stat(filePath);
      if (info.size > MAX_IMPORT_BYTES) {
        add('文件大小', 'fail', `超过 ${MAX_IMPORT_BYTES / 1024 / 1024} MB 上限`);
        return finish({ name: fileName, size: info.size });
      }
      bytes = await readFile(filePath);
    } catch (readError) {
      add('读取文件', 'fail', `文件无法读取：${errorText(readError)}`);
      return finish({ name: fileName, size: null });
    }
    const digest = sha256(bytes);
    const file = { name: fileName, size: bytes.length, sha256: digest };

    const builtin = await inspect(resource);
    const currentStructure = currentVersionId === BUILTIN_VERSION_ID
      ? builtin
      : ((versions.find((version) => version.versionId === currentVersionId) || {}).structure || {});
    const references = collectScenarioReferences(
      typeof store.listScenarioConfigs === 'function' ? store.listScenarioConfigs() : []
    );
    const contract = await inspectContract(resource.id, bytes, {
      builtinSheetNames: (builtin.sheets || []).map((sheet) => sheet.name),
      currentValues: comparableValues(resource, currentStructure),
      references
    });
    checks.push(...contract.checks);

    const sameUser = versions.find((version) => version.sha256 === digest);
    const same = sameUser
      ? { id: sameUser.versionId, label: labelOf(sameUser.versionId) }
      : (builtin.sha256 === digest ? { id: BUILTIN_VERSION_ID, label: 'V1' } : null);
    if (same) {
      add('与已有版本', 'fail', same.id === currentVersionId
        ? '与当前版本内容相同'
        : `与 ${same.label} 内容相同，可在“版本”中直接启用`);
    } else if (contract.ok) {
      const enumLike = resource.type === 'enum' || resource.id === 'gateway-recon';
      add('与当前版本', 'info', enumLike
        ? (contract.diff.added.length || contract.diff.removed.length
          ? `新增 ${contract.diff.added.length} 个 · 移除 ${contract.diff.removed.length} 个`
          : '取值不变，文件内容有变化')
        : '表头不变，样式或内容有变化');
    }
    checks.push(...usageChecks(resource, contract.ok));

    // 结构描述失败（文件契约检查已过但 SheetJS 读不出）时预检不通过，不发放可提交的版本记录。
    let structure = {};
    try {
      structure = describeWorkbook(bytes, resource);
    } catch (describeError) {
      if (!checks.some((check) => check.status === 'fail')) add('读取文件', 'fail', `无法读取表格结构：${errorText(describeError)}`);
    }
    const verdict = verdictOf(checks);
    prunePendingImports();
    const importToken = crypto.randomUUID();
    pendingImports.set(importToken, {
      resourceId: resource.id,
      expectedVersionId: currentVersionId,
      fileName,
      bytes,
      sha256: digest,
      verdict,
      structure,
      createdAt: now().getTime()
    });
    return finish(file, { diff: contract.diff, importToken });
  }

  function discardImport(importToken) {
    prunePendingImports({ keepSlot: false });
    pendingImports.delete(String(importToken || ''));
    return { status: 'success' };
  }

  function recordFailure(resource, action, detail) {
    try {
      store.appendTemplateResourceChange({
        createdAt: now().toISOString(),
        resourceId: resource.id,
        action,
        result: 'failed',
        detail,
        appVersion
      });
    } catch (_error) { /* 失败记录本身写不进去时不再掩盖原错误 */ }
  }

  function commitImport({ importToken, enable } = {}) {
    return serialize(async () => {
      prunePendingImports({ keepSlot: false });
      const pending = pendingImports.get(String(importToken || ''));
      if (!pending) return { status: 'failed', message: '导入已失效，请重新选择文件' };
      const { resource, error } = requireReplaceable(pending.resourceId);
      if (error) return error;
      if (pending.verdict === 'fail') return { status: 'failed', message: '预检未通过，不能导入' };
      const snapshot = readStore();
      const { versions, currentVersionId, nextVersionNo } = stateOf(snapshot, resource.id);
      if (currentVersionId !== pending.expectedVersionId) {
        pendingImports.delete(importToken);
        return { status: 'conflict', message: `模板已更新为 ${versionLabelInfo(snapshot, resource.id, currentVersionId).label}，请重新校验` };
      }
      if (versions.some((version) => version.sha256 === pending.sha256)) {
        pendingImports.delete(importToken);
        return { status: 'failed', message: '已存在内容相同的版本' };
      }
      const versionId = `v${nextVersionNo}`;
      const label = labelOf(versionId);
      const fromLabel = versionLabelInfo(snapshot, resource.id, currentVersionId).label;
      const action = enable ? '导入并启用' : '导入';
      const filePath = versionPath(resource.id, versionId);
      try {
        writeVersionFile(filePath, pending.bytes);
      } catch (writeError) {
        recordFailure(resource, action, `写入版本文件失败：${errorText(writeError)}`);
        return { status: 'failed', message: `保存失败：${errorText(writeError)}` };
      }
      const createdAt = now().toISOString();
      const version = {
        versionId,
        versionNo: nextVersionNo,
        fileName: pending.fileName,
        sizeBytes: pending.bytes.length,
        sha256: pending.sha256,
        validation: pending.verdict === 'warn' ? 'warning' : 'passed',
        structure: pending.structure,
        appVersion,
        createdAt
      };
      let result;
      try {
        result = store.commitTemplateResourceVersion({
          resourceId: resource.id,
          version,
          enable: enable === true,
          expectedVersionId: pending.expectedVersionId,
          now: createdAt,
          change: {
            createdAt,
            resourceId: resource.id,
            action,
            fromLabel: enable ? fromLabel : '',
            toLabel: label,
            result: 'success',
            appVersion
          }
        });
      } catch (commitError) {
        await rm(filePath, { force: true }).catch(() => {});
        recordFailure(resource, action, `写入版本记录失败：${errorText(commitError)}`);
        return { status: 'failed', message: `保存失败：${errorText(commitError)}` };
      }
      if (result.status !== 'success') {
        await rm(filePath, { force: true }).catch(() => {});
        pendingImports.delete(importToken);
        const latest = readStore();
        return { status: 'conflict', message: `模板已更新为 ${versionLabelInfo(latest, resource.id, stateOf(latest, resource.id).currentVersionId).label}，请重新校验` };
      }
      pendingImports.delete(importToken);
      log({ level: 'info', message: `模板文件：${resource.id} ${action} ${label}`, details: [`SHA-256：${pending.sha256.slice(0, 12)}`] });
      notify(resource.id);
      const dto = await userVersionDto(resource, { ...version, structure: pending.structure }, enable ? versionId : currentVersionId);
      return { status: 'success', enabled: enable === true, version: dto };
    });
  }

  function setCurrentVersion({ resourceId, versionId, expectedVersionId } = {}) {
    return serialize(async () => {
      const { resource, error } = requireReplaceable(resourceId);
      if (error) return error;
      const snapshot = readStore();
      const { versions, currentVersionId } = stateOf(snapshot, resource.id);
      const target = versionId === BUILTIN_VERSION_ID ? null : versions.find((item) => item.versionId === versionId);
      if (versionId !== BUILTIN_VERSION_ID && !target) return { status: 'failed', message: '版本不存在' };
      if (expectedVersionId && currentVersionId !== expectedVersionId) {
        return { status: 'conflict', message: `模板已更新为 ${versionLabelInfo(snapshot, resource.id, currentVersionId).label}，请确认后重试` };
      }
      const toLabel = versionId === BUILTIN_VERSION_ID ? 'V1' : labelOf(versionId);
      if (target) {
        const inspected = await inspectUserVersion(resource, target);
        if (!inspected.ok) return { status: 'failed', message: `${toLabel} 不能启用：${inspected.message}` };
      }
      const action = versionId === BUILTIN_VERSION_ID ? '恢复默认' : '启用';
      const createdAt = now().toISOString();
      const result = store.setTemplateResourceCurrentVersion({
        resourceId: resource.id,
        versionId,
        expectedVersionId: expectedVersionId || currentVersionId,
        now: createdAt,
        change: {
          createdAt,
          resourceId: resource.id,
          action,
          fromLabel: versionLabelInfo(snapshot, resource.id, currentVersionId).label,
          toLabel,
          result: 'success',
          appVersion
        }
      });
      if (result.status === 'conflict') {
        const latest = readStore();
        return { status: 'conflict', message: `模板已更新为 ${versionLabelInfo(latest, resource.id, stateOf(latest, resource.id).currentVersionId).label}，请确认后重试` };
      }
      if (result.status !== 'success') return { status: 'failed', message: '版本不存在' };
      if (!result.unchanged) {
        log({ level: 'info', message: `模板文件：${resource.id} ${action} ${toLabel}` });
        notify(resource.id);
      }
      return { status: 'success', version: { id: versionId, label: toLabel } };
    });
  }

  function deleteVersion({ resourceId, versionId } = {}) {
    return serialize(async () => {
      const { resource, error } = requireReplaceable(resourceId);
      if (error) return error;
      if (versionId === BUILTIN_VERSION_ID) return { status: 'failed', message: '内置版本不能删除' };
      const snapshot = readStore();
      const { versions, currentVersionId } = stateOf(snapshot, resource.id);
      const target = versions.find((item) => item.versionId === versionId);
      if (!target) return { status: 'failed', message: '版本不存在' };
      if (currentVersionId === versionId) return { status: 'failed', message: '当前版本不能删除，请先启用其他版本' };
      const inUse = leaseTasks(resource.id, versionId);
      if (inUse.length) return { status: 'failed', message: `${inUse.length} 个任务正在使用该版本` };
      const label = labelOf(versionId);
      const createdAt = now().toISOString();
      const result = store.deleteTemplateResourceVersion({
        resourceId: resource.id,
        versionId,
        change: { createdAt, resourceId: resource.id, action: '删除版本', fromLabel: label, toLabel: '', result: 'success', appVersion }
      });
      if (result.status === 'current') return { status: 'failed', message: '当前版本不能删除，请先启用其他版本' };
      if (result.status !== 'success') return { status: 'failed', message: '版本不存在' };
      userInspections.delete(`${resource.id}:${versionId}`);
      try {
        await rm(versionPath(resource.id, versionId), { force: true });
      } catch (removeError) {
        // 记录已删除；残留文件由下次启动的孤儿清扫处理。
        log({ level: 'warn', message: '模板文件：删除版本文件失败', details: [versionPath(resource.id, versionId), errorText(removeError)] });
      }
      log({ level: 'info', message: `模板文件：${resource.id} 删除版本 ${label}` });
      notify(resource.id);
      return { status: 'success' };
    });
  }

  function listChanges() {
    if (!versioning) return { status: 'success', changes: [] };
    const names = new Map(TEMPLATE_RESOURCES.map((resource) => [resource.id, fileNameOf(resource).replace(/\.xlsx?$/i, '')]));
    return {
      status: 'success',
      changes: store.listTemplateResourceChanges(MAX_CHANGES).map((change) => ({
        at: localTimeText(change.createdAt),
        resourceId: change.resourceId,
        resourceName: names.get(change.resourceId) || change.resourceId,
        action: change.action,
        from: change.fromLabel,
        to: change.toLabel,
        result: change.result,
        detail: change.detail
      }))
    };
  }

  return Object.freeze({
    list,
    get,
    resolveVersion,
    exportVersion,
    acquire,
    source,
    resolveCurrentFile,
    rememberPickedFile,
    prepareImport,
    discardImport,
    commitImport,
    setCurrentVersion,
    deleteVersion,
    listChanges
  });
}

module.exports = {
  BUILTIN_VERSION_ID,
  TemplateResourceUnavailableError,
  createTemplateResourceService
};
