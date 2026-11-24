'use strict';

// v3.2.22 B45：网银多模板分组生成的写出记录。写出经 write(filePath, writeFn) 进行：
//   - 每个文件首次写入前记下原状态：已存在的普通文件复制原内容到批次临时目录，不存在的记为新建；路径上是符号链接、
//     文件夹等非普通文件时拒绝写出（写出会跟随链接改写别处的文件，回滚无法还原），由调用方回滚本批已写的内容。
//     同一文件经不同路径写入（不区分大小写的文件系统上大小写不同的路径、硬链接）按 dev + ino 合并为一条，只保留首份备份，
//     并记下写过的每个路径（回滚时逐一核对，已脱离原文件的路径列入恢复清单）。文件系统不提供文件编号（ino 为 0）时按路径区分；
//     此时原有文件另有硬链接（nlink > 1）的无法确认各链接是否同一文件，首次改写前拒绝。
//   - 首次记下时即把「原路径 ↔ 备份文件」追加到批次目录的写出记录，临时卷随后写满时仍可据此人工恢复。
//   - 每次写完记下文件身份（dev + ino + 大小 + 修改时间）。同一文件再次写入前核对身份，写完后被其他程序替换或修改的
//     不再写入、回滚时也不覆盖。已知文件（原有文件、本批写成过的文件）写前写后的文件编号不同，说明写出期间被替换，同样停止。
//   - 任一组或合并失败时按首次写入的逆序还原：原有文件内容与备份一致时不动（如被 Excel 占用、写出时根本没打开），
//     否则分块原地写回（不换文件：余额种子的人工补录保护按 dev + ino 识别种子文件）：以不截断方式打开，在同一文件描述符上
//     核对身份后再截断、写回，核对与写回针对同一个文件；本批新建的文件删除。
//     本批的写出只原地改写文件（不换 dev + ino、不移走），写出回调抛错时路径上已换成另一个文件或原有文件已不在的属于其他程序；
//     导入前不存在、本批也没写成过的路径上出现的文件无法确认归属。这几类与写完后被改动的文件都不覆盖、不删除，交给人工。
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
  MISSING: '原有文件已被其他程序移走或删除，未自动重建',
  UNCERTAIN_OWNER: '写出失败时路径上出现的文件，无法确认是否本批写出，未自动删除',
  BACKUP_MISSING: '原内容备份已不可用（被删除、移走或大小与备份时不符），路径上仍是本批写出的内容，未自动处理'
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

// 文件对象（不含内容）：同一文件经不同路径写入时据此合并，写出回调抛错时据此判断路径上是否还是本批写过的文件。
//   文件系统不提供文件编号（ino 为 0，与 balance-seed-store.js getBalanceSeedFileIdentity 同一回退）时按系统解析出的
//   真实路径区分（realpathSync.native：不区分大小写的卷上还原磁盘上的实际大小写、Windows 短文件名还原为长文件名、
//   解析链接），不把同卷所有文件当成同一个，也不把同一文件的大小写别名当成两个（Codex 第五轮）；解析失败时退回字面路径
function canonicalPathOf(fsImpl, filePath) {
  const resolved = path.resolve(String(filePath));
  const realpath = fsImpl.realpathSync && (fsImpl.realpathSync.native || fsImpl.realpathSync);
  if (typeof realpath !== 'function') return resolved;
  try {
    return path.resolve(realpath(resolved));
  } catch (_error) {
    return resolved;
  }
}

function fileKeyOf(stat, filePath, fsImpl) {
  if (!stat) return null;
  return stat.ino ? `${stat.dev}:${stat.ino}` : `path:${canonicalPathOf(fsImpl, filePath)}`;
}

function withOpenFile(fsImpl, filePath, flags, use) {
  const fd = fsImpl.openSync(filePath, flags);
  try {
    return use(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// 从 position 起读满 buffer（readSync 可能未到文件末尾就返回较少字节），返回实际读到的字节数（不足说明已到末尾）
function readChunk(fsImpl, fd, buffer, position) {
  let filled = 0;
  while (filled < buffer.length) {
    const read = fsImpl.readSync(fd, buffer, filled, buffer.length - filled, position + filled);
    if (!read) break;
    filled += read;
  }
  return filled;
}

// 分块比较（left 为已打开的文件描述符），不把整份文件读入内存；两边按同一逻辑分块读满再比较（Codex 第七轮）
function sameContent(fsImpl, left, rightPath) {
  return withOpenFile(fsImpl, rightPath, 'r', (right) => {
    if (fsImpl.fstatSync(left).size !== fsImpl.fstatSync(right).size) return false;
    const leftBuffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    const rightBuffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const leftRead = readChunk(fsImpl, left, leftBuffer, position);
      const rightRead = readChunk(fsImpl, right, rightBuffer, position);
      if (leftRead !== rightRead) return false;
      if (!leftRead) return true;
      if (!leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))) return false;
      position += leftRead;
    }
  });
}

