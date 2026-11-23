'use strict';

// v3.2.21 release 审查：写进活动日志的说明文字中形似账号、卡号的编号只写位数（AGENTS.md 敏感数据边界）。
//   模板包导入跳过模板时的原因来自校验异常消息，可能带完整的大账号。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '../../../src/main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });

function loadMainFunction(name) {
  const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
  assert.ok(node, name);
  return Function(`return (${MAIN_SOURCE.slice(node.start, node.end)});`)();
}

const maskAccountLikeTextForLog = loadMainFunction('maskAccountLikeTextForLog');

test('maskAccountLikeTextForLog：形似账号的编号只写位数，字段名、币种、短编号与日期以外的文字不变', () => {
  assert.equal(
    maskAccountLikeTextForLog('大账号「6222021234567890123」与币种「USD」重复'),
    '大账号「（19位编号）」与币种「USD」重复'
  );
  assert.equal(maskAccountLikeTextForLog('大账号 NET20261234 已存在'), '大账号 （11位编号） 已存在');
  assert.equal(maskAccountLikeTextForLog('映射字段不存在：Transaction Description'), '映射字段不存在：Transaction Description');
  assert.equal(maskAccountLikeTextForLog('特征值「流水号」：筛选字段不存在：ABC123'), '特征值「流水号」：筛选字段不存在：ABC123');
  assert.equal(maskAccountLikeTextForLog(undefined), '');
});

test('模板包导入跳过模板时，活动日志的原因经 maskAccountLikeTextForLog 脱敏', () => {
  const start = MAIN_SOURCE.indexOf("message: '模板包导入时跳过模板'");
  assert.ok(start > 0);
  const snippet = MAIN_SOURCE.slice(start, start + 200);
  assert.match(snippet, /原因：\$\{maskAccountLikeTextForLog\(error\.message\)\}/);
  assert.doesNotMatch(snippet, /原因：\$\{error\.message\}/);
});
