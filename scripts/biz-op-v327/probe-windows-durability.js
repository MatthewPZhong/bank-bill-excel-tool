'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-durability-probe-'));
const file = path.join(root, 'payload.txt');
fs.writeFileSync(file, '独立目录屏障探针');
const records = [];
for (const [kind, target] of [['directory', root], ['file', file]]) {
  for (const [label, flags] of [['r', 'r'], ['r+', 'r+'],
    ['O_RDONLY|O_SYNC', fs.constants.O_RDONLY | fs.constants.O_SYNC],
    ['O_RDWR|O_SYNC', fs.constants.O_RDWR | fs.constants.O_SYNC],
    ['O_WRONLY|O_SYNC', fs.constants.O_WRONLY | fs.constants.O_SYNC]]) {
    let fd; let phase = 'open';
    try {
      fd = fs.openSync(target, flags);
      phase = 'fsync'; fs.fsyncSync(fd);
      records.push({ kind, flags: label, result: 'success' });
    } catch (error) {
      records.push({ kind, flags: label, result: 'failed', phase, code: error.code, errno: error.errno });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}
fs.rmSync(root, { recursive: true });
const output = { platform: process.platform, versions: process.versions, records };
fs.mkdirSync('outputs/windows-durability-probe', { recursive: true });
fs.writeFileSync('outputs/windows-durability-probe/node-probe.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