// 分块原地写回到已打开（不截断）并核对过身份的文件描述符：备份成功打开后才截断（打开备份失败时不清空目标），
//   再按位置写入，不换 dev + ino，不把整份文件读入内存。已打开的备份大小与备份时不符（被截短等）时不截断目标、返回 false；
//   写回的字节数与备份时不符时报错（Codex 第十一轮）
function copyIntoDescriptor(fsImpl, fromPath, target, expectedSize) {
  return withOpenFile(fsImpl, fromPath, 'r', (source) => {
    if (fsImpl.fstatSync(source, { bigint: true }).size !== expectedSize) return false;
    fsImpl.ftruncateSync(target, 0);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const read = fsImpl.readSync(source, buffer, 0, COPY_CHUNK_BYTES, position);
      if (!read) {
        if (BigInt(position) !== expectedSize) {
          throw Object.assign(new Error('原内容备份在写回期间变短'), { code: 'STATEMENT_BACKUP_SHORT' });
        }
        return true;
      }
      let written = 0;
      while (written < read) written += fsImpl.writeSync(target, buffer, written, read - written, position + written);
      position += read;
    }
  });
}

function changedExternallyError(filePath) {
  return new FileValidationError(
    'STATEMENT_OUTPUT_CHANGED_EXTERNALLY',
    '导出文件在本批写出期间被其他程序修改或替换，已停止生成',
    { detailLines: [`所在目录：${path.dirname(filePath)}`] }
  );
}

function unsafeTargetError(filePath, message = '导出位置有同名的快捷方式（符号链接）或文件夹，无法安全覆盖，请移走后重新导入') {
  // 只给目录：内部文件名可能含完整账号
  return new FileValidationError(
    'STATEMENT_OUTPUT_TARGET_UNSAFE',
    message,
    { detailLines: [`所在目录：${path.dirname(filePath)}`] }
  );
}

const UNIDENTIFIABLE_HARD_LINK_MESSAGE = '导出位置的同名文件另有硬链接，且所在磁盘不提供文件编号、无法确认各链接是否为同一文件，'
  + '无法安全覆盖，请改为独立的文件后重新导入';

