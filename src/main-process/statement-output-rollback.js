'use strict';

// v3.2.22 B45：网银多模板分组生成的写出记录。写出经 write(filePath, writeFn) 进行：
//   - 每个文件首次写入前记下原状态：已存在的普通文件复制原内容到批次临时目录，不存在的记为新建；路径上是符号链接、
//     文件夹等非普通文件时拒绝写出（写出会跟随链接改写别处的文件，回滚无法还原），由调用方回滚本批已写的内容。
//     同一文件经不同路径写入（不区分大小写的文件系统上大小写不同的路径、硬链接）按 dev + ino 合并为一条，只保留首份备份。
//   - 首次记下时即把「原路径 ↔ 备份文件」追加到批次目录的写出记录，临时卷随后写满时仍可据此人工恢复。
//   - 每次写完记下文件身份（dev + ino + 大小 + 修改时间）。同一文件再次写入前核对身份，写完后被其他程序替换或修改的
//     不再写入、回滚时也不覆盖。
//   - 任一组或合并失败时按首次写入的逆序还原：原有文件内容与备份一致时不动（如被 Excel 占用、写出时根本没打开），
//     否则分块原地写回（打开时截断，不换文件：余额种子的人工补录保护按 dev + ino 识别种子文件）；本批新建的文件删除。
//     本批的写出只原地改写文件（不换 dev + ino），写出回调抛错时路径上已换成另一个文件的属于其他程序；导入前不存在、
//     本批也没写成过的路径上出现的文件无法确认归属。这两类与写完后被改动的文件都不覆盖、不删除，交给人工。
//   - 有未能还原的文件时，备份目录只保留这些文件的备份，并写入「恢复清单.txt」（原路径 ↔ 备份文件 ↔ 处理方式 ↔ 原因）；
//     清单写不出时以写出记录代替。全部还原或成功时删除批次目录。进程在批次中途退出时不能还原（与修复前相同）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileValidationError } = require('../backend/file-service/common');

const COPY_CHUNK_BYTES = 1024 * 1024;
const MANIFEST_FILE_NAME = '恢复清单.txt';
const RECORD_FILE_NAME = '写出记录.txt';

// 写出期间失败、本批写出的文件都已还原时给原错误打的标记（导入入口据此按未生效的导入处理）
const OUTPUTS_RESTORED = Symbol('statementOutputsRestored');

function isStatementOutputsRestored(error) {
  return Boolean(error && typeof error === 'object' && error[OUTPUTS_RESTORED]);
}

const FAILURE_REASONS = Object.freeze({
  CHANGED_EXTERNALLY: '写出后已被其他程序修改或替换，未自动处理',
  NOT_REGULAR_FILE: '路径上已不是普通文件，未自动处理',
  UNCERTAIN_OWNER: '写出失败时路径上出现的文件，无法确认是否本批写出，未自动删除'
});

