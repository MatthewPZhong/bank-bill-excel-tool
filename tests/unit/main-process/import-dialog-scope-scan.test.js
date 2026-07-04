// PR #83 review 发现 4 的静态守卫：
// 1) main.js 里 showImportOpenDialog 的 scope 字面量必须全部登记在 IMPORT_DIALOG_SCOPES；
// 2) main.js 里禁止新增裸 dialog.showOpenDialog——业务导入必须走 showImportOpenDialog
//    才能接入目录记忆；唯一白名单是 background:select-file（背景图选择，非业务入口）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { IMPORT_DIALOG_SCOPES } = require('../../../src/main-process/import-dialog-state');

const mainSource = fs.readFileSync(
  path.join(__dirname, '../../../src/main.js'),
  'utf8'
);

test.describe('main.js 导入弹窗 scope 扫描', () => {
  test('所有 showImportOpenDialog scope 字面量都登记在 IMPORT_DIALOG_SCOPES', () => {
    const used = new Set();
    for (const match of mainSource.matchAll(/showImportOpenDialog\(\s*'([^']*)'/g)) {
      used.add(match[1]);
    }
    assert.ok(used.size > 0, '未在 main.js 中找到任何 showImportOpenDialog 调用');
    const unregistered = [...used].filter((scope) => !IMPORT_DIALOG_SCOPES.includes(scope));
    assert.deepEqual(
      unregistered,
      [],
      `以下 scope 未登记在 IMPORT_DIALOG_SCOPES（疑似 typo 或漏登记）：${unregistered.join(', ')}`
    );
  });

  test('禁止新增裸 dialog.showOpenDialog（白名单仅 background:select-file 1 处）', () => {
    const matches = [...mainSource.matchAll(/dialog\.showOpenDialog\(/g)];
    assert.equal(
      matches.length,
      1,
      `main.js 中裸 dialog.showOpenDialog 应只有 background:select-file 1 处，实际 ${matches.length} 处；` +
        '业务导入入口请改用 showImportOpenDialog 以接入目录记忆'
    );
    const context = mainSource.slice(Math.max(0, matches[0].index - 400), matches[0].index);
    assert.ok(
      context.includes('background:select-file'),
      '唯一的裸 dialog.showOpenDialog 不在 background:select-file handler 内，白名单失效'
    );
  });
});
