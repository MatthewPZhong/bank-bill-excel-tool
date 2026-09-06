'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeFileAtomicDurable, fsyncDirectory } = require('../background-execution/durable-file');
const { fail, opaque, digest, count, hash, snapshot } = require('./contracts');

const verifiedManifests = new WeakMap();
const ROOT_NAMES = new Set(['staging', 'inputs', 'results', 'operations', 'diagnostics', 'upgrade']);
const OBJECT_FOLDERS = { DATASET: 'inputs', RESULT: 'results', DIAGNOSTIC: 'diagnostics' };
const MAX_MANIFEST_BYTES = 65536;

function readVerifiedManifest(token) {
  const value = verifiedManifests.get(token);
  if (!value) fail('BIZOP_MANIFEST_NOT_VERIFIED');
  return value;
}
function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}
function assertBarrier(value) {
  if (value.capability !== 'supported') fail('DURABILITY_BARRIER_UNAVAILABLE');
}
function createBizOpPayloadStore({ userDataDir }) {
  const root = path.resolve(userDataDir, 'run-data', 'biz-op-v327');
  function resolve(relative, { mustExist = true } = {}) {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0')) fail('BIZOP_PATH_INVALID');
    const segments = relative.split('/');
    if (!ROOT_NAMES.has(segments[0]) || segments.some((part) => !part || part === '.' || part === '..'
        || !/^[a-zA-Z0-9_.-]+$/.test(part))) fail('BIZOP_PATH_INVALID');
    const target = path.join(root, ...segments);
    // 包含 userData 下的受控父目录，拒绝任一中间 symlink/junction。
    const relativeRoot = path.relative(path.resolve(userDataDir), target).split(path.sep);
    let current = path.resolve(userDataDir);
    for (let index = 0; index < relativeRoot.length; index += 1) {
      current = path.join(current, relativeRoot[index]);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || (index < relativeRoot.length - 1 && !stat.isDirectory())) fail('BIZOP_PATH_UNSAFE');
      } catch (error) {
        if (error.code === 'ENOENT' && !mustExist) break;
        throw error;
      }
    }
    return target;
  }
  function initialize() {
    for (const name of ROOT_NAMES) {
      const target = resolve(name, { mustExist: false });
      fs.mkdirSync(target, { recursive: true });
      resolve(name);
    }
  }
  function syncDocumentParents(target) {
    // 新建的 task/root 目录本身也需要在其父目录中持久化，不能只同步最后一级。
    let directory = path.dirname(target);
    const boundary = path.resolve(userDataDir);
    while (directory === boundary || directory.startsWith(`${boundary}${path.sep}`)) {
      assertBarrier(fsyncDirectory(directory));
      if (directory === boundary) break;
      directory = path.dirname(directory);
    }
  }
  function writeDocument(relative, value) {
    const bytes = Buffer.from(JSON.stringify(snapshot(value, { maxBytes: MAX_MANIFEST_BYTES })));
    if (bytes.length > MAX_MANIFEST_BYTES) fail('BIZOP_MANIFEST_TOO_LARGE');
    const target = resolve(relative, { mustExist: false });
    if (fs.existsSync(target)) {
      const previous = readDocument(relative);
      if (hash(previous.value) !== hash(value)) fail('BIZOP_DOCUMENT_IMMUTABLE');
      const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      syncDocumentParents(target);
      return { relativePath: relative, digest: previous.digest, byteSize: previous.byteSize };
    }
    const result = writeFileAtomicDurable(target, bytes);
    if (result.status !== 'committed') fail('DURABILITY_BARRIER_UNAVAILABLE');
    syncDocumentParents(target);
    return { relativePath: relative, digest: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length };
  }
  function readDocument(relative, expectedDigest) {
    const target = resolve(relative);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size > MAX_MANIFEST_BYTES) fail('BIZOP_MANIFEST_TOO_LARGE');
      const bytes = fs.readFileSync(fd);
      if (fileIdentity(before) !== fileIdentity(fs.fstatSync(fd))) fail('BIZOP_FILE_CHANGED');
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (expectedDigest !== undefined && actual !== digest(expectedDigest)) fail('BIZOP_MANIFEST_DIGEST_MISMATCH');
      return { value: snapshot(JSON.parse(bytes.toString('utf8'))), digest: actual, byteSize: bytes.length };
    } finally { fs.closeSync(fd); }
  }
  function prepareCandidate(taskRunId, objectId) {
    opaque(taskRunId); opaque(objectId);
    const relativePath = `staging/${taskRunId}/${objectId}`;
    const directory = resolve(relativePath, { mustExist: false });
    fs.mkdirSync(directory, { recursive: true });
    return Object.freeze({ directory: resolve(relativePath), relativePath });
  }
  function abortInventory(taskRunId, candidateRefs = []) {
    const directories = [];
    const files = [];
    function visit(relative) {
      const directory = resolve(relative, { mustExist: false });
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(resolve(relative), { withFileTypes: true })) {
        if (files.length + directories.length >= 4096) fail('BIZOP_CLEANUP_INVENTORY_LIMIT');
        const child = `${relative}/${entry.name}`;
        resolve(child);
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile()) files.push(child);
        else fail('BIZOP_CLEANUP_UNKNOWN_ENTRY');
      }
      directories.push(relative);
    }
    visit(`staging/${opaque(taskRunId)}`);
    for (const ref of candidateRefs) {
      opaque(ref);
      for (const folder of ['inputs', 'results']) {
        const relative = `${folder}/${ref}/manifest.json`;
        if (!fs.existsSync(resolve(relative, { mustExist: false }))) continue;
        const manifest = readDocument(relative).value;
        if (manifest.taskRunId !== taskRunId || manifest.objectId !== ref) fail('BIZOP_CLEANUP_OWNER_MISMATCH');
        visit(`${folder}/${ref}`);
      }
    }
    return { files, directories };
  }
  async function fileHash(relative) {
    const target = resolve(relative);
    const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      if (!before.isFile()) fail('BIZOP_PAYLOAD_NOT_FILE');
      const hasher = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hasher.update(chunk);
      if (fileIdentity(before) !== fileIdentity(await handle.stat())) fail('BIZOP_FILE_CHANGED');
      return { sha256: hasher.digest('hex'), byteSize: before.size };
    } finally { await handle.close(); }
  }
  async function verifyManifest(relative, expectedDigest) {
    const read = readDocument(relative, expectedDigest);
    const manifest = read.value;
    const folder = OBJECT_FOLDERS[manifest.objectKind];
    opaque(manifest.objectId); opaque(manifest.taskRunId); digest(manifest.intentDigest);
    if (manifest.schemaVersion !== 1 || !folder || relative !== `${folder}/${manifest.objectId}/manifest.json`
        || !Array.isArray(manifest.parts) || !manifest.parts.length) fail('BIZOP_MANIFEST_INVALID');
    const directory = path.posix.dirname(relative);
    const expected = new Set(['manifest.json']);
    let rows = 0;
    for (const part of manifest.parts) {
      if (!/^part-\d{6}\.(sqlite|jsonl)$/.test(part.name) || expected.has(part.name)) fail('BIZOP_PART_INVALID');
      expected.add(part.name);
      const actual = await fileHash(`${directory}/${part.name}`);
      if (actual.sha256 !== digest(part.sha256) || actual.byteSize !== count(part.byteSize)) fail('BIZOP_PART_MISMATCH');
      rows += count(part.rowCount);
    }
    const actualNames = await fs.promises.readdir(resolve(directory));
    if (actualNames.length !== expected.size || actualNames.some((name) => !expected.has(name))) fail('BIZOP_UNSEALED_FILES');
    if (count(manifest.rowCount) !== rows) fail('BIZOP_ROW_COUNT_MISMATCH');
    const token = Object.freeze({ ref: manifest.objectId, sha256: read.digest });
    verifiedManifests.set(token, snapshot({ ...manifest, relativePath: relative, digest: read.digest }));
    return token;
  }
  async function sealCandidate({ taskRunId, objectId, objectKind, intentDigest, catalog, parts }) {
    const folder = OBJECT_FOLDERS[objectKind];
    if (!folder) fail('BIZOP_OBJECT_KIND_INVALID');
    const staging = `staging/${opaque(taskRunId)}/${opaque(objectId)}`;
    const destination = `${folder}/${objectId}`;
    const measured = [];
    for (const part of parts) {
      if (!/^part-\d{6}\.(sqlite|jsonl)$/.test(part.name)) fail('BIZOP_PART_INVALID');
      const actual = await fileHash(`${staging}/${part.name}`);
      const handle = await fs.promises.open(resolve(`${staging}/${part.name}`), 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      measured.push({ name: part.name, ...actual, rowCount: count(part.rowCount) });
    }
    const names = await fs.promises.readdir(resolve(staging));
    if (names.length !== measured.length || names.some((name) => !measured.some((part) => part.name === name))) {
      fail('BIZOP_UNSEALED_FILES');
    }
    const manifest = { schemaVersion: 1, taskRunId, objectId, objectKind, intentDigest: digest(intentDigest),
      rowCount: measured.reduce((sum, part) => sum + part.rowCount, 0), catalog, parts: measured };
    const document = writeDocument(`${staging}/manifest.json`, manifest);
    const target = resolve(destination, { mustExist: false });
    if (fs.existsSync(target)) fail('BIZOP_DESTINATION_EXISTS');
    await fs.promises.rename(resolve(staging), target);
    assertBarrier(fsyncDirectory(path.dirname(target)));
    assertBarrier(fsyncDirectory(path.dirname(resolve(staging, { mustExist: false }))));
    return verifyManifest(`${destination}/manifest.json`, document.digest);
  }
  return Object.freeze({ root, initialize, resolve, writeDocument, readDocument, prepareCandidate,
    verifyManifest, sealCandidate, fileHash, abortInventory });
}

module.exports = { createBizOpPayloadStore, readVerifiedManifest, MAX_MANIFEST_BYTES };
