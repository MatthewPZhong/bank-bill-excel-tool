'use strict';

const fs = require('node:fs');
const { hash } = require('./contracts');

// Windows 文件标识可超过 Number 安全范围；按原生 BigInt 无损封存，不改变文件内容。
function exportFileIdentity(stat) {
  return { version: 2, ...Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
    .map((key) => [key, stat[key].toString()])) };
}
function matchesExportFileIdentity(filePath, expected) {
  if (expected?.version === 2) return hash(exportFileIdentity(fs.lstatSync(filePath, { bigint: true }))) === hash(expected);
  // 兼容旧宿主已经封存的安全数值证据；不接纳曾经失去精度的文件标识。
  if (!expected || ['dev', 'ino', 'size'].some((key) => !Number.isSafeInteger(expected[key]))) return false;
  const stat = fs.lstatSync(filePath);
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => stat[key] === expected[key]);
}

module.exports = { exportFileIdentity, matchesExportFileIdentity };
