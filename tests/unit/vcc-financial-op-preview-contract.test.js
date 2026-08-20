const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const main = read('src/main.js');
const renderer = read('src/renderer.js');
const moduleRenderer = read('src/renderer-vcc-financial-op.js');
const preload = read('src/preload.js');
const renderScript = read('scripts/render-modal-preview.js');
const clearStyles = read('src/styles-gemini.css');
const legacyStyles = read('src/styles.css');
const packageJson = JSON.parse(read('package.json'));
const {
  finalizePreviewCapture,
  hasPngSignature,
  promotePreview
} = require('../../scripts/render-modal-preview');

const PREVIEW_CONTRACT = [
  ['vcc-financial-op-panel', 'openPanel', 'sync'],
  ['vcc-financial-op-import-month', 'openImportMonth', 'lifecycle'],
  ['vcc-financial-op-run-month', 'openRunMonth', 'lifecycle'],
  ['vcc-financial-op-data-manager', 'openDataManager', 'state'],
  ['vcc-financial-op-data-manager-no-archive', 'openDataManagerNoArchive', 'state'],
  ['vcc-financial-op-delete', 'openDelete', 'state'],
  ['vcc-financial-op-delete-first-month', 'openDeleteFirstMonth', 'state'],
  ['vcc-financial-op-delete-first-month-archived', 'openDeleteFirstMonthArchived', 'state'],
  ['vcc-financial-op-delete-result', 'openDeleteResult', 'state'],
  ['vcc-financial-op-unarchive', 'openUnarchive', 'state'],
  ['vcc-financial-op-unarchive-year-switch', 'openUnarchiveYearSwitch', 'state'],
  ['vcc-financial-op-unarchive-non-tail', 'openUnarchiveNonTail', 'state'],
  ['vcc-financial-op-unarchive-executing', 'openUnarchiveExecuting', 'state'],
  ['vcc-financial-op-export', 'openExport', 'state'],
  ['vcc-financial-op-result-export-month', 'openResultExportMonth', 'state'],
  ['vcc-financial-op-result-export-month-empty', 'openResultExportMonthEmpty', 'sync'],
  ['vcc-financial-op-result', 'openResult', 'lifecycle'],
  ['vcc-financial-op-result-single-adjustment', 'openResultSingleAdjustment', 'lifecycle'],
  ['vcc-financial-op-result-multiple-adjustments', 'openResultMultipleAdjustments', 'lifecycle'],
  ['vcc-financial-op-result-archived', 'openResultArchived', 'lifecycle'],
  ['vcc-financial-op-result-zoom-125', 'openResult', 'lifecycle'],
  ['vcc-financial-op-result-zoom-150', 'openResult', 'lifecycle'],
  ['vcc-financial-op-result-min-window', 'openResult', 'lifecycle'],
  ['vcc-financial-op-adjustment', 'openAdjustment', 'lifecycle'],
  ['vcc-financial-op-run-preflight-error', 'openRunPreflightError', 'sync'],
  ['vcc-financial-op-opening', 'openOpening', 'lifecycle']
];