function lstatOrNull(fsImpl, filePath) {
  try {
    return fsImpl.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function identityOf(stat) {
  return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` : null;
}

// 文件对象（不含内容）：同一文件经不同路径写入时据此合并，写出回调抛错时据此判断路径上是否还是本批写过的文件
function fileKeyOf(stat) {
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

function withOpenFile(fsImpl, filePath, flags, use) {
  const fd = fsImpl.openSync(filePath, flags);
  try {
    return use(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// 分块比较，不把整份文件读入内存
function sameContent(fsImpl, leftPath, rightPath) {
  return withOpenFile(fsImpl, leftPath, 'r', (left) => withOpenFile(fsImpl, rightPath, 'r', (right) => {
    if (fsImpl.fstatSync(left).size !== fsImpl.fstatSync(right).size) return false;
    const leftBuffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    const rightBuffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const leftRead = fsImpl.readSync(left, leftBuffer, 0, COPY_CHUNK_BYTES, position);
      const rightRead = fsImpl.readSync(right, rightBuffer, 0, COPY_CHUNK_BYTES, position);
      if (leftRead !== rightRead) return false;
      if (!leftRead) return true;
      if (!leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))) return false;
      position += leftRead;
    }
  }));
}

// 分块原地写回：以截断方式打开目标（路径上仍是原文件时不换 dev + ino），不把整份文件读入内存
function copyInPlace(fsImpl, fromPath, toPath) {
  withOpenFile(fsImpl, fromPath, 'r', (source) => withOpenFile(fsImpl, toPath, 'w', (target) => {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const read = fsImpl.readSync(source, buffer, 0, COPY_CHUNK_BYTES, position);
      if (!read) return;
      let written = 0;
      while (written < read) written += fsImpl.writeSync(target, buffer, written, read - written);
      position += read;
    }
  }));
}

function changedExternallyError(filePath) {
  return new FileValidationError(
    'STATEMENT_OUTPUT_CHANGED_EXTERNALLY',
    '导出文件在本批写出期间被其他程序修改或替换，已停止生成',
    { detailLines: [`所在目录：${path.dirname(filePath)}`] }
  );
}

function unsafeTargetError(filePath) {
  // 只给目录：内部文件名可能含完整账号
  return new FileValidationError(
    'STATEMENT_OUTPUT_TARGET_UNSAFE',
    '导出位置有同名的快捷方式（符号链接）或文件夹，无法安全覆盖，请移走后重新导入',
    { detailLines: [`所在目录：${path.dirname(filePath)}`] }
  );
}

// 还原不完整：改报业务错误，列出原因、未能还原的数量与恢复清单位置（清单在系统临时目录、含完整路径，供本机人工恢复）。
//   不列文件路径：内部文件名可能含完整账号，错误会写入报错文件
function buildRollbackIncompleteError(error, { failures, backupDirectory, manifestPath }) {
  const restore = failures.filter((item) => item.existed).length;
  const changed = failures.filter((item) => item.reason === FAILURE_REASONS.CHANGED_EXTERNALLY).length;
  const summary = `未能自动还原 ${failures.length} 个文件（原有文件 ${restore} 个、本次新建 ${failures.length - restore} 个；其中写出后被其他程序改动 ${changed} 个）`;
  const location = manifestPath ? `恢复清单：${manifestPath}` : `原内容备份目录：${backupDirectory || '（未能创建）'}`;
  const business = error instanceof FileValidationError;
  // 数量与清单位置同时放进消息：界面状态框只显示消息（清单在系统临时目录，路径不含账号）
  return new FileValidationError(
    'STATEMENT_OUTPUT_ROLLBACK_INCOMPLETE',
    `生成失败，且有 ${failures.length} 个已写出的文件未能自动还原，请按恢复清单人工处理后再重新导入（${location}）`,
    {
      detailLines: [
        `生成失败原因：${business ? error.message : `系统异常${error && error.code ? `（${error.code}）` : ''}`}`,
        ...(business && Array.isArray(error.detailLines) ? error.detailLines : []),
        summary,
        location
      ],
      context: { rollbackSummary: summary, rollbackLocation: location }
    }
  );
}

function createStatementOutputJournal({ fsImpl = fs, stagingRoot = os.tmpdir(), now = () => new Date() } = {}) {
  const entries = [];
  const byPath = new Map();
  const byFile = new Map();
  let backupDirectory = null;

  function ensureBackupDirectory() {
    if (!backupDirectory) {
      backupDirectory = fsImpl.mkdtempSync(path.join(stagingRoot, 'statement-rollback-'));
      fsImpl.writeFileSync(path.join(backupDirectory, RECORD_FILE_NAME), [
        `网银多模板生成的写出记录（${now().toISOString()}）`,
        '本批首次写入每个文件前记下：原有文件的原内容备份、本次新建的文件。',
        ''
      ].join('\n') + '\n', 'utf8');
    }
    return backupDirectory;
  }

  // 写出前的目标检查：路径上是符号链接、文件夹等非普通文件时拒绝。多模板生成在首次读取余额种子前也调用
  function checkTarget(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    const stat = lstatOrNull(fsImpl, resolved);
    if (stat && !stat.isFile()) throw unsafeTargetError(resolved);
    return { resolved, stat };
  }

  function track(filePath) {
    const { resolved, stat } = checkTarget(filePath);
    const known = byPath.get(resolved) || (stat && byFile.get(fileKeyOf(stat)));
    if (known) {
      byPath.set(resolved, known);
      // 本批上次写完后被其他程序替换或修改：不再写入，回滚时按写完后被改动处理
      if (known.writtenIdentity && identityOf(stat) !== known.writtenIdentity) throw changedExternallyError(resolved);
      return known;
    }
    const entry = {
      filePath: resolved,
      existed: Boolean(stat),
      backupName: null,
      // 本批写过的文件对象：原有文件为原文件，新建的在首次写成后记下
      ownedFileKey: fileKeyOf(stat),
      writePending: false,
      writtenIdentity: null
    };
    const directory = ensureBackupDirectory();
    if (stat) {
      entry.backupName = `${String(entries.length + 1).padStart(3, '0')}.bak`;
      fsImpl.copyFileSync(resolved, path.join(directory, entry.backupName));
    }
    fsImpl.appendFileSync(path.join(directory, RECORD_FILE_NAME), `${entries.length + 1}. ${resolved}\n${
      entry.existed ? `   原有文件，原内容备份：${entry.backupName}` : '   本次新建的文件（导入前不存在）'}\n`, 'utf8');
    entries.push(entry);
    byPath.set(resolved, entry);
    if (stat) byFile.set(fileKeyOf(stat), entry);
    return entry;
  }

  // 写出入口：记下首次写入前的原状态后执行 writeFn，写完记下文件身份；writeFn 抛错时原样抛出
  function write(filePath, writeFn) {
    const entry = track(filePath);
    entry.writePending = true;
    const result = writeFn();
    const written = lstatOrNull(fsImpl, entry.filePath);
    entry.writtenIdentity = identityOf(written);
    entry.ownedFileKey = fileKeyOf(written);
    if (written) byFile.set(entry.ownedFileKey, entry);
    entry.writePending = false;
    return result;
  }

  function removeBackup(entry) {
    if (!entry.backupName) return;
    try {
      fsImpl.rmSync(path.join(backupDirectory, entry.backupName), { force: true });
    } catch (_error) {
      // 备份清理失败不影响还原结果
    }
  }

  // 路径上的文件是否可以按本批写过的文件处理；返回 null 或不能自动处理的原因
  function ownershipProblem(entry, current) {
    if (!entry.writePending) {
      // 本批写完后（下一次写出前）被其他程序替换或修改
      return identityOf(current) === entry.writtenIdentity ? null : FAILURE_REASONS.CHANGED_EXTERNALLY;
    }
    // 写出回调抛错：本批只原地改写文件，路径上换成另一个文件说明是其他程序替换的；
    //   导入前不存在、本批也没写成过的路径上出现的文件，无法确认是本批写到一半还是其他程序新建的
    if (!current) return null;
    if (!entry.ownedFileKey) return FAILURE_REASONS.UNCERTAIN_OWNER;
    return fileKeyOf(current) === entry.ownedFileKey ? null : FAILURE_REASONS.CHANGED_EXTERNALLY;
  }

  // 还原一项；返回 null 或未能还原的说明
  function restore(entry) {
    const failure = (reason) => ({ filePath: entry.filePath, existed: entry.existed, backupName: entry.backupName, reason });
    try {
      const current = lstatOrNull(fsImpl, entry.filePath);
      if (current && !current.isFile()) return failure(FAILURE_REASONS.NOT_REGULAR_FILE);
      const problem = ownershipProblem(entry, current);
      if (problem) return failure(problem);
      if (entry.existed) {
        const backupPath = path.join(backupDirectory, entry.backupName);
        if (!current || !sameContent(fsImpl, entry.filePath, backupPath)) copyInPlace(fsImpl, backupPath, entry.filePath);
        removeBackup(entry);
      } else if (current) {
        fsImpl.rmSync(entry.filePath, { force: true });
      }
      return null;
    } catch (error) {
      return failure(`系统错误 ${error && error.code ? error.code : (error && error.message) || String(error)}`);
    }
  }

  function writeManifest(failures) {
    try {
      const lines = [
        `网银多模板生成失败后未能自动还原的文件（${now().toISOString()}）`,
        '原有文件：用本目录中对应的备份文件覆盖原路径即可还原；本次新建的文件：确认后删除原路径的文件。',
        ''
      ];
      failures.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.filePath}`);
        lines.push(item.existed ? `   原有文件，原内容备份：${item.backupName}` : '   本次新建的文件（导入前不存在）');
        lines.push(`   原因：${item.reason}`);
      });
      const manifestPath = path.join(backupDirectory, MANIFEST_FILE_NAME);
      fsImpl.writeFileSync(manifestPath, `${lines.join('\n')}\n`, 'utf8');
      return manifestPath;
    } catch (_error) {
      // 清单写不出（如临时卷已满）：以首次写入时记下的写出记录代替（列出本批全部写出的文件与备份；已还原文件的备份已删除）
      const recordPath = path.join(backupDirectory, RECORD_FILE_NAME);
      return fsImpl.existsSync(recordPath) ? recordPath : null;
    }
  }

  function cleanup() {
    if (!backupDirectory) return;
    try {
      fsImpl.rmSync(backupDirectory, { recursive: true, force: true });
    } catch (_error) {
      // 临时目录清理失败不影响结果；系统临时目录由操作系统回收
    }
    backupDirectory = null;
  }

  function reset() {
    entries.length = 0;
    byPath.clear();
    byFile.clear();
  }

  // 按首次写入的逆序还原。返回 { restored, failures, backupDirectory, manifestPath }：
  //   restored 为 true 表示本批写出的文件都已回到导入前的状态；有未能还原的文件时保留备份目录与恢复清单
  function rollback() {
    const failures = [];
    for (const entry of [...entries].reverse()) {
      const failure = restore(entry);
      if (failure) failures.push(failure);
    }
    reset();
    if (!failures.length) {
      cleanup();
      return { restored: true, failures, backupDirectory: null, manifestPath: null };
    }
    const manifestPath = writeManifest(failures.reverse());
    const keptDirectory = backupDirectory;
    backupDirectory = null;
    return { restored: false, failures, backupDirectory: keptDirectory, manifestPath };
  }

  function commit() {
    reset();
    cleanup();
  }

  // 批次失败：回滚后返回要抛出的错误。全部还原时为打了标记的原错误；还原不完整时为列出恢复清单的业务错误
  function failBatch(error) {
    const outcome = rollback();
    if (!outcome.restored) return { error: buildRollbackIncompleteError(error, outcome), outcome };
    if (error && typeof error === 'object') Object.defineProperty(error, OUTPUTS_RESTORED, { value: true, configurable: true });
    return { error, outcome };
  }

  return { write, checkTarget, rollback, commit, failBatch };
}

module.exports = { createStatementOutputJournal, isStatementOutputsRestored, MANIFEST_FILE_NAME, RECORD_FILE_NAME };
