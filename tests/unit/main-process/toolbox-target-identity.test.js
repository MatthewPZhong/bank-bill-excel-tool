'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeTargetAliasKey,
  pathsAlias
} = require('../../../src/main-process/toolbox-target-identity');

test.describe('toolbox target identity', () => {
  test('所有平台统一 NFC，阻止预组合与组合字符目标别名', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      assert.equal(
        normalizeTargetAliasKey('\u00e9.xlsx', { platform }),
        normalizeTargetAliasKey('e\u0301.xlsx', { platform })
      );
    }
  });

  test('macOS/Windows 折叠大小写，Linux 保留大小写差异', () => {
    assert.equal(
      normalizeTargetAliasKey('Result.xlsx', { platform: 'darwin' }),
      normalizeTargetAliasKey('result.xlsx', { platform: 'darwin' })
    );
    assert.equal(
      normalizeTargetAliasKey('Result.xlsx', { platform: 'win32' }),
      normalizeTargetAliasKey('result.xlsx', { platform: 'win32' })
    );
    assert.notEqual(
      normalizeTargetAliasKey('Result.xlsx', { platform: 'linux' }),
      normalizeTargetAliasKey('result.xlsx', { platform: 'linux' })
    );
  });

  test('macOS/Windows 完整折叠 ß/SS、sigma/final-sigma 与 ligature', () => {
    for (const platform of ['darwin', 'win32']) {
      assert.equal(
        normalizeTargetAliasKey('straße.xlsx', { platform }),
        normalizeTargetAliasKey('STRASSE.xlsx', { platform })
      );
      assert.equal(
        normalizeTargetAliasKey('οσ.xlsx', { platform }),
        normalizeTargetAliasKey('ος.xlsx', { platform })
      );
      assert.equal(
        normalizeTargetAliasKey('oﬃce.xlsx', { platform }),
        normalizeTargetAliasKey('OFFICE.xlsx', { platform })
      );
    }
  });

  test('真实 symlink 与 hardlink 均识别为源文件别名', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-path-alias-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source.xlsx');
    const symlink = path.join(root, 'source-link.xlsx');
    const hardlink = path.join(root, 'source-hardlink.xlsx');
    fs.writeFileSync(source, 'source');
    fs.symlinkSync(source, symlink);
    fs.linkSync(source, hardlink);

    assert.equal(pathsAlias(fs, source, symlink), true);
    assert.equal(pathsAlias(fs, source, hardlink), true);
    assert.equal(pathsAlias(fs, source, path.join(root, 'other.xlsx')), false);
  });
});
