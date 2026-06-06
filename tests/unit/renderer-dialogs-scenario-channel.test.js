// v2.1.13 PR#58 review P2-2 / P2-3：renderer-dialogs 场景渠道相关修复的源码断言
//
// renderer-dialogs.js 是 5000+ 行的浏览器 IIFE（依赖 DOM + deps 注入），无 jsdom 单测脚手架，
// 故沿用本仓既有范式（tests/unit/renderer-status-box-text.test.js）：用源码字符串断言锁定修复，
// 防止后续重构无意回退。配套行为由 backend 层测试 + 手测把关。
//
//   P2-2：新建 ReconID 修复场景（recon-id-fix / gateway-recon-id-fix）的 channel_id 必须固定 = 1（通用），
//         不能跟随 state.activeScenarioChannelId（银行对账单 manager 残留的渠道选择）。
//   P2-3：场景管理弹窗列表把 builtin-fixed 置顶（序号固定 1）——run 路径 displayIndex 已在
//         scenarios-repository.listScenarios 对齐（见 scenarios-repository.test.js），此处锁定 manager 端排序仍在。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIALOGS_PATH = path.join(__dirname, '..', '..', 'src', 'renderer-dialogs.js');
const source = fs.readFileSync(DIALOGS_PATH, 'utf8');

describe('P2-2：新建 ReconID 场景固定 channel_id=1', () => {
  test('create 路径用 isReconIdFixCategory 选 channelId（ReconID → 1，否则沿用 activeScenarioChannelId）', () => {
    // 关键修复行：const createChannelId = isReconIdFixCategory(draft.category) ? 1 : (...)
    assert.ok(
      /const\s+createChannelId\s*=\s*isReconIdFixCategory\(draft\.category\)\s*\n?\s*\?\s*1\s*\n?\s*:\s*\(Number\(state\.activeScenarioChannelId\)/.test(source),
      'create 路径应按 isReconIdFixCategory 分流：ReconID → 1，否则 activeScenarioChannelId'
    );
  });

  test('scenarios.create 的 channelId 入参用 createChannelId（不再直接用 activeChannelId 局部变量）', () => {
    // 旧实现是 `channelId: activeChannelId`（局部 const activeChannelId = ...）；修复后是 `channelId: createChannelId`
    assert.ok(source.includes('channelId: createChannelId'),
      'scenarios.create 应传 channelId: createChannelId');
  });
});

describe('P2-3：场景管理弹窗 builtin-fixed 置顶（与 run 路径 displayIndex 对齐）', () => {
  test('manager refreshTable 仍把 builtin-fixed sort 到首位（displayIndex=1）', () => {
    // visible.sort((a, b) => (a.category === 'builtin-fixed' ? 0 : 1) - (b.category === 'builtin-fixed' ? 0 : 1));
    assert.ok(
      /\(a\.category === 'builtin-fixed' \? 0 : 1\)\s*-\s*\(b\.category === 'builtin-fixed' \? 0 : 1\)/.test(source),
      'manager 仍需把 builtin-fixed 置顶排序（run 路径 displayIndex 已对齐到同款顺序）'
    );
  });
});
