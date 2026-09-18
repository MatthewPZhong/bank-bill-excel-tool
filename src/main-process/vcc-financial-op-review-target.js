'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { targetPathAliasKey, pathsAlias } = require('./toolbox-target-identity');
const { exportFileIdentity } = require('./biz-op-v327/export-file-identity');
const { hashClosedFile } = require('./biz-op-v327/export-validator');
const { reviewError } = require('../backend/vcc-financial-op/review-export-contract');

function statIdentity(stat) {
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].map((key) => [key, String(stat[key])]));
}
function sameIdentity(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function maybeStat(filePath) {
  try { return fs.lstatSync(filePath, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function assertTargetAllowed(filePath, { protectedRoots = [], knownInputPaths = [] } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.xlsx') {
    throw reviewError('vcc-review-target-invalid', '请选择完整的 .xlsx 文件路径');
  }
  const target = targetPathAliasKey(fs, filePath);
  for (const root of protectedRoots.filter(Boolean)) {
    const rootKey = targetPathAliasKey(fs, path.resolve(root), { allowMissingParentLexicalFallback: true });
    if (target === rootKey || target.startsWith(`${rootKey}${path.sep}`)) {
      throw reviewError('vcc-review-target-protected', '不能将待确认表保存到应用或存档的受管目录');
    }
  }
  for (const input of knownInputPaths.filter(Boolean)) {
    if (pathsAlias(fs, filePath, input, { allowMissingParentLexicalFallback: true })) {
      throw reviewError('vcc-review-target-protected', '不能覆盖当前结果使用的原始输入文件');
    }
  }
  const stat = maybeStat(filePath);
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)) {
    throw reviewError('vcc-review-target-protected', '输出目标必须是普通文件，不能使用符号链接或硬链接');
  }
}
async function captureTarget(filePath, guards, safePoint = () => {}) {
  assertTargetAllowed(filePath, guards);
  const parentPath = fs.realpathSync(path.dirname(filePath));
  const parent = fs.statSync(parentPath, { bigint: true });
  if (!parent.isDirectory()) throw reviewError('vcc-review-target-invalid', '输出目录无效');
  const target = path.join(parentPath, path.basename(filePath));
  const stat = maybeStat(target);
  // Existing empty files are legal output targets; their identity still participates in publication.
  const content = stat && stat.size > 0n ? await hashClosedFile(target, safePoint) : null;
  const snapshot = { target, selectedPath: filePath, parentPath,
    parentIdentity: { dev: String(parent.dev), ino: String(parent.ino) },
    identity: stat ? statIdentity(stat) : null, sha256: content?.sha256 || null };
  assertTargetUnchanged(snapshot); return snapshot;
}
function assertTargetUnchanged(snapshot) {
  if (fs.realpathSync(path.dirname(snapshot.selectedPath)) !== snapshot.parentPath) throw reviewError('vcc-review-target-changed', '保存期间输出目录发生变化，请重新保存');
  const parent = fs.statSync(snapshot.parentPath, { bigint: true });
  const stat = maybeStat(snapshot.target);
  if (String(parent.dev) !== snapshot.parentIdentity.dev || String(parent.ino) !== snapshot.parentIdentity.ino
      || (snapshot.identity ? !stat || !sameIdentity(snapshot.identity, statIdentity(stat)) : stat !== null)) {
    throw reviewError('vcc-review-target-changed', '保存期间目标文件发生变化，请重新保存');
  }
}
function publishReviewFile({ stagedPath, evidence, snapshot, assertFresh, fsImpl = fs }) {
  // This entire function is synchronous. The final business freshness check and
  // rename cannot be separated by an event-loop turn admitting another VCC task.
  const stagedStat = fsImpl.lstatSync(stagedPath, { bigint: true });
  if (!stagedStat.isFile() || stagedStat.isSymbolicLink() || stagedStat.nlink !== 1n
      || !sameIdentity(exportFileIdentity(stagedStat), evidence.fileIdentity)
      || path.dirname(stagedPath) !== snapshot.parentPath) {
    throw reviewError('vcc-review-output-changed', '待发布文件已变化，已停止保存');
  }
  assertTargetUnchanged(snapshot);
  const check = assertFresh();
  if (check && typeof check.then === 'function') throw reviewError('vcc-review-publish-contract', '发布前检查必须同步完成');
  const backupPath = path.join(snapshot.parentPath, `.vcc-review-backup-${randomUUID()}.xlsx`);
  let backedUp = false;
  try {
    if (snapshot.identity) { fsImpl.renameSync(snapshot.target, backupPath); backedUp = true; }
    fsImpl.renameSync(stagedPath, snapshot.target);
  } catch (error) {
    if (backedUp) {
      try {
        // Never destroy a third-party file which appeared after the old target was moved.
        if (maybeStat(snapshot.target)) throw new Error('恢复目标已被占用');
        fsImpl.renameSync(backupPath, snapshot.target);
      } catch (restoreError) {
        const failure = reviewError('vcc-review-publish-recovery-required', `保存失败，旧文件保留在恢复路径：${backupPath}`,
          [error.message, restoreError.message, backupPath, stagedPath]);
        failure.recoveryPaths = [backupPath, stagedPath]; failure.preserveTemporaryFiles = true; throw failure;
      }
    }
    throw error;
  }
  let recoveryPath = null;
  if (backedUp) { try { fsImpl.unlinkSync(backupPath); } catch (_error) { recoveryPath = backupPath; } }
  return { filePath: snapshot.target, fileName: path.basename(snapshot.target), ...(recoveryPath ? { recoveryPaths: [recoveryPath] } : {}) };
}

module.exports = { assertTargetAllowed, captureTarget, assertTargetUnchanged, publishReviewFile, statIdentity };
