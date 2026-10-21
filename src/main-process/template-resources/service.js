'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EXCLUDED_TEMPLATE_FILES, TEMPLATE_RESOURCES } = require('./catalog');
const {
  MAX_IMPORT_BYTES,
  collectScenarioReferences,
  diffValues,
  hasContract,
  usageChecks,
  verdictOf
} = require('./contracts');
const { DEFAULT_INSPECTION_LIMITS, runTemplateInspection } = require('./inspection-runner');
const { RUNTIME_VALUE_PARSERS, describeWorkbook, parseRuntimeValues } = require('./workbook-structure');
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

// 有上限地读文件：读到的字节超过 maxBytes 即停止并报错，文件在检查大小之后变大也不会在主进程整份读入。
async function readFileWithCap(filePath, maxBytes) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const chunks = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw Object.assign(new Error(`文件超过 ${maxBytes} 字节的读取上限`), { code: 'TEMPLATE_FILE_TOO_LARGE' });
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
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
  writeVersionFile = (filePath, bytes) => writeFileAtomicDurable(filePath, bytes),
  readFileCapped = readFileWithCap,
  inspectionLimits = DEFAULT_INSPECTION_LIMITS,
  runInspection = (payload) => runTemplateInspection(payload, { limits: inspectionLimits })
} = {}) {
  if (!appRoot) throw new Error('模板文件服务缺少应用目录');
  const versioning = Boolean(store && userDataRoot);
  const versionRoot = versioning ? path.join(userDataRoot, VERSION_ROOT_NAME) : '';
  const inspections = new Map();
  const userInspections = new Map();
  const compatibility = new Map();
  const contractsInFlight = new Map();
  const versionReadsInFlight = new Map();
  const reparsedValues = new Map();
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

  // 用户导入的文件只在受限 Worker 中解析（契约检查与结构描述）：读入时的逐格展开超出内存上限只终止该 Worker。
  //   Worker 超限、超时或无法启动时转换为一条“读取文件”检查；超时与无法启动属于运行环境问题，标为 transient。
  async function inspectUserBytes(resource, bytes, context) {
    try {
      return await runInspection({
        task: 'inspect',
        resource: { id: resource.id, type: resource.type, headerRow: resource.headerRow },
        bytes,
        context
      });
    } catch (error) {
      const check = { group: 'file', label: '读取文件', status: 'fail', detail: errorText(error) };
      return {
        contract: { checks: [check], ok: false, transient: error && error.transient === true, message: `${check.label}：${check.detail}`, diff: { added: [], removed: [] } },
        structure: null,
        describeError: null
      };
    }
  }

  // 契约复核只取决于文件内容与当前代码，按内容哈希缓存。
  // 运行环境导致的失败（临时目录不可写、文件被占用等）不代表模板不兼容，不缓存，下次复核重试。
  //   同一内容正在复核时合并为一次（列表刷新、导出取用等可能同时触发），不重复启动检查 Worker。
  function contractOf(resource, bytes, digest) {
    const key = `${resource.id}:${digest}`;
    if (compatibility.has(key)) return Promise.resolve(compatibility.get(key));
    if (contractsInFlight.has(key)) return contractsInFlight.get(key);
    const running = (async () => {
      const builtin = await inspect(resource);
      const { contract: result } = await inspectUserBytes(resource, bytes, {
        builtinSheetNames: (builtin.sheets || []).map((sheet) => sheet.name),
        expectCanonical: true
      });
      const verdict = { ok: result.ok, message: result.message, transient: result.transient === true };
      if (!verdict.transient) compatibility.set(key, verdict);
      return verdict;
    })();
    contractsInFlight.set(key, running);
    running.finally(() => contractsInFlight.delete(key)).catch(() => {});
    return running;
  }

  // 版本文件打不开：确认不存在或不是普通文件（如被同名目录替代）时为“缺失”（不兼容，需恢复默认或重新导入）；
  // 权限、占用、句柄耗尽等其他读盘错误是运行环境问题，标为 transient（暂不可用，稍后重试），结果不缓存。
  const MISSING_FILE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);
  const MODIFIED_SIZE_MESSAGE = '版本文件已被修改（大小与记录不一致）';
  function accessFailure(filePath, error) {
    if (error && MISSING_FILE_CODES.has(error.code)) return { filePath, ok: false, message: '版本文件缺失' };
    if (error && error.code === 'TEMPLATE_FILE_TOO_LARGE') return { filePath, ok: false, message: MODIFIED_SIZE_MESSAGE };
    return { filePath, ok: false, transient: true, message: `版本文件暂时无法读取（${errorText(error)}），请稍后重试` };
  }

  const versionReadCap = (version) => (Number.isFinite(version.sizeBytes) && version.sizeBytes > 0
    ? Math.min(version.sizeBytes, MAX_IMPORT_BYTES)
    : MAX_IMPORT_BYTES);

  // 用户版本：核对文件存在、SHA-256 与当前代码契约；任一不满足即视为不可用（保留为当前版本并报错，不自动切回内置）。
  async function inspectUserVersion(resource, version) {
    const filePath = versionPath(resource.id, version.versionId);
    let info;
    try {
      info = await stat(filePath);
    } catch (error) {
      return accessFailure(filePath, error);
    }
    if (typeof info.isFile === 'function' && !info.isFile()) return { filePath, ok: false, message: '版本文件缺失' };
    // 先比大小再读：版本文件被替换成大文件时，不在主进程整份读入（读取本身也有上限）。
    if (Number.isFinite(version.sizeBytes) && info.size !== version.sizeBytes) return { filePath, ok: false, message: MODIFIED_SIZE_MESSAGE };
    const signature = `${info.size}:${info.mtimeMs}`;
    const cacheKey = `${resource.id}:${version.versionId}`;
    const cached = userInspections.get(cacheKey);
    if (cached && cached.signature === signature && cached.sha256 === version.sha256) return cached;
    // 同一版本、同一文件签名正在复核时合并为一次：读盘、SHA-256 与契约检查只做一遍，并发请求不各自持有一份文件字节。
    const flightKey = `${cacheKey}:${signature}:${version.sha256}`;
    if (versionReadsInFlight.has(flightKey)) return versionReadsInFlight.get(flightKey);
    const running = (async () => {
      let bytes;
      try {
        bytes = await readFileCapped(filePath, versionReadCap(version));
      } catch (error) {
        return accessFailure(filePath, error);
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
    })();
    versionReadsInFlight.set(flightKey, running);
    running.finally(() => versionReadsInFlight.delete(flightKey)).catch(() => {});
    return running;
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
      // 每个版本各自能否另存为：当前版本缺失时，内置等其他可读的版本仍可另存为。
      saveAs: !record.error,
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
      saveAs: inspected.message !== '版本文件缺失',
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
        saveAs: current.saveAs,
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
      await writeFile(temporaryPath, await readFileCapped(target.filePath, MAX_IMPORT_BYTES));
      await rename(temporaryPath, targetPath);
    } catch (error) {
      try { await rm(temporaryPath, { force: true }); } catch (_cleanupError) {}
      return { status: 'failed', message: `保存失败：${errorText(error)}` };
    }
    return { status: 'success', filePath: targetPath, fileName: path.basename(targetPath) };
  }

  // 运行时读取当前版本。返回的租约在任务结束前保护该版本不被删除，并在“版本/使用方”中显示为任务使用中；
  // 用户版本不可用（缺失、被修改、不兼容）时抛错，导出中止。用户版本总带 bytes（已核对 SHA-256），
  // withBytes 只决定内置版本是否也读出字节（VCC 交给 Worker 使用）。
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
        // 用户版本总是返回核对过 SHA-256 的字节，Writer 直接读入这份字节：检查之后文件被替换也不会读到未经检查的内容。
        const bytes = inspected.bytes || await readFileCapped(inspected.filePath, versionReadCap(version));
        if (sha256(bytes) !== version.sha256) {
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

  // 版本的取值（与运行时同口径，来自可信内容）：内置版本解析随包文件；用户版本取导入时保存的取值快照
  //   （导入时已按运行时口径解析，内容由 SHA-256 锁定）；早期记录没有快照时，核对 SHA-256 后在检查 Worker 中重新解析。
  //   都取不到时 values 为 null，由调用方按场景引用逐项核对。
  async function versionComparableValues(resource, versionId, versions) {
    if (!RUNTIME_VALUE_PARSERS[resource.id]) return { values: [] };
    if (versionId === BUILTIN_VERSION_ID) {
      try {
        return { values: parseRuntimeValues(resource.id, await readFile(absolutePath(resource))) };
      } catch (error) {
        return { values: null, reason: `内置版本读取失败：${errorText(error)}` };
      }
    }
    const version = versions.find((item) => item.versionId === versionId);
    if (!version) return { values: null, reason: '版本不存在' };
    const snapshot = version.structure && version.structure.comparableValues;
    if (Array.isArray(snapshot)) return { values: snapshot };
    const cacheKey = `${resource.id}:${version.sha256}`;
    if (reparsedValues.has(cacheKey)) return { values: reparsedValues.get(cacheKey) };
    try {
      const bytes = await readFileCapped(versionPath(resource.id, versionId), versionReadCap(version));
      if (sha256(bytes) !== version.sha256) return { values: null, reason: '版本文件已被修改（SHA-256 不一致）' };
      const parsed = await runInspection({ task: 'values', resource: { id: resource.id, type: resource.type, headerRow: resource.headerRow }, bytes });
      reparsedValues.set(cacheKey, parsed.values);
      return { values: parsed.values };
    } catch (error) {
      return { values: null, reason: `版本文件无法读取：${errorText(error)}` };
    }
  }

  // 场景配置下拉（FundType 取值、网关表头字段）使用的当前版本取值。内置版本返回 builtin，由调用方按原逻辑读取随包文件；
  //   用户版本先复核文件（存在、SHA-256、契约），再返回导入时在检查 Worker 中按运行时口径解析的取值，主进程不解析用户文件。
  async function currentRuntimeValues(resourceId) {
    const resource = findResource(resourceId);
    if (!resource || !RUNTIME_VALUE_PARSERS[resource.id]) throw new TypeError(`模板没有运行时取值：${resourceId}`);
    const { versions, currentVersionId } = stateOf(readStore(), resource.id);
    if (currentVersionId === BUILTIN_VERSION_ID) return { status: 'builtin' };
    const version = versions.find((item) => item.versionId === currentVersionId);
    const inspected = await inspectUserVersion(resource, version);
    if (!inspected.ok) return { status: 'unavailable', message: inspected.message, versionId: currentVersionId };
    const values = await versionComparableValues(resource, currentVersionId, versions);
    if (!values.values) return { status: 'unavailable', message: values.reason, versionId: currentVersionId };
    // 取值为空时交由调用方按原逻辑降级（FundType 空列表、网关旧字段），不返回空下拉。
    if (!values.values.length) return { status: 'unavailable', message: '版本取值为空', versionId: currentVersionId };
    return { status: 'user', values: values.values, versionId: currentVersionId };
  }

  function scenarioReferences() {
    return collectScenarioReferences(typeof store.listScenarioConfigs === 'function' ? store.listScenarioConfigs() : []);
  }

  function referencedValuesOf(resource, references) {
    return resource.id === 'gateway-recon' ? references.gatewayFields : references.fundTypeValues;
  }

  // 从一个版本切到另一个版本会移除的、已被场景使用的取值（与导入预检的场景引用保护同口径）。
  async function removedReferencedValues(resource, fromVersionId, toVersionId, versions) {
    if (!RUNTIME_VALUE_PARSERS[resource.id]) return { values: [] };
    const referenced = referencedValuesOf(resource, scenarioReferences());
    if (!referenced.size) return { values: [] };
    const target = await versionComparableValues(resource, toVersionId, versions);
    if (!target.values) return { error: `无法确认其取值（${target.reason}）` };
    const current = await versionComparableValues(resource, fromVersionId, versions);
    const before = current.values || [...referenced];
    return { values: diffValues(before, target.values).removed.filter((value) => referenced.has(value)) };
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
      bytes = await readFileCapped(filePath, MAX_IMPORT_BYTES);
    } catch (readError) {
      add('读取文件', 'fail', `文件无法读取：${errorText(readError)}`);
      return finish({ name: fileName, size: null });
    }
    const digest = sha256(bytes);
    const file = { name: fileName, size: bytes.length, sha256: digest };

    const builtin = await inspect(resource);
    const references = scenarioReferences();
    // 取不到可信的当前取值时，假定场景引用的值都在当前版本中：新版本缺少其中任何一个都按移除被引用的值处理。
    const baseline = await versionComparableValues(resource, currentVersionId, versions);
    if (!baseline.values) {
      add('比较基准', 'warn', `无法确认当前版本 ${expected.label} 的取值（${baseline.reason}），按场景引用逐项核对`);
    }
    const inspected = await inspectUserBytes(resource, bytes, {
      builtinSheetNames: (builtin.sheets || []).map((sheet) => sheet.name),
      currentValues: baseline.values || [...referencedValuesOf(resource, references)],
      references: { fundTypeValues: [...references.fundTypeValues], gatewayFields: [...references.gatewayFields] },
      describe: true
    });
    const contract = inspected.contract;
    checks.push(...contract.checks);

    // 保存的是检查 Worker 重新打包后的字节：与已有用户版本按重新打包后的内容比较，与内置版本按原文件比较。
    const canonical = inspected.canonical ? Buffer.from(inspected.canonical) : null;
    const canonicalDigest = canonical ? sha256(canonical) : '';
    const sameUser = canonical ? versions.find((version) => version.sha256 === canonicalDigest) : null;
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

    // 结构描述在检查 Worker 中随契约检查一起完成；契约通过但结构读不出时预检不通过，不发放可提交的版本记录。
    const structure = inspected.structure || {};
    if (contract.ok && !inspected.structure) {
      add('读取文件', 'fail', `无法读取表格结构：${inspected.describeError ? inspected.describeError.message : '未知错误'}`);
    }
    const verdict = verdictOf(checks);
    prunePendingImports();
    const importToken = crypto.randomUUID();
    pendingImports.set(importToken, {
      resourceId: resource.id,
      expectedVersionId: currentVersionId,
      fileName,
      bytes: canonical,
      sha256: canonicalDigest,
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
        // 与导入预检相同：启用后会缺少已被场景使用的取值时不允许启用。恢复默认不受此限，始终可以回退。
        const removed = await removedReferencedValues(resource, currentVersionId, target.versionId, versions);
        if (removed.error) return { status: 'failed', message: `${toLabel} 不能启用：${removed.error}` };
        if (removed.values.length) {
          const names = `${removed.values.slice(0, 5).join('、')}${removed.values.length > 5 ? ` 等 ${removed.values.length} 个` : ''}`;
          return { status: 'failed', message: `${toLabel} 不能启用：缺少已被场景使用的取值 ${names}` };
        }
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
    currentRuntimeValues,
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
