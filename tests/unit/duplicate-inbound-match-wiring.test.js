'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  executeIpcTaskInvocation,
  normalizeIpcTaskHandler,
  prepareIpcTaskInvocation
} = require('../../src/main-process/archive-center/ipc-task-contract');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到函数 ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`函数 ${name} 未闭合`);
}

function createMainHandlerHarness(overrides = {}) {
  const handlers = new Map();
  const calls = { dialogs: 0, released: 0, service: [], sent: [] };
  const assertStartupAvailable = overrides.assertStartupAvailable || (() => true);
  const service = overrides.service || {
    status: () => ({ status: 'ok' }),
    importFiles: async () => ({ status: 'ok' }),
    run: async () => ({ status: 'success' }),
    buildDefaultFileName: () => '260715_重复入金召回邮件模板.xlsx',
    export: async () => ({ status: 'success', filePath: '/tmp/result.xlsx' })
  };
  const source = [
    extractFunction(main, 'duplicateInboundMatchFailureResult'),
    extractFunction(main, 'sendDuplicateInboundMatchProgress'),
    extractFunction(main, 'registerDuplicateInboundMatchHandlers'),
    'return registerDuplicateInboundMatchHandlers;'
  ].join('\n');
  const factory = new Function(
    'ipcMain',
    'trackedIpcHandle',
    'getDuplicateInboundMatchService',
    'assertDuplicateInboundMatchStartupAvailable',
    'tryAcquireBankStatementOpLock',
    'showImportOpenDialog',
    'releaseBankStatementOpLock',
    'dialog',
    'mainWindow',
    source
  );
  const register = factory(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    (channel, _moduleName, _actionName, handler) => {
      const contract = normalizeIpcTaskHandler(handler);
      handlers.set(channel, async (event, ...args) => {
        const prepared = await prepareIpcTaskInvocation(contract, event, args);
        if (!prepared.proceed) return prepared.result;
        return executeIpcTaskInvocation(
          contract,
          event,
          prepared,
          prepared.args,
          {
            fileEvidence: { filePlan: prepared.filePlan },
            settleArtifacts: async () => ({ ok: true, durable: true })
          }
        );
      });
    },
    () => {
      assertStartupAvailable();
      return service;
    },
    assertStartupAvailable,
    overrides.tryAcquireBankStatementOpLock || (() => ({ acquired: true })),
    overrides.showImportOpenDialog || (async () => {
      calls.dialogs += 1;
      return { canceled: true, filePaths: [] };
    }),
    () => { calls.released += 1; },
    {
      showSaveDialog: overrides.showSaveDialog || (async () => ({ canceled: true }))
    },
    {}
  );
  register();
  const event = {
    sender: {
      isDestroyed: () => false,
      send: (channel, payload) => calls.sent.push({ channel, payload })
    }
  };
  return { handlers, calls, service, event };
}

