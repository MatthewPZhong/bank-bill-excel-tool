'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
const previews = fs.readFileSync(path.join(ROOT, 'src', 'renderer-previews.js'), 'utf8');

function extractPanel() {
  const start = html.indexOf('id="positionReconciliationModulePanel"');
  assert.ok(start >= 0, '应存在平盘对账模块面板');
  const sectionStart = html.lastIndexOf('<section', start);
  const nextSection = html.indexOf('<section', start + 1);
  assert.ok(sectionStart >= 0 && nextSection > start, '应能提取平盘对账模块 section');
  return html.slice(sectionStart, nextSection);
}

const panel = extractPanel();

test.describe('v3.0.25 平盘对账数据处理前端契约', () => {
  test('模块 ID、显示名和面板显隐接线完整', () => {
    assert.match(renderer, /positionReconciliation:\s*\{\s*id:\s*'position-reconciliation-process',\s*name:\s*'平盘对账数据处理'/);
    assert.match(renderer, /positionReconciliationModulePanel\.hidden\s*=\s*moduleId\s*!==\s*MODULES\.positionReconciliation\.id/);
    assert.match(previews, /setCurrentModule\(MODULES\.positionReconciliation\.id\)/);
    assert.ok(renderer.includes("info.previewModal === 'position-reconciliation-panel'"));
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
      ['positionReconciliationTableManagerBtn', '对账表管理'],
      ['positionReconciliationLinkedTableManagerBtn', '链接表管理'],
      ['positionReconciliationConfigBtn', '对账配置管理'],
      ['positionReconciliationExportBtn', '导出文件']
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

  test('开始运行和导出文件恢复为对账单修复的 140px 按钮宽度', () => {
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

  test('五个按钮只绑定 showComingSoon，不接业务 handler', () => {
    const start = renderer.indexOf('// v3.0.24：仅前端占位');
    const end = renderer.indexOf('elements.statusBox.addEventListener', start);
    const binding = renderer.slice(start, end);
    for (const id of [
      'positionReconciliationRunBtn',
      'positionReconciliationTableManagerBtn',
      'positionReconciliationLinkedTableManagerBtn',
      'positionReconciliationConfigBtn',
      'positionReconciliationExportBtn'
    ]) {
      assert.ok(binding.includes(`elements.${id}`), `${id} 应在占位绑定中`);
    }
    assert.match(binding, /showComingSoon\(featureName\)/);
    assert.doesNotMatch(binding, /desktopApi|handle[A-Z]|ipc/);
  });

  test('共享 Payment 解析脚本先于 renderer-dialogs 加载', () => {
    assert.ok(
      html.indexOf('./src/shared/payment-big-accounts.js') < html.indexOf('./src/renderer-dialogs.js'),
      '共享解析器必须先加载'
    );
  });
});
