'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
const positionRenderer = fs.readFileSync(
  path.join(ROOT, 'src', 'renderer-position-reconciliation.js'),
  'utf8'
);
const rendererDialogs = fs.readFileSync(path.join(ROOT, 'src', 'renderer-dialogs.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const previews = fs.readFileSync(path.join(ROOT, 'src', 'renderer-previews.js'), 'utf8');
const mainProcess = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const operationLifecycle = fs.readFileSync(
  path.join(
    ROOT,
    'src',
    'main-process',
    'position-reconciliation',
    'operation-lifecycle.js'
  ),
  'utf8'
);

function extractPanel() {
  const start = html.indexOf('id="positionReconciliationModulePanel"');
  assert.ok(start >= 0, '应存在平盘对账模块面板');
  const sectionStart = html.lastIndexOf('<section', start);
  const nextSection = html.indexOf('<section', start + 1);
  assert.ok(sectionStart >= 0 && nextSection > start, '应能提取平盘对账模块 section');
  return html.slice(sectionStart, nextSection);
}

const panel = extractPanel();

function loadRendererModule() {
  const window = {};
  vm.runInNewContext(positionRenderer, { window });
  return window.__positionReconciliation;
}

test.describe('v3.1.0 平盘对账数据处理前端契约', () => {
  test('模块 ID、显示名和面板显隐接线完整', () => {
    assert.match(renderer, /positionReconciliation:\s*\{\s*id:\s*'position-reconciliation-process',\s*name:\s*'平盘对账数据处理'/);
    assert.match(renderer, /positionReconciliationModulePanel\.hidden\s*=\s*moduleId\s*!==\s*MODULES\.positionReconciliation\.id/);
    assert.match(previews, /setCurrentModule\(MODULES\.positionReconciliation\.id\)/);
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-panel'"));
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-data-manager'"));
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-differences'"));
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-linked-manager'"));
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-raw-sources'"));
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-source-delete'"));
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-run-scope'"));
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-result'"));
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-account-mapping'"));
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-import-progress'"));
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-import-stopping'"));
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-import-committing'"));
  });

  test('功能下拉固定三项并默认选中第一项', () => {
    assert.match(panel, /<label[^>]*>功能<\/label>/);
    const options = Array.from(panel.matchAll(/<option value="([^"]+)"([^>]*)>([^<]+)<\/option>/g))
      .map((match) => ({ value: match[1], attrs: match[2], label: match[3] }));
    assert.deepEqual(options, [
      { value: 'position-fund-nature-check', attrs: ' selected', label: '平盘资金性质校验' },
      { value: 'position-data-info-backfill', attrs: '', label: '平盘对账数据处理' },
      { value: 'position-order-writeoff', attrs: '', label: '平盘订单销账处理' }
    ]);
  });

  test('五个按钮文本和原槽位结构固定，页面不显示场景标签', () => {
    for (const [id, label] of [
      ['positionReconciliationRunBtn', '开始运行'],
      ['positionReconciliationTableManagerBtn', '对账数据管理'],
      ['positionReconciliationLinkedTableManagerBtn', '链接表管理'],
      ['positionReconciliationConfigBtn', '对账配置管理'],
      ['positionReconciliationExportBtn', '结果确认']
    ]) {
      assert.match(panel, new RegExp(`id="${id}"[^>]*>${label}<\\/button>`));
    }
    assert.ok(panel.includes('position-reconciliation-empty-label'), '第二行应保留空标签轨道');
    assert.ok(!/>\s*场景\s*</.test(panel), '新模块不得显示“场景”标签');
  });

  test('仅开始运行使用蓝色主按钮，其余四个入口使用白色次按钮', () => {
    assert.match(panel, /id="positionReconciliationRunBtn" class="primary-btn"/);
    for (const id of [
      'positionReconciliationTableManagerBtn',
      'positionReconciliationLinkedTableManagerBtn',
      'positionReconciliationConfigBtn',
      'positionReconciliationExportBtn'
    ]) {
      assert.match(panel, new RegExp(`id="${id}" class="secondary-btn"`));
    }
  });

  test('开始运行和结果确认保持对账单修复的 140px 按钮宽度', () => {
    for (const styles of [
      fs.readFileSync(path.join(ROOT, 'src', 'styles-gemini-extra.css'), 'utf8'),
      fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8')
    ]) {
      assert.match(
        styles,
        /\.position-reconciliation-board #positionReconciliationRunBtn,\s*\.position-reconciliation-board #positionReconciliationExportBtn\s*\{[\s\S]*?width:\s*140px;[\s\S]*?min-width:\s*140px;/
      );
    }
  });

  test('状态框初始文案和统一内容层完整', () => {
    assert.ok(panel.includes('id="positionReconciliationStatusBox"'));
    assert.ok(panel.includes('class="status-box-content"'));
    assert.ok(panel.includes('class="status-spark"'));
    assert.match(panel, /class="status-box-text">欢迎使用小助手<\/span>/);
  });

  test('SQLite UTC 更新时间按本机时区转换后再显示日期', () => {
    const module = loadRendererModule();
    const value = '2026-07-25 23:30:00';
    const date = new Date('2026-07-25T23:30:00Z');
    const pad = (number) => String(number).padStart(2, '0');
    const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    assert.equal(module.formatUpdatedDate(value), expected);
  });

  test('主进程取消状态和兼容错误码都不当作导入失败', () => {
    const module = loadRendererModule();
    assert.equal(module.isImportCancelledResult({ status: 'cancelled' }), true);
    assert.equal(module.isImportCancelledResult({
      status: 'failed',
      code: 'position-import-cancelled'
    }), true);
    assert.equal(module.isImportCancelledResult({
      status: 'failed',
      code: 'position-write-failed'
    }), false);
    assert.match(positionRenderer, /if \(isImportCancelledResult\(applied\)\) return;/);
    assert.match(
      positionRenderer,
      /if \(isImportCancelledResult\(applied\)\) \{[\s\S]*?item\.status = 'cancelled';[\s\S]*?item\.message = '已取消替换';/
    );
  });

  test('独立控制器接通导入、管理、运行、导出、回导和确认，非一期功能继续占位', () => {
    assert.ok(
      html.indexOf('./src/renderer-position-reconciliation.js') < html.indexOf('./src/renderer.js'),
      '平盘控制器必须先于 renderer.js 加载'
    );
    assert.match(renderer, /createPositionReconciliationUI\(\{/);
    assert.match(renderer, /positionReconciliationUI\) await positionReconciliationUI\.initialize\(\)/);
    assert.match(positionRenderer, /api\.prepareBankImport\(\)/);
    assert.match(positionRenderer, /api\.prepareSourceImport\(\)/);
    assert.match(positionRenderer, /api\.run\(selection\)/);
    assert.match(positionRenderer, /api\.exportRun\(\{\s*runId,\s*differencesOnly,/);
    assert.match(positionRenderer, /api\.importRunResult\(runId\)/);
    assert.match(positionRenderer, /api\.confirmRun\(runId\)/);
    assert.match(positionRenderer, /confirmButton\.disabled\s*=\s*!pending\.canExport/);
    assert.match(positionRenderer, /await exportRun\(targetRunId\)\) confirmButton\.disabled = false/);
    assert.match(positionRenderer, /await importRunResult\(targetRunId\)\)[\s\S]*?await openResultDialog\(targetRunId\)/);
    assert.match(positionRenderer, /当前功能将在后续版本开放/);
  });

  test('主页面结果确认入口仅打开结果页，结果页仍保留独立导出文件操作', () => {
    assert.match(
      positionRenderer,
      /exportBtn\.addEventListener\('click',\s*\(\)\s*=>\s*openResultDialog\(\)\)/
    );
    assert.match(positionRenderer, /const exportButton = makeButton\('导出文件'\)/);
    assert.match(positionRenderer, /<span>不适用<\/span><strong>\$\{Number\(summary\.notApplicableRows\) \|\| 0\}<\/strong>/);
    assert.match(positionRenderer, /<span>人工修改<\/span><strong>\$\{Number\(summary\.manualModifiedRows\) \|\| 0\}<\/strong>/);
    assert.match(
      positionRenderer,
      /未解决差异确认后仅保留人工结论，不会认领或消费链接来源/
    );
  });

  test('管理按钮不得把 click 事件误当成 preview 数据', () => {
    assert.match(
      positionRenderer,
      /dataManagerBtn\.addEventListener\('click',\s*\(\)\s*=>\s*openDataManager\(\)\)/
    );
    assert.match(
      positionRenderer,
      /linkedManagerBtn\.addEventListener\('click',\s*\(\)\s*=>\s*openLinkedManager\(\)\)/
    );
    assert.doesNotMatch(
      positionRenderer,
      /dataManagerBtn\.addEventListener\('click',\s*openDataManager\)/
    );
    assert.doesNotMatch(
      positionRenderer,
      /linkedManagerBtn\.addEventListener\('click',\s*openLinkedManager\)/
    );
  });

  test('对账数据管理的导入为蓝色、返回为白色，归档空提示返回管理页', () => {
    assert.match(positionRenderer, /makeButton\('导入',\s*\{\s*primary:\s*true\s*\}\)/);
    assert.match(positionRenderer, /const back = makeButton\('返回'\)/);
    assert.match(positionRenderer, /archive\.addEventListener\('click',\s*showArchiveUnavailable\)/);
    assert.match(
      positionRenderer,
      /confirmText:\s*'返回',[\s\S]*?confirmSecondary:\s*true,[\s\S]*?closeOnConfirm:\s*false/
    );
    assert.match(positionRenderer, /modalRoot\.appendChild\(overlay\)/);
    assert.match(rendererDialogs, /confirmSecondary \? 'secondary-btn small' : 'primary-btn small'/);
    assert.match(rendererDialogs, /if \(closeOnConfirm\) closeModal\(\);\s*else overlay\.remove\(\);/);
  });

  test('差异数据把功能和月份移到表格上方并按最新月份单选过滤', () => {
    const start = positionRenderer.indexOf('const allRows = Array.isArray(result.differences)');
    const end = positionRenderer.indexOf("pane.querySelectorAll('[data-diff-run]')", start);
    const differencePane = positionRenderer.slice(start, end);
    assert.ok(start >= 0 && end > start, '应能提取差异数据页面实现');
    assert.match(
      differencePane,
      /position-difference-filters[\s\S]*<span>功能<\/span>[\s\S]*positionDifferenceFunctionFilter[\s\S]*平盘资金性质校验[\s\S]*<span>月份<\/span>[\s\S]*positionDifferenceMonthFilter/
    );
    assert.match(
      differencePane,
      /positionDifferenceFunctionFilter" class="template-select main-panel-select-control"/
    );
    assert.match(
      differencePane,
      /positionDifferenceMonthFilter"[\s\S]*class="template-select main-panel-select-control"/
    );
    assert.match(
      differencePane,
      /sort\(\(leftMonth, rightMonth\) => rightMonth\.localeCompare\(leftMonth\)\)/
    );
    assert.match(differencePane, /differenceMonth = months\[0\] \|\| ''/);
    assert.match(
      differencePane,
      /const rows = differenceMonth[\s\S]*allRows\.filter\(\(row\) => row\.monthKey === differenceMonth\)[\s\S]*: \[\]/
    );
    assert.match(
      differencePane,
      /<thead><tr><th>银行渠道<\/th><th>运行批次<\/th><th>状态<\/th><th>差异数<\/th><th>操作<\/th><\/tr><\/thead>/
    );
    assert.doesNotMatch(differencePane, /<th>功能<\/th>|<th>月份<\/th>/);
    assert.match(differencePane, /<td>\$\{escapeHtml\(row\.bankChannel\)\}<\/td>/);
    assert.match(
      differencePane,
      /monthSelect\.addEventListener\('change',[\s\S]*differenceMonth = monthSelect\.value;[\s\S]*renderPane\(\)/
    );
    assert.match(differencePane, /data-diff-month="\$\{escapeHtml\(row\.monthKey\)\}"/);
    assert.match(differencePane, /data-diff-region="\$\{escapeHtml\(row\.region\)\}"/);
    assert.match(
      positionRenderer,
      /channels:\s*\[button\.dataset\.diffChannel\],[\s\S]*regions:\s*\[button\.dataset\.diffRegion\]/
    );
    assert.match(
      mainProcess,
      /regions:\s*Array\.isArray\(payload\.regions\)\s*\?\s*payload\.regions\s*:\s*\[\]/
    );
  });

  test('链接表管理去掉未归档和操作栏，底部导入导出返回样式及顺序固定', () => {
    const start = positionRenderer.indexOf('function openLinkedExportDialog');
    const end = positionRenderer.indexOf('function bindEvents', start);
    const linkedManager = positionRenderer.slice(start, end);
    assert.ok(start >= 0 && end > start, '应能提取链接表管理实现');
    assert.doesNotMatch(linkedManager, /position-linked-label|>未归档</);
    assert.match(linkedManager, /链接对账单名[\s\S]*数据日期范围[\s\S]*表库更新日期/);
    assert.doesNotMatch(linkedManager, /<th[^>]*>操作<\/th>|data-export-link/);
    assert.match(linkedManager, /formatMonthRange\(row\)/);
    assert.match(linkedManager, /formatUpdatedDate\(row\.updatedAt\)/);
    assert.match(positionRenderer, /return `\$\{dateMin \|\| '—'\} ~ \$\{dateMax \|\| '—'\}`/);
    assert.match(
      linkedManager,
      /const importButton = makeButton\('导入', \{ primary: true \}\);[\s\S]*const exportButton = makeButton\('导出'\);[\s\S]*const back = makeButton\('返回'\);[\s\S]*right\.append\(remove, importButton, exportButton, back\)/
    );
    assert.match(
      linkedManager,
      /exportButton\.addEventListener\('click', \(\) => openLinkedExportDialog\(result\.linked\)\)/
    );
    assert.match(
      linkedManager,
      /api\.exportLinked\(selected\.sourceType, selected\.tableName\)/
    );
  });

  test('链接原始表去掉行数和操作栏，底部蓝色导出选择目标表后调用原接口', () => {
    const start = positionRenderer.indexOf('function openRawExportDialog');
    const end = positionRenderer.indexOf('async function openSourceDeleteDialog', start);
    const rawManager = positionRenderer.slice(start, end);
    assert.ok(start >= 0 && end > start, '应能提取链接原始表页面实现');
    assert.match(rawManager, /原始表名[\s\S]*日期范围[\s\S]*更新时间/);
    assert.doesNotMatch(rawManager, /<th[^>]*>行数<\/th>|<th[^>]*>操作<\/th>|data-export-raw/);
    assert.match(
      rawManager,
      /const exportButton = makeButton\('导出', \{ primary: true \}\);[\s\S]*const back = makeButton\('返回'\);[\s\S]*right\.append\(exportButton, back\)/
    );
    assert.doesNotMatch(rawManager, /const importButton = makeButton\('导入'\)/);
    assert.match(
      rawManager,
      /exportButton\.addEventListener\('click', \(\) => openRawExportDialog\(result\.raw\)\)/
    );
    assert.match(
      rawManager,
      /api\.exportRaw\(selected\.sourceType, selected\.tableName\)/
    );
    assert.match(positionRenderer, /function previewRawSourceDialog\(\)/);
    assert.match(positionRenderer, /function previewSourceDeleteDialog\(\)/);
    assert.match(positionRenderer, /function previewRunScopeDialog\(\)/);
  });

  test('链接原始表导入失败时展示文件级错误及 detailLines', () => {
    assert.match(
      positionRenderer,
      /const details = Array\.isArray\(item\.detailLines\)[\s\S]*?details\.join\('<br>'\)/
    );
    assert.match(
      positionRenderer,
      /showAlert\(summary \|\| failureDetailsHtml\(result, '链接原始表导入失败'\), \{\s*html:\s*true\s*\}\)/
    );
    assert.match(positionRenderer, /item\.detailLines = applied && Array\.isArray\(applied\.detailLines\)/);
    assert.match(
      positionRenderer,
      /showAlert\(failureDetailsHtml\(applied, item\.message\), \{ html: true \}\)/
    );
  });

  test('银行导入准备和写入失败时展示已转义的 detailLines', () => {
    assert.match(
      positionRenderer,
      /function failureDetailsHtml[\s\S]*?detailLines[\s\S]*?map\(escapeHtml\)[\s\S]*?details\.join\('<br>'\)/
    );
    assert.match(
      positionRenderer,
      /showAlert\(failureDetailsHtml\(result, '平盘银行对账单导入失败'\), \{ html: true \}\)/
    );
    assert.match(
      positionRenderer,
      /showAlert\(failureDetailsHtml\(applied, '平盘银行对账单写入失败'\), \{ html: true \}\)/
    );
  });

  test('preload 仅暴露平盘命名空间，不向 renderer 泄露 Electron IPC', () => {
    for (const method of [
      'status', 'dataManager', 'linkedManager', 'prepareBankImport', 'applyBankImport',
      'prepareSourceImport', 'applySourceImport', 'cancelSourceImport',
      'cancelActiveImport', 'onImportProgress', 'listMappings', 'saveMappings',
      'deleteBank', 'deleteSource', 'exportBank', 'exportLinked', 'exportRaw',
      'run', 'exportRun', 'importRunResult', 'confirmRun'
    ]) {
      assert.match(preload, new RegExp(`${method}:\\s*\\(`));
    }
    assert.doesNotMatch(positionRenderer, /ipcRenderer|require\(['"]electron['"]\)/);
  });

  test('百万级导入显示进度、支持取消，并在提交阶段锁定取消操作', () => {
    assert.match(positionRenderer, /function withImportProgress\(title, task, previewProgress = null\)/);
    assert.match(positionRenderer, /api\.onImportProgress\(updateProgress\)/);
    assert.match(positionRenderer, /api\.cancelActiveImport\(jobId\)/);
    assert.match(positionRenderer, /stage === 'committing'[\s\S]*cancel\.disabled = true/);
    assert.match(positionRenderer, /summarizing: '正在汇总并提交，无法取消'/);
    assert.match(
      positionRenderer,
      /result && result\.status === 'not-cancellable'[\s\S]*正在提交，无法取消/
    );
    assert.match(positionRenderer, /'preparing-apply': '正在准备写入索引'/);
    assert.match(positionRenderer, /stage === 'stopping' \|\| stage === 'force-terminating'/);
    assert.match(
      positionRenderer,
      /finally\s*\{[\s\S]*if \(typeof unsubscribe === 'function'\) unsubscribe\(\);[\s\S]*shell\.overlay\.remove\(\)/
    );
    assert.match(positionRenderer, /withImportProgress\(\s*'导入平盘银行对账单'/);
    assert.match(positionRenderer, /withImportProgress\(\s*'写入平盘银行对账单'/);
    assert.match(positionRenderer, /withImportProgress\(\s*'导入链接原始表'/);
    assert.match(positionRenderer, /withImportProgress\(\s*'替换清结算银行账户表'/);
    assert.match(preload, /position-reconciliation:import:cancel/);
    assert.match(preload, /position-reconciliation:import-progress/);
    assert.match(mainProcess, /position-reconciliation:import:cancel/);
    assert.match(mainProcess, /position-reconciliation:import-progress/);
  });

  test('主进程以主库 checkpoint 防止平盘侧库缺失或回滚后静默继续', () => {
    assert.match(
      mainProcess,
      /const expectedSideDbCheckpoint = database\.getSetting\(\s*POSITION_SIDE_DB_CHECKPOINT_SETTING\s*\)/
    );
    assert.match(
      mainProcess,
      /requireExistingSideDb:\s*Boolean\(expectedSideDbCheckpoint\)/
    );
    assert.match(mainProcess, /expectedSideDbCheckpoint,/);
    assert.match(mainProcess, /expectedPendingOperation:\s*pendingSideDbOperation/);
    assert.match(mainProcess, /initialSideDbCheckpoint,/);
    assert.match(mainProcess, /POSITION_SIDE_DB_BOOTSTRAP_SETTING/);
    assert.match(mainProcess, /POSITION_SIDE_DB_PENDING_SETTING/);
    assert.match(mainProcess, /positionReconciliationOperationContext\.run/);
    assert.match(
      mainProcess,
      /JSON\.stringify\(checkpoint\)/
    );
    assert.match(mainProcess, /channel\.startsWith\('position-reconciliation:'\)/);
    assert.match(mainProcess, /syncPositionReconciliationCheckpoint\(\)/);
  });

  test('平盘写操作独占执行，并在 checkpoint 同步前校验 token 与存档持久性', () => {
    assert.match(mainProcess, /if \(positionReconciliationOperationActive\)/);
    assert.match(mainProcess, /const unresolvedPending = database\.getSetting\(POSITION_SIDE_DB_PENDING_SETTING\)/);
    assert.match(mainProcess, /runPositionOperationLifecycle\(\{/);
    assert.match(operationLifecycle, /persistedPending\.operationToken !== operationToken/);
    assert.match(operationLifecycle, /persistedPending\.archiveState !== 'durable'/);
    assert.match(operationLifecycle, /pendingBeforeClear\.operationToken !== operationToken/);
    assert.match(mainProcess, /archiveCenterService\.persistOperationIntent\(\{/);
    assert.match(
      mainProcess,
      /const files = requirePositionPendingArchiveFiles\(pending\);[\s\S]*const archiveRequired = pending\.archiveRequired[\s\S]*positionArchiveIntentEvidence\(pending, currentCheckpoint\)/
    );
    assert.match(operationLifecycle, /requirePositionPendingArchiveFiles\(persistedPending\);/);
    assert.match(mainProcess, /businessState:\s*'running'/);
    assert.match(mainProcess, /function markPositionBusinessOutcome\(result\)/);
    assert.match(mainProcess, /positionBusinessStateForResult\(result, SUCCESS_STATUSES\)/);
    assert.match(operationLifecycle, /result && result\.archiveDeferred === true/);
    assert.match(operationLifecycle, /'awaiting-confirmation'/);
    assert.match(operationLifecycle, /const outputPublished = files\.some/);
    assert.match(operationLifecycle, /sourceSnapshotMatchesStat\(file\.beforeSnapshot, stat\)/);
    assert.match(operationLifecycle, /archiveResult && archiveResult\.handled === false/);
    assert.match(mainProcess, /settlePositionArchiveResult\(\{/);
    assert.match(mainProcess, /persistCurrentPositionArchiveIntentIfNeeded\(\)/);
    assert.match(operationLifecycle, /markDurable\(recoveryIntent \|\| archiveResult\)/);
    assert.match(
      operationLifecycle,
      /markDurable\(recoveryIntent \|\| archiveResult\);\s*await cleanup\(runtime\)/
    );
    assert.match(operationLifecycle, /archiveResult\.persistentRetryAvailable !== true/);
    assert.match(operationLifecycle, /markDurable\(archiveResult\);\s*await cleanup\(runtime\)/);
    assert.match(mainProcess, /code:\s*'archive-retry-registration-failed'/);
  });

  test('管理页侧库恢复失败时显示 detailLines，不只显示总标题', () => {
    for (const fallback of [
      '对账数据管理读取失败',
      '链接原始表读取失败',
      '链接表管理读取失败'
    ]) {
      assert.match(
        positionRenderer,
        new RegExp(`failureDetailsHtml\\(result, '${fallback}'\\)`)
      );
    }
  });

  test('差异导出携带汇总行范围，删除链接数据禁止空月份请求', () => {
    assert.match(positionRenderer, /differenceStatuses:\s*\[button\.dataset\.diffStatus\]/);
    assert.match(positionRenderer, /if \(!wholeTable && selectedMonths\.length === 0\)/);
    assert.match(positionRenderer, /api\.cancelSourceImport\(item\.token\)/);
  });

  test('平盘账户映射复用现有三列表格交互，并以嵌套弹窗保留链接表管理底层页面', () => {
    assert.match(positionRenderer, /createDialogShell\('账户映射管理'/);
    assert.match(positionRenderer, /中台调拨单账户号/);
    assert.match(positionRenderer, /清结算系统银行账号/);
    assert.match(positionRenderer, /执行操作/);
    assert.match(positionRenderer, /makeTextButton\('编辑'/);
    assert.match(positionRenderer, /makeTextButton\('删除'/);
    assert.match(positionRenderer, /makeTextButton\('新增'/);
    assert.match(positionRenderer, /makeButton\('完成', \{ primary: true \}\)/);
    assert.match(positionRenderer, /modalRoot\.appendChild\(shell\.overlay\)/);
  });

  test('共享 Payment 解析脚本先于 renderer-dialogs 加载', () => {
    assert.ok(
      html.indexOf('./src/shared/payment-big-accounts.js') < html.indexOf('./src/renderer-dialogs.js'),
      '共享解析器必须先加载'
    );
  });
});
