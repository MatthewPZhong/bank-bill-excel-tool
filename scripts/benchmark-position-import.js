'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const files = process.argv.slice(2).map((value) => path.resolve(value));
const evidence = {
  status: files.length > 0 ? 'input-inventory' : 'no-input',
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  cpus: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  files: files.map((filePath) => {
    const stat = fs.statSync(filePath);
    return {
      fileName: path.basename(filePath),
      sizeBytes: stat.size
    };
  }),
  note: 'PR-A 仅建立证据格式；PR-B 起追加 parser 指标，PR-E 执行 300 万行门禁。'
};

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

