'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeTargetAliasKey,
  pathsAlias,
  targetPathAliasKey
} = require('../../../src/main-process/toolbox-target-identity');

test.describe('toolbox target identity', () => {
  test('Darwin/Linux沿用NFC；Windows lexical fallback保留NFC/NFD不同legacy名称', () => {
    for (const platform of ['darwin', 'linux']) {
      assert.equal(
        normalizeTargetAliasKey('\u00e9.xlsx', { platform }),
        normalizeTargetAliasKey('e\u0301.xlsx', { platform })
      );
    }
    assert.notEqual(
      normalizeTargetAliasKey('\u00e9.xlsx', { platform: 'win32' }),
      normalizeTargetAliasKey('e\u0301.xlsx', { platform: 'win32' })
    );
    assert.equal(
      normalizeTargetAliasKey('\u00c9.xlsx', { platform: 'win32' }),
      normalizeTargetAliasKey('\u00e9.xlsx', { platform: 'win32' })
    );
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

  test('macOS按实机inode证据完整折叠；Windows missing path只接受单code-point uppercase', (t) => {
    for (const platform of ['darwin']) {
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
    assert.equal(
      normalizeTargetAliasKey('οσ.xlsx', { platform: 'win32' }),
      normalizeTargetAliasKey('ος.xlsx', { platform: 'win32' })
    );
    for (const [left, right] of [
      ['straße.xlsx', 'STRASSE.xlsx'],
      ['oﬃce.xlsx', 'OFFICE.xlsx']
    ]) {
      assert.notEqual(
        normalizeTargetAliasKey(left, { platform: 'win32' }),
        normalizeTargetAliasKey(right, { platform: 'win32' }),
        '未证明missing path时保留expansion字符，不能误并'
      );
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-win-path-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const options = { platform: 'win32' };
    assert.equal(
      targetPathAliasKey(fs, path.join(root, 'É.json'), options),
      targetPathAliasKey(fs, path.join(root, 'é.json'), options),
      'missing basename 的 É/é 必须共享 scope identity'
    );
    assert.notEqual(
      targetPathAliasKey(fs, path.join(root, 'é.json'), options),
      targetPathAliasKey(fs, path.join(root, 'e\u0301.json'), options)
    );
    assert.throws(
      () => targetPathAliasKey(fs, path.join(root, 'straße.json'), options),
      {
        name: 'TargetIdentityError',
        code: 'TARGET_IDENTITY_WINDOWS_CASE_MAPPING_UNSAFE',
        message: 'Windows 缺失目标包含无法可靠表达的大小写映射',
        details: { platform: 'win32', reason: 'expanding-case-mapping' }
      }
    );
    assert.doesNotThrow(
      () => targetPathAliasKey(fs, path.join(root, 'STRASSE.json'), options)
    );
    const missingParentOptions = {
      ...options,
      allowMissingParentLexicalFallback: true
    };
    assert.equal(
      targetPathAliasKey(fs, path.join(root, 'É', 'seed.json'), missingParentOptions),
      targetPathAliasKey(fs, path.join(root, 'é', 'seed.json'), missingParentOptions),
      'missing parent segment 的 É/é 必须共享 scope identity'
    );
    assert.throws(
      () => targetPathAliasKey(
        fs,
        path.join(root, 'straße', 'seed.json'),
        missingParentOptions
      ),
      {
        name: 'TargetIdentityError',
        code: 'TARGET_IDENTITY_WINDOWS_CASE_MAPPING_UNSAFE',
        details: { platform: 'win32', reason: 'expanding-case-mapping' }
      }
    );

    const canonicalExisting = 'C:\\canonical\\straße.json';
    const existingFs = { realpathSync: () => canonicalExisting };
    assert.equal(
      targetPathAliasKey(existingFs, 'C:\\alias\\straße.json', options),
      targetPathAliasKey(existingFs, 'C:\\alias\\STRASSE.json', options),
      'existing target必须以同一realpath作为物理authority'
    );
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
