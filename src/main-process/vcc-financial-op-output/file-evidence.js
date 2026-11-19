'use strict';

// 已关闭输出文件的内容摘要与文件标识（VCC 财务OP 审核/结果导出发布前后核对用）。
// v3.2.20 下线业务OP数据核对时由 biz-op-v327/export-validator.js、export-file-identity.js 迁入，算法不变。

const fs = require('node:fs');
const { createHash } = require('node:crypto');

function fail(code) {
  throw Object.assign(new Error('输出文件状态或证据不满足操作条件'), { code });
}

// Windows 文件标识可超过 Number 安全范围；按原生 BigInt 无损封存，不改变文件内容。
function exportFileIdentity(stat) {
  return { version: 2, ...Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
    .map((key) => [key, stat[key].toString()])) };
}

async function hashClosedFile(filePath, safePoint = () => {}) {
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('OUTPUT_FILE_INVALID');
    const digest = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) { safePoint(); digest.update(bytes); }
    const after = await handle.stat({ bigint: true }); const current = await fs.promises.lstat(filePath, { bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== after[key] || before[key] !== current[key])) fail('OUTPUT_FILE_CHANGED');
    return { sha256: digest.digest('hex'), byteSize: Number(before.size), fileIdentity: exportFileIdentity(before) };
  } finally { await handle.close(); }
}

module.exports = { exportFileIdentity, hashClosedFile };
