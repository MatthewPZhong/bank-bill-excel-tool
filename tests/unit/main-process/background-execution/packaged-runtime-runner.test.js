'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertPackagedLayout,
  pathUsesAppAsar,
  runPackagedRuntimeCanary
} = require('../../../../src/main-process/background-execution/canary/packaged-runtime-runner');
const {
  parsePackagedRuntimeRequest
} = require('../../../../src/main-process/background-execution/canary/packaged-runtime-request');

function privateRequest(root, reportName) {
  return parsePackagedRuntimeRequest({
    BACKGROUND_EXECUTION_PACKAGED_CANARY: '1',
    BACKGROUND_EXECUTION_PACKAGED_CANARY_REPORT_PATH: path.join(root, reportName),
    RUNNER_TEMP: root
  });
}

function withRunnerTemp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-runtime-runner-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('packaged layout 要求 app、module、两个 Worker 与 schema 全部来自 app.asar', () => {
  const asarRoot = path.join(path.parse(process.cwd()).root, 'bundle', 'resources', 'app.asar');
  assert.equal(pathUsesAppAsar(asarRoot), true);
  assert.equal(pathUsesAppAsar(path.join(asarRoot, 'src', 'worker.js')), true);
  assert.equal(pathUsesAppAsar(path.join(process.cwd(), 'src', 'worker.js')), false);
  assert.equal(assertPackagedLayout({
    app: { isPackaged: true, getAppPath: () => asarRoot },
    moduleDir: path.join(asarRoot, 'src', 'canary'),
    workerPath: path.join(asarRoot, 'src', 'pure-worker.js'),
    durableWorkerPath: path.join(asarRoot, 'src', 'durable-worker.js'),
    schemaPath: path.join(asarRoot, 'src', 'schema.js')
  }), true);
  assert.throws(
    () => assertPackagedLayout({
      app: { isPackaged: true, getAppPath: () => asarRoot },
      moduleDir: path.join(process.cwd(), 'src'),
      workerPath: path.join(asarRoot, 'worker.js'),
      durableWorkerPath: path.join(asarRoot, 'durable.js'),
      schemaPath: path.join(asarRoot, 'schema.js')
    }),
    { code: 'PACKAGED_CANARY_ASAR_LAYOUT_INVALID' }
  );
});

test('source-tree invocation fail closed，并只写严格 FAIL booleans', async (t) => {
  const root = withRunnerTemp(t);
  const request = privateRequest(root, 'source-tree.json');
  const result = await runPackagedRuntimeCanary({
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    request
  });
  assert.deepEqual(result, { exitCode: 1, errorCode: 'PACKAGED_CANARY_NOT_PACKAGED' });
  const report = JSON.parse(fs.readFileSync(request.reportPath, 'utf8'));
  assert.equal(report.status, 'FAIL');
  assert.equal(report.packaged, false);
  assert.equal(report.appAsar, false);
  assert.equal(Object.values(report.checks).every((value) => value === false), true);
  assert.equal(JSON.stringify(report).includes(root), false);
});

test('真实 Worker、private SQLite crash/reopen/coordinator probe 全部 PASS 且临时目录清零', async (t) => {
  const root = withRunnerTemp(t);
  const request = privateRequest(root, 'real-probe.json');
  const result = await runPackagedRuntimeCanary({
    app: { isPackaged: true, getAppPath: () => path.join(root, 'app.asar') },
    request,
    assertLayout: () => true
  });
  assert.deepEqual(result, { exitCode: 0, errorCode: null });
  const report = JSON.parse(fs.readFileSync(request.reportPath, 'utf8'));
  assert.equal(report.status, 'PASS');
  assert.equal(report.packaged, true);
  assert.equal(report.appAsar, true);
  assert.equal(Object.values(report.checks).every((value) => value === true), true);
  assert.deepEqual(fs.readdirSync(root), ['real-probe.json']);
});

test('report 已存在时拒绝覆盖并 nonzero', async (t) => {
  const root = withRunnerTemp(t);
  const request = privateRequest(root, 'existing.json');
  fs.writeFileSync(request.reportPath, 'owned');
  const result = await runPackagedRuntimeCanary({
    app: { isPackaged: true, getAppPath: () => path.join(root, 'app.asar') },
    request,
    assertLayout: () => true,
    execute: async (_request, state) => {
      for (const key of Object.keys(state.checks)) state.checks[key] = true;
    }
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorCode, 'EEXIST');
  assert.equal(fs.readFileSync(request.reportPath, 'utf8'), 'owned');
});

test('main canary branch 在普通 DB/IPC/window 前退出且不注册 normal quit handlers', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../../../../src/main.js'), 'utf8');
  const parse = main.indexOf('parsePackagedRuntimeRequest(process.env)');
  const userData = main.indexOf("app.setPath('userData'");
  const lock = main.indexOf('app.requestSingleInstanceLock()');
  const ready = main.indexOf('if (hasSingleInstanceLock) app.whenReady()');
  const branch = main.indexOf('if (packagedRuntimeModeSelected)', ready);
  const normalStartup = main.indexOf("startStartupPhase('startup-total'", branch);
  const runner = main.indexOf('runPackagedRuntimeCanary', branch);
  const exit = main.indexOf('app.exit(exitCode)', runner);
  assert.ok(parse >= 0 && parse < userData && userData < lock && lock < ready);
  assert.ok(branch >= ready && runner > branch && exit > runner && exit < normalStartup);
  assert.match(main, /if \(!packagedRuntimeModeSelected\) \{\s+app\.on\('before-quit'/);
  assert.equal(main.includes('handleStartupFailure(packagedRuntimeRequestError)'), false);
  assert.match(main, /\.catch\(\(error\) => \{\s+if \(packagedRuntimeModeSelected\)[\s\S]*?app\.exit\(1\);[\s\S]*?handleStartupFailure\(error\)/);
  assert.match(main, /\^\[A-Z0-9_:-\]\{1,64\}\$/);
});
