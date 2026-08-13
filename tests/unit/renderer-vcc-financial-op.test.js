'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'src/renderer.js'), 'utf8');
const moduleRenderer = fs.readFileSync(path.join(ROOT, 'src/renderer-vcc-financial-op.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const vccService = fs.readFileSync(path.join(ROOT, 'src/main-process/vcc-financial-op-service.js'), 'utf8');
const styles = fs.readFileSync(path.join(ROOT, 'src/styles-vcc-financial-op.css'), 'utf8');
const sharedStyles = fs.readFileSync(path.join(ROOT, 'src/styles-gemini-extra.css'), 'utf8');

function panelSource() {
  const start = html.indexOf('id="vccFinancialOpModulePanel"');
  const sectionStart = html.lastIndexOf('<section', start);
  const nextSection = html.indexOf('<section', start + 1);
  assert.ok(start >= 0 && sectionStart >= 0 && nextSection > start);
  return html.slice(sectionStart, nextSection);
}

test.describe('v3.1.6 VCC财务OP校验前端契约', () => {
  test('模块注册、脚本加载顺序和主面板四个动作完整', () => {
    const panel = panelSource();
    assert.match(renderer, /vccFinancialOp:\s*\{\s*id:\s*'vcc-financial-op',\s*name:\s*'VCC财务OP校验'/);
    assert.match(renderer, /vccFinancialOpModulePanel\.hidden\s*=\s*moduleId\s*!==\s*MODULES\.vccFinancialOp\.id/);
    assert.ok(
      html.indexOf('./src/renderer-vcc-financial-op.js') < html.indexOf('./src/renderer.js'),
      '模块控制器必须先于 renderer.js 加载'
    );
    assert.ok(
      html.indexOf('./src/shared/vcc-financial-op-difference.js')
        < html.indexOf('./src/renderer-vcc-financial-op.js'),
      '生效差异共享判定必须先于 VCC renderer 加载'
    );
    assert.match(html, /href="\.\/src\/styles-vcc-financial-op\.css"/);
    for (const [id, label] of [
      ['vccFinancialOpImportBtn', '导入文件'],
      ['vccFinancialOpRunBtn', '开始运行'],
      ['vccFinancialOpExportBtn', '导出校验结果表'],
      ['vccFinancialOpDataManagerBtn', '数据管理']
    ]) {
      assert.match(panel, new RegExp(`id="${id}"[^>]*>${label}<\\/button>`));
    }
    assert.match(panel, /id="vccFinancialOpRunBtn" class="primary-btn"/);
    assert.match(panel, /id="vccFinancialOpImportBtn" class="secondary-btn"/);
    assert.match(panel, /id="vccFinancialOpExportBtn" class="secondary-btn"[^>]*disabled/);
    assert.match(panel, /id="vccFinancialOpDataManagerBtn" class="secondary-btn"/);
    assert.match(styles, /\.vcc-financial-op-board \.pending-action-pair > button\s*\{[\s\S]*width:\s*140px;[\s\S]*flex:\s*0 0 140px;/);
  });

  test('导入账期沿用业务OP日期弹窗的年月双下拉结构并对调确定取消按钮', () => {
    assert.match(moduleRenderer, /function chooseImportMonth\(\{ title, initial = '' \}\)/);
    assert.match(moduleRenderer, /const availableYears = \[currentYear - 1, currentYear, currentYear \+ 1\]/);
    assert.match(moduleRenderer, /const canReuseInitial = Boolean\(initialMatch && availableYears\.includes\(Number\(initialMatch\[1\]\)\)\)/);
    assert.match(moduleRenderer, /Array\.from\(\{ length: 12 \}/);
    assert.match(
      moduleRenderer,
      /class="monthly-balance-time-picker pending-import-month-picker biz-op-recon-date-picker vcc-fin-op-import-month-picker"[\s\S]*data-field="import-year" aria-label="年份"[\s\S]*data-field="import-month" aria-label="月份"/
    );
    assert.doesNotMatch(moduleRenderer, /data-field="import-day"|type="month"/);
    const actionsStart = moduleRenderer.indexOf('class="dialog-actions center vcc-fin-op-import-month-actions"');
    const actionsEnd = moduleRenderer.indexOf('</div>', actionsStart);
    const actions = moduleRenderer.slice(actionsStart, actionsEnd);
    assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
    assert.ok(
      actions.indexOf('data-action="confirm"') < actions.indexOf('data-action="cancel"'),
      '导入账期弹窗应在左侧展示确定、右侧展示取消'
    );
    assert.match(moduleRenderer, /chooseImportMonth\(\{ title: '选择导入账期', initial: state\.lastMonth \}\)/);
    assert.match(moduleRenderer, /openImportMonth\(\)\s*\{\s*return chooseImportMonth\(\{ title: '选择导入账期' \}\);/);
    assert.match(renderer, /'vcc-financial-op-import-month': Object\.freeze\(\{ method: 'openImportMonth', strategy: 'lifecycle' \}\)/);
    assert.match(renderer, /info\.previewModal\.startsWith\('vcc-financial-op-'\)[\s\S]*registerVccPreviewCaptureReadiness\(info\.previewModal\)/);
    assert.match(styles, /\.vcc-fin-op-import-month-dialog\s*\{[\s\S]*width:\s*min\(100%, 420px\);[\s\S]*padding:\s*24px 28px;/);
    assert.match(styles, /\.vcc-fin-op-import-month-dialog \.icon-close\s*\{[\s\S]*display:\s*none;/);
    assert.match(styles, /\.vcc-fin-op-import-month-actions\s*\{[\s\S]*justify-content:\s*center;/);
  });

  test('运行账期移除可见标签并将下拉框缩至整行四分之一且与标题左对齐', () => {
    const start = moduleRenderer.indexOf('function chooseMonth(');
    const end = moduleRenderer.indexOf('function assignSubjects', start);
    assert.ok(start >= 0 && end > start);
    const chooser = moduleRenderer.slice(start, end);
    assert.match(
      chooser,
      /<select class="vcc-fin-op-input vcc-fin-op-run-month-input" data-field="month" aria-label="月份账期"/
    );
    assert.match(chooser, /class="dialog-actions right vcc-fin-op-run-month-actions"/);
    assert.doesNotMatch(chooser, /<span>月份账期<\/span>|<label class="vcc-fin-op-field">/);
    assert.match(chooser, /<option value="">暂无账期<\/option>/);
    assert.match(
      styles,
      /\.vcc-fin-op-input\.vcc-fin-op-run-month-input\s*\{[\s\S]*width:\s*25%;[\s\S]*margin-left:\s*28px;/
    );
    assert.match(styles, /\.vcc-fin-op-dialog \.vcc-fin-op-run-month-actions\s*\{[\s\S]*margin-top:\s*15px;/);
    assert.match(moduleRenderer, /chooseExistingMonth\('选择运行账期'\)/);
    assert.match(moduleRenderer, /openRunMonth\(\)\s*\{[\s\S]*title: '选择运行账期'/);
    assert.match(renderer, /'vcc-financial-op-run-month': Object\.freeze\(\{ method: 'openRunMonth', strategy: 'lifecycle' \}\)/);
  });

  test('导入完成不弹导入记录框并将结果摘要写入主页面状态框', () => {
    const start = moduleRenderer.indexOf('function formatSystemOpSnapshotCount(');
    const end = moduleRenderer.indexOf('function setStatus(', start);
    assert.ok(start >= 0 && end > start);
    const formatter = Function(
      'formatInteger',
      'CURRENCIES',
      `'use strict'; ${moduleRenderer.slice(start, end)}; return buildImportCompletionStatus;`
    )((value) => String(value), ['AUD', 'CAD', 'CNH', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'USD']);
    assert.deepEqual(
      formatter({
        targetMonth: '2026-06',
        records: [
          { status: 'success_with_skips', insertedCount: 10, skippedCount: 2 },
          { status: 'failed_validation', insertedCount: 0, skippedCount: 0 }
        ]
      }),
      {
        message: '2026-06 导入完成：新增 10 行，幂等跳过 2 行，待处理异常 1 条导入记录，详情见数据管理 → 校验原表',
        tone: 'warning'
      }
    );
    assert.deepEqual(
      formatter({ records: [{ status: 'success', insertedCount: 5, skippedCount: 0 }] }, '2026-05'),
      { message: '2026-05 导入完成：新增 5 行，幂等跳过 0 行', tone: 'success' }
    );
    assert.deepEqual(
      formatter({
        targetMonth: '2026-05',
        records: [{
          sourceType: 'system_op',
          status: 'success',
          insertedCount: 1,
          skippedCount: 0
        }]
      }),
      {
        message: '2026-05 导入完成：系统财务OP新增 9 行币种数据（1 个主体快照），幂等跳过 0 行币种数据（0 个主体快照）',
        tone: 'success'
      }
    );
    assert.deepEqual(
      formatter({
        targetMonth: '2026-05',
        records: [
          { sourceType: 'recharge_refund', status: 'success', insertedCount: 2, skippedCount: 1 },
          { sourceType: 'system_op', status: 'success', insertedCount: 1, skippedCount: 0 }
        ]
      }),
      {
        message: '2026-05 导入完成：明细新增 2 行，明细幂等跳过 1 行，系统财务OP新增 9 行币种数据（1 个主体快照），系统财务OP幂等跳过 0 行币种数据（0 个主体快照）',
        tone: 'success'
      }
    );
    assert.match(moduleRenderer, /isSystemOpSummary \? '新增币种数据' : '新增'/);
    assert.match(moduleRenderer, /formatSystemOpSnapshotCount\(value, true\)/);
    assert.doesNotMatch(moduleRenderer, /function showImportSummary|function importSummaryHtml|showImportSummary\(result\)/);
    assert.match(
      moduleRenderer,
      /const completion = buildImportCompletionStatus\(result, month\);\s*setStatus\(completion\.message, completion\.tone\);/
    );
    assert.match(
      moduleRenderer,
      /const detailLines = Array\.isArray\(picked\.detailLines\)[\s\S]*throw new Error\(\[picked\.message \|\| '原表识别失败', \.\.\.detailLines\]\.join\('\\n'\)\)/
    );
    assert.match(
      moduleRenderer,
      /const detailLines = result && Array\.isArray\(result\.detailLines\)[\s\S]*throw new Error\(\[result && result\.message \|\| '导入失败', \.\.\.detailLines\]\.join\('\\n'\)\)/
    );
    assert.match(
      main,
      /vccFinancialOp:import:apply[\s\S]*detailLines: error && Array\.isArray\(error\.detailLines\) \? error\.detailLines : \[\]/
    );
    assert.match(styles, /\.vcc-fin-op-message\s*\{[\s\S]*white-space:\s*pre-wrap;[\s\S]*overflow-wrap:\s*anywhere;/);
  });

  test('preload 和主进程覆盖导入、取消、计算、归档、管理删除及三类导出通道', () => {
    const channels = [
      'vccFinancialOp:import:pick-files',
      'vccFinancialOp:import:apply',
      'vccFinancialOp:task:cancel',
      'vccFinancialOp:run:calculate',
      'vccFinancialOp:opening:initialize',
      'vccFinancialOp:run:archive',
      'vccFinancialOp:run:adjustment-options',
      'vccFinancialOp:run:adjustment-add',
      'vccFinancialOp:run:archived-months',
      'vccFinancialOp:run:unarchive-preview',
      'vccFinancialOp:run:unarchive',
      'vccFinancialOp:imports:list-months',
      'vccFinancialOp:imports:list-records',
      'vccFinancialOp:imports:get-detail',
      'vccFinancialOp:imports:resolve',
      'vccFinancialOp:data-manager:overview',
      'vccFinancialOp:data-manager:delete-targets',
      'vccFinancialOp:data-manager:delete-preview',
      'vccFinancialOp:data-manager:delete',
      'vccFinancialOp:data-manager:export-preview',
      'vccFinancialOp:data-manager:export',
      'vccFinancialOp:run:get',
      'vccFinancialOp:run:latest-archived',
      'vccFinancialOp:export:result',
      'vccFinancialOp:export:import-audit'
    ];
    for (const channel of channels) {
      assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload 缺少 ${channel}`);
      assert.ok(main.includes(`'${channel}'`), `main 缺少 ${channel}`);
    }
    assert.match(main, /await vccFinancialOpService\.terminate\(\)/);
    assert.match(vccService, /return runWorker\('inspect', \{ filePaths \}\)/);
    assert.match(vccService, /return runWorker\('delete-data-target'/);
    for (const serviceCall of [
      'listArchivedResultMonths', 'previewUnarchive', 'listImportMonths',
      'listDeleteTargets', 'previewDataTargetDeletion', 'latestArchivedRun',
      'getArchivedRunByMonth'
    ]) {
      assert.match(main, new RegExp(`await [^\\n]*${serviceCall}\\(`));
    }
    assert.match(vccService, /readWorkerFactory = \(filename, options\) => new Worker\(filename, options\)/);
    assert.match(vccService, /taskGeneration !== capturedGeneration \|\| activeTask !== capturedTask/);
    assert.match(preload, /ipcRenderer\.on\('vccFinancialOp:operation:progress', listener\)/);
    assert.match(preload, /removeListener\('vccFinancialOp:operation:progress', listener\)/);
    assert.equal(
      (main.match(/sender\.send\('vccFinancialOp:operation:progress', progress\)/g) || []).length,
      2
    );
    assert.match(vccService, /function archive\(payload = \{\}, onProgress\)[\s\S]*VCC_MUTATION_OPERATIONS\.ARCHIVE_RESULT/);
    assert.match(vccService, /function addRunAdjustment\(payload = \{\}, onProgress\)[\s\S]*VCC_MUTATION_OPERATIONS\.ADD_ADJUSTMENT/);
    assert.doesNotMatch(vccService, /archiveRun\(|addRunAdjustmentToDb\(/);
    assert.doesNotMatch(main, /legacySourceRequest|service\.deleteDatasetData\(payload\)/);
    assert.match(
      vccService,
      /function deleteDatasetData\(payload = \{\}\) \{[\s\S]*?expectedPreviewToken: payload\.expectedPreviewToken,[\s\S]*?taskGeneration: payload\.taskGeneration[\s\S]*?\n  \}/
    );
    assert.match(preload, /ipcRenderer\.on\('vccFinancialOp:import:progress'/);
    assert.match(preload, /ipcRenderer\.removeListener\('vccFinancialOp:import:progress'/);
    assert.match(moduleRenderer, /elements\.importBtn\.textContent\s*=\s*state\.busyKind === 'import' \? '取消导入'/);
    assert.match(moduleRenderer, /setBusy\(true, 'import'\);\s*setStatus\('正在识别原表/);
    assert.match(moduleRenderer, /api\.cancelTask\(\)/);
    assert.match(main, /\{ \.\.\.result, runStatus: result\.status, status: 'success' \}/);

    const calculateStart = main.indexOf("trackedIpcHandle('vccFinancialOp:run:calculate'");
    const calculateEnd = main.indexOf("trackedIpcHandle('vccFinancialOp:opening:initialize'", calculateStart);
    const calculateHandler = main.slice(calculateStart, calculateEnd);
    assert.match(
      calculateHandler,
      /catch \(error\) \{\s*return vccFinancialOpErrorResult\(error\);\s*\}/,
      '计算 IPC 必须保留 worker 结构化错误和 auditFailure'
    );

    const resultExportStart = main.indexOf("trackedIpcHandle('vccFinancialOp:export:result'");
    const resultExportEnd = main.indexOf("trackedIpcHandle('vccFinancialOp:export:import-audit'", resultExportStart);
    const resultExportHandler = main.slice(resultExportStart, resultExportEnd);
    assert.match(
      resultExportHandler,
      /catch \(error\) \{\s*return vccFinancialOpErrorResult\(error\);\s*\}/,
      '结果导出 IPC 必须返回临时 fail-closed 闸的稳定 code 和上下文'
    );
  });

  test('数据管理标题和左侧导航沿用平盘对账数据管理契约', () => {
    assert.match(moduleRenderer, /title: '数据管理'/);
    assert.doesNotMatch(moduleRenderer, /title: 'VCC财务OP校验 · 数据管理'/);
    assert.match(moduleRenderer, /initialFocusSelector: '\[data-field="manager-month"\]:not\(:disabled\)'/);
    assert.match(moduleRenderer, /\[aria-current="page"\][^']*button:not\(\[data-action="close"\]\):not\(:disabled\)/);
    assert.match(moduleRenderer, /class="position-manager-layout vcc-fin-op-manager-layout"/);
    assert.match(moduleRenderer, /class="position-manager-nav vcc-fin-op-manager-nav"/);
    assert.match(moduleRenderer, /class="position-nav-item"[^>]*data-section="results"/);
    assert.match(moduleRenderer, /data-section="results">结果表<\/button>/);
    assert.match(moduleRenderer, /class="position-manager-pane vcc-fin-op-manager-pane"/);
    assert.match(moduleRenderer, /button\.classList\.toggle\('active', selected\)/);
    assert.match(moduleRenderer, /\{ results: '结果表', checks: '校验表', raw: '导入记录' \}/);
    assert.match(moduleRenderer, /<h3 data-role="manager-title">/);
    assert.match(moduleRenderer, /managerTitle\.textContent = titles\[section\]/);
    assert.doesNotMatch(moduleRenderer, /vcc-fin-op-manager-heading/);
    assert.match(styles, /\.vcc-fin-op-manager-toolbar\s*\{[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*space-between;/);
    assert.match(moduleRenderer, /const currentVersion = \+\+renderVersion;/);
    assert.match(moduleRenderer, /if \(currentVersion !== renderVersion\) return;/);
    assert.match(moduleRenderer, /row\.generatedAt \|\| row\.createdAt \|\| row\.archivedAt/);
    assert.match(sharedStyles, /\.position-manager-layout\s*\{[\s\S]*grid-template-columns:\s*156px minmax\(0, 1fr\);/);
    assert.match(sharedStyles, /\.position-manager-nav\s*\{[\s\S]*padding:\s*12px 8px;[\s\S]*background:\s*#f8f9fa;/);
    assert.match(sharedStyles, /\.position-nav-item\s*\{[\s\S]*height:\s*42px;[\s\S]*border-radius:\s*6px;/);
    assert.match(sharedStyles, /\.position-nav-item\.active\s*\{[\s\S]*background:\s*#e8f0fe;[\s\S]*font-weight:\s*600;/);
    assert.match(styles, /\.vcc-fin-op-manager-toolbar h3\s*\{[\s\S]*transform:\s*translateX\(11px\);/);
    assert.match(styles, /\.vcc-fin-op-manager-nav \.position-nav-item\s*\{[\s\S]*padding-left:\s*20px;/);
  });

  test('数据管理左侧解归档、右侧删除导出返回，删除页使用动态统一目标与 token', () => {
    assert.match(moduleRenderer, /class="dialog-actions split vcc-fin-op-manager-footer"[\s\S]*data-action="unarchive"[^>]*>正在读取归档…<\/button>[\s\S]*data-action="delete-dataset"[^>]*>删除<\/button>[\s\S]*data-action="export-dataset"[^>]*>导出<\/button>[\s\S]*data-action="return">返回<\/button>/);
    assert.match(moduleRenderer, /暂无已归档结果/);
    assert.match(moduleRenderer, /returnButton\.addEventListener\('click', modal\.close\)/);
    assert.match(moduleRenderer, /title: '删除数据'/);
    assert.match(moduleRenderer, /data-field="delete-target"/);
    assert.match(moduleRenderer, /data-field="delete-month"/);
    assert.ok(
      moduleRenderer.indexOf('data-field="delete-month"') < moduleRenderer.indexOf('data-field="delete-target"'),
      '删除页应在左侧展示月份账期、右侧展示目标表'
    );
    assert.match(moduleRenderer, /class="danger-btn small"[^>]*data-action="confirm-delete" disabled>删除<\/button>/);
    assert.match(moduleRenderer, /data-action="cancel">取消<\/button>/);
    for (const label of [
      'VCC充值清退明细',
      'VCC费用及换汇明细',
      'VCC通道明细',
      'VCC_移除归档Pending账单',
      '系统财务OP',
      '首月期初初始化数据',
      '财务OP校验结果表'
    ]) {
      assert.ok(moduleRenderer.includes(label), `删除目标表缺少 ${label}`);
    }
    assert.match(moduleRenderer, /api\.listDeleteTargets\(\{ targetMonth \}\)/);
    const deleteDialogSource = moduleRenderer.slice(
      moduleRenderer.indexOf('function openDatasetDeleteDialog('),
      moduleRenderer.indexOf('function openDatasetExportDialog(')
    );
    assert.doesNotMatch(deleteDialogSource, /api\.previewDataTargetDeletion/);
    assert.match(deleteDialogSource, /selectCachedDeletePreview\(currentTargets, targetType\)/);
    assert.match(deleteDialogSource, /targetSelect\.addEventListener\('change', \(\) => modal\.trackPreviewState\(applyCachedPreview\(\)\)\)/);
    assert.match(moduleRenderer, /api\.deleteDataTarget\(\{[\s\S]*expectedPreviewToken: latestPreview\.previewToken,[\s\S]*taskGeneration: latestPreview\.taskGeneration/);
    assert.doesNotMatch(moduleRenderer, /<option[^>]*disabled[^>]*>[^<]*(首月期初初始化数据|财务OP校验结果表)/);
    assert.match(moduleRenderer, /const currentVersion = \+\+previewVersion;/);
    assert.match(moduleRenderer, /if \(currentVersion !== previewVersion\) return;/);
    assert.match(moduleRenderer, /canClose: \(\) => !deleting/);
    assert.match(moduleRenderer, /setBusy\(true, 'delete'\)/);
    assert.match(moduleRenderer, /cancelButton\.disabled = true/);
    assert.match(moduleRenderer, /closeButton\.disabled = true/);
    assert.match(moduleRenderer, /let successMessage;/);
    assert.match(moduleRenderer, /数据管理刷新失败/);
    assert.match(moduleRenderer, /onDeleted: async \(result\)/);
    assert.match(styles, /\.vcc-fin-op-delete-dialog\s*\{[\s\S]*width:\s*min\(100%, 470px\);/);
    assert.match(styles, /\.vcc-fin-op-delete-form\s*\{[\s\S]*margin-left:\s*20px;[\s\S]*padding:\s*4px 8px 0;/);
    assert.match(styles, /\.vcc-fin-op-delete-fields\s*\{[\s\S]*grid-template-columns:\s*25% 40%;[\s\S]*column-gap:\s*10px;/);
    assert.match(styles, /\.vcc-fin-op-manager-shell\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;/);
    assert.match(moduleRenderer, /data-field="manager-month" disabled><option value="">正在读取…<\/option>/);
    assert.match(moduleRenderer, /vcc-fin-op-manager-skeleton/);
    assert.match(moduleRenderer, /modal\.trackPreviewState\(refreshManagerData\(\{ preferredMonth: initialMonth \}\)\)/);
    assert.match(moduleRenderer, /unarchiveButton\.textContent = loadingManagerData \? '正在读取归档…' : '解归档'/);
    assert.doesNotMatch(moduleRenderer, /async function openDataManager/);
    const managerSource = moduleRenderer.slice(
      moduleRenderer.indexOf('function openDataManager('),
      moduleRenderer.indexOf('async function initialize()')
    );
    assert.ok(
      managerSource.indexOf('const modal = mountDialog(')
        < managerSource.indexOf('await Promise.all([api.listImportMonths(), loadArchivedResultMonths()])'),
      '数据管理 shell 必须在任何后端 await 前挂载'
    );
  });

  test('删除 target 切换只读本次响应缓存并满足 50ms 结构预算', () => {
    const helperStart = moduleRenderer.indexOf('function selectCachedDeletePreview(');
    const helperEnd = moduleRenderer.indexOf('function formatAmount(', helperStart);
    const selectCachedDeletePreview = Function(
      `'use strict'; ${moduleRenderer.slice(helperStart, helperEnd)}; return selectCachedDeletePreview;`
    )();
    const targets = [
      'recharge_refund', 'fee_fx', 'channel', 'pending_archive_removal',
      'system_op', 'opening_initialization', 'result'
    ].map((targetType) => ({
      targetType,
      previewToken: `v2:${targetType}`
    }));
    const startedAt = performance.now();
    let selected = null;
    for (let index = 0; index < 1000; index += 1) {
      selected = selectCachedDeletePreview(targets, index % 2 === 0 ? 'recharge_refund' : 'result');
    }
    const elapsed = performance.now() - startedAt;
    assert.equal(selected.targetType, 'result');
    assert.ok(elapsed < 50, `1000 次缓存切换耗时 ${elapsed.toFixed(3)}ms`);
  });

  test('解归档复用年月选择器、强制降级警示，并只在 pre-critical 开放取消', () => {
    assert.match(moduleRenderer, /function createArchivedMonthPickerDialog\(/);
    assert.match(moduleRenderer, /title: actionLabel === '导出' \? '请选择要导出的月份' : '请选择月份'/);
    assert.match(moduleRenderer, /data-field="archive-year"[\s\S]*data-field="archive-month"/);
    assert.match(moduleRenderer, /sort\(\(left, right\) => right\.targetMonth\.localeCompare\(left\.targetMonth\)\)/);
    assert.match(moduleRenderer, /yearSelect\.addEventListener\('change',[\s\S]*renderMonths\(\);[\s\S]*requestPreviewRefresh\(\)/);
    assert.match(moduleRenderer, /monthSelect\.addEventListener\('change', requestPreviewRefresh\)/);
    assert.match(moduleRenderer, /waitForPreviewState[\s\S]*confirmDisabled: actionButton\.disabled === true/);
    assert.match(moduleRenderer, /result\.dependentMonths\.join\('、'\)/);
    assert.match(moduleRenderer, /Object\.hasOwn\(result, 'canExecute'\)/);
    assert.match(moduleRenderer, /Boolean\(result\.canUnarchive\)/);
    assert.match(moduleRenderer, /replaceEntries\(result\.months, entry\.targetMonth\)/);
    assert.match(moduleRenderer, /canClose: \(\) => !executing/);
    assert.match(moduleRenderer, /setExecutionLocked\(true\)/);
    assert.match(moduleRenderer, /actionButton\.disabled = locked \|\| !currentSelectionCanExecute/);
    assert.match(moduleRenderer, /actionLabel: '解归档'/);
    assert.doesNotMatch(
      moduleRenderer.slice(
        moduleRenderer.indexOf('async function openUnarchiveDialog('),
        moduleRenderer.indexOf('function openArchivedExportDialog(')
      ),
      /actionLabel: '删除'/
    );
    assert.match(moduleRenderer, /解归档后只能由 v3\.1\.9 及以上版本继续维护/);
    assert.match(moduleRenderer, /降级前必须恢复完整数据库备份/);
    assert.match(moduleRenderer, /data-field="archive-picker-confirm"/);
    assert.match(moduleRenderer, /confirmationSatisfied\(\)/);
    assert.match(moduleRenderer, /allowOperationCancel: true/);
    assert.match(moduleRenderer, /controls\.setCancellable\(progress\.cancellable === true\)/);
    assert.match(moduleRenderer, /await api\.cancelTask\(\)/);
    assert.match(moduleRenderer, /expectedPreviewToken: preview && preview\.previewToken/);
    assert.match(moduleRenderer, /taskGeneration: preview && preview\.taskGeneration/);
    assert.match(moduleRenderer, /catch \(error\) \{[\s\S]*\$\{entry\.targetMonth\} 解归档失败：[\s\S]*throw error/);
    assert.match(moduleRenderer, /await refreshArchivedState\(\)/);
    assert.match(moduleRenderer, /managerState\.section = 'results'/);
    assert.match(styles, /\.vcc-fin-op-archive-picker-fields\s*\{[\s\S]*grid-template-columns:/);
  });

  test('四类结果写操作呈现审计保全阶段并按 worker cancellable 控制取消', () => {
    assert.match(moduleRenderer, /'preserving-audit': '正在保全审计证据'/);
    const adjustmentSource = moduleRenderer.slice(
      moduleRenderer.indexOf('async function requestRunAdjustment('),
      moduleRenderer.indexOf('function confirmArchive(')
    );
    assert.match(adjustmentSource, /setAdjustmentCancellable\(progress\.cancellable === true\)/);
    assert.match(adjustmentSource, /await api\.cancelTask\(\)/);
    const archiveSource = moduleRenderer.slice(
      moduleRenderer.indexOf('function confirmArchive('),
      moduleRenderer.indexOf('async function chooseExistingMonth')
    );
    assert.match(archiveSource, /setReviewCancellable\(progress\.cancellable === true\)/);
    assert.match(archiveSource, /await api\.cancelTask\(\)/);
    const deleteSource = moduleRenderer.slice(
      moduleRenderer.indexOf('function openDatasetDeleteDialog('),
      moduleRenderer.indexOf('function openDatasetExportDialog(')
    );
    assert.match(deleteSource, /setDeleteCancellable\(progress\.cancellable === true\)/);
    assert.match(deleteSource, /await api\.cancelTask\(\)/);
  });

  test('解归档提交成功后刷新失败只告警关闭，不重新开放破坏性操作', async () => {
    const helperStart = moduleRenderer.indexOf('async function settleArchivedPickerCompletion(');
    const helperEnd = moduleRenderer.indexOf('function createArchivedMonthPickerDialog(', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart);
    const settleCompletion = Function(
      `'use strict'; ${moduleRenderer.slice(helperStart, helperEnd)}; return settleArchivedPickerCompletion;`
    )();
    const entry = { targetMonth: '2026-06' };
    const result = { status: 'success' };
    assert.equal(await settleCompletion(null, result, entry), null);
    let received = null;
    assert.equal(await settleCompletion(async (...args) => { received = args; }, result, entry), null);
    assert.deepEqual(received, [result, entry]);
    const refreshError = new Error('刷新异常');
    assert.equal(await settleCompletion(async () => { throw refreshError; }, result, entry), refreshError);

    const handlerStart = moduleRenderer.indexOf("actionButton.addEventListener('click', async () => {");
    const handlerEnd = moduleRenderer.indexOf('renderMonths(entries[0].targetMonth);', handlerStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
    const handler = moduleRenderer.slice(handlerStart, handlerEnd);
    assert.match(handler, /const execution = await runArchivedPickerExecution/);
    assert.match(handler, /execution\.outcome === 'cancelled'[\s\S]*execution\.outcome === 'error'/);
    assert.match(handler, /const completionError = await settleArchivedPickerCompletion[\s\S]*modal\.close\(\);[\s\S]*操作已成功但刷新失败/);
    const committedPath = handler.slice(handler.indexOf('const completionError'));
    assert.doesNotMatch(committedPath, /refreshPreview\(\)|setExecutionLocked\(false\)/);
  });

  test('归档月份 picker 可执行状态覆盖默认最新、空列表、保存取消与失败刷新后重试', async () => {
    const responseHelperStart = moduleRenderer.indexOf('function normalizeResponseDetailLines(');
    const responseHelperEnd = moduleRenderer.indexOf('async function requestRunAdjustment(', responseHelperStart);
    const helperStart = moduleRenderer.indexOf('function normalizeArchivedPickerEntries(');
    const helperEnd = moduleRenderer.indexOf('function createArchivedMonthPickerDialog(', helperStart);
    assert.ok(responseHelperStart >= 0 && responseHelperEnd > responseHelperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart);
    const helpers = Function(
      `'use strict'; ${moduleRenderer.slice(responseHelperStart, responseHelperEnd)} ${moduleRenderer.slice(helperStart, helperEnd)}; return { normalizeArchivedPickerEntries, responseFailure, runArchivedPickerExecution, archivedPickerExecutionErrorMessage };`
    )();
    assert.equal(helpers.normalizeArchivedPickerEntries([]).length, 0);
    assert.deepEqual(
      helpers.normalizeArchivedPickerEntries([
        { targetMonth: '2026-05' },
        { targetMonth: 'invalid' },
        { targetMonth: '2026-07' },
        { targetMonth: '2026-06' }
      ]).map((item) => item.targetMonth),
      ['2026-07', '2026-06', '2026-05']
    );

    let refreshCount = 0;
    const cancelled = await helpers.runArchivedPickerExecution({
      entry: { targetMonth: '2026-07' },
      preview: { canExecute: true },
      actionLabel: '导出',
      executeSelection: async () => ({ status: 'cancelled' }),
      refreshPreview: async () => { refreshCount += 1; return { ok: true, canExecute: true }; }
    });
    assert.equal(cancelled.outcome, 'cancelled');
    assert.equal(refreshCount, 1);
    const retryAfterCancel = await helpers.runArchivedPickerExecution({
      entry: { targetMonth: '2026-07' },
      preview: { canExecute: true },
      actionLabel: '导出',
      executeSelection: async () => ({ status: 'success', filePaths: ['retry.xlsx'] }),
      refreshPreview: async () => { refreshCount += 1; return { ok: true, canExecute: true }; }
    });
    assert.equal(retryAfterCancel.outcome, 'success');

    let refreshedMonth = '2026-06';
    const failed = await helpers.runArchivedPickerExecution({
      entry: { targetMonth: '2026-06' },
      preview: { canExecute: true },
      actionLabel: '导出',
      executeSelection: async () => { throw new Error('OS 保存失败'); },
      refreshPreview: async () => { refreshedMonth = '2026-05'; return { ok: true, canExecute: true }; }
    });
    assert.equal(failed.outcome, 'error');
    assert.equal(failed.error.message, 'OS 保存失败', '刷新条目后仍必须保留本次失败原因');
    assert.equal(refreshedMonth, '2026-05');
    assert.equal(helpers.archivedPickerExecutionErrorMessage({
      entry: { targetMonth: '2026-06' },
      actionLabel: '导出',
      error: failed.error,
      refreshError: null,
      currentMonth: refreshedMonth
    }), '2026-06 导出失败：OS 保存失败；月份列表已刷新并切至 2026-05，请确认后重试');
    const retryAfterFailure = await helpers.runArchivedPickerExecution({
      entry: { targetMonth: refreshedMonth },
      preview: { canExecute: true },
      actionLabel: '导出',
      executeSelection: async () => ({ status: 'success' }),
      refreshPreview: async () => ({ ok: true, canExecute: true })
    });
    assert.equal(retryAfterFailure.outcome, 'success');

    const returnedRefreshError = new Error('结构化刷新失败');
    const cancelledWithRefreshFailure = await helpers.runArchivedPickerExecution({
      entry: { targetMonth: '2026-05' },
      preview: { canExecute: true },
      actionLabel: '导出',
      executeSelection: async () => ({ status: 'cancelled' }),
      refreshPreview: async () => ({ ok: false, error: returnedRefreshError })
    });
    assert.equal(cancelledWithRefreshFailure.outcome, 'cancelled');
    assert.equal(cancelledWithRefreshFailure.refreshError, returnedRefreshError);

    const cancelledWithDisabledFreshState = await helpers.runArchivedPickerExecution({
      entry: { targetMonth: '2026-05' },
      preview: { canExecute: true },
      actionLabel: '导出',
      executeSelection: async () => ({ status: 'cancelled' }),
      refreshPreview: async () => ({ ok: true, canExecute: false })
    });
    assert.equal(cancelledWithDisabledFreshState.outcome, 'cancelled');
    assert.equal(cancelledWithDisabledFreshState.refreshError, null);
    assert.equal(cancelledWithDisabledFreshState.refreshResult.canExecute, false);

    const thrownRefreshError = new Error('刷新调用抛错');
    const failedWithRefreshThrow = await helpers.runArchivedPickerExecution({
      entry: { targetMonth: '2026-05' },
      preview: { canExecute: true },
      actionLabel: '导出',
      executeSelection: async () => { throw new Error('导出本身失败'); },
      refreshPreview: async () => { throw thrownRefreshError; }
    });
    assert.equal(failedWithRefreshThrow.outcome, 'error');
    assert.equal(failedWithRefreshThrow.error.message, '导出本身失败');
    assert.equal(failedWithRefreshThrow.refreshError, thrownRefreshError);

    const actualTemplatePath = '/actual/assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx';
    const api = {
      exportResult: async () => ({
        status: 'error',
        code: 'result-template-missing',
        message: '未找到结果模板',
        detailLines: ['', `  ${actualTemplatePath}  `, 42],
        stack: 'SENSITIVE_STACK_MUST_NOT_RENDER'
      })
    };
    const structuredFailure = await helpers.runArchivedPickerExecution({
      entry: { targetMonth: '2026-06' },
      preview: { canExecute: true },
      actionLabel: '导出',
      executeSelection: async (entry) => {
        const response = await api.exportResult({ targetMonth: entry.targetMonth });
        if (!response || response.status === 'error') {
          throw helpers.responseFailure(response, '导出失败');
        }
        return response;
      },
      refreshPreview: async () => ({ ok: true, canExecute: true })
    });
    assert.equal(structuredFailure.outcome, 'error');
    assert.equal(structuredFailure.error.code, 'result-template-missing');
    assert.equal(structuredFailure.error.message, '未找到结果模板');
    assert.deepEqual(structuredFailure.error.detailLines, [actualTemplatePath]);
    const structuredMessage = helpers.archivedPickerExecutionErrorMessage({
      entry: { targetMonth: '2026-06' },
      actionLabel: '导出',
      error: structuredFailure.error,
      refreshError: null,
      refreshResult: null,
      currentMonth: '2026-06'
    });
    assert.match(structuredMessage, /未找到结果模板/);
    assert.match(structuredMessage, new RegExp(actualTemplatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(structuredMessage, /SENSITIVE_STACK_MUST_NOT_RENDER/);
  });

  test('数据管理导出按账期和分组目标表预检，支持校验原表与校验表', () => {
    assert.match(moduleRenderer, /title: '导出数据'/);
    assert.match(moduleRenderer, /\['raw', '校验原表', SOURCE_LABELS\]/);
    assert.match(moduleRenderer, /\['check', '校验表', CHECK_TABLE_LABELS\]/);
    assert.match(moduleRenderer, /<optgroup label="\$\{groupLabel\}">/);
    assert.match(moduleRenderer, /data-field="export-month"/);
    assert.match(moduleRenderer, /data-field="export-target"/);
    assert.ok(
      moduleRenderer.indexOf('data-field="export-month"') < moduleRenderer.indexOf('data-field="export-target"'),
      '导出页应在左侧展示月份账期、右侧展示目标表'
    );
    assert.match(moduleRenderer, /api\.previewDatasetExport\(\{ targetMonth, sourceType, targetKind \}\)/);
    assert.match(moduleRenderer, /api\.exportDataset\(\{ targetMonth, sourceType, targetKind \}\)/);
    assert.match(moduleRenderer, /data-action="confirm-export" disabled>导出<\/button>/);
    assert.match(moduleRenderer, /canClose: \(\) => !exporting/);
    assert.match(moduleRenderer, /setBusy\(true, 'export-data'\)/);
    assert.match(styles, /\.vcc-fin-op-export-dialog\s*\{[\s\S]*width:\s*min\(100%, 680px\);/);
    assert.match(styles, /\.vcc-fin-op-export-dialog \.vcc-fin-op-delete-fields\s*\{[\s\S]*grid-template-columns:\s*25% minmax\(0, 1fr\);/);
    assert.match(moduleRenderer, /openExport\(\)\s*\{[\s\S]*openDatasetExportDialog/);
    assert.match(renderer, /'vcc-financial-op-export': Object\.freeze\(\{ method: 'openExport', strategy: 'state' \}\)/);
    for (const label of Object.values({
      recharge: 'VCC充值清退明细_校验表',
      fee: 'VCC费用及换汇明细_校验表',
      channel: 'VCC通道明细_校验表',
      pending: '移除归档Pending账单_校验表'
    })) assert.ok(moduleRenderer.includes(label), `校验表导出目标缺少 ${label}`);
  });

  test('有效原表删除后列表显示已删除，详情保留原导入状态和删除时间', () => {
    assert.match(vccService, /deleted:\s*'已删除'/);
    assert.match(vccService, /status:\s*deleted \? 'deleted' : originalStatus/);
    assert.match(vccService, /originalStatusText:/);
    assert.match(vccService, /datasetDeletedAt:/);
    assert.match(moduleRenderer, /if \(status === 'deleted'\) return 'deleted'/);
    assert.match(moduleRenderer, /已删除（原导入状态：\$\{summary\.originalStatusText \|\| '-'\}）/);
    assert.match(moduleRenderer, /原导入统计与审计明细继续保留/);
  });

  test('校验原表直接进入按单一月份筛选的七列导入记录', () => {
    assert.match(moduleRenderer, /<option value="">暂无已导入账期<\/option>/);
    assert.doesNotMatch(moduleRenderer, /全部月份/);
    assert.match(
      moduleRenderer,
      /<tr><th>账期<\/th><th>导入批次<\/th><th>原表类型<\/th><th>来源文件<\/th><th>导入时间<\/th><th>导入状态<\/th><th>操作<\/th><\/tr>/
    );
    assert.match(moduleRenderer, />查看导入明细<\/button>/);
    assert.match(moduleRenderer, /listImportRecords\(\{ yearMonth: month \}\)/);
  });

  test('导入详情保留四页签、双侧原始数据、筛选、导出和人工处置留痕', () => {
    for (const label of ['概览', '幂等跳过', '幂等冲突', '其他异常']) {
      assert.ok(moduleRenderer.includes(label), `缺少 ${label} 页签`);
    }
    assert.match(moduleRenderer, /<h4>本次导入<\/h4>/);
    assert.match(moduleRenderer, /<h4>已存在记录<\/h4>/);
    assert.match(moduleRenderer, /placeholder="筛选幂等键"/);
    assert.match(moduleRenderer, /placeholder="筛选文件名"/);
    assert.match(moduleRenderer, />导出当前分类<\/button>/);
    assert.match(moduleRenderer, /api\.exportImportAudit\(/);
    assert.match(moduleRenderer, /action: 'keep_current_effective_dataset'/);
    assert.match(moduleRenderer, /data-field="resolution-confirm"/);
    assert.match(moduleRenderer, /本次失败导入不参与计算/);
    assert.match(moduleRenderer, /<th>文件<\/th><th>sheet<\/th><th>原表行号<\/th><th>异常字段<\/th><th>错误码<\/th><th>说明<\/th>/);
    assert.match(moduleRenderer, /detailState\.tab === 'other' \? importErrorsTable/);
    assert.match(moduleRenderer, /row\.sheetName \|\| '-'/);
    assert.match(moduleRenderer, /row\.validationField \|\| '-'/);
  });

  test('结果确认读取完整后端 review、按生效差异展示并在页内带 revision 归档', () => {
    assert.match(moduleRenderer, /\['AUD', 'CAD', 'CNH', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'USD'\]/);
    assert.match(moduleRenderer, /<th>主体<\/th><th>大类<\/th><th>分类<\/th>/);
    assert.match(moduleRenderer, /\['effectiveCalculatedBalance', '当月计算财务OP'\]/);
    assert.match(moduleRenderer, /\['systemBalance', '系统财务OP'\]/);
    assert.match(moduleRenderer, /\['effectiveDifference', '差异'\]/);
    assert.match(moduleRenderer, /row\.type === 'adjustment'/);
    assert.match(moduleRenderer, /amount === null \|\| amount === undefined \? '-' :/);
    assert.match(moduleRenderer, /balanced \? '-' : formatAmount\(amount\)/);
    assert.match(moduleRenderer, /<th class="\$\{balanced \? 'balanced' : 'unbalanced'\}">/);
    assert.match(moduleRenderer, /data-field="archive-confirm"/);
    assert.match(moduleRenderer, /archiveBtn\.disabled = operating \|\| !reviewHealthy \|\| !checkbox\.checked/);
    assert.match(moduleRenderer, /expectedResultRevision: currentResult\.resultRevision/);
    assert.match(moduleRenderer, /reviewFailureDisposition\('archive', error\.code\)/);
    assert.match(moduleRenderer, /await refetchCurrentResult/);
    assert.match(moduleRenderer, /normalizeRunResponse\(await api\.getRun\(\{ runId: result\.runId \}\)\)/);
    assert.match(moduleRenderer, /data-result-run-id=/);
    assert.match(moduleRenderer, /reopenManagedResult\(Number\(button\.dataset\.resultRunId\), button\)/);
    assert.match(moduleRenderer, /elements\.exportBtn\.disabled = state\.busy \|\| !state\.latestArchivedRun/);
    assert.match(moduleRenderer, /results: \[\{\s*runId: 316,[\s\S]*resultRevision: 1,[\s\S]*updatedAt: '2026-07-02 11:08:00'/);
    assert.match(moduleRenderer, /function buildResultPreview\(\{ status = 'calculated', adjustmentCount = 0 \} = \{\}\)/);
    assert.match(moduleRenderer, /openResult\(\) \{\s*return confirmArchive\(buildResultPreview\(\)\);/);
    assert.match(moduleRenderer, /openAdjustment\(\) \{[\s\S]*return requestRunAdjustment\([\s\S]*runStatus: 'calculated'/);
    assert.match(renderer, /'vcc-financial-op-adjustment': Object\.freeze\(\{ method: 'openAdjustment', strategy: 'lifecycle' \}\)/);
  });

  test('完整结果渲染严格校验九币种与四类 summary，调整紧跟基础行且不在前端计算金额', () => {
    const start = moduleRenderer.indexOf('function isZeroAmount(');
    const end = moduleRenderer.indexOf('async function requestRunAdjustment(', start);
    assert.ok(start >= 0 && end > start);
    const buildResultHtml = Function(
      'escapeHtml',
      'formatAmount',
      'SOURCE_LABELS',
      'CURRENCIES',
      'differenceApi',
      `'use strict'; ${moduleRenderer.slice(start, end)}; return resultReviewHtml;`
    )(
      (value) => String(value == null ? '' : value),
      (value) => String(value),
      { recharge_refund: 'VCC充值清退明细' },
      ['AUD', 'CAD', 'CNH', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'USD'],
      require('../../src/shared/vcc-financial-op-difference')
    );
    const currencies = ['AUD', 'CAD', 'CNH', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'USD'];
    const amounts = (usd, eur = '0') => Object.fromEntries(
      currencies.map((currency) => [currency, currency === 'USD' ? usd : (currency === 'EUR' ? eur : '0')])
    );
    const dto = {
      review: {
        currencies,
        subjects: [{
          subject: 'PPHK',
          rows: [{
            type: 'base', subject: 'PPHK', sourceType: 'recharge_refund',
            categoryMajor: '充值', categoryMinor: 'OPS',
            currencyAmounts: { ...amounts(null), USD: '10', EUR: null }
          }, {
            type: 'adjustment', subject: 'PPHK', sourceType: 'recharge_refund',
            categoryMajor: '充值', categoryMinor: 'OPS', currency: 'USD',
            currencyAmounts: { ...amounts(null), USD: '-2', EUR: null },
            adjustmentAmount: '-2', reason: '人工核对'
          }],
          summaries: {
            openingBalance: amounts('100'),
            effectiveCalculatedBalance: amounts('108'),
            systemBalance: amounts('108', '-2'),
            effectiveDifference: amounts('0', '-2')
          }
        }]
      }
    };
    const output = buildResultHtml(dto);
    assert.ok(output.indexOf('vcc-fin-op-base-row') < output.indexOf('vcc-fin-op-adjustment-row'));
    assert.match(output, /人工调整/);
    assert.match(output, /人工核对/);
    assert.match(output, /class="number">-<\/td>/);
    assert.match(output, /class="number">-2<\/td>/);
    assert.doesNotMatch(output, /<td class="number (?:balanced|unbalanced)">/);
    assert.match(output, /<th class="balanced">AUD<\/th>/);
    assert.match(output, /<th class="unbalanced">EUR<\/th>/);
    assert.match(output, /<th>调整值<\/th><th>调整原因<\/th>/);

    const badCurrencies = JSON.parse(JSON.stringify(dto));
    badCurrencies.review.currencies = currencies.slice(0, 8);
    assert.throws(() => buildResultHtml(badCurrencies), /币种契约异常/);
    const missingSummaryCurrency = JSON.parse(JSON.stringify(dto));
    delete missingSummaryCurrency.review.subjects[0].summaries.effectiveDifference.USD;
    assert.throws(() => buildResultHtml(missingSummaryCurrency), /缺少 USD/);
    const nonCanonical = JSON.parse(JSON.stringify(dto));
    nonCanonical.review.subjects[0].summaries.systemBalance.USD = '108.00';
    assert.throws(() => buildResultHtml(nonCanonical), /金额契约异常/);

    const resultFunction = moduleRenderer.slice(
      moduleRenderer.indexOf('function resultReviewHtml('),
      moduleRenderer.indexOf('async function requestRunAdjustment(')
    );
    assert.match(resultFunction, /const \{ currencies, subjects \} = validateResultReview\(result\)/);
    assert.doesNotMatch(resultFunction, /CURRENCIES\.map/);
    assert.doesNotMatch(resultFunction, /parseFloat|parseInt|Number\(/);
  });

  test('结果导出复用归档月份选择器且 renderer 只提交 targetMonth', () => {
    const start = moduleRenderer.indexOf('async function handleExport()');
    const end = moduleRenderer.indexOf('function statusTone(', start);
    const exportSource = moduleRenderer.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(exportSource, /months = await loadArchivedResultMonths\(\)/);
    assert.match(exportSource, /createArchivedMonthPickerDialog\(\{/);
    assert.match(exportSource, /actionLabel: '导出'/);
    assert.match(exportSource, /previewSelection: async \(entry\) =>/);
    assert.match(exportSource, /const freshMonths = await loadArchivedResultMonths\(\)/);
    assert.match(exportSource, /canExecute: stillArchived/);
    assert.match(exportSource, /setBusy\(true, 'export-months'\)/);
    assert.match(exportSource, /applyArchivedMonthsState\(months\)/);
    assert.match(exportSource, /if \(!months\.length\)[\s\S]*暂无已归档财务OP校验结果[\s\S]*showMessage\('导出结果'/);
    assert.match(exportSource, /api\.exportResult\(\{ targetMonth: entry\.targetMonth \}\)/);
    assert.match(exportSource, /catch \(error\) \{[\s\S]*setStatus\(`\$\{entry\.targetMonth\} 导出失败：\$\{responseFailureDisplayMessage\(error\)\}`, 'error'\);[\s\S]*throw error/);
    assert.doesNotMatch(exportSource, /runId/);
    assert.doesNotMatch(exportSource, /closeOnExecutionError/);
    const mainStart = main.indexOf("trackedIpcHandle('vccFinancialOp:export:result'");
    const mainEnd = main.indexOf("trackedIpcHandle('vccFinancialOp:export:import-audit'", mainStart);
    const mainExportSource = main.slice(mainStart, mainEnd);
    assert.match(mainExportSource, /getArchivedRunByMonth\(payload\.targetMonth\)/);
    assert.match(mainExportSource, /exportRun\(\{[\s\S]*targetMonth: target\.targetMonth/);
    assert.doesNotMatch(mainExportSource, /payload\.runId/);
    assert.match(styles, /vcc-fin-op-full-result-table thead th\.balanced/);
    assert.match(styles, /vcc-fin-op-full-result-table thead th\.unbalanced/);
    assert.doesNotMatch(styles, /difference-row td\.(?:balanced|unbalanced)/);
    assert.match(
      moduleRenderer,
      /const PREVIEW_ARCHIVED_MONTHS = \[[\s\S]*targetMonth: '2026-06'[\s\S]*targetMonth: '2025-12'[\s\S]*openResultExportMonth\(\)[\s\S]*actionLabel: '导出'[\s\S]*canExecute: true/
    );
    assert.match(
      renderer,
      /'vcc-financial-op-result-export-month': Object\.freeze\(\{ method: 'openResultExportMonth', strategy: 'state' \}\)/
    );
    assert.match(moduleRenderer, /danger \? 'danger-btn' : 'primary-btn'/);
  });

  test('已归档月份空态同步导出按钮 disabled 与 title，恢复月份时清除 title', () => {
    const start = moduleRenderer.indexOf('function applyArchivedMonthsState(');
    const end = moduleRenderer.indexOf('async function settleArchivedPickerCompletion(', start);
    assert.ok(start >= 0 && end > start);
    const state = { busy: false, latestArchivedRun: { targetMonth: '2026-07' }, lastMonth: '2026-07' };
    const elements = { exportBtn: { disabled: false, title: '' } };
    const applyState = Function(
      'state',
      'elements',
      `'use strict'; ${moduleRenderer.slice(start, end)}; return applyArchivedMonthsState;`
    )(state, elements);

    applyState([]);
    assert.equal(state.latestArchivedRun, null);
    assert.equal(elements.exportBtn.disabled, true);
    assert.equal(elements.exportBtn.title, '暂无已归档财务OP校验结果');

    applyState([{ targetMonth: '2026-06', runId: 316 }]);
    assert.equal(state.latestArchivedRun.targetMonth, '2026-06');
    assert.equal(elements.exportBtn.disabled, false);
    assert.equal(elements.exportBtn.title, '');

    state.busy = true;
    applyState([{ targetMonth: '2026-05', runId: 315 }]);
    assert.equal(elements.exportBtn.disabled, true);
    assert.equal(elements.exportBtn.title, '');

    applyState([]);
    assert.equal(elements.exportBtn.disabled, true);
    assert.equal(elements.exportBtn.title, '暂无已归档财务OP校验结果');
    assert.match(moduleRenderer, /initialize\(\)[\s\S]*setStatus\('暂无已归档财务OP校验结果', 'info'\)/);
  });

  test('修改结果固定四级无默认级联，保存锁窗并在成功或 stale 后强制 refetch 清核对', () => {
    const start = moduleRenderer.indexOf('async function requestRunAdjustment(');
    const end = moduleRenderer.indexOf('function confirmArchive(', start);
    const adjustmentSource = moduleRenderer.slice(start, end);
    assert.ok(start >= 0 && end > start);
    const orderedFields = [
      'adjustment-subject', 'adjustment-major', 'adjustment-minor',
      'adjustment-currency', 'adjustment-amount', 'adjustment-reason'
    ];
    let previous = -1;
    for (const field of orderedFields) {
      const index = adjustmentSource.indexOf(`data-field="${field}"`);
      assert.ok(index > previous, `${field} 必须按固定顺序出现`);
      previous = index;
    }
    assert.match(adjustmentSource, /resetSelect\(subjectSelect, '请选择主体', false\)/);
    assert.match(adjustmentSource, /<option value="" selected disabled>/);
    assert.match(adjustmentSource, /option\.dataset\.rowKey = rowKey/);
    assert.match(adjustmentSource, /duplicateCounts[\s\S]*row\.sourceLabel/);
    assert.match(adjustmentSource, /for \(const currency of CURRENCIES\)[\s\S]*available\.includes\(currency\)/);
    assert.match(adjustmentSource, /rowKey,[\s\S]*expectedResultRevision: result\.resultRevision/);
    assert.match(adjustmentSource, /expectedPreviewToken: result\.previewTokens && result\.previewTokens\.adjustment/);
    assert.match(adjustmentSource, /taskGeneration: result\.taskGeneration/);
    assert.match(adjustmentSource, /api\.onOperationProgress[\s\S]*progress\.action !== 'adjustment'/);
    assert.match(adjustmentSource, /if \(typeof stopProgress === 'function'\) stopProgress\(\)/);
    assert.match(adjustmentSource, /canClose: \(\) => !saving/);
    assert.match(adjustmentSource, /setAdjustmentLocked\(true\);\s*setBusy\(true, 'adjustment'\)/);
    assert.match(adjustmentSource, /setBusy\(previousBusy\.busy, previousBusy\.kind\)/);
    assert.doesNotMatch(adjustmentSource, /maxlength="500"/);
    assert.ok(
      adjustmentSource.indexOf('data-action="cancel-adjustment"')
        < adjustmentSource.indexOf('data-action="confirm-adjustment"'),
      '取消必须在左，蓝色确认必须在最右'
    );

    const reviewStart = moduleRenderer.indexOf('function confirmArchive(');
    const reviewEnd = moduleRenderer.indexOf('async function chooseExistingMonth', reviewStart);
    const reviewSource = moduleRenderer.slice(reviewStart, reviewEnd);
    assert.match(reviewSource, /adjustmentOutcome && adjustmentOutcome\.status === 'saved'[\s\S]*await refetchCurrentResult\('调整已保存/);
    assert.match(reviewSource, /\['stale', 'locked'\]\.includes\(adjustmentOutcome\.status\)[\s\S]*await refetchCurrentResult/);
    assert.match(reviewSource, /checkbox\.checked = false/);
    assert.match(reviewSource, /modifyBtn\.hidden = !editable/);
    assert.match(reviewSource, /if \(modifyBtn\.disabled \|\| runStatusOf\(currentResult\) !== 'calculated'\) return;/);
    assert.match(reviewSource, /reviewFailureDisposition\('archive', error\.code\)[\s\S]*await refetchCurrentResult/);
    assert.match(reviewSource, /expectedPreviewToken: currentResult\.previewTokens && currentResult\.previewTokens\.archive/);
    assert.match(reviewSource, /taskGeneration: currentResult\.taskGeneration/);
    assert.match(reviewSource, /api\.onOperationProgress[\s\S]*progress\.action !== 'archive'/);
  });

  test('结果操作失败策略区分临时失败、无候选、并发归档与结构性归档错误', () => {
    const start = moduleRenderer.indexOf('function reviewFailureDisposition(');
    const end = moduleRenderer.indexOf('function responseFailure(', start);
    assert.ok(start >= 0 && end > start);
    const disposition = Function(
      `'use strict'; ${moduleRenderer.slice(start, end)}; return reviewFailureDisposition;`
    )();

    assert.deepEqual(disposition('modify', 'active-vcc-task'), {
      refetch: false, poisonReview: false, disableModify: false
    });
    assert.deepEqual(disposition('modify', 'adjustment-options-empty'), {
      refetch: false, poisonReview: false, disableModify: true
    });
    assert.deepEqual(disposition('modify', 'adjustment-locked'), {
      refetch: true, poisonReview: false, disableModify: false
    });
    assert.deepEqual(disposition('modify', 'result-revision-changed'), {
      refetch: true, poisonReview: false, disableModify: false
    });
    assert.deepEqual(disposition('archive', 'active-vcc-task'), {
      refetch: false, poisonReview: false, disableModify: false
    });
    assert.deepEqual(disposition('archive', 'result-input-changed'), {
      refetch: false, poisonReview: true, disableModify: false
    });
    assert.deepEqual(disposition('archive', 'result-recalculation-required'), {
      refetch: false, poisonReview: true, disableModify: true
    });

    const reviewStart = moduleRenderer.indexOf('function confirmArchive(');
    const reviewEnd = moduleRenderer.indexOf('async function chooseExistingMonth', reviewStart);
    const reviewSource = moduleRenderer.slice(reviewStart, reviewEnd);
    assert.match(reviewSource, /checkbox\.checked = false;\s*if \(error && error\.reviewRefetchFailed\)/);
    assert.match(reviewSource, /if \(disposition\.disableModify\) adjustmentAvailable = false/);
    assert.match(reviewSource, /modifyBtn\.disabled = locked \|\| !reviewHealthy \|\| !adjustmentAvailable/);
    assert.match(reviewSource, /checkbox\.disabled = locked \|\| !reviewHealthy/);
    assert.match(reviewSource, /reviewFailureDisposition\('archive', error\.code\)/);
    assert.match(reviewSource, /if \(disposition\.poisonReview\) reviewHealthy = false/);
    assert.match(reviewSource, /error\.reviewRefetchFailed = true/);

    const adjustmentStart = moduleRenderer.indexOf('async function requestRunAdjustment(');
    const adjustmentEnd = moduleRenderer.indexOf('function confirmArchive(', adjustmentStart);
    const adjustmentSource = moduleRenderer.slice(adjustmentStart, adjustmentEnd);
    assert.match(adjustmentSource, /error\.code = 'adjustment-options-empty'/);
    assert.match(adjustmentSource, /\['result-revision-changed', 'adjustment-locked'\]\.includes\(saved\.code\)/);
    assert.match(reviewSource, /\['stale', 'locked'\]\.includes\(adjustmentOutcome\.status\)[\s\S]*await refetchCurrentResult/);
  });

  test('开始运行先做五表预检，失败不启动 worker 并使用明确错误标题', () => {
    assert.match(preload, /preflightRun: \(payload\) => ipcRenderer\.invoke\('vccFinancialOp:run:preflight'/);
    assert.match(main, /ipcMain\.handle\('vccFinancialOp:run:preflight'/);
    assert.match(moduleRenderer, /await api\.preflightRun\(\{ targetMonth: month \}\)/);
    assert.match(moduleRenderer, /showMessage\('无法开始运行', message, 'warning'\)/);
    assert.match(moduleRenderer, /expectedInputFingerprint: preflight\.inputFingerprint/);
  });

  test('运行前检查同时存在多个问题时完整展示结构化 issues', () => {
    const start = moduleRenderer.indexOf('function blockedCalculationMessage(');
    const end = moduleRenderer.indexOf('function requestOpeningInitialization(', start);
    assert.ok(start >= 0 && end > start);
    const formatter = Function(
      `'use strict'; ${moduleRenderer.slice(start, end)}; return blockedCalculationMessage;`
    )();
    assert.equal(formatter({
      code: 'missing-datasets',
      issues: [
        { code: 'empty-dataset', message: 'Pending 校验表没有有效数据。' },
        { code: 'invalid-system-snapshot', message: 'PPHK 系统财务OP缺少 USD 余额。' },
        { code: 'unresolved-imports', message: '仍有 1 条未处理失败记录。' }
      ]
    }), [
      'Pending 校验表没有有效数据。',
      'PPHK 系统财务OP缺少 USD 余额。',
      '仍有 1 条未处理失败记录。'
    ].join('\n'));
  });

  test('缺少上月归档时提供九币种一次性期初初始化且不默认补零', () => {
    assert.match(moduleRenderer, /result\.code === 'active-imports'/);
    assert.match(moduleRenderer, /result\.code === 'missing-opening-balance'/);
    assert.match(moduleRenderer, /系统不会按 0 或系统财务OP代替/);
    assert.match(moduleRenderer, /data-opening-currency=/);
    assert.match(moduleRenderer, /data-field="opening-note"/);
    assert.match(moduleRenderer, /data-field="opening-confirm"/);
    assert.match(moduleRenderer, /api\.initializeOpening\(openingPayload\)/);
    const initializedStart = moduleRenderer.indexOf('const initialized = await api.initializeOpening(openingPayload)');
    const initializedEnd = moduleRenderer.indexOf("if (result.status === 'blocked')", initializedStart);
    assert.ok(initializedStart >= 0 && initializedEnd > initializedStart, '应能定位期初初始化后的运行分支');
    const afterInitialization = moduleRenderer.slice(initializedStart, initializedEnd);
    assert.match(afterInitialization, /请再次点击【开始运行】进行计算。/);
    assert.match(afterInitialization, /showMessage\('期初初始化完成', initializedMessage, 'success'\);\s*return;/);
    assert.doesNotMatch(
      afterInitialization,
      /api\.preflightRun|api\.calculate|confirmArchive|api\.archive/,
      '期初初始化成功后不得在同一次点击中继续预检、计算或归档'
    );
    assert.match(moduleRenderer, /零余额请填写 0/);
    assert.match(moduleRenderer, /确认一次性初始化/);
    assert.match(moduleRenderer, /\['openingBalance', '期初财务OP'\]/);
    assert.doesNotMatch(moduleRenderer, /overview\.openingBalances|function renderOpeningAudit/);
    assert.doesNotMatch(vccService, /openingBalances/);
  });

  test('宽表和低分辨率弹框具备稳定尺寸及滚动约束', () => {
    assert.match(styles, /\.vcc-fin-op-dialog\s*\{[\s\S]*max-height:\s*calc\(100vh - 48px\);[\s\S]*overflow:\s*hidden;/);
    assert.match(styles, /\.vcc-fin-op-table-wrap\s*\{[\s\S]*overflow:\s*auto;/);
    assert.match(styles, /\.vcc-fin-op-balance-table\s*\{[\s\S]*min-width:\s*1080px;/);
    assert.match(styles, /\.vcc-fin-op-manager-dialog\s*\.vcc-fin-op-dialog-body\s*\{[\s\S]*overflow:\s*hidden;/);
    assert.match(styles, /@media \(max-width: 820px\)/);
    assert.match(styles, /@media \(max-width: 520px\)/);
    const narrowStart = styles.indexOf('@media (max-width: 520px)');
    const narrowStyles = styles.slice(narrowStart);
    assert.match(narrowStyles, /\.vcc-fin-op-adjustment-form\s*\{\s*grid-template-columns:\s*1fr;/);
    assert.match(narrowStyles, /\.vcc-fin-op-adjustment-reason-field\s*\{\s*grid-column:\s*auto;/);
  });
});
