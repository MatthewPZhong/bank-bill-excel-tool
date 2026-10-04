'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { readRows } = require('../../../../src/backend/file-service/readers');

test('CSV 文本片段拼接保留固定 main 的 512 组引号、换行和 Unicode 解析结果', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-memory-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'input.csv');
  const chars = ['a', '中', '0', '"', ',', '\n', '\r', ' ', '\t', '😀'];
  let seed = 123456789;
  const result = [];
  for (let i = 0; i < 512; i++) {
    let text = '';
    for (let j = 0; j < i % 99 + 1; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += chars[seed % chars.length];
    }
    fs.writeFileSync(file, text);
    try { result.push(readRows(file)); } catch (error) { result.push({ code: error.code, message: error.message }); }
  }
  // 由 18b82b4 的公开 readRows 对相同生成输入计算；没有从当前实现重算预期值。
  assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    'f3a206cfa528e6f30ca08d1453786687635db84b7bf670678db496f120ec7fab');
});
