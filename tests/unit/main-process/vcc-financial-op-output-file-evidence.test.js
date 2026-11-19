'use strict';

// v3.2.20：hashClosedFile / exportFileIdentity 由 biz-op-v327 迁入 VCC 输出模块，算法不变、错误码改为中性。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportFileIdentity, hashClosedFile } = require('../../../src/main-process/vcc-financial-op-output/file-evidence');

function directory(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-file-evidence-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('已关闭文件返回内容摘要、字节数与 BigInt 无损文件标识', async (t) => {
  const file = path.join(directory(t), '结果.xlsx');
  fs.writeFileSync(file, 'verified workbook bytes');
  const ticks = [];
  const evidence = await hashClosedFile(file, () => ticks.push(1));
  assert.equal(evidence.sha256, crypto.createHash('sha256').update('verified workbook bytes').digest('hex'));
  assert.equal(evidence.byteSize, Buffer.byteLength('verified workbook bytes'));
  assert.deepEqual(evidence.fileIdentity, exportFileIdentity(fs.lstatSync(file, { bigint: true })));
  assert.equal(evidence.fileIdentity.version, 2);
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(typeof evidence.fileIdentity[key], 'string');
  assert.ok(ticks.length >= 1, '读取期间调用 safePoint');
});

test('空文件与多硬链接文件拒绝为输出证据，错误码为中性 OUTPUT_FILE_INVALID', async (t) => {
  const root = directory(t);
  const empty = path.join(root, 'empty.xlsx');
  fs.writeFileSync(empty, '');
  await assert.rejects(hashClosedFile(empty), { code: 'OUTPUT_FILE_INVALID', message: '输出文件状态或证据不满足操作条件' });
  const linked = path.join(root, 'linked.xlsx');
  fs.writeFileSync(linked, 'content');
  fs.linkSync(linked, path.join(root, 'alias.xlsx'));
  await assert.rejects(hashClosedFile(linked), { code: 'OUTPUT_FILE_INVALID' });
});

test('safePoint 中断时向上抛出原错误，不返回部分摘要', async (t) => {
  const file = path.join(directory(t), 'cancel.xlsx');
  fs.writeFileSync(file, 'x'.repeat(1024));
  const cancelled = Object.assign(new Error('已取消'), { code: 'VCC_EXPORT_CANCELLED' });
  await assert.rejects(hashClosedFile(file, () => { throw cancelled; }), (error) => error === cancelled);
});
