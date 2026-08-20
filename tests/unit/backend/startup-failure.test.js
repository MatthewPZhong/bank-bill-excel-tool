'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildStartupFailureDialogMessage,
  reportStartupFailure
} = require('../../../src/backend/startup-failure');

test('启动失败对话框直接展示恢复明细与去重后的人工恢复路径', () => {
  const error = new Error('工具箱发布恢复索引损坏');
  error.detailLines = ['索引无法解析', '请勿删除旧文件'];
  error.recoveryPaths = ['/tmp/index.json', '/tmp/journal.json', '/tmp/index.json'];

  const message = buildStartupFailureDialogMessage(error, '/tmp/app.log');

  assert.match(message, /错误摘要：工具箱发布恢复索引损坏/);
  assert.match(message, /处理明细：\n索引无法解析\n请勿删除旧文件/);
  assert.match(message, /人工恢复路径：\n\/tmp\/index\.json\n\/tmp\/journal\.json/);
  assert.equal((message.match(/\/tmp\/index\.json/g) || []).length, 1);
  assert.match(message, /日志文件：\/tmp\/app\.log/);
});

test('启动失败上报把恢复路径写入日志并在展示后退出', () => {
  const error = new Error('自动恢复失败');
  error.detailLines = ['目标状态未知'];
  error.recoveryPaths = ['/tmp/target.xlsx'];
  let logged = null;
  let shown = null;
  let exitCode = null;

  reportStartupFailure({
    error,
    logFilePath: '/tmp/app.log',
    appendRecord(_filePath, payload) {
      logged = payload;
    },
    showErrorBox(title, message) {
      shown = { title, message };
    },
    exit(code) {
      exitCode = code;
    }
  });

  assert.ok(logged.details.includes('目标状态未知'));
  assert.ok(logged.details.includes('人工恢复路径：/tmp/target.xlsx'));
  assert.match(shown.message, /\/tmp\/target\.xlsx/);
  assert.equal(exitCode, 1);
});

test('日志写入失败仍只展示一次 native dialog 并退出', () => {
  let dialogs = 0;
  let exits = 0;
  reportStartupFailure({
    error: new Error('数据库不可用'),
    appendRecord() { throw new Error('日志目录不可用'); },
    showErrorBox() { dialogs += 1; },
    exit(code) {
      assert.equal(code, 1);
      exits += 1;
    }
  });
  assert.equal(dialogs, 1);
  assert.equal(exits, 1);
});