// 还原不完整：改报业务错误，列出原因、未能还原的数量与恢复清单位置（清单在系统临时目录、含完整路径，供本机人工恢复）。
//   不列文件路径：内部文件名可能含完整账号，错误会写入报错文件
function buildRollbackIncompleteError(error, { failures, backupDirectory, manifestPath }) {
  const restore = failures.filter((item) => item.existed).length;
  // 写前不存在的路径只在本批曾写成该文件（记下过文件身份）时计为「本次新建」（Codex 第九、十轮）
  const uncertain = failures.filter((item) => !item.existed && !item.createdByBatch).length;
  const changed = failures.filter((item) => item.reason === FAILURE_REASONS.CHANGED_EXTERNALLY).length;
  // 写前不存在、写出回调抛错后路径上出现的文件归属不明，不计入「本次新建」（Codex 第九轮）
  const summary = `未能自动还原 ${failures.length} 个文件（原有文件 ${restore} 个、本次新建 ${failures.length - restore - uncertain} 个${
    uncertain ? `、写前不存在且归属待核对 ${uncertain} 个` : ''}；其中写出后被其他程序改动 ${changed} 个）`;
  // 恢复清单写不出时退回写出记录：它列出本批全部写入尝试（含已还原的），不是失败清单（Codex 第八轮）
  const location = !manifestPath
    ? `原内容备份目录：${backupDirectory || '（未能创建）'}`
    : (path.basename(manifestPath) === RECORD_FILE_NAME
      ? `恢复清单未能写出，请按写出记录逐个核对（记录列出本批全部写入尝试，不是失败清单）：${manifestPath}`
      : `恢复清单：${manifestPath}`);
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
  // 写出记录的条目序号与备份文件名（撤销登记后不复用，Codex 第八轮）
  let sequence = 0;
  // 已还原文件的备份重试后仍未能删除（部分回滚时随恢复清单列出，与需人工还原的文件分开，Codex 第九轮）
  const leftoverBackups = [];

  function ensureBackupDirectory() {
    if (!backupDirectory) {
      backupDirectory = fsImpl.mkdtempSync(path.join(stagingRoot, 'statement-rollback-'));
      fsImpl.writeFileSync(path.join(backupDirectory, RECORD_FILE_NAME), [
        `网银多模板生成的写出记录（${now().toISOString()}）`,
        '本文件不是失败清单：本批首次写入每个文件前记下原状态（含之后已自动还原的文件），只在恢复清单写不出时供逐个核对。',
        '「写前不存在」只表示导入前该路径没有文件，不代表路径上现在的文件由本批创建；删除或覆盖前先核对内容与修改时间。',
        ''
      ].join('\n') + '\n', 'utf8');
    }
    return backupDirectory;
  }

  // 写出前的目标检查：路径上是符号链接、文件夹等非普通文件时拒绝。多模板生成在首次读取余额种子前也调用
  //   文件系统不提供文件编号（ino 为 0）且文件另有硬链接时同样拒绝：真实路径不能把各硬链接归为同一文件，经不同链接写入会
  //   各记一份备份（后一份已是前组写后的内容），回滚无法还原批前内容（Codex 第六轮）
  function checkTarget(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    const stat = lstatOrNull(fsImpl, resolved);
    if (stat && !stat.isFile()) throw unsafeTargetError(resolved);
    if (stat && !stat.ino && stat.nlink > 1) throw unsafeTargetError(resolved, UNIDENTIFIABLE_HARD_LINK_MESSAGE);
    return { resolved, stat };
  }

  function track(filePath) {
    const { resolved, stat } = checkTarget(filePath);
    const known = byPath.get(resolved) || (stat && byFile.get(fileKeyOf(stat, resolved, fsImpl)));
    if (known) {
      byPath.set(resolved, known);
      if (!known.paths.has(resolved)) {
        known.paths.add(resolved);
        // 别名同样登记到写出记录（恢复清单写不出时以写出记录代替，须能找到经别名写过的路径）
        fsImpl.appendFileSync(path.join(ensureBackupDirectory(), RECORD_FILE_NAME), `   同一文件的别名路径：${resolved}${
          known.backupName ? `（原内容备份：${known.backupName}）` : ''}\n`, 'utf8');
      }
      // 本批上次写完后被其他程序替换或修改：不再写入，回滚时按写完后被改动处理
      if (known.writtenIdentity && identityOf(stat) !== known.writtenIdentity) throw changedExternallyError(resolved);
      return { entry: known, resolved, stat, created: false };
    }
    sequence += 1;
    const entry = {
      filePath: resolved,
      // 写过这个文件的全部路径（硬链接等别名）
      paths: new Set([resolved]),
      existed: Boolean(stat),
      backupName: null,
      // 本批写过的文件对象：原有文件为原文件，新建的在首次写成后记下
      ownedFileKey: fileKeyOf(stat, resolved, fsImpl),
      // 备份文件的大小（字节，bigint）：回滚前与写回时核对，备份被截短时不按它写回（Codex 第十一轮）
      backupSize: null,
      writePending: false,
      writtenIdentity: null,
      replacedWhileWriting: false
    };
    const directory = ensureBackupDirectory();
    if (stat) {
      entry.backupName = `${String(sequence).padStart(3, '0')}.bak`;
      fsImpl.copyFileSync(resolved, path.join(directory, entry.backupName));
      entry.backupSize = fsImpl.lstatSync(path.join(directory, entry.backupName), { bigint: true }).size;
    }
    try {
      fsImpl.appendFileSync(path.join(directory, RECORD_FILE_NAME), `${sequence}. ${resolved}\n${
        entry.existed ? `   写前已有文件，原内容备份：${entry.backupName}` : '   写前不存在（不代表路径上现在的文件由本批创建）'}\n`, 'utf8');
    } catch (error) {
      // 登记失败时该文件还没被改写、也不归写出记录管理：清掉刚做的备份，不在批次目录里留下无关账单
      if (entry.backupName) {
        try {
          fsImpl.rmSync(path.join(directory, entry.backupName), { force: true });
        } catch (_cleanupError) {
          // 尽力而为
        }
      }
      throw error;
    }
    entries.push(entry);
    byPath.set(resolved, entry);
    if (stat) byFile.set(fileKeyOf(stat, resolved, fsImpl), entry);
    return { entry, resolved, stat, created: true };
  }

  // 撤销本次首次登记（写出回调在改动目标之前失败）：之后同一路径再写时重新记下原状态与备份
  function untrack(entry) {
    entries.splice(entries.indexOf(entry), 1);
    entry.paths.forEach((filePath) => byPath.delete(filePath));
    if (entry.ownedFileKey && byFile.get(entry.ownedFileKey) === entry) byFile.delete(entry.ownedFileKey);
    removeBackup(entry);
    try {
      fsImpl.appendFileSync(path.join(backupDirectory, RECORD_FILE_NAME), `   ${entry.filePath}：本次未写入（写出前读取失败），不归本批处理\n`, 'utf8');
    } catch (_error) {
      // 尽力而为：回滚不再处理该路径
    }
  }

  // 写出回调在改动目标之前失败：FILE_READ（读余额模板、逐笔写种子前重读种子失败）按「余额生成失败」告警，本批继续（spec D3）
  function isReadBeforeWriteError(error) {
    return error instanceof FileValidationError && error.code === 'FILE_READ';
  }

  // 写出入口：记下首次写入前的原状态后执行 writeFn，写完记下文件身份；writeFn 抛错时原样抛出。
  //   已知文件（原有文件、本批写成过的文件）写后按路径查到的文件编号须与写前相同（本批只原地改写），否则是写出期间被
  //   其他程序替换：不认作本批文件，停止生成，回滚时留给人工。本批新建的文件首次写成后按路径记下（极短的写完与记下之间
  //   被替换无法识别，见 spec §3）
  function write(filePath, writeFn) {
    const { entry, resolved, stat, created } = track(filePath);
    const keyBefore = fileKeyOf(stat, resolved, fsImpl);
    const pendingBefore = entry.writePending;
    entry.writePending = true;
    let result;
    try {
      result = writeFn();
    } catch (error) {
      // 写出前读取失败且路径上的文件与写前一致：本次确定未写入，撤销本次的写入登记（首次登记的撤销登记，此前写成过的
      //   回到上次写后的状态），回滚时不把它当作写到一半的文件（Codex 第八轮 P1）
      let unchanged = false;
      try {
        unchanged = isReadBeforeWriteError(error) && identityOf(lstatOrNull(fsImpl, resolved)) === identityOf(stat);
      } catch (_statError) {
        // 状态不明：保持写入中，回滚时按写出回调抛错处理
      }
      if (unchanged) {
        if (created) untrack(entry);
        else entry.writePending = pendingBefore;
      }
      throw error;
    }
    const written = lstatOrNull(fsImpl, resolved);
    if (keyBefore && fileKeyOf(written, resolved, fsImpl) !== keyBefore) {
      entry.replacedWhileWriting = true;
      throw changedExternallyError(resolved);
    }
    // 写完后路径上没有普通文件（被其他程序移走等）：本批没有可交付的输出（后续合并会跳过缺失的分组文件），停止生成
    if (!written || !written.isFile()) throw changedExternallyError(resolved);
    entry.writtenIdentity = identityOf(written);
    if (!entry.ownedFileKey) entry.ownedFileKey = fileKeyOf(written, resolved, fsImpl);
    if (written) byFile.set(entry.ownedFileKey, entry);
    entry.writePending = false;
    return result;
  }

  function removeBackup(entry) {
    if (!entry.backupName) return;
    try {
      fsImpl.rmSync(path.join(backupDirectory, entry.backupName), { force: true, maxRetries: 3, retryDelay: 100 });
    } catch (_error) {
      // 备份清理失败不影响还原结果；记下，部分回滚时在恢复清单中单列
      leftoverBackups.push(entry.backupName);
    }
  }

  // 路径上的文件是否可以按本批写过的文件处理；返回 null 或不能自动处理的原因
  function ownershipProblem(entry, current) {
    if (entry.replacedWhileWriting) return FAILURE_REASONS.CHANGED_EXTERNALLY;
    // 本批只原地改写、不移走文件：原有文件或本批写成过的文件不在了，是其他程序移走或删除的
    if (!current) return entry.existed ? FAILURE_REASONS.MISSING : null;
    if (!entry.writePending) {
      // 本批写完后（下一次写出前）被其他程序替换或修改
      return identityOf(current) === entry.writtenIdentity ? null : FAILURE_REASONS.CHANGED_EXTERNALLY;
    }
    // 写出回调抛错：本批只原地改写文件，路径上换成另一个文件说明是其他程序替换的；
    //   导入前不存在、本批也没写成过的路径上出现的文件，无法确认是本批写到一半还是其他程序新建的
    if (!entry.ownedFileKey) return FAILURE_REASONS.UNCERTAIN_OWNER;
    return fileKeyOf(current, entry.filePath, fsImpl) === entry.ownedFileKey ? null : FAILURE_REASONS.CHANGED_EXTERNALLY;
  }

  function noteRestoreAttempt(entry, fd) {
    try {
      entry.writtenIdentity = identityOf(fsImpl.fstatSync(fd, { bigint: true }));
      entry.writePending = false;
    } catch (_error) {
      // 取不到状态时保持原记录：别名重试按写完后被改动处理，交给人工
    }
  }

  // 经别名写回原内容后复核此前失败的路径：仍指向原文件且内容与备份一致的，已随别名一起还原（Codex 第六轮）
  function restoredInPlace(entry, filePath) {
    try {
      const current = lstatOrNull(fsImpl, filePath);
      if (!current || !current.isFile() || fileKeyOf(current, filePath, fsImpl) !== entry.ownedFileKey) return false;
      return withOpenFile(fsImpl, filePath, 'r', (fd) => (
        fileKeyOf(fsImpl.fstatSync(fd, { bigint: true }), filePath, fsImpl) === entry.ownedFileKey
          && sameContent(fsImpl, fd, path.join(backupDirectory, entry.backupName))
      ));
    } catch (_error) {
      return false;
    }
  }

  // 原有文件写回：先只读打开比较内容（一致时不写回：被 Excel 占用、写出时根本没打开的文件，写回会再次撞上占用）；
  //   需要写回时以不截断方式打开，在同一描述符上核对身份后再截断、写回，核对与写回针对同一个文件
  //   写回后再核对路径仍指向写回的文件（写回期间被另存替换时，备份写进了已脱离路径的旧文件，不算还原）。
  //   targetPath 为经哪个路径写回（主路径被替换时经仍指向原文件的别名写回）
  function restoreExisting(entry, targetPath = entry.filePath) {
    const backupPath = path.join(backupDirectory, entry.backupName);
    const readProblem = withOpenFile(fsImpl, targetPath, 'r', (fd) => {
      const current = fsImpl.fstatSync(fd, { bigint: true });
      if (!current.isFile()) return { reason: FAILURE_REASONS.NOT_REGULAR_FILE };
      const problem = ownershipProblem(entry, current);
      if (problem) return { reason: problem };
      return sameContent(fsImpl, fd, backupPath) ? { done: true } : { key: fileKeyOf(current, targetPath, fsImpl) };
    });
    if (readProblem.reason || readProblem.done) return readProblem.reason || null;
    return withOpenFile(fsImpl, targetPath, 'r+', (fd) => {
      const current = fsImpl.fstatSync(fd, { bigint: true });
      if (!current.isFile()) return FAILURE_REASONS.NOT_REGULAR_FILE;
      if (fileKeyOf(current, targetPath, fsImpl) !== readProblem.key) return FAILURE_REASONS.CHANGED_EXTERNALLY;
      const problem = ownershipProblem(entry, current);
      if (problem) return problem;
      let copied;
      try {
        copied = copyIntoDescriptor(fsImpl, backupPath, fd, entry.backupSize);
      } finally {
        // 写回成功或截断后失败，都在已核对的描述符上记下当前文件状态：之后关闭描述符失败（网络盘到关闭时才报错）或写回失败时，
        //   经别名重试仍认作本批文件、核对内容，不误判为被其他程序修改（Codex 第六、九轮）
        noteRestoreAttempt(entry, fd);
      }
      if (!copied) return FAILURE_REASONS.BACKUP_MISSING;
      return fileKeyOf(lstatOrNull(fsImpl, targetPath), targetPath, fsImpl) === readProblem.key
        ? null
        : FAILURE_REASONS.CHANGED_EXTERNALLY;
    });
  }

  function backupIntact(entry) {
    const stat = lstatOrNull(fsImpl, path.join(backupDirectory, entry.backupName));
    return Boolean(stat && stat.isFile() && stat.size === entry.backupSize);
  }

  // 还原一项；返回未能还原的说明列表（主路径与已脱离原文件的别名路径）
  function restore(entry) {
    // createdByBatch：写前不存在、本批曾写成该文件（有文件身份为证）；否则路径上的文件归属待核对
    const failure = (reason, filePath = entry.filePath) => ({
      filePath, existed: entry.existed, backupName: entry.backupName, reason,
      createdByBatch: !entry.existed && Boolean(entry.ownedFileKey)
    });
    const failures = [];
    // 原有文件的内容是否已写回（经主路径或仍指向原文件的别名）
    let originalRestored = !entry.existed;
    try {
      const current = lstatOrNull(fsImpl, entry.filePath);
      if (current && !current.isFile()) {
        failures.push(failure(FAILURE_REASONS.NOT_REGULAR_FILE));
      } else if (entry.existed && current && !backupIntact(entry)) {
        // 备份不可用（被删除、移走或被截短）：目标仍是本批写出的内容，与原文件被移走区分（Codex 第十、十一轮）
        failures.push(failure(FAILURE_REASONS.BACKUP_MISSING));
      } else if (entry.existed && current) {
        const reason = restoreExisting(entry);
        if (reason) failures.push(failure(reason));
        else originalRestored = true;
      } else {
        const problem = ownershipProblem(entry, current);
        if (problem) failures.push(failure(problem));
        else if (current) fsImpl.rmSync(entry.filePath, { force: true });
      }
    } catch (error) {
      failures.push(failure(error && error.code === 'ENOENT' && entry.existed
        ? FAILURE_REASONS.MISSING
        : `系统错误 ${error && error.code ? error.code : (error && error.message) || String(error)}`));
    }
    // 经别名路径写过的同一文件：别名已指向另一个文件（被其他程序另存替换等）时，该路径未还原，列入恢复清单。
    //   主路径没能写回、别名仍指向原文件时经别名写回一次（否则之后经别名读到的仍是失败批次的内容）
    for (const aliasPath of entry.paths) {
      if (aliasPath === entry.filePath) continue;
      try {
        const aliased = lstatOrNull(fsImpl, aliasPath);
        const stillOwned = aliased ? fileKeyOf(aliased, aliasPath, fsImpl) === entry.ownedFileKey : !entry.existed;
        if (!stillOwned) {
          failures.push(failure(aliased ? FAILURE_REASONS.CHANGED_EXTERNALLY : FAILURE_REASONS.MISSING, aliasPath));
        } else if (!originalRestored && aliased) {
          const reason = restoreExisting(entry, aliasPath);
          if (reason) failures.push(failure(reason, aliasPath));
          else originalRestored = true;
        }
      } catch (error) {
        failures.push(failure(`系统错误 ${error && error.code ? error.code : String(error)}`, aliasPath));
      }
    }
    // 先前写回失败的路径（如主路径打开失败）经后面的别名写回了同一文件：复核后不再列入恢复清单
    if (entry.existed && originalRestored && failures.length) {
      for (let index = failures.length - 1; index >= 0; index -= 1) {
        if (restoredInPlace(entry, failures[index].filePath)) failures.splice(index, 1);
      }
    }
    // 有未还原的路径时保留备份（别名原本指向同一文件，也按这份备份人工恢复）
    if (!failures.length) removeBackup(entry);
    return failures;
  }

  // 恢复清单逐条的处理方式（Codex 第七轮）：只有确认路径上仍是本批写过的文件时才可直接覆盖或删除；路径已指向其他文件、
  //   已不是普通文件或无法确认归属时，覆盖或删除会改掉其他程序的文件（或经快捷方式改写别处），须先人工核对
  function manualActionOf(item) {
    const backup = item.existed ? `本目录的备份 ${item.backupName}` : '';
    switch (item.reason) {
      case FAILURE_REASONS.CHANGED_EXTERNALLY:
        return item.existed
          ? `路径上的文件已被其他程序改动或替换，先保留现状、另存一份，再与${backup}核对，确认后人工合并或覆盖`
          : '路径上的文件已被其他程序改动或替换，先保留现状，核对后再决定是否删除';
      case FAILURE_REASONS.NOT_REGULAR_FILE:
        return `路径上已是快捷方式（符号链接）或文件夹，不要直接覆盖或删除（会改写或删掉别处的内容）；移走后再${item.existed ? `用${backup}放回原路径` : '确认是否需要处理'}`;
      case FAILURE_REASONS.MISSING:
        return `原有文件已被其他程序移走或删除，确认去向后再决定是否用${backup}在原路径重建`;
      case FAILURE_REASONS.UNCERTAIN_OWNER:
        return '无法确认是否本批写出，核对内容后再决定是否删除';
      case FAILURE_REASONS.BACKUP_MISSING:
        return '原内容备份已不可用，无法据此还原；路径上仍是本批写出的内容，从导入前的其他来源（如上一次导出、同步盘历史版本）恢复';
      default:
        if (item.existed) return `确认路径上仍是原文件后，用${backup}覆盖原路径`;
        return item.createdByBatch ? '确认路径上仍是本次写出的文件后删除' : '无法确认路径上的文件是否本批写出，核对内容后再决定是否删除';
    }
  }

  function writeManifest(failures) {
    try {
      const lines = [
        `网银多模板生成失败后未能自动还原的文件（${now().toISOString()}）`,
        '每个文件的处理方式见各条说明；路径上已是其他程序的文件或快捷方式、文件夹时，先保留现状，不要直接覆盖或删除。',
        ''
      ];
      failures.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.filePath}`);
        lines.push(item.existed
          ? `   原有文件，原内容备份：${item.backupName}`
          : (item.createdByBatch
            ? '   本次新建的文件（导入前不存在）'
            : '   写前不存在，路径上现在的文件归属待核对（不一定由本批创建）'));
        lines.push(`   原因：${item.reason}`);
        lines.push(`   处理方式：${manualActionOf(item)}`);
      });
      if (leftoverBackups.length) {
        lines.push('', `以下备份对应的文件已自动还原，备份未能删除，不需人工还原，可直接删除：${leftoverBackups.join('、')}`);
      }
      // 先写临时文件、完整写成后再改为正式名称：写到一半失败（如临时卷写满）时不留下残缺的正式清单（Codex 第九轮）
      const manifestPath = path.join(backupDirectory, MANIFEST_FILE_NAME);
      const partialPath = `${manifestPath}.partial`;
      try {
        fsImpl.writeFileSync(partialPath, `${lines.join('\n')}\n`, 'utf8');
        fsImpl.renameSync(partialPath, manifestPath);
      } catch (error) {
        try {
          fsImpl.rmSync(partialPath, { force: true });
        } catch (_cleanupError) {
          // 尽力而为：临时文件名不是正式清单
        }
        throw error;
      }
      return manifestPath;
    } catch (_error) {
      // 清单写不出（如临时卷已满）：以首次写入时记下的写出记录代替（列出本批全部写出的文件与备份；已还原文件的备份已删除）
      const recordPath = path.join(backupDirectory, RECORD_FILE_NAME);
      return fsImpl.existsSync(recordPath) ? recordPath : null;
    }
  }

  // 删除批次目录（含账单原内容备份与列出完整路径的写出记录）：被扫描程序等短暂占用时有限重试（Codex 第八轮）；
  //   仍失败时不影响结果，返回目录位置交调用方留痕（目录名不含业务信息）
  function cleanup() {
    if (!backupDirectory) return null;
    const directory = backupDirectory;
    backupDirectory = null;
    try {
      fsImpl.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return null;
    } catch (_error) {
      return directory;
    }
  }

  function reset() {
    entries.length = 0;
    byPath.clear();
    byFile.clear();
    leftoverBackups.length = 0;
  }

  // 按首次写入的逆序还原。返回 { restored, failures, backupDirectory, manifestPath }：
  //   restored 为 true 表示本批写出的文件都已回到导入前的状态；有未能还原的文件时保留备份目录与恢复清单
  function rollback() {
    const failures = [];
    for (const entry of [...entries].reverse()) {
      failures.push(...restore(entry).reverse());
    }
    if (!failures.length) {
      reset();
      const cleanupFailedDirectory = cleanup();
      return { restored: true, failures, backupDirectory: null, manifestPath: null, cleanupFailedDirectory };
    }
    const manifestPath = writeManifest(failures.reverse());
    reset();
    const keptDirectory = backupDirectory;
    backupDirectory = null;
    return { restored: false, failures, backupDirectory: keptDirectory, manifestPath };
  }

  function commit() {
    reset();
    return { cleanupFailedDirectory: cleanup() };
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
