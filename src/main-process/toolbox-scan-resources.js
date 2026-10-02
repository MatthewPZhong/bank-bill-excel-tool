'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const OWNER = 'toolbox-split-read';
const RECORD_PREFIX = '.toolbox-scan-owner-';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_ENTRIES = 4096;
const MAX_RECORD_BYTES = 2 * 1024 ** 2;

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function identity(stat) {
  if ((!stat.isFile() && !stat.isDirectory()) || stat.isSymbolicLink() || stat.ino <= 0n) {
    throw failure('TOOLBOX_SCAN_IDENTITY_INVALID', '扫描临时资源缺少可靠的普通文件或目录身份');
  }
  return { type: stat.isDirectory() ? 'directory' : 'file', dev: String(stat.dev), ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs), ...(stat.isFile() ? { size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } : {}) };
}
function sameIdentity(expected, actual) {
  return expected && Object.keys(actual).length === Object.keys(expected).length &&
    Object.keys(actual).every((key) => actual[key] === expected[key]);
}
function diagnostic(error) { return { code: error.code || 'TOOLBOX_SCAN_CLEANUP_FAILED', message: error.message }; }

// Main 固定根中的记录才是补偿入口；不扫描系统 temp 中仅有同名前缀的目录。
function createToolboxScanResources({ temporaryRoot, fsImpl = fs }) {
  const configuredRoot = path.resolve(temporaryRoot);
  const live = new WeakMap();
  const liveRecords = new Map();
  const durableCleanup = new Set();
  const recovered = new Map();
  let rootPath = null;
  let rootIdentity = null;
  let rootIssue = null;
  const stat = (target) => fsImpl.lstatSync(target, { bigint: true });
  function maybeStat(target) {
    try { return stat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function initialize(create) {
    if (rootPath) return;
    if (!maybeStat(configuredRoot)) {
      if (!create) return;
      fsImpl.mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
    }
    const current = stat(configuredRoot);
    if (!current.isDirectory() || current.isSymbolicLink()) throw failure('TOOLBOX_SCAN_ROOT_CHANGED', '扫描临时资源根必须是真实目录');
    const actualRoot = fsImpl.realpathSync(configuredRoot), actualIdentity = identity(current);
    rootPath = actualRoot;
    rootIdentity = actualIdentity;
  }
  function assertRoot(record) {
    initialize(false);
    if (!rootPath || fsImpl.realpathSync(configuredRoot) !== rootPath || record.rootPath !== rootPath ||
        !sameIdentity(record.rootIdentity, identity(stat(rootPath)))) {
      throw failure('TOOLBOX_SCAN_ROOT_CHANGED', '扫描临时资源根身份已变化，保留待清理内容');
    }
  }
  const directoryOf = (record) => path.join(record.rootPath, `toolbox-scan-${record.id}`);
  const journalOf = (record) => path.join(record.rootPath, `${RECORD_PREFIX}${record.id}.json`);
  function assertObject(target, expected, allowMissing = false) {
    const current = maybeStat(target);
    if (!current && allowMissing) return false;
    if (!current || !sameIdentity(expected, identity(current))) {
      throw failure('TOOLBOX_SCAN_IDENTITY_CHANGED', '扫描临时资源身份已变化，保留内容等待处理');
    }
    return true;
  }
  function assertJournal(record) {
    const current = maybeStat(journalOf(record));
    if (!current && !record.journalIdentity) return;
    if (!current || !sameIdentity(record.journalIdentity, identity(current))) {
      throw failure('TOOLBOX_SCAN_RECORD_CHANGED', '扫描清理责任记录已变化，停止覆盖或删除');
    }
  }
  function save(record) {
    assertRoot(record);
    assertJournal(record);
    const { journalIdentity: _identity, ...payload } = record;
    const content = JSON.stringify(payload);
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES) throw failure('TOOLBOX_SCAN_RECORD_LIMIT', '扫描清理责任记录超过安全上限');
    const staging = `${journalOf(record)}.new-${randomUUID()}`;
    let fd = null, stagingIdentity = null;
    try {
      fd = fsImpl.openSync(staging, 'wx', 0o600);
      fsImpl.writeFileSync(fd, content);
      fsImpl.fsyncSync(fd);
      stagingIdentity = identity(fsImpl.fstatSync(fd, { bigint: true }));
      fsImpl.closeSync(fd); fd = null;
      assertRoot(record);
      assertJournal(record);
      fsImpl.renameSync(staging, journalOf(record));
      record.journalIdentity = identity(stat(journalOf(record)));
      if (record.state === 'cleanup-pending') durableCleanup.add(record.id);
    } finally {
      if (fd !== null) {
        try { stagingIdentity = identity(fsImpl.fstatSync(fd, { bigint: true })); }
        finally { fsImpl.closeSync(fd); }
      }
      // staging 是本次独占创建的记录写入临时文件，不涉及扫描产物。
      if (stagingIdentity && assertObject(staging, stagingIdentity, true)) fsImpl.unlinkSync(staging);
    }
  }
  function captureTree(record) {
    const directory = directoryOf(record), entries = [];
    if (!assertObject(directory, record.directoryIdentity, true)) return entries;
    function visit(parent, parts) {
      for (const name of fsImpl.readdirSync(parent)) {
        if (entries.length >= MAX_ENTRIES) throw failure('TOOLBOX_SCAN_ENTRY_LIMIT', '扫描临时文件数量超过安全清理上限');
        const child = path.join(parent, name), childParts = [...parts, name], childIdentity = identity(stat(child));
        entries.push({ relativePath: childParts.join('/'), identity: childIdentity });
        if (childIdentity.type === 'directory') visit(child, childParts);
      }
    }
    visit(directory, []);
    return entries;
  }
  function validateEntries(record) {
    if (!Array.isArray(record.entries) || record.entries.length > MAX_ENTRIES) throw failure('TOOLBOX_SCAN_RECORD_INVALID', '扫描清理文件清单无效');
    const entries = new Map();
    for (const entry of record.entries) {
      if (typeof entry.relativePath !== 'string' || entry.relativePath.includes('\\') ||
          entry.relativePath.split('/').some((part) => !part || part === '.' || part === '..') ||
          path.isAbsolute(entry.relativePath) || entries.has(entry.relativePath) || !entry.identity ||
          !['file', 'directory'].includes(entry.identity.type)) throw failure('TOOLBOX_SCAN_RECORD_INVALID', '扫描清理文件身份记录无效');
      entries.set(entry.relativePath, entry.identity);
    }
    for (const current of captureTree(record)) {
      if (!sameIdentity(entries.get(current.relativePath), current.identity)) {
        throw failure('TOOLBOX_SCAN_IDENTITY_CHANGED', '扫描目录中出现未登记或已变化的内容，保留待清理文件');
      }
    }
    return entries;
  }
  function clean(record) {
    try {
      assertRoot(record);
      assertJournal(record);
      record.state = 'cleanup-pending';
      if (record.entries === null) record.entries = captureTree(record);
      const entries = validateEntries(record);
      save(record);
      const directory = directoryOf(record);
      // 清单保留全部原身份；允许上次部分删除已成功的对象缺失，拒绝替换和新增对象。
      for (const [relative, expected] of [...entries].sort(([a], [b]) => b.split('/').length - a.split('/').length)) {
        assertRoot(record);
        if (!assertObject(directory, record.directoryIdentity, true)) break;
        const parts = relative.split('/');
        let parent = directory, missingParent = false;
        for (let index = 0; index < parts.length - 1; index++) {
          parent = path.join(parent, parts[index]);
          if (!assertObject(parent, entries.get(parts.slice(0, index + 1).join('/')), true)) { missingParent = true; break; }
        }
        if (missingParent) continue;
        const target = path.join(directory, ...parts);
        if (!assertObject(target, expected, true)) continue;
        if (expected.type === 'directory') fsImpl.rmdirSync(target);
        else fsImpl.unlinkSync(target);
      }
      assertRoot(record);
      if (assertObject(directory, record.directoryIdentity, true)) fsImpl.rmdirSync(directory);
      assertJournal(record);
      if (record.journalIdentity) fsImpl.unlinkSync(journalOf(record));
      record.journalIdentity = null;
      recovered.delete(record.id);
      durableCleanup.delete(record.id);
    } catch (error) {
      record.lastError = diagnostic(error);
      try { save(record); } catch (saveError) { error.recordSaveError = diagnostic(saveError); }
      throw error;
    }
  }
  function load() {
    try {
      initialize(false);
      if (!rootPath) return;
      for (const name of fsImpl.readdirSync(rootPath)) {
        if (!name.startsWith(RECORD_PREFIX) || !name.endsWith('.json')) continue;
        const id = name.slice(RECORD_PREFIX.length, -5);
        if (liveRecords.has(id)) continue;
        let record = null;
        try {
          if (!UUID.test(id)) throw failure('TOOLBOX_SCAN_RECORD_INVALID', '扫描清理记录名无效');
          const file = path.join(rootPath, name), before = stat(file);
          if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_RECORD_BYTES)) throw failure('TOOLBOX_SCAN_RECORD_INVALID', '扫描清理记录类型或大小无效');
          const fd = fsImpl.openSync(file, 'r');
          let content;
          try {
            if (!sameIdentity(identity(before), identity(fsImpl.fstatSync(fd, { bigint: true })))) throw failure('TOOLBOX_SCAN_RECORD_CHANGED', '读取扫描清理记录时身份已变化');
            content = fsImpl.readFileSync(fd, 'utf8');
          } finally { fsImpl.closeSync(fd); }
          record = JSON.parse(content);
          if (record.version !== 1 || record.owner !== OWNER || record.id !== id ||
              !['running', 'cleanup-pending'].includes(record.state)) throw failure('TOOLBOX_SCAN_RECORD_INVALID', '扫描清理记录合同无效');
          record.journalIdentity = identity(before);
          assertRoot(record); assertJournal(record);
          if (record.state === 'running') throw failure('RESOURCE_PREPARE_CLOSE_UNCONFIRMED', '扫描记录尚无载体关闭事实，保留临时资源');
          clean(record);
        } catch (error) {
          recovered.set(id, { record, error });
        }
      }
    } catch (error) { rootIssue = error; }
  }
  load();
  return Object.freeze({
    create(input) {
      initialize(true);
      const record = { version: 1, owner: OWNER, id: randomUUID(), pid: process.pid,
        rootPath, rootIdentity, directoryIdentity: null, state: 'running', entries: null, lastError: null, journalIdentity: null };
      assertRoot(record);
      fsImpl.mkdirSync(directoryOf(record), { mode: 0o700 });
      live.set(input, record);
      liveRecords.set(record.id, record);
      record.directoryIdentity = identity(stat(directoryOf(record)));
      input.privateDirectory = directoryOf(record);
      save(record);
    },
    cleanup(input) {
      const record = live.get(input);
      if (!record) return;
      clean(record);
      live.delete(input);
      liveRecords.delete(record.id);
    },
    retryRecovered() {
      // 每轮重新读盘核验，损坏/活跃记录没有资格直接进入 clean。
      recovered.clear(); rootIssue = null; load();
      return this.snapshot();
    },
    snapshot() {
      const issues = [...recovered].map(([id, { error }]) => ({ id, ...diagnostic(error) }));
      if (rootIssue) issues.push({ id: null, ...diagnostic(rootIssue) });
      return Object.freeze({ cleanupPendingCount: issues.length,
        cleanupUnpersistedCount: [...liveRecords.values()].filter((record) => record.lastError && !durableCleanup.has(record.id)).length,
        cleanupFailures: Object.freeze(issues) });
    }
  });
}

function recoverToolboxScanResources(options) { return createToolboxScanResources(options).snapshot(); }
module.exports = { createToolboxScanResources, recoverToolboxScanResources };
