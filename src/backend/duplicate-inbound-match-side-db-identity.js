'use strict';

const path = require('node:path');

const DUPLICATE_SIDE_DB_ROOT = Object.freeze([
  'run-data',
  'duplicate-inbound-match'
]);

function duplicateSideDbRelPath(monthKey) {
  if (typeof monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new TypeError('Duplicate side DB monthKey必须为YYYY-MM');
  }
  return path.posix.join(...DUPLICATE_SIDE_DB_ROOT, `month-${monthKey}.sqlite`);
}

// side_db_rel_path 是跨平台持久 identity。只把历史 Windows separator 映射为 POSIX；
// 不清理 .、..、重复 separator 或大小写，避免把不同 identity 错判为相同。
function canonicalDuplicateSideDbRelPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function sameDuplicateSideDbRelPath(left, right) {
  return canonicalDuplicateSideDbRelPath(left) === canonicalDuplicateSideDbRelPath(right);
}

module.exports = {
  canonicalDuplicateSideDbRelPath,
  duplicateSideDbRelPath,
  sameDuplicateSideDbRelPath
};
