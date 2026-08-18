'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const rendererPreviews = fs.readFileSync(path.join(root, 'src/renderer-previews.js'), 'utf8');
const dialogs = fs.readFileSync(path.join(root, 'src/renderer-dialogs.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const generalStyles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const clearStyles = fs.readFileSync(path.join(root, 'src/styles-gemini-extra.css'), 'utf8');

test.describe('前置资金对账 UI / preload / IPC 接线', () => {
  test('页面包含完整控件、收敛 MPT 入口且 3.0.14 只展示缺网关账单', () => {
    const start = html.indexOf('id="preFundReconciliationModulePanel"');
    const end = html.indexOf('id="reconIdFixModulePanel"', start);
    assert.ok(start > 0 && end > start);
    const section = html.slice(start, end);
    for (const id of [
      'preFundReconciliationRunBtn',
      'preFundReconciliationImportBankBtn',
      'preFundReconciliationExportBtn',
      'preFundReconciliationScenarioSelect',
      'preFundReconciliationTempManagerBtn',
      'preFundReconciliationStatusBox'
    ]) {
      assert.ok(section.includes(`id="${id}"`), `缺少 #${id}`);
    }
    assert.match(section, /<option value="missing-gateway" selected>缺网关账单<\/option>/);
    assert.doesNotMatch(section, /缺渠道账单|missing-channel/);
    assert.doesNotMatch(section, /preFundReconciliationImportMptBtn|>导入账单文件<\/button>|>临时链接表管理<\/button>/);
    assert.match(section, /class="control-row"[\s\S]*class="cell left"[\s\S]*preFundReconciliationImportBankBtn[\s\S]*class="cell right"[\s\S]*pending-action-pair pre-fund-action-pair[\s\S]*pre-fund-scenario-slot[\s\S]*preFundReconciliationScenarioSelect[\s\S]*preFundReconciliationTempManagerBtn[^>]*>链接表管理<\/button>/);
    assert.match(section, /pre-fund-board-merged-row[\s\S]*pre-fund-merged-run[\s\S]*preFundReconciliationRunBtn[^>]*>开始运行<\/button>[\s\S]*pre-fund-merged-export[\s\S]*preFundReconciliationExportBtn[^>]*>导出文件<\/button>[\s\S]*pre-fund-merged-status[\s\S]*preFundReconciliationStatusBox/);
    assert.match(section, /id="preFundReconciliationStatusBox"[\s\S]*欢迎使用小助手/);
    assert.doesNotMatch(renderer, /preFundReconciliationImportMptBtn/);
  });

  test('五槽位结构与资金对账数据处理一致，状态框保持原跨行尺寸', () => {
    for (const styles of [generalStyles, clearStyles]) {
      const start = styles.indexOf('#preFundReconciliationModulePanel .pre-fund-scenario-slot');
      const end = styles.indexOf('#preFundReconciliationStatusBox .status-box-text', start);
      assert.ok(start > 0 && end > start);
      const layout = styles.slice(start, end);
      assert.match(layout, /\.pre-fund-scenario-slot\s*\{[\s\S]*position:\s*relative[\s\S]*flex:\s*1 1 0/);
      assert.match(layout, /\.pre-fund-scenario-label[\s\S]*position:\s*absolute[\s\S]*top:\s*0[\s\S]*right:\s*calc\(100% \+ 8px\)[\s\S]*height:\s*48px[\s\S]*transform:\s*none/);
      assert.match(layout, /\.pre-fund-scenario-slot \.template-select[\s\S]*width:\s*100%[\s\S]*max-width:\s*100%/);
      assert.match(layout, /\.pre-fund-action-pair > :first-child\s*\{\s*transform:\s*translateX\(-14px\)/);
      assert.match(layout, /\.pre-fund-action-pair > :last-child\s*\{\s*transform:\s*translateX\(14px\)/);
      assert.match(layout, /\.pre-fund-board-merged-row[\s\S]*grid-template-rows:\s*auto 110px[\s\S]*row-gap:\s*18px/);
      assert.match(layout, /\.pre-fund-merged-run\s*\{\s*grid-column:\s*1;\s*grid-row:\s*1;/);
      assert.match(layout, /\.pre-fund-merged-export\s*\{\s*grid-column:\s*1;\s*grid-row:\s*2;/);
      assert.match(layout, /\.pre-fund-merged-status\s*\{\s*grid-column:\s*2;\s*grid-row:\s*1 \/ 3;/);
      assert.doesNotMatch(layout, /pre-fund-top-controls|pre-fund-merged-manager/);
    }
    assert.match(generalStyles, /\.status-box\s*\{[\s\S]*?width:\s*280px/);
    assert.match(clearStyles, /\.bank-statement-board \.status-box,[\s\S]*?max-width:\s*360px/);
  });

  test('renderer 注册模块、状态刷新、按钮处理和事件解绑', () => {
    assert.match(renderer, /preFundReconciliation:\s*\{\s*id:\s*'pre-fund-reconciliation'/);
    for (const functionName of [
      'refreshPreFundReconciliationStatus',
      'handlePreFundImportBank',
      'handlePreFundImportMpt',
      'handlePreFundRun',
      'handlePreFundExport',
      'applyPreFundReconciliationPanelPreviewState'
    ]) {
      assert.ok(renderer.includes(`function ${functionName}(`), `缺少 ${functionName}`);
    }
    assert.ok(renderer.includes("info.previewModal === 'pre-fund-reconciliation-panel'"));
    assert.ok(renderer.includes("info.previewModal === 'pre-fund-temp-manager'"));
    assert.ok(renderer.includes("info.previewModal === 'pre-fund-temp-delete-range'"));
    assert.ok(rendererPreviews.includes('function applyPreFundTempManagerPreviewState('));
    assert.ok(rendererPreviews.includes('function applyPreFundTempImportFailurePreviewState('));
    assert.ok(rendererPreviews.includes('function applyPreFundTempDeleteRangePreviewState('));
    assert.ok(renderer.includes("if (typeof unsubscribe === 'function') unsubscribe();"));
    assert.match(renderer, /showPreFundFailure[\s\S]*escapeHtml\(message\)/);
    const uiStart = renderer.indexOf('function updatePreFundReconciliationUi(');
    const uiEnd = renderer.indexOf('async function refreshPreFundReconciliationStatus(', uiStart);
    const updateUi = renderer.slice(uiStart, uiEnd);
    assert.match(updateUi, /let text = '欢迎使用小助手'/);
    assert.match(updateUi, /if \(run\.unavailable\)[\s\S]*unavailableMessage/);
    assert.match(updateUi, /bankRuleUnmappedRows[\s\S]*bankRuleDirectionMismatchRows[\s\S]*bankRuleNoGatewayTradeTypeRows/);
    assert.doesNotMatch(updateUi, /请导入银行对账单|tempBatchCount > 0 \|\| linkedRowCount > 0/);
  });

  test('preload 的 12 个 invoke 与 3 个进度通道和 main handler 对齐', () => {
    const invokeChannels = [
      'pre-fund-reconciliation:import-bank',
      'pre-fund-reconciliation:import-mpt',
      'pre-fund-reconciliation:mpt-errors:export',
      'pre-fund-reconciliation:mpt-errors:repair',
      'pre-fund-reconciliation:temp:list',
      'pre-fund-reconciliation:temp:delete',
      'pre-fund-reconciliation:temp:count-by-date-range',
      'pre-fund-reconciliation:temp:delete-by-date-range',
      'pre-fund-reconciliation:temp:clear',
      'pre-fund-reconciliation:session-status',
      'pre-fund-reconciliation:run',
      'pre-fund-reconciliation:export'
    ];
    for (const channel of invokeChannels) {
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload 缺少 ${channel}`);
      assert.ok(main.includes(`'${channel}'`), `main 缺少 ${channel}`);
    }
    assert.match(main, /temp:count-by-date-range'[\s\S]*countTempByDateRange\(payload\)/);
    assert.match(main, /temp:delete-by-date-range'[\s\S]*tryAcquireBankStatementOpLock\('pre-fund-delete-temp-by-date-range'\)[\s\S]*deleteTempByDateRange\(payload\)/);
    assert.match(main, /function schedulePreFundReconciliationStartupCleanup\(\)[\s\S]*getPreFundReconciliationService\(\)/);
    assert.match(main, /database\.init\(\);[\s\S]*schedulePreFundReconciliationStartupCleanup\(\)/);
    assert.match(preload, /countTempByDateRange:\s*\(start, end, sourceType\)[\s\S]*\{ start, end, sourceType \}/);
    assert.match(preload, /deleteTempByDateRange:\s*\(start, end, sourceType\)[\s\S]*\{ start, end, sourceType \}/);
    assert.match(preload, /exportMptErrors:\s*\(repairTokens\)[\s\S]*mpt-errors:export/);
    assert.match(preload, /repairMptErrors:\s*\(repairTokens\)[\s\S]*mpt-errors:repair/);
    assert.match(main, /mpt-errors:export'[\s\S]*dialog\.showSaveDialog[\s\S]*exportMptErrorData/);
    assert.match(main, /mpt-errors:repair'[\s\S]*retryMptImportFailures/);
    for (const channel of [
      'pre-fund-reconciliation:import-progress',
      'pre-fund-reconciliation:run-progress',
      'pre-fund-reconciliation:export-progress'
    ]) {
      assert.ok(preload.includes(`ipcRenderer.on('${channel}', wrapped)`));
      assert.ok(preload.includes(`ipcRenderer.removeListener('${channel}', wrapped)`));
      assert.ok(main.includes(`'${channel}'`));
    }
  });

  test('run/export 精确血缘与 startup owner 顺序在 main seam 闭合', () => {
    const runStart = main.indexOf("trackedIpcHandle('pre-fund-reconciliation:run'");
    const exportStart = main.indexOf("trackedIpcHandle('pre-fund-reconciliation:export'");
    const exportEnd = main.indexOf('\nfunction getDuplicateInboundMatchService()', exportStart);
    assert.ok(runStart >= 0 && exportStart > runStart && exportEnd > exportStart);
    const runHandler = main.slice(runStart, exportStart);
    const exportHandler = main.slice(exportStart, exportEnd);
    assert.match(runHandler, /const taskRunId = randomUUID\(\)/);
    assert.match(runHandler, /const plan = service\.prepareRunLineage\(\)/);
    assert.match(runHandler, /lineageIntents:\s*plan\.lineageIntents/);
    assert.match(runHandler, /expectedDatasets:\s*plan\.expectedDatasets/);
    assert.match(runHandler, /taskRunId:\s*taskContext\.operationContext\.taskRunId/);
    assert.match(runHandler, /terminalStatus === 'succeeded'[\s\S]*acknowledgeRunByTaskRun/);

    assert.match(exportHandler, /const runLocator = service\.lastRunLocator\(\)/);
    assert.match(exportHandler, /lineageIntents:\s*\[service\.lastRunLineageIntent\(\)\]/);
    assert.match(exportHandler, /flowPlan:\s*service\.lastRunBusinessFlowPlan\(runLocator\)/);
    assert.match(exportHandler, /filePlan:[\s\S]*outputs:\s*plan\.map/);
    assert.match(exportHandler, /taskContext\.fileEvidence\.filePlan\.outputs/);
    assert.match(exportHandler, /runLocator:\s*prepared\.runLocator/);
    assert.match(exportHandler, /taskContext\.settleArtifacts\(/);
    assert.doesNotMatch(
      exportHandler.slice(exportHandler.indexOf('async execute')),
      /service\.lastRun(?:Locator)?\(/,
      'execute 不得按后来 lastRun/latest 重选业务 run'
    );

    const pendingOwner = main.indexOf("ownerName: 'Pending runs'");
    const bizOwner = main.indexOf("ownerName: 'Biz OP runs'");
    const preFundOwner = main.indexOf("ownerName: 'Pre-fund runs'");
    const positionOwner = main.indexOf("ownerName: 'Position'");
    assert.ok(pendingOwner < bizOwner && bizOwner < preFundOwner && preFundOwner < positionOwner);
    const archiveAwait = main.indexOf('if (archiveCenterInitializationPromise) await archiveCenterInitializationPromise;');
    const cleanupSchedule = main.indexOf('schedulePreFundReconciliationStartupCleanup();', archiveAwait);
    assert.ok(archiveAwait >= 0 && cleanupSchedule > archiveAwait);
  });

  test('临时链接表首页复用标准链接表结构，且不提供账户映射', () => {
    assert.ok(dialogs.includes('function createPreFundTempManagerDialog('));
    assert.match(dialogs, /createPreFundTempManagerDialog,/);
    const start = dialogs.indexOf('function createPreFundTempManagerDialog(');
    const end = dialogs.indexOf('function createPreFundTempDeleteRangeDialog(', start);
    assert.ok(start > 0 && end > start);
    const manager = dialogs.slice(start, end);
    assert.match(manager, /manager-card linked-table-manager-card/);
    assert.match(manager, /dialog-title">链接表管理<\/div>/);
    assert.doesNotMatch(manager, /dialog-title">临时链接表管理<\/div>/);
    assert.match(manager, /data-table linked-table-table/);
    assert.match(manager, /表库名[\s\S]*数据日期范围[\s\S]*表库更新日期/);
    assert.match(dialogs, /临时中台入金网关账单表库/);
    assert.match(dialogs, /临时中台出金网关账单表库/);
    assert.match(manager, /data-source-type="\$\{table\.sourceType\}"/);
    assert.match(manager, /batch\.sourceType === table\.sourceType/);
    assert.match(manager, /data-action="delete">删除/);
    assert.match(manager, /data-action="import">导入/);
    assert.match(manager, /data-action="exit">退出/);
    assert.doesNotMatch(manager, /account-mapping|账户映射管理/);
    assert.match(manager, /onImport\(\{ showFailures: false \}\)/);
    assert.match(manager, /canRepair === true[\s\S]*repairToken/);
    assert.match(manager, /confirmText: '删除错误数据并重跑'/);
    assert.match(manager, /middleText: '导出错误数据'/);
    assert.match(manager, /cancelText: '关闭'/);
    assert.match(manager, /repairMptErrors\(repairTokens\)/);
    assert.match(manager, /exportMptErrors\(repairTokens\)/);
    assert.match(manager, /exported\.warnings[\s\S]*warningHtml/);
    assert.match(manager, /hasRetryableFailure[\s\S]*showImportResult\(repaired\)/);
    assert.match(manager, /repairable\.length === 0[\s\S]*createAlertDialog/);
  });

  test('临时删除框复用标准删除框结构，并改走临时表日期范围接口', () => {
    const start = dialogs.indexOf('function createPreFundTempDeleteRangeDialog(');
    const end = dialogs.indexOf('function createLinkedTableManagerDialog(', start);
    assert.ok(start > 0 && end > start);
    const deleteDialog = dialogs.slice(start, end);
    assert.match(deleteDialog, /modal-card linked-table-delete-range-card/);
    assert.match(dialogs, /sourceType:\s*'MPT_INBOUND_GATEWAY'[\s\S]*label:\s*'临时中台入金网关账单'/);
    assert.match(dialogs, /sourceType:\s*'MPT_OUTBOUND_GATEWAY'[\s\S]*label:\s*'临时中台出金网关账单'/);
    assert.match(deleteDialog, /目标表[\s\S]*PRE_FUND_TEMP_TABLES\.map[\s\S]*起始日期[\s\S]*结束日期/);
    assert.match(deleteDialog, /data-action="confirm-delete" disabled>删除/);
    assert.match(deleteDialog, /data-action="cancel">取消/);
    assert.ok(deleteDialog.includes('preFundReconciliation.countTempByDateRange'));
    assert.ok(deleteDialog.includes('preFundReconciliation.deleteTempByDateRange'));
    assert.match(deleteDialog, /countTempByDateRange\([\s\S]*selectedTable\(\)\.sourceType/);
    assert.match(deleteDialog, /deleteTempByDateRange\([\s\S]*targetTable\.sourceType/);
    assert.doesNotMatch(deleteDialog, /删除选中批次|全部清空|preFundReconciliation\.clearTemp/);
  });

  test('临时链接表按钮把既有 MPT 导入处理传入管理弹窗', () => {
    assert.match(renderer, /createPreFundTempManagerDialog\(\{[\s\S]*onImport:\s*handlePreFundImportMpt[\s\S]*\}\)/);
    assert.match(renderer, /handlePreFundImportMpt\(\{ showFailures = true \} = \{\}\)/);
  });
});
