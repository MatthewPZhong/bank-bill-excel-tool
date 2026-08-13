const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { finished } = require('node:stream/promises');
const test = require('node:test');
const asar = require('@electron/asar');

const ROOT = path.resolve(__dirname, '../../..');
const CHECK_SCRIPT = path.join(ROOT, 'scripts/check-dist-size.js');
const CURRENT_VERSION = require(path.join(ROOT, 'package.json')).version;
const CURRENT_COMMIT = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: ROOT,
  encoding: 'utf8'
}).trim();
const REQUIRED_FIXTURE_FILES = [
  'package.json',
  'docs/USER_GUIDE.md',
  'assets/币种映射表.xlsx',
  'assets/VCC财务OP校验/VCC_移除归档Pending账单.xlsx',
  'assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx',
  'COMMON枚举.xlsx',
  'src/main.js',
  'src/build-info.js'
];

async function createFixtureAsar({
  omit = '',
  packagedVersion = CURRENT_VERSION,
  packagedCommit = CURRENT_COMMIT
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-dist-size-test-'));
  const sourceDir = path.join(tempRoot, 'source');
  const asarPath = path.join(tempRoot, 'app.asar');
  for (const relativePath of REQUIRED_FIXTURE_FILES) {
    if (relativePath === omit) continue;
    const filePath = path.join(sourceDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      relativePath === 'package.json'
        ? JSON.stringify(packagedVersion === null ? {} : { version: packagedVersion })
        : relativePath === 'src/build-info.js'
          ? `module.exports = ${JSON.stringify({ commit: packagedCommit })};\n`
          : `fixture:${relativePath}`
    );
  }
  const outputStream = await asar.createPackage(sourceDir, asarPath);
  // @electron/asar 3.x resolves createPackage() after calling end(), before the
  // destination stream necessarily emits finish. Wait for durable fixture bytes
  // so a concurrently loaded full test run cannot inspect a partially flushed asar.
  await finished(outputStream);
  return { tempRoot, asarPath };
}

test('check-dist-size 接受同时包含两份 VCC 金标准模板的 app.asar', async (t) => {
  const fixture = await createFixtureAsar();
  t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, [CHECK_SCRIPT, fixture.asarPath], {
    encoding: 'utf8'
  });
  assert.match(output, /check-dist-size PASS/);
  assert.match(output, /必需文件：8\/8 齐全/);
  assert.match(output, new RegExp(`包内版本：${CURRENT_VERSION.replaceAll('.', '\\.')}（与当前源码一致）`));
  assert.match(output, new RegExp(`构建提交：${CURRENT_COMMIT}（与当前源码一致）`));
});

for (const missingTemplate of [
  'assets/VCC财务OP校验/VCC_移除归档Pending账单.xlsx',
  'assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx'
]) {
  test(`check-dist-size 缺少 ${path.basename(missingTemplate)} 时失败`, async (t) => {
    const fixture = await createFixtureAsar({ omit: missingTemplate });
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }));
    assert.throws(
      () => execFileSync(process.execPath, [CHECK_SCRIPT, fixture.asarPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /check-dist-size FAIL/);
        assert.match(error.stderr, new RegExp(missingTemplate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      }
    );
  });
}

test('check-dist-size 拒绝 clean source identity 不一致的 app.asar', async (t) => {
  const fixture = await createFixtureAsar({ packagedCommit: '0000000' });
  t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }));
  assert.throws(
    () => execFileSync(process.execPath, [CHECK_SCRIPT, fixture.asarPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(
        error.stderr,
        new RegExp(`断言⑤包内构建提交不匹配：app\\.asar=0000000，当前源码=${CURRENT_COMMIT}`)
      );
      return true;
    }
  );
});

test('check-dist-size 拒绝版本陈旧的 app.asar', async (t) => {
  const staleVersion = '0.0.0';
  const fixture = await createFixtureAsar({ packagedVersion: staleVersion });
  t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }));
  assert.throws(
    () => execFileSync(process.execPath, [CHECK_SCRIPT, fixture.asarPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(
        error.stderr,
        new RegExp(`断言④包内版本不匹配：app\\.asar=${staleVersion.replaceAll('.', '\\.')}，当前源码=${CURRENT_VERSION.replaceAll('.', '\\.')}`)
      );
      return true;
    }
  );
});

for (const [label, packagedVersion] of [
  ['缺失 version', null],
  ['version 为空', '']
]) {
  test(`check-dist-size 拒绝 package.json ${label} 的 app.asar`, async (t) => {
    const fixture = await createFixtureAsar({ packagedVersion });
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }));
    assert.throws(
      () => execFileSync(process.execPath, [CHECK_SCRIPT, fixture.asarPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /断言④包内 package\.json\.version 缺失或为空/);
        return true;
      }
    );
  });
}
