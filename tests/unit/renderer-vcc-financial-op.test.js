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
    assert.match(renderer, /info\.previewModal === 'vcc-financial-op-import-month'[\s\S]*__vccFinancialOpPreview\?\.openImportMonth\(\)/);
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
    assert.match(renderer, /info\.previewModal === 'vcc-financial-op-run-month'[\s\S]*__vccFinancialOpPreview\?\.openRunMonth\(\)/);
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
      'vccFinancialOp:imports:list-months',
      'vccFinancialOp:imports:list-records',
      'vccFinancialOp:imports:get-detail',
      'vccFinancialOp:imports:resolve',
      'vccFinancialOp:data-manager:overview',
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
    assert.match(vccService, /return runWorker\('delete-dataset'/);
    assert.match(preload, /ipcRenderer\.on\('vccFinancialOp:import:progress'/);
    assert.match(preload, /ipcRenderer\.removeListener\('vccFinancialOp:import:progress'/);
    assert.match(moduleRenderer, /elements\.importBtn\.textContent\s*=\s*state\.busyKind === 'import' \? '取消导入'/);
    assert.match(moduleRenderer, /setBusy\(true, 'import'\);\s*setStatus\('正在识别原表/);
    assert.match(moduleRenderer, /api\.cancelTask\(\)/);
    assert.match(main, /\{ \.\.\.result, runStatus: result\.status, status: 'success' \}/);
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

  test('数据管理右下角按删除、导出、返回排列，删除页按账期与五类目标表预检后执行', () => {
    assert.match(moduleRenderer, /class="dialog-actions right vcc-fin-op-manager-footer"[\s\S]*data-action="delete-dataset"[^>]*>删除<\/button>[\s\S]*data-action="export-dataset"[^>]*>导出<\/button>[\s\S]*data-action="return">返回<\/button>/);
    assert.match(moduleRenderer, /returnButton\.addEventListener\('click', modal\.close\)/);
    assert.match(moduleRenderer, /title: '删除数据'/);
    assert.match(moduleRenderer, /data-field="delete-source"/);
    assert.match(moduleRenderer, /data-field="delete-month"/);
    assert.ok(
      moduleRenderer.indexOf('data-field="delete-month"') < moduleRenderer.indexOf('data-field="delete-source"'),
      '删除页应在左侧展示月份账期、右侧展示目标表'
    );
    assert.match(moduleRenderer, /class="danger-btn small"[^>]*data-action="confirm-delete" disabled>删除<\/button>/);
    assert.match(moduleRenderer, /data-action="cancel">取消<\/button>/);
    for (const label of [
      'VCC充值清退明细',
      'VCC费用及换汇明细',
      'VCC通道明细',
      'VCC_移除归档Pending账单',
      '系统财务OP'
    ]) {
      assert.ok(moduleRenderer.includes(label), `删除目标表缺少 ${label}`);
    }
    assert.match(moduleRenderer, /api\.previewDatasetDeletion\(\{ targetMonth, sourceType \}\)/);
    assert.match(moduleRenderer, /api\.deleteDataset\(\{ targetMonth, sourceType \}\)/);
    assert.match(moduleRenderer, /const currentVersion = \+\+previewVersion;/);
    assert.match(moduleRenderer, /if \(currentVersion !== previewVersion\) return;/);
    assert.match(moduleRenderer, /canClose: \(\) => !deleting/);
    assert.match(moduleRenderer, /setBusy\(true, 'delete'\)/);
    assert.match(moduleRenderer, /cancelButton\.disabled = true/);
    assert.match(moduleRenderer, /closeButton\.disabled = true/);
    assert.match(moduleRenderer, /const successMessage = `已删除/);
    assert.match(moduleRenderer, /数据管理刷新失败/);
    assert.match(moduleRenderer, /onDeleted: render/);
    assert.match(styles, /\.vcc-fin-op-delete-dialog\s*\{[\s\S]*width:\s*min\(100%, 470px\);/);
    assert.match(styles, /\.vcc-fin-op-delete-form\s*\{[\s\S]*margin-left:\s*20px;[\s\S]*padding:\s*4px 8px 0;/);
    assert.match(styles, /\.vcc-fin-op-delete-fields\s*\{[\s\S]*grid-template-columns:\s*25% 40%;[\s\S]*column-gap:\s*10px;/);
    assert.match(styles, /\.vcc-fin-op-manager-shell\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;/);
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
    assert.match(renderer, /info\.previewModal === 'vcc-financial-op-export'[\s\S]*__vccFinancialOpPreview\?\.openExport\(\)/);
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

  test('结果确认固定九币种、明确差异并二次勾选后归档', () => {
    assert.match(moduleRenderer, /\['AUD', 'CAD', 'CNH', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'USD'\]/);
    assert.match(moduleRenderer, />当月计算财务OP<\/th>/);
    assert.match(moduleRenderer, />系统财务OP<\/th>/);
    assert.match(moduleRenderer, />差异<\/th>/);
    assert.match(moduleRenderer, /data-field="archive-confirm"/);
    assert.match(moduleRenderer, /archiveBtn\.disabled = !checkbox\.checked/);
    assert.match(moduleRenderer, /api\.archive\(\{ runId: result\.runId \}\)/);
    assert.match(moduleRenderer, /elements\.exportBtn\.disabled = state\.busy \|\| !state\.latestArchivedRun/);
  });

  test('缺少上月归档时提供九币种一次性期初初始化且不默认补零', () => {
    assert.match(moduleRenderer, /result\.code === 'active-imports'/);
    assert.match(moduleRenderer, /result\.code === 'missing-opening-balance'/);
    assert.match(moduleRenderer, /系统不会按 0 或系统财务OP代替/);
    assert.match(moduleRenderer, /data-opening-currency=/);
    assert.match(moduleRenderer, /data-field="opening-note"/);
    assert.match(moduleRenderer, /data-field="opening-confirm"/);
    assert.match(moduleRenderer, /api\.initializeOpening\(openingPayload\)/);
    assert.match(moduleRenderer, /零余额请填写 0/);
    assert.match(moduleRenderer, /首月期初初始化/);
    assert.match(moduleRenderer, /一次性记录，不可改写/);
    assert.match(moduleRenderer, /overview\.openingBalances/);
  });

  test('宽表和低分辨率弹框具备稳定尺寸及滚动约束', () => {
    assert.match(styles, /\.vcc-fin-op-dialog\s*\{[\s\S]*max-height:\s*calc\(100vh - 48px\);[\s\S]*overflow:\s*hidden;/);
    assert.match(styles, /\.vcc-fin-op-table-wrap\s*\{[\s\S]*overflow:\s*auto;/);
    assert.match(styles, /\.vcc-fin-op-balance-table\s*\{[\s\S]*min-width:\s*1080px;/);
    assert.match(styles, /\.vcc-fin-op-manager-dialog\s*\.vcc-fin-op-dialog-body\s*\{[\s\S]*overflow:\s*hidden;/);
    assert.match(styles, /@media \(max-width: 820px\)/);
    assert.match(styles, /@media \(max-width: 520px\)/);
  });
});
