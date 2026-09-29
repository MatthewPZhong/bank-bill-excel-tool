'use strict';

// 在真实 Main/生成/Publisher 测试中模拟 Windows 对未关闭读取句柄的目录重命名拒绝。
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../..');
const relative = 'tests/unit/main-process/toolbox-row-split-parent-identity.test.js';
const filename = path.join(root, relative);
const streams = new Set();
const createReadStream = fs.createReadStream;
const renameSync = fs.renameSync;
fs.createReadStream = function (...args) {
  const stream = createReadStream.apply(this, args);
  streams.add(stream);
  stream.once('close', () => streams.delete(stream));
  return stream;
};
fs.renameSync = function (from, to, ...args) {
  if (path.basename(from) === 'chosen' && from.includes('rows-parent-test-')) {
    const open = [...streams].filter((stream) => !stream.closed && typeof stream.path === 'string'
      && stream.path.startsWith(`${from}${path.sep}`));
    console.log('PARENT_RENAME_OPEN_READS', JSON.stringify(open.map((stream) => ({
      file: path.basename(stream.path), closed: stream.closed, readableEnded: stream.readableEnded
    }))));
    if (open.length) throw Object.assign(new Error('probe: Windows parent directory is busy before read handle close'), { code: 'EPERM' });
  }
  return renameSync.call(this, from, to, ...args);
};
const target = new Module(filename, module);
target.filename = filename;
target.paths = Module._nodeModulePaths(path.dirname(filename));
const source = process.argv[2] === 'baseline'
  ? execFileSync('git', ['show', `6dca78683f2587a0f028b260b94a4204da3ccaff:${relative}`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(filename, 'utf8');
target._compile(source, filename);
