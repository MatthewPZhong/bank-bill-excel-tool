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
const { hasPngSignature, promotePreview } = require('../../scripts/render-modal-preview');

const PREVIEW_CONTRACT = [
  ['vcc-financial-op-data-manager-no-archive', 'openDataManagerNoArchive'],
  ['vcc-financial-op-delete-first-month', 'openDeleteFirstMonth'],
  ['vcc-financial-op-delete-first-month-archived', 'openDeleteFirstMonthArchived'],
  ['vcc-financial-op-delete-result', 'openDeleteResult'],
  ['vcc-financial-op-unarchive', 'openUnarchive'],
  ['vcc-financial-op-unarchive-year-switch', 'openUnarchiveYearSwitch'],
  ['vcc-financial-op-unarchive-non-tail', 'openUnarchiveNonTail'],
  ['vcc-financial-op-unarchive-executing', 'openUnarchiveExecuting'],
  ['vcc-financial-op-result-export-month-empty', 'openResultExportMonthEmpty'],
  ['vcc-financial-op-result-single-adjustment', 'openResultSingleAdjustment'],
  ['vcc-financial-op-result-multiple-adjustments', 'openResultMultipleAdjustments'],
  ['vcc-financial-op-result-archived', 'openResultArchived'],
  ['vcc-financial-op-result-zoom-125', 'openResult'],
  ['vcc-financial-op-result-zoom-150', 'openResult'],
  ['vcc-financial-op-result-min-window', 'openResult'],
  ['vcc-financial-op-run-preflight-error', 'openRunPreflightError']
];

test('v3.1.8 VCC 关键 preview 状态均有 renderer token、mock hook 与独立脚本', () => {
  for (const [token, method] of PREVIEW_CONTRACT) {
    assert.ok(renderer.includes(`'${token}'`), `renderer 缺少 preview token：${token}`);
    assert.ok(renderer.includes(`'${token}': '${method}'`), `preview token 未路由到 ${method}`);
    assert.match(moduleRenderer, new RegExp(`\\b${method}\\(\\)\\s*\\{`));
    assert.ok(
      Object.hasOwn(packageJson.scripts, `preview:${token}`),
      `package scripts 缺少 preview:${token}`
    );
    assert.ok(
      packageJson.scripts['preview:vcc-financial-op'].includes(`npm run preview:${token}`),
      `preview:vcc-financial-op 未聚合 ${token}`
    );
  }
  assert.ok(packageJson.scripts['preview:all'].includes('npm run preview:vcc-financial-op'));
  assert.match(moduleRenderer, /openDataManager\(\)[\s\S]*previewDataManagerPayload\(\{ hasArchive: true \}\)/);
  assert.match(moduleRenderer, /openResult\(\) \{\s*return confirmArchive\(buildResultPreview\(\)\);/);
  assert.match(moduleRenderer, /openAdjustment\(\) \{[\s\S]*return requestRunAdjustment/);
});

test('zoom 与最小窗口参数只在 APP_CAPTURE_PATH preview 路径改写 BrowserWindow options', () => {
  const createWindowStart = main.indexOf('function createWindow()');
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

test('VCC capture readiness 缺 hook 或缺 method 时明确失败，生产启动不注册等待', async () => {
  const helperStart = renderer.indexOf('function registerVccPreviewCaptureReadiness(');
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
  assert.equal(productionRegister(Promise.resolve()), false);
  assert.equal(productionWindow.__vccPreviewCaptureReady, undefined);

  const captureWindow = { desktopApi: { previewCapture: true } };
  const captureRegister = buildRegister(captureWindow);
  const missingHookTask = captureWindow.__vccFinancialOpPreview?.openUnarchive?.();
  assert.equal(captureRegister(missingHookTask), true);
  await assert.rejects(
    captureWindow.__vccPreviewCaptureReady,
    /did not return a readiness task/
  );

  captureWindow.__vccFinancialOpPreview = {};
  const missingMethodTask = captureWindow.__vccFinancialOpPreview?.openUnarchive?.();
  assert.equal(captureRegister(missingMethodTask), true);
  await assert.rejects(
    captureWindow.__vccPreviewCaptureReady,
    /did not return a readiness task/
  );

  assert.equal(captureRegister(Promise.resolve({ confirmDisabled: true })), true);
  assert.deepEqual(await captureWindow.__vccPreviewCaptureReady, { status: 'ready' });
  assert.match(renderer, /info\.previewModal\.startsWith\('vcc-financial-op-unarchive'\)/);
  assert.match(main, /VCC_PREVIEW_READINESS_TIMEOUT_MS = 8000/);
  assert.match(main, /await waitForVccPreviewCaptureReady\(mainWindow\.webContents\)/);
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