test('v3.1.8 VCC 关键 preview 状态均有 renderer token、mock hook 与独立脚本', () => {
  for (const [token, method, strategy] of PREVIEW_CONTRACT) {
    assert.ok(renderer.includes(`'${token}'`), `renderer 缺少 preview token：${token}`);
    assert.ok(main.includes(`'${token}'`), `main readiness 白名单缺少 preview token：${token}`);
    assert.ok(
      renderer.includes(`'${token}': Object.freeze({ method: '${method}', strategy: '${strategy}' })`),
      `preview token 未锁定到 ${method}/${strategy}`
    );
    assert.match(moduleRenderer, new RegExp(`(?:async\\s+)?\\b${method}\\(\\)\\s*\\{`));
    assert.ok(
      Object.hasOwn(packageJson.scripts, `preview:${token}`),
      `package scripts 缺少 preview:${token}`
    );
    assert.ok(
      packageJson.scripts['preview:vcc-financial-op'].includes(`npm run preview:${token}`),
      `preview:vcc-financial-op 未聚合 ${token}`
    );
  }
  const scriptTokens = Object.keys(packageJson.scripts)
    .filter((name) => name.startsWith('preview:vcc-financial-op-'))
    .map((name) => name.slice('preview:'.length))
    .sort();
  assert.deepEqual(scriptTokens, PREVIEW_CONTRACT.map(([token]) => token).sort());
  assert.ok(packageJson.scripts['preview:all'].includes('npm run preview:vcc-financial-op'));
  assert.match(moduleRenderer, /openDataManager\(\)[\s\S]*previewDataManagerPayload\(\{ hasArchive: true \}\)/);
  assert.match(moduleRenderer, /openResult\(\) \{\s*return confirmArchive\(buildResultPreview\(\)\);/);
  assert.match(moduleRenderer, /openAdjustment\(\) \{[\s\S]*return requestRunAdjustment/);
});

test('仓库提交的 26 张 VCC preview 均为完整 PNG 且尺寸与 capture 契约一致', () => {
  assert.equal(PREVIEW_CONTRACT.length, 26);
  const previewDir = path.join(ROOT, 'docs', 'previews');
  const expectedFiles = PREVIEW_CONTRACT.map(([token]) => `${token}.png`).sort();
  const committedFiles = fs.readdirSync(previewDir)
    .filter((name) => /^vcc-financial-op.*\.png$/.test(name))
    .sort();
  assert.deepEqual(committedFiles, expectedFiles, '仓库根 preview 目录必须与 26-token 契约精确一致');
  let standardCount = 0;
  let minWindowCount = 0;

  for (const [token] of PREVIEW_CONTRACT) {
    const previewPath = path.join(previewDir, `${token}.png`);
    assert.equal(fs.existsSync(previewPath), true, `缺少已提交 preview：${token}.png`);
    assert.equal(hasPngSignature(previewPath), true, `preview 不是含完整 IHDR/IDAT/IEND 的 PNG：${token}.png`);

    const bytes = fs.readFileSync(previewPath);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (token === 'vcc-financial-op-result-min-window') {
      assert.deepEqual([width, height], [2160, 1520], `${token}.png 必须为最小窗口 capture 尺寸`);
      minWindowCount += 1;
    } else {
      assert.deepEqual([width, height], [2480, 1720], `${token}.png 必须为标准 capture 尺寸`);
      standardCount += 1;
    }
  }

  assert.equal(standardCount, 25);
  assert.equal(minWindowCount, 1);
});

test('zoom 与最小窗口参数只在 APP_CAPTURE_PATH preview 路径改写 BrowserWindow options', () => {
  const createWindowStart = main.indexOf('function createWindow(options = {})');
  const createWindowEnd = main.indexOf('function buildTemplateSummary(', createWindowStart);
  assert.ok(createWindowStart >= 0 && createWindowEnd > createWindowStart);
  const createWindowSource = main.slice(createWindowStart, createWindowEnd);
  const captureGateStart = createWindowSource.indexOf('if (process.env.APP_CAPTURE_PATH)');
  const browserWindowStart = createWindowSource.indexOf('mainWindow = new BrowserWindow(windowOptions)');
  assert.ok(captureGateStart > 0 && browserWindowStart > captureGateStart);

  const productionOptions = createWindowSource.slice(0, captureGateStart);
  assert.match(productionOptions, /const windowOptions = \{\s*width: 1240,\s*height: 860,/);
  assert.match(productionOptions, /minWidth: 1080,\s*minHeight: 760,/);
  assert.doesNotMatch(productionOptions, /APP_PREVIEW_ZOOM_FACTOR|APP_CAPTURE_WINDOW_WIDTH|APP_CAPTURE_WINDOW_HEIGHT|zoomFactor/);

  const captureOnlyOverrides = createWindowSource.slice(captureGateStart, browserWindowStart);
  assert.match(captureOnlyOverrides, /APP_CAPTURE_WINDOW_WIDTH/);
  assert.match(captureOnlyOverrides, /APP_CAPTURE_WINDOW_HEIGHT/);
  assert.match(captureOnlyOverrides, /APP_PREVIEW_ZOOM_FACTOR/);
  assert.match(captureOnlyOverrides, /windowOptions\.webPreferences\.zoomFactor = captureZoomFactor/);
});

test('APP_PREVIEW_MODAL 只有在 APP_CAPTURE_PATH capture 模式下才暴露给 renderer', () => {
  assert.match(
    main,
    /previewModal:\s*process\.env\.APP_CAPTURE_PATH\s*\?\s*\(process\.env\.APP_PREVIEW_MODAL \|\| ''\)\s*:\s*''/
  );
  assert.doesNotMatch(
    main,
    /previewModal:\s*process\.env\.APP_PREVIEW_MODAL\s*\|\|\s*''/,
    '生产环境不得仅凭 APP_PREVIEW_MODAL 启动合成预览'
  );
  assert.match(renderScript, /APP_CAPTURE_PATH: stagedPath,[\s\S]*APP_PREVIEW_MODAL: modalName/);
});

test('VCC 合成 preview hook 只在 preload 确认 capture 模式时挂载', () => {
  assert.match(preload, /previewCapture:\s*Boolean\(process\.env\.APP_CAPTURE_PATH\)/);
  assert.match(
    moduleRenderer,
    /const previewHooks = window\.desktopApi\.previewCapture === true \? \{[\s\S]*\} : null;/
  );
  assert.doesNotMatch(moduleRenderer, /window\.__vccFinancialOpPreview\s*=/);
  assert.match(moduleRenderer, /exposePreviewHooks\(previewHooks\);/);

  const helperStart = moduleRenderer.indexOf('function exposePreviewHooks(');
  const helperEnd = moduleRenderer.indexOf('const PREVIEW_ARCHIVED_MONTHS', helperStart);
  const fakeWindow = {};
  const expose = Function(
    'window',
    `'use strict'; ${moduleRenderer.slice(helperStart, helperEnd)}; return exposePreviewHooks;`
  )(fakeWindow);
  assert.equal(expose(null), false);
  assert.equal(fakeWindow.__vccFinancialOpPreview, undefined);

  const hooks = { openResult() {} };
  assert.equal(expose(hooks), true);
  assert.equal(fakeWindow.__vccFinancialOpPreview, hooks);
  assert.equal(Object.isFrozen(fakeWindow.__vccFinancialOpPreview), true);
  assert.equal(Object.getOwnPropertyDescriptor(fakeWindow, '__vccFinancialOpPreview').writable, false);
});

test('VCC capture readiness 对未知、缺失、null、throw 与 reject 全部失败关闭', async () => {
  const helperStart = renderer.indexOf('const VCC_PREVIEW_CAPTURE_CONTRACT = Object.freeze(');
  const helperEnd = renderer.indexOf('const rendererStartupProfiler', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const requestAnimationFrame = (callback) => queueMicrotask(callback);
  const buildRegister = (fakeWindow) => Function(
    'window',
    'requestAnimationFrame',
    `'use strict'; ${renderer.slice(helperStart, helperEnd)}; return registerVccPreviewCaptureReadiness;`
  )(fakeWindow, requestAnimationFrame);

  const productionWindow = { desktopApi: { previewCapture: false } };
  const productionRegister = buildRegister(productionWindow);
  assert.equal(productionRegister('vcc-financial-op-unarchive'), false);
  assert.equal(productionWindow.__vccPreviewCaptureReady, undefined);

  const unknownWindow = { desktopApi: { previewCapture: true }, __vccFinancialOpPreview: {} };
  const unknownRegister = buildRegister(unknownWindow);
  assert.equal(unknownRegister('vcc-financial-op-unknown'), true);
  await assert.rejects(
    unknownWindow.__vccPreviewCaptureReady,
    /Unknown VCC preview capture token/
  );

  const missingHooksWindow = { desktopApi: { previewCapture: true } };
  buildRegister(missingHooksWindow)('vcc-financial-op-delete-first-month');
  await assert.rejects(
    missingHooksWindow.__vccPreviewCaptureReady,
    /preview hooks are unavailable/
  );

  const missingMethodWindow = { desktopApi: { previewCapture: true }, __vccFinancialOpPreview: {} };
  buildRegister(missingMethodWindow)('vcc-financial-op-delete-first-month');
  await assert.rejects(missingMethodWindow.__vccPreviewCaptureReady, /hook is unavailable/);

  const nullStateWindow = {
    desktopApi: { previewCapture: true },
    __vccFinancialOpPreview: { openDeleteFirstMonth: () => null }
  };
  buildRegister(nullStateWindow)('vcc-financial-op-delete-first-month');
  await assert.rejects(nullStateWindow.__vccPreviewCaptureReady, /did not return a readiness task/);

  const rejectedStateWindow = {
    desktopApi: { previewCapture: true },
    __vccFinancialOpPreview: { openDeleteFirstMonth: () => Promise.reject(new Error('delete preview failed')) }
  };
  buildRegister(rejectedStateWindow)('vcc-financial-op-delete-first-month');
  await assert.rejects(rejectedStateWindow.__vccPreviewCaptureReady, /delete preview failed/);

  const throwingWindow = {
    desktopApi: { previewCapture: true },
    __vccFinancialOpPreview: { openRunPreflightError: () => { throw new Error('sync preview failed'); } }
  };
  buildRegister(throwingWindow)('vcc-financial-op-run-preflight-error');
  await assert.rejects(throwingWindow.__vccPreviewCaptureReady, /sync preview failed/);

  const rejectedLifecycleWindow = {
    desktopApi: { previewCapture: true },
    __vccFinancialOpPreview: { openResult: () => Promise.reject(new Error('result dialog failed')) }
  };
  buildRegister(rejectedLifecycleWindow)('vcc-financial-op-result');
  await assert.rejects(rejectedLifecycleWindow.__vccPreviewCaptureReady, /result dialog failed/);

  const readyWindow = {
    desktopApi: { previewCapture: true },
    __vccFinancialOpPreview: { openDeleteFirstMonth: () => Promise.resolve({ confirmDisabled: false }) }
  };
  buildRegister(readyWindow)('vcc-financial-op-delete-first-month');
  assert.deepEqual(
    await readyWindow.__vccPreviewCaptureReady,
    { status: 'ready', token: 'vcc-financial-op-delete-first-month' }
  );
  assert.match(renderer, /info\.previewModal\.startsWith\('vcc-financial-op-'\)/);
  assert.match(main, /VCC_PREVIEW_READINESS_TIMEOUT_MS = 8000/);
  assert.match(main, /await waitForVccPreviewCaptureReady\(mainWindow\.webContents\)/);
  assert.match(main, /throw new Error\(`Unknown VCC preview capture token:/);
});

test('result/import/run/adjustment 生命周期 Promise 不参与 readiness 等待', async () => {
  const helperStart = renderer.indexOf('const VCC_PREVIEW_CAPTURE_CONTRACT = Object.freeze(');
  const helperEnd = renderer.indexOf('const rendererStartupProfiler', helperStart);
  const requestAnimationFrame = (callback) => queueMicrotask(callback);
  const buildRegister = (fakeWindow) => Function(
    'window',
    'requestAnimationFrame',
    `'use strict'; ${renderer.slice(helperStart, helperEnd)}; return registerVccPreviewCaptureReadiness;`
  )(fakeWindow, requestAnimationFrame);

  for (const [token, method] of [
    ['vcc-financial-op-result', 'openResult'],
    ['vcc-financial-op-import-month', 'openImportMonth'],
    ['vcc-financial-op-run-month', 'openRunMonth'],
    ['vcc-financial-op-adjustment', 'openAdjustment']
  ]) {
    const lifecycleWindow = {
      desktopApi: { previewCapture: true },
      __vccFinancialOpPreview: { [method]: () => new Promise(() => {}) }
    };
    buildRegister(lifecycleWindow)(token);
    const settled = await Promise.race([
      lifecycleWindow.__vccPreviewCaptureReady.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100))
    ]);
    assert.equal(settled, true, `${token} readiness 错误等待了弹框关闭`);
  }
});

test('main readiness 对缺注册、悬挂、拒绝和非法结果均在超时内失败', async () => {
  const helperStart = main.indexOf('const VCC_PREVIEW_READINESS_TOKENS = new Set(');
  const helperEnd = main.indexOf('function createWindow(options = {})', helperStart);
  const helperSource = main.slice(helperStart, helperEnd)
    .replace('const VCC_PREVIEW_READINESS_TIMEOUT_MS = 8000;', 'const VCC_PREVIEW_READINESS_TIMEOUT_MS = 30;');
  const waitForReady = Function(
    `'use strict'; ${helperSource}; return waitForVccPreviewCaptureReady;`
  )();
  const webContentsFor = (fakeWindow) => ({
    executeJavaScript(source) {
      return Function('window', `'use strict'; return (${source});`)(fakeWindow);
    }
  });

  await assert.rejects(waitForReady(webContentsFor({})), /was not registered before timeout/);
  await assert.rejects(
    waitForReady(webContentsFor({ __vccPreviewCaptureReady: new Promise(() => {}) })),
    /did not settle before timeout/
  );
  await assert.rejects(
    waitForReady(webContentsFor({ __vccPreviewCaptureReady: Promise.reject(new Error('renderer failed')) })),
    /renderer failed/
  );
  await assert.rejects(
    waitForReady(webContentsFor({ __vccPreviewCaptureReady: Promise.resolve(null) })),
    /returned an invalid state/
  );
});

test('delete-first-month readiness 等 selector 异步刷新按钮与文案稳定后才完成', async () => {
  const trackerStart = moduleRenderer.indexOf('function attachPreviewStateTracker(');
  const trackerEnd = moduleRenderer.indexOf('function showMessage(', trackerStart);
  const waitStart = moduleRenderer.indexOf('async function waitForArchivedPickerPreview(');
  const waitEnd = moduleRenderer.indexOf('function createUnarchivePreviewDialog(', waitStart);
  const helpers = Function(
    `'use strict'; ${moduleRenderer.slice(trackerStart, trackerEnd)} ${moduleRenderer.slice(waitStart, waitEnd)}; return { attachPreviewStateTracker, selectPreviewControl };`
  )();

  let confirmDisabled = true;
  let stateMessage = '正在核对可删除数据…';
  let refreshSettled = false;
  const targetControl = {
    value: 'recharge_refund',
    dispatchEvent() {
      modal.trackPreviewState(new Promise((resolve) => {
        setImmediate(() => {
          confirmDisabled = false;
          stateMessage = '将删除 1 条主体期初初始化数据，并删除 1 份未归档结果；导入事实保留。';
          refreshSettled = true;
          resolve();
        });
      }));
    }
  };
  const modal = {
    dialog: {
      isConnected: true,
      classList: { contains: () => false },
      querySelector(selector) {
        return selector === '[data-field="delete-target"]' ? targetControl : null;
      }
    }
  };
  helpers.attachPreviewStateTracker(modal, () => ({
    modalPresent: true,
    selectedMonth: '2026-06',
    selectedTarget: targetControl.value,
    confirmDisabled,
    stateMessage
  }));

  const readiness = helpers.selectPreviewControl(
    modal,
    '[data-field="delete-target"]',
    'opening_initialization',
    {
      delay: 0,
      expectedMonth: '2026-06',
      expectedConfirmDisabled: false,
      stateMessageIncludes: '主体期初初始化数据'
    }
  );
  assert.equal(refreshSettled, false);
  const snapshot = await readiness;
  assert.equal(refreshSettled, true);
  assert.equal(snapshot.selectedTarget, 'opening_initialization');
  assert.equal(snapshot.confirmDisabled, false);
  assert.match(snapshot.stateMessage, /主体期初初始化数据/);
});

test('年份切换、非尾月与执行中预览等待异步状态后读取真实 disabled 属性', async () => {
  const helperStart = moduleRenderer.indexOf('async function waitForArchivedPickerPreview(');
  const helperEnd = moduleRenderer.indexOf('function createUnarchivePreviewDialog(', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helpers = Function(
    `'use strict'; ${moduleRenderer.slice(helperStart, helperEnd)}; return { waitForArchivedPickerPreview, selectPreviewControl };`
  )();

  function createFakePicker() {
    const confirmButton = { disabled: false };
    const yearControl = { value: '2026' };
    const monthControl = { value: '2026-06' };
    let stateMessage = '2026-06 可解归档；基础结果和调整记录将保留。';
    let stateTone = 'warning';
    let previewPending = false;
    let pending = Promise.resolve();
    const beginAsyncRefresh = () => {
      previewPending = true;
      confirmButton.disabled = true;
      pending = new Promise((resolve) => {
        setImmediate(() => {
          if (yearControl.value === '2025') monthControl.value = '2025-12';
          stateMessage = '该月之后仍存在已归档月份，请先从最新月份开始解归档。 后续依赖月份：2026-06。';
          stateTone = 'error';
          previewPending = false;
          resolve();
        });
      });
    };
    yearControl.dispatchEvent = beginAsyncRefresh;
    monthControl.dispatchEvent = beginAsyncRefresh;
    const dialog = {
      isConnected: true,
      classList: { contains: (name) => name === 'vcc-fin-op-archive-picker-dialog' },
      querySelector(selector) {
        if (selector === '[data-field="archive-year"]') return yearControl;
        if (selector === '[data-field="archive-month"]') return monthControl;
        if (selector === '[data-action="archive-picker-confirm"]') return confirmButton;
        return null;
      }
    };
    return {
      modal: {
        dialog,
        async waitForPreviewState() {
          await pending;
          return {
            modalPresent: dialog.isConnected,
            selectedYear: yearControl.value,
            selectedMonth: monthControl.value,
            previewPending,
            confirmDisabled: confirmButton.disabled === true,
            stateMessage,
            stateTone
          };
        }
      },
      confirmButton,
      setExecuting() {
        confirmButton.disabled = true;
        stateMessage = '正在解归档，请勿关闭窗口…';
        stateTone = 'warning';
      }
    };
  }

  const yearSwitch = createFakePicker();
  const yearCompletion = helpers.selectPreviewControl(
    yearSwitch.modal,
    '[data-field="archive-year"]',
    '2025',
    {
      delay: 0,
      expectedYear: '2025',
      expectedMonth: '2025-12',
      expectedConfirmDisabled: true,
      stateMessageIncludes: '2026-06'
    }
  );
  assert.equal(yearSwitch.confirmButton.disabled, false, '定时切换前按钮仍是初始可执行态');
  const yearSnapshot = await yearCompletion;
  assert.equal(yearSnapshot.confirmDisabled, true);
  assert.equal(yearSwitch.confirmButton.disabled, true);

  const nonTail = createFakePicker();
  const monthSnapshot = await helpers.selectPreviewControl(
    nonTail.modal,
    '[data-field="archive-month"]',
    '2026-05',
    {
      delay: 0,
      expectedYear: '2026',
      expectedMonth: '2026-05',
      expectedConfirmDisabled: true,
      stateMessageIncludes: '2026-06'
    }
  );
  assert.equal(monthSnapshot.confirmDisabled, true);
  assert.equal(nonTail.confirmButton.disabled, true);

  const executing = createFakePicker();
  executing.setExecuting();
  const executingSnapshot = await helpers.waitForArchivedPickerPreview(executing.modal, {
    expectedYear: '2026',
    expectedMonth: '2026-06',
    expectedConfirmDisabled: true,
    stateMessageIncludes: '正在解归档'
  });
  assert.equal(executingSnapshot.confirmDisabled, true);
  assert.equal(executing.confirmButton.disabled, true);

  assert.match(moduleRenderer, /requestPreviewRefresh\(\);[\s\S]*monthSelect\.addEventListener\('change', requestPreviewRefresh\)/);
  assert.match(moduleRenderer, /openUnarchiveYearSwitch\(\)[\s\S]*expectedConfirmDisabled: true/);
  assert.match(moduleRenderer, /openUnarchiveNonTail\(\)[\s\S]*expectedConfirmDisabled: true/);
});

test('render-modal-preview 对可选 zoom/窗口参数做边界校验后才写入 capture 环境', () => {
  assert.match(renderScript, /validateOptionalNumber\(zoomFactor/);
  assert.match(renderScript, /label: 'zoom-factor', min: 0\.5, max: 2/);
  assert.match(renderScript, /label: 'window-width', min: 1080, max: 3840, integer: true/);
  assert.match(renderScript, /label: 'window-height', min: 760, max: 2160, integer: true/);
  assert.match(renderScript, /if \(validatedZoomFactor\) childEnv\.APP_PREVIEW_ZOOM_FACTOR = validatedZoomFactor/);
  assert.match(renderScript, /if \(validatedWindowWidth\) childEnv\.APP_CAPTURE_WINDOW_WIDTH = validatedWindowWidth/);
  assert.match(renderScript, /if \(validatedWindowHeight\) childEnv\.APP_CAPTURE_WINDOW_HEIGHT = validatedWindowHeight/);
  assert.equal(packageJson.scripts['preview:vcc-financial-op-result-zoom-125'].endsWith(' 1.25'), true);
  assert.equal(packageJson.scripts['preview:vcc-financial-op-result-zoom-150'].endsWith(' 1.5'), true);
  assert.equal(packageJson.scripts['preview:vcc-financial-op-result-min-window'].endsWith(' 1 1080 760'), true);
});

test('preview capture 失败必须非 0 退出，不得以旧 PNG 冒充本轮产物', () => {
  const captureStart = main.indexOf('if (process.env.APP_CAPTURE_PATH)', main.indexOf("mainWindow.once('ready-to-show'"));
  const captureEnd = main.indexOf("mainWindow.on('close'", captureStart);
  const captureSource = main.slice(captureStart, captureEnd);
  assert.match(captureSource, /let captureExitCode = 0;/);
  assert.match(captureSource, /catch \(error\) \{\s*captureExitCode = 1;/);
  assert.match(captureSource, /finally \{\s*app\.exit\(captureExitCode\);/);
  assert.doesNotMatch(captureSource, /app\.quit\(\)/);

  assert.match(renderScript, /APP_CAPTURE_PATH: stagedPath/);
  assert.doesNotMatch(renderScript, /APP_CAPTURE_PATH: previewPath/);
  assert.match(renderScript, /hasPngSignature\(stagedPath\)/);
  assert.match(renderScript, /fs\.renameSync\(stagedPath, previewPath\)/);
  assert.match(renderScript, /if \(code !== 0\)[\s\S]*finish\(new Error/);
});

test('preview 仅在本轮临时产物具备完整 PNG 结构时替换旧证据', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-promote-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const target = path.join(tempRoot, 'preview.png');
  const invalidStage = path.join(tempRoot, 'invalid.part');
  const signatureOnlyStage = path.join(tempRoot, 'signature-only.part');
  const truncatedStage = path.join(tempRoot, 'truncated.part');
  const noIdatStage = path.join(tempRoot, 'no-idat.part');
  const noIendStage = path.join(tempRoot, 'no-iend.part');
  const validStage = path.join(tempRoot, 'valid.part');
  fs.writeFileSync(target, 'old-evidence');
  fs.writeFileSync(invalidStage, 'not-a-png');

  assert.equal(hasPngSignature(invalidStage), false);
  assert.throws(() => promotePreview(invalidStage, target), /did not produce a complete PNG/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old-evidence');

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data = Buffer.alloc(0)) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  fs.writeFileSync(signatureOnlyStage, signature);
  assert.equal(hasPngSignature(signatureOnlyStage), false);
  assert.throws(() => promotePreview(signatureOnlyStage, target), /did not produce a complete PNG/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old-evidence');

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  fs.writeFileSync(truncatedStage, Buffer.concat([signature, chunk('IHDR', ihdr).subarray(0, 20)]));
  assert.equal(hasPngSignature(truncatedStage), false);
  assert.throws(() => promotePreview(truncatedStage, target), /did not produce a complete PNG/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old-evidence');

  fs.writeFileSync(noIdatStage, Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IEND')]));
  assert.equal(hasPngSignature(noIdatStage), false);
  assert.throws(() => promotePreview(noIdatStage, target), /did not produce a complete PNG/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old-evidence');

  fs.writeFileSync(noIendStage, Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([1]))]));
  assert.equal(hasPngSignature(noIendStage), false);
  assert.throws(() => promotePreview(noIendStage, target), /did not produce a complete PNG/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old-evidence');

  fs.writeFileSync(
    validStage,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  );
  assert.equal(hasPngSignature(validStage), true);
  promotePreview(validStage, target);
  assert.equal(hasPngSignature(target), true);
  assert.equal(fs.existsSync(validStage), false);
});

test('异步 readiness 失败时即使 staged PNG 合法也不替换旧证据', (t) => {
  const previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-readiness-failure-'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-readiness-user-data-'));
  t.after(() => fs.rmSync(previewRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const target = path.join(previewRoot, 'preview.png');
  const staged = path.join(previewRoot, '.preview.png.part');
  const validPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  fs.writeFileSync(target, 'old-evidence');
  fs.writeFileSync(staged, validPng);

  const result = finalizePreviewCapture({
    stagedPath: staged,
    previewPath: target,
    tempRoot,
    error: new Error('VCC preview readiness did not settle before timeout'),
    exitCode: 1,
    logger: { error() {} }
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.error.message, /readiness did not settle/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old-evidence');
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.existsSync(tempRoot), false);
});

test('危险按钮 disabled 在两套基础样式中均有不可点击视觉态', () => {
  for (const source of [clearStyles, legacyStyles]) {
    assert.match(source, /\.danger-btn:disabled\s*\{[\s\S]*background:[\s\S]*color:[\s\S]*cursor:\s*not-allowed;[\s\S]*transform:\s*none;/);
  }
});

test('VCC 用户可见结果修订术语统一为中文结果版本', () => {
  for (const obsolete of [
    '当前结果 revision',
    '当前 revision',
    '结果 revision'
  ]) {
    assert.equal(moduleRenderer.includes(obsolete), false, `仍存在用户可见英文术语：${obsolete}`);
  }
  assert.match(moduleRenderer, /当前结果版本 \$\{currentResult\.resultRevision\}，请核对后归档/);
  assert.match(moduleRenderer, /正在按当前结果版本重新核对并归档/);
  assert.match(moduleRenderer, /<th>结果版本<\/th>/);
});
