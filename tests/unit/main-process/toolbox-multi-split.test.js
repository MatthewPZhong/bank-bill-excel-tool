'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_MULTI_SPLIT_GROUPS,
  ToolboxMultiSplitValidationError,
  ToolboxMultiSplitPublishError,
  normalizeSplitOutputFileName,
  normalizeMultiSplitGroups,
  createMultipleRowFilters,
  publishPreparedSplitFiles
} = require('../../../src/main-process/toolbox-multi-split');

test.describe('toolbox multi split validation', () => {
  test('文件主名统一补一个 xlsx 后缀', () => {
    assert.equal(normalizeSplitOutputFileName('渠道A'), '渠道A.xlsx');
    assert.equal(normalizeSplitOutputFileName('渠道A.XLSX'), '渠道A.xlsx');
    assert.equal(normalizeSplitOutputFileName('渠道A.xlsx.xlsx'), '渠道A.xlsx');
  });

  test('拒绝非法字符、系统保留名和首尾空格', () => {
    for (const name of ['a/b', 'CON', 'Lpt9.xlsx', '尾空格 ', '.xlsx', 'abc..xlsx']) {
      assert.throws(() => normalizeSplitOutputFileName(name), ToolboxMultiSplitValidationError, name);
    }
  });

  test('支持 1-8 组并按当前平台路径规则判断大小写重复文件名', () => {
    const groups = Array.from({ length: MAX_MULTI_SPLIT_GROUPS }, (_, index) => ({
      fileName: `文件${index + 1}`,
      field: 'Channel',
      values: [`C${index + 1}`]
    }));
    assert.equal(normalizeMultiSplitGroups(groups).length, 8);
    assert.throws(
      () => normalizeMultiSplitGroups([...groups, { fileName: '文件9', field: 'Channel', values: ['C9'] }]),
      ToolboxMultiSplitValidationError
    );
    const caseOnlyGroups = [
      { fileName: 'Same', field: 'Channel', values: ['A'] },
      { fileName: 'same.XLSX', field: 'Channel', values: ['B'] }
    ];
    if (process.platform === 'linux') {
      assert.equal(normalizeMultiSplitGroups(caseOnlyGroups).length, 2);
    } else {
      assert.throws(() => normalizeMultiSplitGroups(caseOnlyGroups), /文件名重复/);
    }
  });

  test('Unicode NFC 与 NFD 等价文件名在生成前被判为重复', () => {
    assert.throws(
      () => normalizeMultiSplitGroups([
        { fileName: '\u00e9', field: 'Channel', values: ['A'] },
        { fileName: 'e\u0301.xlsx', field: 'Channel', values: ['B'] }
      ]),
      /文件名重复/
    );
  });

  test('过滤器允许不同字段和重叠命中', () => {
    const groups = normalizeMultiSplitGroups([
      { fileName: '按渠道', field: 'Channel', values: ['A'] },
      { fileName: '按币种', field: 'Currency', values: ['USD'] }
    ]);
    const filters = createMultipleRowFilters(['Channel', 'Currency'], groups);
    assert.deepEqual(filters.map((entry) => entry.matches(['A', 'USD'])), [true, true]);
    assert.deepEqual(filters.map((entry) => entry.matches(['B', 'USD'])), [false, true]);
  });

  test('字段不存在时在生成前失败', () => {
    const groups = normalizeMultiSplitGroups([{ fileName: 'a', field: 'Missing', values: ['x'] }]);
    assert.throws(() => createMultipleRowFilters(['Channel'], groups), /找不到字段/);
  });
});

