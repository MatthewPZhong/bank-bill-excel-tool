'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FUNCTION_REGISTRY,
  defaultStats,
  incrementFunction,
  serialize
} = require('../../../src/backend/usage-stats');

test('VCC 财务OP现有成功动作及解归档/删除结果均已注册', () => {
  assert.deepEqual(FUNCTION_REGISTRY['VCC财务OP校验'], [
    '导入文件', '开始运行', '初始化期初财务OP', '确认归档',
    '标记导入异常已处理', '删除数据', '导出数据',
    '导出校验结果表', '导出导入审计', '解归档', '删除结果'
  ]);
  const stats = defaultStats();
  incrementFunction(stats, 'VCC财务OP校验', '解归档');
  incrementFunction(stats, 'VCC财务OP校验', '删除结果');
  assert.equal(stats.modules['VCC财务OP校验']['解归档'], 1);
  assert.equal(stats.modules['VCC财务OP校验']['删除结果'], 1);
  assert.match(serialize(stats), /\[VCC财务OP校验\][\s\S]*解归档=1[\s\S]*删除结果=1/);
});

test('统一删除 IPC 对 result 计“删除结果”，其他目标保留既有“删除数据”', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '../../../src/main.js'), 'utf8');
  assert.match(
    mainSource,
    /dynamicTrackedIpcHandle\([\s\S]*?'vccFinancialOp:data-manager:delete'[\s\S]*?=== 'result' \? '删除结果' : '删除数据'/
  );
  assert.doesNotMatch(
    mainSource,
    /trackedIpcHandle\('vccFinancialOp:data-manager:delete',[\s\S]*?'删除结果'/
  );
  assert.match(
    mainSource,
    /VCC_USAGE_SUCCESS_STATUSES = new Set\(\['calculated', 'archived', 'initialized', 'all_skipped'\]\)/
  );
});
