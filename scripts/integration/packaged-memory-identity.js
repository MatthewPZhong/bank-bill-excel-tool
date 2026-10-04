// 内存资格身份的打包回归：真实 builder 文件收集/拷贝、ASAR、Electron 包内读取。
// 覆盖 lock 随包、源码与依赖摘要一致、lock 缺失/变化不会冒充原身份；不构建安装包或授予资格。
// 用法：node scripts/integration/packaged-memory-identity.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getMainFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher');
const { computeFileSets } = require('app-builder-lib/out/util/appFileCopier');
const asar = require('@electron/asar');
const { PHASES, profile } = require('../../src/main-process/execution-descriptors/memory-profiles');
const repo = path.resolve(__dirname, '../..');
const modulePath = 'src/main-process/execution-descriptors/memory-evidence.js';

function identity(root) {
  const code = `try {
    const { sourceIdentity } = require(${JSON.stringify(path.join(root, modulePath))});
    console.log(JSON.stringify({ ok: true, identity: sourceIdentity(${JSON.stringify(root)}) }));
  } catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, message: error.message })); }`;
  const output = execFileSync(require('electron'), ['-e', code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(output.trim());
}


function manualApproval(root) {
  const configs = Object.keys(PHASES).flatMap((phase) => ['normal', 'low'].map((mode) => profile(phase, mode)));
  // Electron 实际读取 ASAR；仅 Windows 平台事实为测试注入，不宣称运行了 Windows 安装包。
  const code = `const { qualifiedProfile } = require(${JSON.stringify(path.join(root, modulePath))});
    const manifest = require(${JSON.stringify(path.join(root, 'src/main-process/execution-descriptors/memory-qualification.json'))});
    const runtime = { platform: 'win32', arch: 'x64', electronVersion: process.versions.electron };
    console.log(JSON.stringify(${JSON.stringify(configs)}.map(config => qualifiedProfile(manifest, config, runtime))));`;
  return JSON.parse(execFileSync(require('electron'), ['-e', code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim());
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-memory-identity-'));
  let passed = 0;
  const pass = (label) => { passed++; console.log(`PASS ${label}`); };
  try {
    const source = path.join(root, 'source'), packed = path.join(root, 'packed');
    fs.mkdirSync(source);
    // 使用当前全部真实 src，资格文件在副本中保持原样，不修改生产 manifest。
    fs.cpSync(path.join(repo, 'src'), path.join(source, 'src'), { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(repo, file), path.join(source, file));
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    const packager = { info: { projectDir: source, buildResourcesDir: 'build', config: pkg.build,
      isPrepackedAppAsar: false, debugLogger: { isEnabled: false } } };
    const matchers = getMainFileMatchers(source, packed, (value) => value, pkg.build.win,
      packager, path.join(root, 'dist'), false);
    const sets = await computeFileSets(matchers, undefined, packager, false);
    assert.ok(sets.some((set) => set.files.includes(path.join(source, 'package-lock.json'))), 'builder 实际文件集合必须包含 lock');
    pass('当前生产 build.files 的实际文件集合包含 lock');

    await copyFiles(matchers, undefined, false);
    const lockBytes = fs.readFileSync(path.join(source, 'package-lock.json'));
    assert.deepEqual(fs.readFileSync(path.join(packed, 'package-lock.json')), lockBytes);
    const archive = path.join(root, 'app.asar');
    await asar.createPackage(packed, archive);
    assert.deepEqual(asar.extractFile(archive, 'package-lock.json'), lockBytes);
    pass('实际拷贝及 ASAR 中的 lock 字节与源码一致');

    const unpackedIdentity = identity(source);
    const packagedIdentity = identity(archive);
    assert.equal(unpackedIdentity.ok, true, JSON.stringify(unpackedIdentity));
    assert.equal(packagedIdentity.ok, true, JSON.stringify(packagedIdentity));
    assert.deepEqual(packagedIdentity.identity, unpackedIdentity.identity);
    pass('Electron 从实际 ASAR 计算身份，全部摘要和运行时字段一致');

    fs.unlinkSync(path.join(packed, 'package-lock.json'));
    const missing = path.join(root, 'missing-lock.asar');
    await asar.createPackage(packed, missing);
    const missingIdentity = identity(missing);
    assert.equal(missingIdentity.ok, false);
    assert.equal(missingIdentity.code, 'ENOENT');
    pass('缺少 lock 的包仍拒绝计算完整身份');

    fs.writeFileSync(path.join(packed, 'package-lock.json'), Buffer.concat([lockBytes, Buffer.from('\n')]));
    const changed = path.join(root, 'changed-lock.asar');
    await asar.createPackage(packed, changed);
    const changedIdentity = identity(changed);
    assert.equal(changedIdentity.ok, true, JSON.stringify(changedIdentity));
    assert.notEqual(changedIdentity.identity.sourceTreeSha256, unpackedIdentity.identity.sourceTreeSha256);
    assert.notEqual(changedIdentity.identity.dependencyLockSha256, unpackedIdentity.identity.dependencyLockSha256);
    pass('lock 变化同时改变源码与依赖摘要，不能沿用原身份');

    // ASAR 的文件查询按宿主 path.sep 分段；Windows 也须传入本机路径。
    const qualificationPath = path.join('src', 'main-process', 'execution-descriptors', 'memory-qualification.json');
    assert.deepEqual(fs.readFileSync(path.join(source, qualificationPath)), fs.readFileSync(path.join(repo, qualificationPath)));
    assert.deepEqual(asar.extractFile(archive, qualificationPath), fs.readFileSync(path.join(repo, qualificationPath)));
    pass('资格清单字节保持原样，测试不授予生产资格');
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, qualificationPath), 'utf8'));
    assert.equal(manifest.schemaVersion, 2);
    for (const file of [archive, missing]) {
      assert.deepEqual(manualApproval(file), Array(18).fill(manifest.approval.reference));
    }
    pass('Electron 包内人工确认可批准 18 个配置，缺少 lock 不再阻断人工启用');
    console.log(`==== ${passed}/7 PASS ====`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; });
