'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const pendingRenderer = fs.readFileSync(path.join(root, 'src/renderer-pending.js'), 'utf8');
const clearBase = fs.readFileSync(path.join(root, 'src/styles-gemini.css'), 'utf8');
const clearExtra = fs.readFileSync(path.join(root, 'src/styles-gemini-extra.css'), 'utf8');
const generalStyles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const geometryVerifier = fs.readFileSync(path.join(root, 'scripts/verify-main-panel-alignment.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const windowsBuildWorkflow = fs.readFileSync(path.join(root, '.github/workflows/build-windows.yml'), 'utf8');
const windowsReleaseWorkflow = fs.readFileSync(path.join(root, '.github/workflows/release-windows.yml'), 'utf8');

const TARGET_STATUS_IDS = [
  'statusBox',
  'pendingStatusBox',
  'bizOpReconStatusBox',
  'bankBuReconStatusBox',
  'duplicateInboundMatchStatusBox',
  'vccOpCalcStatusBox',
  'bankStatementStatusBox',
  'preFundReconciliationStatusBox',
  'reconIdFixStatusBox',
  'positionReconciliationStatusBox',
  'acquiringBillCurrencyStatusBox'
];

const ALIGNED_CONTROL_IDS = [
  'templateSelect',
  'bizOpReconBuSelect',
  'preFundReconciliationScenarioSelect',
  'reconIdFixBillCategorySelect',
  'reconIdFixScenarioSelect',
  'positionReconciliationFunctionSelect'
];

function elementSourceById(id) {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start >= 0, `缺少 #${id}`);
  const end = html.indexOf('</div>', start);
  assert.ok(end > start, `无法读取 #${id}`);
  return html.slice(start, end);
}

test.describe('v3.0.20 主页面垂直对齐契约', () => {
  test('11 个目标状态框共享内容层，新开账户状态框保持原结构', () => {
    assert.equal((html.match(/class="status-box-content"/g) || []).length, TARGET_STATUS_IDS.length);

    for (const id of TARGET_STATUS_IDS) {
      const source = elementSourceById(id);
      assert.equal((source.match(/class="status-box-content"/g) || []).length, 1, `#${id} 内容层数量错误`);
      assert.match(
        source,
        /class="status-box-content"[\s\S]*class="status-spark"[\s\S]*<svg[\s\S]*class="status-box-text"/,
        `#${id} 必须按图标、文字顺序包装`
      );
    }

    const newAccountSource = elementSourceById('newAccountStatusBox');
    assert.doesNotMatch(newAccountSource, /status-box-content/);
    assert.match(newAccountSource, /class="status-spark"[\s\S]*class="status-box-text"/);
  });

  test('状态更新继续使用后代选择器，不依赖直接子元素', () => {
    assert.match(renderer, /box\.querySelector\('\.status-box-text'\)/);
    assert.match(pendingRenderer, /pendingStatusBox\.querySelector\('\.status-box-text'\)/);
    assert.doesNotMatch(renderer, /box\s*>\s*\.status-box-text/);
  });

  test('六组标签和下拉框使用统一 48px 轨道类', () => {
    for (const selectId of ALIGNED_CONTROL_IDS) {
      const selectPattern = new RegExp(`<select[^>]*id="${selectId}"[^>]*class="[^"]*main-panel-select-control[^"]*"`);
      const labelPattern = new RegExp(`<label[^>]*class="[^"]*main-panel-select-label[^"]*"[^>]*for="${selectId}"`);
      assert.match(html, selectPattern, `#${selectId} 缺少控件轨道类`);
      assert.match(html, labelPattern, `#${selectId} 缺少标签轨道类`);
    }
    assert.equal((html.match(/main-panel-select-label/g) || []).length, ALIGNED_CONTROL_IDS.length);
    assert.equal((html.match(/main-panel-select-control/g) || []).length, ALIGNED_CONTROL_IDS.length);
  });

  test('Clear 与 General 均固定状态内容层和 14px 图标盒', () => {
    for (const [name, styles] of [['Clear', clearBase], ['General', generalStyles]]) {
      assert.match(styles, /\.status-box-content\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;[\s\S]*?gap:\s*8px;[\s\S]*?max-width:\s*100%;[\s\S]*?min-width:\s*0;/, `${name} 内容层规则不完整`);
      assert.match(styles, /\.status-box-content \.status-spark\s*\{[\s\S]*?width:\s*14px;[\s\S]*?height:\s*14px;[\s\S]*?flex:\s*0 0 14px;[\s\S]*?line-height:\s*0;/, `${name} 图标盒规则不完整`);
      assert.match(styles, /\.status-box-content \.status-spark svg\s*\{[\s\S]*?display:\s*block;[\s\S]*?width:\s*14px;[\s\S]*?height:\s*14px;/, `${name} SVG 块级规则不完整`);
    }
  });

  test('Clear 与 General 均固定标签轨道和下拉文字行高', () => {
    for (const [name, styles] of [['Clear', clearBase], ['General', generalStyles]]) {
      assert.match(styles, /\.main-panel-select-label\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?height:\s*48px;[\s\S]*?line-height:\s*20px;/, `${name} 标签轨道规则不完整`);
      assert.match(styles, /\.main-panel-select-control\s*\{?[\s\S]*?line-height:\s*20px;/, `${name} 下拉行高未锁定`);
    }
    assert.match(generalStyles, /\.main-panel-select-control\s*\{[\s\S]*?height:\s*48px;/);
  });

  test('绝对标签改按控件顶部定位，横向位置保持不变', () => {
    for (const selector of [
      '#preFundReconciliationModulePanel .pre-fund-scenario-label',
      '.biz-op-recon-bu-row .select-label'
    ]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rule = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(clearExtra);
      assert.ok(rule, `缺少 ${selector}`);
      assert.match(rule[1], /top:\s*0;/);
      assert.match(rule[1], /height:\s*48px;/);
      assert.match(rule[1], /transform:\s*none;/);
      assert.doesNotMatch(rule[1], /translateY/);
    }

    for (const styles of [clearExtra, generalStyles]) {
      assert.match(styles, /\.pre-fund-scenario-label\s*\{[\s\S]*?top:\s*0;[\s\S]*?right:\s*calc\(100% \+ 8px\);[\s\S]*?transform:\s*none;/);
      assert.match(styles, /\.pre-fund-action-pair > :first-child\s*\{\s*transform:\s*translateX\(-14px\)/);
      assert.match(styles, /\.pre-fund-action-pair > :last-child\s*\{\s*transform:\s*translateX\(14px\)/);
    }
    assert.match(clearExtra, /\.pre-fund-scenario-slot\s*\{[\s\S]*?width:\s*140px;[\s\S]*?min-width:\s*140px;/);
    assert.match(generalStyles, /\.pre-fund-scenario-slot\s*\{[\s\S]*?width:\s*144px;[\s\S]*?min-width:\s*144px;/);
  });

  test('对账单修复标签保持右对齐，资金状态滚动改由内容层居中', () => {
    assert.match(clearExtra, /\.recon-id-fix-scenario-label\s*\{[\s\S]*?justify-content:\s*flex-end;/);
    assert.match(clearExtra, /\.recon-id-fix-bill-category-label\s*\{[\s\S]*?justify-content:\s*flex-end;/);
    assert.match(generalStyles, /\.recon-id-fix-bill-category-label,[\s\S]*?\.recon-id-fix-scenario-label\s*\{[\s\S]*?justify-content:\s*flex-end;/);
    assert.match(clearExtra, /#bankStatementStatusBox\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?align-items:\s*flex-start;/);
    assert.match(clearExtra, /#bankStatementModulePanel \.bsb-merged-status\s*\{[\s\S]*?min-height:\s*0;/);
    assert.match(clearExtra, /#bankStatementModulePanel \.bank-statement-board-merged-row\s*\{[\s\S]*?grid-template-rows:\s*48px 110px;/);
    assert.match(clearExtra, /#bankStatementStatusBox\s*\{[\s\S]*?height:\s*100%;[\s\S]*?min-height:\s*0;[\s\S]*?max-height:\s*100%;/);
    assert.match(clearExtra, /#bankStatementStatusBox \.status-box-content\s*\{[\s\S]*?margin-top:\s*auto;[\s\S]*?margin-bottom:\s*auto;/);
    assert.match(generalStyles, /#bankStatementModulePanel \.bsb-merged-status\s*\{[\s\S]*?min-height:\s*0;/);
    assert.match(generalStyles, /#bankStatementModulePanel \.bank-statement-board-merged-row\s*\{[\s\S]*?grid-template-rows:\s*48px 110px;/);
    assert.match(generalStyles, /#bankStatementStatusBox\s*\{[\s\S]*?height:\s*100%;[\s\S]*?min-height:\s*0;[\s\S]*?max-height:\s*100%;/);
    assert.doesNotMatch(clearExtra, /#bankStatementStatusBox \.status-spark,\s*#bankStatementStatusBox \.status-box-text/);
  });

  test('真实 Electron 几何验收覆盖双尺寸、三档缩放并接入 Windows 门禁', () => {
    assert.equal(packageJson.scripts['verify:main-panel-alignment'], 'node scripts/verify-main-panel-alignment.js');
    assert.match(geometryVerifier, /const VIEWPORTS = \[[\s\S]*1240[\s\S]*860[\s\S]*1080[\s\S]*760/);
    assert.match(geometryVerifier, /const SCALE_FACTORS = \[1, 1\.25, 1\.5\]/);
    assert.match(geometryVerifier, /Emulation\.setDeviceMetricsOverride/);
    assert.match(geometryVerifier, /device scale factor: expected \$\{expectedScaleFactor\}, got \$\{window\.devicePixelRatio\}/);
    assert.match(geometryVerifier, /statusTargets = \[[\s\S]*duplicateInboundMatchStatusBox[\s\S]*acquiringBillCurrencyStatusBox/);
    assert.match(geometryVerifier, /bankBox\.scrollTop = bankBox\.scrollHeight/);
    assert.match(geometryVerifier, /Math\.abs\(bankCellHeight - 176\) > tolerance/);
    assert.match(windowsBuildWorkflow, /Verify main panel alignment[\s\S]*npm run verify:main-panel-alignment/);
    assert.match(windowsReleaseWorkflow, /Verify main panel alignment[\s\S]*npm run verify:main-panel-alignment/);
  });
});