test.describe('重复入金匹配 UI / preload / IPC 接线', () => {
  test('页面复用三按钮布局且初始状态正确', () => {
    const start = html.indexOf('id="duplicateInboundMatchModulePanel"');
    const end = html.indexOf('id="vccOpCalcModulePanel"', start);
    assert.ok(start > 0 && end > start);
    const section = html.slice(start, end);
    for (const id of [
      'duplicateInboundMatchImportBtn',
      'duplicateInboundMatchRunBtn',
      'duplicateInboundMatchExportBtn',
      'duplicateInboundMatchStatusBox'
    ]) {
      assert.ok(section.includes(`id="${id}"`), `缺少 #${id}`);
    }
    assert.match(section, />导入文件<\/button>/);
    assert.match(section, />开始运行<\/button>/);
    assert.match(section, />导出文件<\/button>/);
    assert.match(section, /duplicateInboundMatchRunBtn[^>]*disabled/);
    assert.match(section, /duplicateInboundMatchExportBtn[^>]*disabled/);
    assert.match(section, /duplicateInboundMatchStatusBox[\s\S]*欢迎使用小助手/);
  });

  test('renderer 注册默认关闭模块的状态、按钮和 preview 路径', () => {
    assert.match(renderer, /duplicateInboundMatch:\s*\{\s*id:\s*'duplicate-inbound-match'/);
    for (const functionName of [
      'refreshDuplicateInboundMatchStatus',
      'handleDuplicateInboundMatchImport',
      'handleDuplicateInboundMatchRun',
      'handleDuplicateInboundMatchExport',
      'applyDuplicateInboundMatchPanelPreviewState'
    ]) {
      assert.ok(renderer.includes(`function ${functionName}(`), `缺少 ${functionName}`);
    }
    assert.ok(renderer.includes("info.previewModal === 'duplicate-inbound-match-panel'"));
    assert.match(renderer, /setDuplicateInboundMatchStatus[\s\S]*updateStatusBox\(/);
    assert.match(renderer, /duplicateInboundMatchState\.busy \|\| !status\.canRun/);
    assert.match(renderer, /duplicateInboundMatchState\.busy \|\| !status\.canExport/);
    assert.match(renderer, /MPT 异常：零候选/);
    assert.ok(renderer.includes('duplicate-inbound-mpt-candidate-count-multiple'));
    assert.ok(renderer.includes('duplicate-inbound-mpt-candidate-reused-across-groups'));
    assert.ok(renderer.includes('duplicate-inbound-mpt-opp-bu-conflict'));
    assert.ok(renderer.includes('duplicate-inbound-mpt-order-id-empty'));
    assert.ok(renderer.includes('duplicate-inbound-document-candidate-count-zero'));
    assert.ok(renderer.includes('duplicate-inbound-document-identity-fields-conflict'));
    assert.ok(renderer.includes('duplicate-inbound-document-business-department-mismatch'));
    assert.ok(renderer.includes('window.desktopApi.duplicateInboundMatch.importFiles()'));
    assert.match(renderer, /function formatDuplicateInboundMatchFailure\(/);
    assert.match(renderer, /Array\.isArray\(value\.detailLines\)/);
    assert.match(renderer, /\.\.\.detailLines\]\.join\('\\n'\)/);
    assert.equal(
      (renderer.match(/formatDuplicateInboundMatchFailure\('(导入|运行|导出)失败'/g) || []).length,
      6,
      '导入、运行、导出的返回错误与抛错都必须展示 detailLines'
    );
    assert.match(
      renderer,
      /formatDuplicateInboundMatchFailure\('状态读取失败', status\)/,
      '启动回收或侧库状态读取失败必须对用户可见'
    );
    const formatExportSuccess = new Function(
      `${extractFunction(renderer, 'formatDuplicateInboundMatchExportSuccess')}; return formatDuplicateInboundMatchExportSuccess;`
    )();
    assert.deepEqual(
      formatExportSuccess({ filePath: '/tmp/result.xlsx', warnings: ['旧备份未删除'] }),
      {
        message: '文件已生成：/tmp/result.xlsx\n警告：旧备份未删除',
        tone: 'warning'
      }
    );
  });

  test('preload 的 4 个 invoke、3 个进度通道与 main handlers 对齐', () => {
    for (const channel of [
      'duplicate-inbound-match:import-files',
      'duplicate-inbound-match:session-status',
      'duplicate-inbound-match:run',
      'duplicate-inbound-match:export'
    ]) {
      assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload 缺少 ${channel}`);
      assert.ok(main.includes(`'${channel}'`), `main 缺少 ${channel}`);
    }
    for (const channel of [
      'duplicate-inbound-match:import-progress',
      'duplicate-inbound-match:run-progress',
      'duplicate-inbound-match:export-progress'
    ]) {
      assert.ok(preload.includes(`ipcRenderer.on('${channel}', wrapped)`), `preload 缺少 ${channel}`);
      assert.ok(preload.includes(`ipcRenderer.removeListener('${channel}', wrapped)`));
      assert.ok(main.includes(`'${channel}'`), `main 缺少 ${channel}`);
    }
    assert.match(main, /registerDuplicateInboundMatchHandlers\(\)/);
    assert.doesNotMatch(main, /scheduleDuplicateInboundMatchStartupCleanup\(\)/);
    assert.match(main, /await initializeBackgroundExecutionRecovery\(\)/);
    assert.match(main, /DUPLICATE_STARTUP_RECOVERY_UNAVAILABLE/);
    assert.match(main, /DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY/);
  });

  test('startup在freeze前同时注册manual与duplicate恢复链，再允许getter构造Service', () => {
    const recovery = extractFunction(main, 'initializeBackgroundExecutionRecovery');
    const registerManualInspectorAt = recovery.indexOf(
      'inspectorRegistry.register(MANUAL_BALANCE_INSPECTOR_KEY'
    );
    const registerDuplicateInspectorAt = recovery.indexOf(
      'inspectorRegistry.register(DUPLICATE_STARTUP_INSPECTOR_KEY'
    );
    const registerManualProviderAt = recovery.indexOf(
      'providerRegistry.register(\n    MANUAL_BALANCE_SETTLEMENT_KEY'
    );
    const registerDuplicateProviderAt = recovery.indexOf(
      'providerRegistry.register(\n    DUPLICATE_STARTUP_RECOVERY_KEY'
    );
    const inspectorFreezeAt = recovery.indexOf('inspectorRegistry.freeze()');
    const providerFreezeAt = recovery.indexOf('providerRegistry.freeze()');
    const scanAt = recovery.indexOf('await coordinator.scanAndRecover()');
    const readyAt = recovery.lastIndexOf('duplicateStartupRecoveryReady = true');
    assert.ok(registerManualInspectorAt >= 0 && registerManualInspectorAt < inspectorFreezeAt);
    assert.ok(registerDuplicateInspectorAt >= 0 && registerDuplicateInspectorAt < inspectorFreezeAt);
    assert.ok(registerManualProviderAt >= 0 && registerManualProviderAt < providerFreezeAt);
    assert.ok(registerDuplicateProviderAt >= 0 && registerDuplicateProviderAt < providerFreezeAt);
    assert.ok(inspectorFreezeAt < scanAt && providerFreezeAt < scanAt && scanAt < readyAt);

    const getter = extractFunction(main, 'getDuplicateInboundMatchService');
    assert.ok(
      getter.indexOf('assertDuplicateInboundMatchStartupAvailable()') <
        getter.indexOf('createDuplicateInboundMatchService({')
    );
    const initialize = extractFunction(main, 'initializeApplication');
    assert.ok(
      initialize.indexOf('await initializeBackgroundExecutionRecovery()') <
        initialize.indexOf('schedulePreFundReconciliationStartupCleanup()')
    );
  });

  test('main handlers 对取消、失败、进度和锁释放执行真实契约', async () => {
    let importCalled = 0;
    const cancelled = createMainHandlerHarness({
      service: {
        importFiles: async () => { importCalled += 1; }
      }
    });
    assert.deepEqual(
      await cancelled.handlers.get('duplicate-inbound-match:import-files')(cancelled.event),
      { status: 'cancelled' }
    );
    assert.equal(importCalled, 0);
    assert.equal(cancelled.calls.released, 0);

    const expectedError = Object.assign(new Error('导入校验失败'), {
      code: 'bad-import',
      detailLines: ['第 3 行 BizId 为空']
    });
    const failed = createMainHandlerHarness({
      showImportOpenDialog: async () => ({
        canceled: false,
        filePaths: [__filename, path.join(root, 'src', 'main.js')]
      }),
      service: {
        importFiles: async () => { throw expectedError; }
      }
    });
    assert.deepEqual(
      await failed.handlers.get('duplicate-inbound-match:import-files')(failed.event),
      {
        status: 'failed',
        code: 'bad-import',
        message: '导入校验失败',
        detailLines: ['第 3 行 BizId 为空']
      }
    );
    assert.equal(failed.calls.released, 1);

    const progress = createMainHandlerHarness({
      service: {
        run: async ({ onProgress }) => {
          onProgress({ message: '正在查询 MPT' });
          return { status: 'success' };
        }
      }
    });
    assert.deepEqual(
      await progress.handlers.get('duplicate-inbound-match:run')(progress.event),
      { status: 'success' }
    );
    assert.deepEqual(progress.calls.sent, [{
      channel: 'duplicate-inbound-match:run-progress',
      payload: { message: '正在查询 MPT' }
    }]);
    assert.equal(progress.calls.released, 1);

    let exportCalled = 0;
    const exportCancelled = createMainHandlerHarness({
      service: {
        buildDefaultFileName: () => '260715_重复入金召回邮件模板.xlsx',
        export: async () => { exportCalled += 1; }
      }
    });
    assert.deepEqual(
      await exportCancelled.handlers.get('duplicate-inbound-match:export')(exportCancelled.event),
      { status: 'cancelled' }
    );
    assert.equal(exportCalled, 0);
    assert.equal(exportCancelled.calls.released, 0);
  });

  test('startup未完成或active Hold时所有legacy入口fail closed且不打开文件选择器', async () => {
    const startupError = Object.assign(new Error('重复入金启动恢复门禁尚未完成'), {
      code: 'DUPLICATE_STARTUP_RECOVERY_UNAVAILABLE'
    });
    const blocked = createMainHandlerHarness({
      assertStartupAvailable() { throw startupError; }
    });
    await assert.rejects(
      () => blocked.handlers.get('duplicate-inbound-match:import-files')(blocked.event),
      (error) => error.code === 'DUPLICATE_STARTUP_RECOVERY_UNAVAILABLE'
    );
    assert.equal(blocked.calls.dialogs, 0);
    assert.deepEqual(
      await blocked.handlers.get('duplicate-inbound-match:session-status')(blocked.event),
      {
        status: 'failed',
        code: 'DUPLICATE_STARTUP_RECOVERY_UNAVAILABLE',
        message: '重复入金启动恢复门禁尚未完成',
        detailLines: []
      }
    );
    assert.deepEqual(
      await blocked.handlers.get('duplicate-inbound-match:run')(blocked.event),
      {
        status: 'failed',
        code: 'DUPLICATE_STARTUP_RECOVERY_UNAVAILABLE',
        message: '重复入金启动恢复门禁尚未完成',
        detailLines: []
      }
    );
    assert.equal(blocked.calls.released, 1, 'run获得业务锁后仍必须在service构造前由gate拒绝');
  });
});