test.describe('toolbox multi split atomic publish', () => {
  let root;
  test.beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-multi-publish-'));
  });
  test.afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  });

  test('全部临时文件一次发布并替换旧文件', () => {
    const temp1 = path.join(root, '.tmp-1');
    const temp2 = path.join(root, '.tmp-2');
    const target1 = path.join(root, 'A.xlsx');
    const target2 = path.join(root, 'B.xlsx');
    fs.writeFileSync(temp1, 'new-a');
    fs.writeFileSync(temp2, 'new-b');
    fs.writeFileSync(target1, 'old-a');

    const files = publishPreparedSplitFiles([
      { temporaryPath: temp1, targetPath: target1, fileName: 'A.xlsx', matchedCount: 2 },
      { temporaryPath: temp2, targetPath: target2, fileName: 'B.xlsx', matchedCount: 0 }
    ]);

    assert.equal(fs.readFileSync(target1, 'utf8'), 'new-a');
    assert.equal(fs.readFileSync(target2, 'utf8'), 'new-b');
    assert.deepEqual(files.map((file) => file.matchedCount), [2, 0]);
  });

  test('第二个发布失败会删除本批文件并恢复全部被覆盖文件', () => {
    const temp1 = path.join(root, '.tmp-1');
    const temp2 = path.join(root, '.tmp-2');
    const target1 = path.join(root, 'A.xlsx');
    const target2 = path.join(root, 'B.xlsx');
    fs.writeFileSync(temp1, 'new-a');
    fs.writeFileSync(temp2, 'new-b');
    fs.writeFileSync(target1, 'old-a');
    fs.writeFileSync(target2, 'old-b');

    const fsImpl = {
      existsSync: fs.existsSync,
      rmSync: fs.rmSync,
      renameSync(source, target) {
        if (source === temp2 && target === target2) {
          throw new Error('simulated publish failure');
        }
        fs.renameSync(source, target);
      }
    };

    assert.throws(
      () => publishPreparedSplitFiles([
        { temporaryPath: temp1, targetPath: target1, fileName: 'A.xlsx', matchedCount: 1 },
        { temporaryPath: temp2, targetPath: target2, fileName: 'B.xlsx', matchedCount: 1 }
      ], { fsImpl }),
      ToolboxMultiSplitPublishError
    );
    assert.equal(fs.readFileSync(target1, 'utf8'), 'old-a');
    assert.equal(fs.readFileSync(target2, 'utf8'), 'old-b');
  });

  test('目标路径是目录时在移动任何文件前拒绝发布', () => {
    const temporaryPath = path.join(root, '.tmp-directory-target');
    const targetPath = path.join(root, 'A.xlsx');
    fs.writeFileSync(temporaryPath, 'new-a');
    fs.mkdirSync(targetPath);

    assert.throws(
      () => publishPreparedSplitFiles([{ temporaryPath, targetPath, fileName: 'A.xlsx' }]),
      /不是可覆盖的普通文件/
    );
    assert.equal(fs.readFileSync(temporaryPath, 'utf8'), 'new-a');
    assert.equal(fs.lstatSync(targetPath).isDirectory(), true);
  });

  test('Unicode NFC 与 NFD 等价目标在移动任何文件前拒绝发布', () => {
    const temp1 = path.join(root, '.tmp-unicode-1');
    const temp2 = path.join(root, '.tmp-unicode-2');
    const targetNfc = path.join(root, '\u00e9.xlsx');
    const targetNfd = path.join(root, 'e\u0301.xlsx');
    fs.writeFileSync(temp1, 'new-a');
    fs.writeFileSync(temp2, 'new-b');
    fs.writeFileSync(targetNfc, 'old-target');

    assert.throws(
      () => publishPreparedSplitFiles([
        { temporaryPath: temp1, targetPath: targetNfc, fileName: '\u00e9.xlsx' },
        { temporaryPath: temp2, targetPath: targetNfd, fileName: 'e\u0301.xlsx' }
      ]),
      /目标路径重复/
    );
    assert.equal(fs.readFileSync(targetNfc, 'utf8'), 'old-target');
    assert.equal(fs.readFileSync(temp1, 'utf8'), 'new-a');
    assert.equal(fs.readFileSync(temp2, 'utf8'), 'new-b');
  });

  test('原文件恢复失败时保留备份并显式要求上层保留临时目录', () => {
    const temp1 = path.join(root, '.tmp-preserve-1');
    const temp2 = path.join(root, '.tmp-preserve-2');
    const target1 = path.join(root, 'A.xlsx');
    const target2 = path.join(root, 'B.xlsx');
    const backup2 = `${temp2}.existing-1`;
    fs.writeFileSync(temp1, 'new-a');
    fs.writeFileSync(temp2, 'new-b');
    fs.writeFileSync(target1, 'old-a');
    fs.writeFileSync(target2, 'old-b');

    const fsImpl = {
      existsSync: fs.existsSync,
      lstatSync: fs.lstatSync,
      rmSync: fs.rmSync,
      renameSync(source, target) {
        if (source === temp2 && target === target2) throw new Error('simulated publish failure');
        if (source === backup2 && target === target2) throw new Error('simulated restore failure');
        fs.renameSync(source, target);
      }
    };

    let caught;
    try {
      publishPreparedSplitFiles([
        { temporaryPath: temp1, targetPath: target1, fileName: 'A.xlsx' },
        { temporaryPath: temp2, targetPath: target2, fileName: 'B.xlsx' }
      ], { fsImpl });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ToolboxMultiSplitPublishError);
    assert.equal(caught.preserveTemporaryFiles, true);
    assert.ok(caught.detailLines.some((line) => line.includes(backup2)));
    assert.equal(fs.readFileSync(target1, 'utf8'), 'old-a');
    assert.equal(fs.readFileSync(backup2, 'utf8'), 'old-b');
  });
});
