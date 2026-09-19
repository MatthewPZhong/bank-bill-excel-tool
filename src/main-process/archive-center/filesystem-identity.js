'use strict';

// NTFS 对象身份可能超出 Number 安全范围；已经舍入的数字不能转成 BigInt
// 或十进制字符串来冒充可靠身份。
function identityInteger(value) {
  if (typeof value === 'bigint') return value > 0n ? value.toString(10) : null;
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return BigInt(value).toString(10);
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function statTimeMs(stat, millisecondKey, nanosecondKey) {
  if (typeof stat[nanosecondKey] === 'bigint') {
    const nanoseconds = stat[nanosecondKey];
    return Number(nanoseconds / 1000000n) + Number(nanoseconds % 1000000n) / 1e6;
  }
  return Number(stat[millisecondKey]);
}

// 同一次原生 stat 同时提供全部字段，保持既有 Number 元数据及小数毫秒，
// 仅 dev/ino 使用无损十进制身份；不得用两次 stat 拼接一个快照。
function identityStatView(stat) {
  if (!stat) return stat;
  const result = {};
  for (const [key, value] of Object.entries(stat)) {
    if (key.endsWith('Ns')) continue;
    result[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  for (const key of ['dev', 'ino']) result[key] = identityInteger(stat[key]);
  for (const key of ['atime', 'mtime', 'ctime', 'birthtime']) {
    result[`${key}Ms`] = statTimeMs(stat, `${key}Ms`, `${key}Ns`);
  }
  for (const method of ['isFile', 'isDirectory', 'isSymbolicLink', 'isBlockDevice',
    'isCharacterDevice', 'isFIFO', 'isSocket']) {
    if (typeof stat[method] === 'function') result[method] = stat[method].bind(stat);
  }
  return result;
}

function readIdentityStatSync(fsImpl, target, method = 'lstatSync') {
  return identityStatView(fsImpl[method](target, { bigint: true }));
}

async function readIdentityStat(fsImpl, target, method = 'lstat') {
  return identityStatView(await fsImpl.promises[method](target, { bigint: true }));
}

async function readHandleIdentityStat(handle) {
  return identityStatView(await handle.stat({ bigint: true }));
}

module.exports = { identityInteger, identityStatView, readHandleIdentityStat,
  readIdentityStat, readIdentityStatSync, statTimeMs };
