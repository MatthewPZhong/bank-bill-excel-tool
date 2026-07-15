'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');

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
    assert.ok(renderer.includes('duplicate-inbound-document-candidate-count-zero'));
    assert.ok(renderer.includes('duplicate-inbound-document-identity-fields-conflict'));
    assert.ok(renderer.includes('duplicate-inbound-document-business-department-mismatch'));
    assert.ok(renderer.includes('window.desktopApi.duplicateInboundMatch.importFiles()'));
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
    assert.match(main, /scheduleDuplicateInboundMatchStartupCleanup\(\)/);
  });
});
