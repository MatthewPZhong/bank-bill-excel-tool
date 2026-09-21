'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createToolboxDialogs } = require('../../../src/renderer/dialogs/toolbox');

const { validateRowsInput } = createToolboxDialogs({ api: {}, modalBridge: {}, ui: {} });

test('按行拆分输入校验保留空值、整数、数值安全范围与前导零处理', () => {
  assert.equal(validateRowsInput('').valid, false);
  assert.equal(validateRowsInput('   ').valid, false);
  for (const input of ['0', '-1', '1.2', '1e3', '+1', '9007199254740992', 'NaN', 'Infinity']) {
    assert.equal(validateRowsInput(input).valid, false, input);
  }
  assert.deepEqual(validateRowsInput(' 0010 '), { valid: true, value: 10 });
  assert.deepEqual(validateRowsInput('9007199254740991'), { valid: true, value: Number.MAX_SAFE_INTEGER });
});

test('工具箱经典脚本只导出工厂，不执行 DOM 或 IPC', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../../src/renderer/dialogs/toolbox'), 'utf8'), { window });
  assert.equal(typeof window.__toolboxDialogs.createToolboxDialogs, 'function');
});
