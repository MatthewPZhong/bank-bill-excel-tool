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
  'vccFinancialOpStatusBox',
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

test.describe('v3.1.13 主页面状态框与垂直对齐契约', () => {
  test('13 个静态状态框只保留文字，12 个目标状态框共享内容层', () => {
    assert.equal((html.match(/class="status-box-content"/g) || []).length, TARGET_STATUS_IDS.length);
    assert.equal((html.match(/class="[^"]*status-box(?:\s[^"]*)?"/g) || []).length, TARGET_STATUS_IDS.length + 1);
    assert.doesNotMatch(html, /status-spark|gsStatus/);

    for (const id of TARGET_STATUS_IDS) {
      const source = elementSourceById(id);
      assert.equal((source.match(/class="status-box-content"/g) || []).length, 1, `#${id} 内容层数量错误`);
      assert.match(source, /class="status-box-content"[\s\S]*class="status-box-text"/, `#${id} 缺少文字内容层`);
      assert.doesNotMatch(source, /status-spark|<svg/, `#${id} 不应保留星星 SVG`);
    }

    const newAccountSource = elementSourceById('newAccountStatusBox');
    assert.doesNotMatch(newAccountSource, /status-box-content/);
    assert.match(newAccountSource, /class="status-box-text">等待生成<\/span>/);
    assert.doesNotMatch(newAccountSource, /status-spark|<svg/);
  });

  test('Clear 当前 UI 样板同步移除状态框星星及残余间距', () => {
    const clearPrototypeDir = path.join(root, 'Clear');
    for (const name of fs.readdirSync(clearPrototypeDir).filter((entry) => entry.endsWith('.html'))) {
      const source = fs.readFileSync(path.join(clearPrototypeDir, name), 'utf8');
      assert.doesNotMatch(source, /status-spark/, `${name} 不应保留状态框星星镜像`);
      const statusSections = Array.from(source.matchAll(/<div[^>]*class="[^"]*\bstatus-box\b[^"]*"[^>]*>([\s\S]*?)<\/div>/g));
      for (const [, statusMarkup] of statusSections) {
        assert.doesNotMatch(statusMarkup, /<svg/, `${name} 的状态框不应包含 SVG`);
      }
    }
    const prototypeStyles = fs.readFileSync(path.join(clearPrototypeDir, 'styles-gemini.css'), 'utf8');
    const boxRule = /\.status-box\s*\{([\s\S]*?)\}/.exec(prototypeStyles);
    assert.ok(boxRule, 'Clear 样板缺少状态框规则');
    assert.doesNotMatch(boxRule[1], /\bgap\s*:/, 'Clear 样板不应保留图文间距');
    assert.doesNotMatch(prototypeStyles, /status-spark/, 'Clear 样板 CSS 不应保留星星规则');
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

  test('Clear 与 General 均保留纯文字内容层且无残余星星样式和图文间距', () => {
    for (const [name, styles] of [['Clear', clearBase], ['General', generalStyles]]) {
      const boxRule = /\.status-box\s*\{([\s\S]*?)\}/.exec(styles);
      const contentRule = /\.status-box-content\s*\{([\s\S]*?)\}/.exec(styles);
      assert.ok(boxRule, `${name} 缺少状态框规则`);
      assert.ok(contentRule, `${name} 缺少状态内容层规则`);
      assert.match(contentRule[1], /display:\s*inline-flex;/, `${name} 内容层 display 不完整`);
      assert.match(contentRule[1], /align-items:\s*center;/, `${name} 内容层垂直居中不完整`);
      assert.match(contentRule[1], /justify-content:\s*center;/, `${name} 内容层水平居中不完整`);
      assert.match(contentRule[1], /max-width:\s*100%;/, `${name} 内容层最大宽度不完整`);
      assert.match(contentRule[1], /min-width:\s*0;/, `${name} 内容层最小宽度不完整`);
      assert.doesNotMatch(boxRule[1], /\bgap\s*:/, `${name} 状态框不应保留图文间距`);
      assert.doesNotMatch(contentRule[1], /\bgap\s*:/, `${name} 不应保留图文间距`);
      assert.doesNotMatch(styles, /status-spark/, `${name} 不应保留星星专属样式`);
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
    assert.match(geometryVerifier, /statusTargets = \[[\s\S]*duplicateInboundMatchStatusBox[\s\S]*vccFinancialOpStatusBox[\s\S]*acquiringBillCurrencyStatusBox/);
    assert.match(geometryVerifier, /box\.querySelector\('svg'\)/);
    assert.match(geometryVerifier, /unexpected status SVG/);
    assert.doesNotMatch(geometryVerifier, /querySelector\('\.status-spark'\)/);
    assert.match(geometryVerifier, /vccButtonWidthDelta[\s\S]*vccButtonSymmetryDelta/);
    assert.match(geometryVerifier, /Math\.abs\(importRect\.width - 140\) > tolerance/);
    assert.match(geometryVerifier, /importDistance <= 0 \|\| runDistance <= 0 \|\| metrics\.vccButtonSymmetryDelta > tolerance/);
    assert.match(geometryVerifier, /bankBox\.scrollTop = bankBox\.scrollHeight/);
    assert.match(geometryVerifier, /Math\.abs\(bankCellHeight - 176\) > tolerance/);
    assert.match(windowsBuildWorkflow, /Verify main panel alignment[\s\S]*npm run verify:main-panel-alignment/);
    assert.match(windowsReleaseWorkflow, /Verify main panel alignment[\s\S]*npm run verify:main-panel-alignment/);
  });
});
