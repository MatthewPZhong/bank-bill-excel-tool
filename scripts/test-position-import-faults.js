'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = [
  'tests/unit/main-process/position-reconciliation-operation-lifecycle.test.js'
];
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit'
});
process.exit(result.status === null ? 1 : result.status);

