'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { writeFileAtomicDurable } = require('../background-execution/durable-file');
const { CHANNEL_HEADER, STRUCTURE_RESOURCE_ID } = require('./constants');
const { parseBankAccountWorkbook } = require('./workbook');

// 设置 → 账户管理：清结算系统银行账户表的统一存放。
//   原文件存 {userData}/bank-accounts/<sha256>.<扩展名>，主库只保留当前一份（元数据 + 账户行），导入整份替换。
//   表头识别结构取「设置 → 模板文件 → 清结算银行账户表」当前版本（与平盘共用，由 resolveStructure 注入）。
//   对外只读接口 getSnapshotMeta / listAccounts 供其他模块接入；各模块自行决定筛选口径。
const STRUCTURE_NAME = '清结算银行账户表';
const ROOT_NAME = 'bank-accounts';
const SUPPORTED_EXTENSIONS = Object.freeze(['xlsx', 'xls']);
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 500;
const IMPORT_TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_IMPORTS = 2;
const STORED_FILE_PATTERN = /^[0-9a-f]{64}\.(xlsx|xls)$/;
const TEMP_FILE_PATTERN = /\.tmp-\d+-\d+$/;
const REIMPORT_HINT = '请重新导入银行账户信息';

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

// 有上限地读文件：读到的字节超过 maxBytes 即停止并报错，文件在检查大小之后变大也不会整份读入。
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
        throw Object.assign(new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MiB`), { code: 'BANK_ACCOUNT_FILE_TOO_LARGE' });
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function failed(message, detailLines = []) {
  return { status: 'failed', message, detailLines };
}

function createBankAccountService({
  userDataRoot,
  store,
  resolveStructure,
  appVersion = '',
  log = () => {},
  onChanged = () => {},
  now = () => new Date(),
  readFileCapped = readFileWithCap,
  writeStoredFile = (filePath, bytes) => writeFileAtomicDurable(filePath, bytes),
  fileSystem = fs.promises
} = {}) {
  if (!userDataRoot) throw new Error('账户管理服务缺少用户数据目录');
  if (!store) throw new Error('账户管理服务缺少主库');
  if (typeof resolveStructure !== 'function') throw new Error('账户管理服务缺少识别结构来源');
  const root = path.join(userDataRoot, ROOT_NAME);
  const pickedFiles = new Set();
  const pendingImports = new Map();
  let mutationQueue = Promise.resolve();
  let swept = false;

  const storedPathOf = (snapshot) => path.join(root, `${snapshot.sha256}.${snapshot.fileExtension}`);

  function serialize(task) {
    const run = mutationQueue.then(task, task);
    mutationQueue = run.catch(() => {});
    return run;
  }

  function notify(payload) {
    try { onChanged(payload); } catch (_error) { /* 通知失败不影响已提交的变更 */ }
  }

  function snapshotMeta(snapshot) {
    if (!snapshot) return null;
    return {
      snapshotNo: snapshot.snapshotNo,
      fileName: snapshot.fileName,
      fileExtension: snapshot.fileExtension,
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.sha256,
      sheetName: snapshot.sheetName,
      headers: [...snapshot.headers],
      channelHeader: snapshot.channelHeader,
      structureVersionId: snapshot.structureVersionId,
      structureLabel: snapshot.structureLabel,
      rowCount: snapshot.rowCount,
      appVersion: snapshot.appVersion,
      importedAt: snapshot.importedAt,
      importedAtText: localTimeText(snapshot.importedAt)
    };
  }

  // 删除不再被当前账户表引用的原文件与写入中断留下的临时文件；只处理本目录内本服务命名的文件。
  async function sweepStoredFiles() {
    const snapshot = store.readBankAccountSnapshot();
    const keep = snapshot ? path.basename(storedPathOf(snapshot)) : '';
    let names;
    try {
      names = await fileSystem.readdir(root);
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      if (name === keep) continue;
      const temporary = TEMP_FILE_PATTERN.test(name) && STORED_FILE_PATTERN.test(name.replace(TEMP_FILE_PATTERN, ''));
      if (!STORED_FILE_PATTERN.test(name) && !temporary) continue;
      try {
        await fileSystem.rm(path.join(root, name), { force: true });
      } catch (error) {
        log({ level: 'warning', message: '账户管理：清理旧原表文件失败', details: [name, errorText(error)] });
      }
    }
  }

  function sweepOnce() {
    if (swept) return Promise.resolve();
    swept = true;
    return serialize(() => sweepStoredFiles().catch((error) => {
      log({ level: 'warning', message: '账户管理：清理旧原表文件失败', details: [errorText(error)] });
    }));
  }

  async function getOverview() {
    await sweepOnce();
    const snapshot = store.readBankAccountSnapshot();
    return {
      status: 'success',
      channelHeader: CHANNEL_HEADER,
      snapshot: snapshotMeta(snapshot),
      channels: snapshot ? store.listBankAccountChannels() : []
    };
  }

  function list({ channel = '', offset = 0, limit = DEFAULT_PAGE_LIMIT } = {}) {
    const channelValue = typeof channel === 'string' ? channel : '';
    const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE_LIMIT) : DEFAULT_PAGE_LIMIT;
    const snapshot = store.readBankAccountSnapshot();
    if (!snapshot) return { status: 'success', snapshotNo: 0, headers: [], channel: channelValue, total: 0, offset: 0, limit: size, rows: [] };
    return {
      status: 'success',
      snapshotNo: snapshot.snapshotNo,
      headers: [...snapshot.headers],
      channel: channelValue,
      total: store.countBankAccountRows({ channel: channelValue }),
      offset: start,
      limit: size,
      rows: store.listBankAccountRows({ channel: channelValue, offset: start, limit: size })
    };
  }

  function rememberPickedFile(filePath) {
    pickedFiles.add(path.resolve(filePath));
  }

  function prunePendingImports() {
    const cutoff = now().getTime() - IMPORT_TOKEN_TTL_MS;
    for (const [token, pending] of pendingImports) {
      if (pending.createdAt < cutoff) pendingImports.delete(token);
    }
    while (pendingImports.size >= MAX_PENDING_IMPORTS) {
      pendingImports.delete(pendingImports.keys().next().value);
    }
  }

  async function prepareImport({ filePath } = {}) {
    const resolved = typeof filePath === 'string' && filePath ? path.resolve(filePath) : '';
    if (!resolved || !pickedFiles.has(resolved)) return failed('请通过【导入银行账户信息】选择文件');
    const fileName = path.basename(resolved);
    const extension = path.extname(fileName).slice(1).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(extension)) return failed(`仅支持 .xlsx / .xls 文件：${fileName}`);

    let bytes;
    try {
      bytes = await readFileCapped(resolved, MAX_IMPORT_BYTES);
    } catch (error) {
      if (error && error.code === 'BANK_ACCOUNT_FILE_TOO_LARGE') return failed(`${errorText(error)}，无法导入：${fileName}`);
      return failed(`无法读取文件：${fileName}`, [errorText(error)]);
    }
    if (!bytes.length) return failed(`文件为空：${fileName}`);

    let structure;
    try {
      structure = await resolveStructure();
    } catch (error) {
      return failed(`无法读取「${STRUCTURE_NAME}」的识别结构`, [errorText(error)]);
    }
    if (!structure || structure.status === 'unavailable' || !Array.isArray(structure.headers) || !structure.headers.length) {
      return failed((structure && structure.message) || `「${STRUCTURE_NAME}」的识别结构不可用，请在 设置 → 模板文件 恢复默认或重新导入`);
    }
    const label = structure.label || '';
    if (!structure.headers.includes(CHANNEL_HEADER)) {
      return failed(`「${STRUCTURE_NAME}」当前版本 ${label} 缺少「${CHANNEL_HEADER}」列，账户管理无法按渠道筛选。请在 设置 → 模板文件 恢复默认或重新导入`);
    }

    const parsed = parseBankAccountWorkbook(bytes, {
      fileName,
      expectedHeaders: structure.headers,
      structureName: STRUCTURE_NAME,
      versionLabel: label,
      channelHeader: CHANNEL_HEADER
    });
    if (!parsed.ok) return failed(parsed.message, parsed.detailLines);
    if (!parsed.rows.length) return failed(`文件中没有账户数据行：${fileName}`);

    const previous = store.readBankAccountSnapshot();
    const channels = new Set(parsed.rows.map((row) => row.channel).filter(Boolean));
    prunePendingImports();
    const importToken = crypto.randomUUID();
    pendingImports.set(importToken, {
      createdAt: now().getTime(),
      bytes,
      sha256: sha256(bytes),
      fileName,
      extension,
      sheetName: parsed.sheetName,
      headers: [...structure.headers],
      structureVersionId: structure.versionId || '',
      structureLabel: label,
      rows: parsed.rows,
      expectedSnapshotNo: previous ? previous.snapshotNo : 0
    });
    return {
      status: 'success',
      importToken,
      fileName,
      sheetName: parsed.sheetName,
      structureLabel: label,
      rowCount: parsed.rows.length,
      channelCount: channels.size,
      previousRowCount: previous ? previous.rowCount : 0,
      previousFileName: previous ? previous.fileName : ''
    };
  }

  function discardImport(importToken) {
    pendingImports.delete(String(importToken || ''));
    return { status: 'success' };
  }

  function commitImport({ importToken } = {}) {
    return serialize(async () => {
      const token = String(importToken || '');
      const pending = pendingImports.get(token);
      if (!pending) return failed('导入预检已失效，请重新选择文件');
      pendingImports.delete(token);

      const targetPath = path.join(root, `${pending.sha256}.${pending.extension}`);
      const previous = store.readBankAccountSnapshot();
      const previousPath = previous ? storedPathOf(previous) : '';
      try {
        await writeStoredFile(targetPath, pending.bytes);
      } catch (error) {
        log({ level: 'error', message: '账户管理：保存原表文件失败', details: [pending.fileName, errorText(error)] });
        return failed(`保存原表文件失败，账户表未改变：${errorText(error)}`);
      }

      let committed;
      try {
        committed = store.replaceBankAccountSnapshot({
          expectedSnapshotNo: pending.expectedSnapshotNo,
          fileName: pending.fileName,
          fileExtension: pending.extension,
          sizeBytes: pending.bytes.length,
          sha256: pending.sha256,
          sheetName: pending.sheetName,
          headers: pending.headers,
          channelHeader: CHANNEL_HEADER,
          structureVersionId: pending.structureVersionId,
          structureLabel: pending.structureLabel,
          appVersion,
          importedAt: now().toISOString(),
          rows: pending.rows
        });
      } catch (error) {
        if (targetPath !== previousPath) {
          try { await fileSystem.rm(targetPath, { force: true }); } catch (_cleanupError) { /* 下次打开时清理 */ }
        }
        if (error && error.code === 'bank-account-snapshot-conflict') {
          return failed(`账户表在预检之后已被替换，${REIMPORT_HINT}`);
        }
        log({ level: 'error', message: '账户管理：写入账户表失败', details: [pending.fileName, errorText(error)] });
        return failed(`写入账户表失败，账户表未改变：${errorText(error)}`);
      }

      if (previousPath && previousPath !== targetPath) {
        try {
          await fileSystem.rm(previousPath, { force: true });
        } catch (error) {
          log({ level: 'warning', message: '账户管理：删除旧原表文件失败', details: [path.basename(previousPath), errorText(error)] });
        }
      }
      const channelCount = new Set(pending.rows.map((row) => row.channel).filter(Boolean)).size;
      log({
        level: 'info',
        message: '账户管理：导入银行账户信息成功',
        details: [
          `文件：${pending.fileName}`,
          `账户行数：${previous ? previous.rowCount : 0} → ${committed.rowCount}`,
          `渠道数：${channelCount}`,
          `识别结构：${pending.structureLabel}`,
          `SHA-256：${pending.sha256.slice(0, 12)}`
        ]
      });
      notify({ snapshotNo: committed.snapshotNo });
      return {
        status: 'success',
        snapshotNo: committed.snapshotNo,
        fileName: pending.fileName,
        rowCount: committed.rowCount,
        channelCount
      };
    });
  }

  // 另存为对话框需要的默认文件名与扩展名。
  function resolveOriginal() {
    const snapshot = store.readBankAccountSnapshot();
    if (!snapshot) return failed('尚未导入银行账户信息');
    return { status: 'success', fileName: snapshot.fileName, extension: snapshot.fileExtension };
  }

  async function exportOriginal({ targetPath } = {}) {
    const snapshot = store.readBankAccountSnapshot();
    if (!snapshot) return failed('尚未导入银行账户信息');
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) return failed('保存位置无效');
    const target = path.resolve(targetPath);
    if (path.dirname(target) === path.resolve(root)) return failed('不能保存到账户管理的存放目录，请选择其他位置');
    const sourcePath = storedPathOf(snapshot);
    let bytes;
    try {
      bytes = await readFileCapped(sourcePath, MAX_IMPORT_BYTES);
    } catch (error) {
      const missing = error && error.code === 'ENOENT';
      log({ level: 'error', message: '账户管理：读取原表文件失败', details: [snapshot.fileName, errorText(error)] });
      return failed(missing ? `原表文件缺失，${REIMPORT_HINT}` : `读取原表文件失败：${errorText(error)}`);
    }
    if (bytes.length !== snapshot.sizeBytes || sha256(bytes) !== snapshot.sha256) {
      log({ level: 'error', message: '账户管理：原表文件与导入时不一致，已拒绝导出', details: [snapshot.fileName] });
      return failed(`原表文件已被修改，${REIMPORT_HINT}`);
    }
    // 先写同目录临时文件再替换：用户确认覆盖已有文件时，写出或替换失败不会截断原文件。
    const temporaryPath = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await fileSystem.writeFile(temporaryPath, bytes);
      await fileSystem.rename(temporaryPath, target);
    } catch (error) {
      try { await fileSystem.rm(temporaryPath, { force: true }); } catch (_cleanupError) { /* 保留原错误 */ }
      return failed(`保存失败：${errorText(error)}`);
    }
    log({ level: 'info', message: '账户管理：导出银行账户表原表', details: [`文件：${path.basename(target)}`] });
    return { status: 'success', filePath: target, fileName: path.basename(target) };
  }

  // —— 对外只读接口（供其他模块接入；本期无调用方） ——
  function getSnapshotMeta() {
    return snapshotMeta(store.readBankAccountSnapshot());
  }

  // 返回按表头组成的账户行对象；channel 为空串时返回全部。
  function listAccounts({ channel = '' } = {}) {
    const snapshot = store.readBankAccountSnapshot();
    if (!snapshot) return [];
    return store.listBankAccountRows({ channel: typeof channel === 'string' ? channel : '' }).map((row) => ({
      excelRowNumber: row.excelRowNumber,
      channel: row.channel,
      record: Object.fromEntries(snapshot.headers.map((header, index) => [header, row.values[index] ?? '']))
    }));
  }

  return Object.freeze({
    getOverview,
    list,
    rememberPickedFile,
    prepareImport,
    discardImport,
    commitImport,
    resolveOriginal,
    exportOriginal,
    getSnapshotMeta,
    listAccounts
  });
}

module.exports = {
  CHANNEL_HEADER,
  MAX_IMPORT_BYTES,
  STRUCTURE_RESOURCE_ID,
  createBankAccountService
};
