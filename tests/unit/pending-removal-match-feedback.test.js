// v2.1.11 SR Round 2 — I-R2-1：对账后移除核对「失败态」与「无数据态」反馈区分
//
// 背景（资金/对账模块误导）：
//   pending:reconcile:run handler 在 matchRemoval 抛错时，catch 块原先沿用初值 null 返回 removalMatch=null。
//   但 null 语义已被「countByMonth=0 该上月无移除归档数据、未触发核对」占用 →
//   renderer 的 buildRemovalMatchSummary(null) 会显示「无移除归档数据，未执行移除核对」。
//   结果：移除数据「确实存在但匹配崩溃」时，用户看到「无移除归档数据」——与事实相反。
//
// 修复：error 态返回可区分标记 { error: true }（main.js catch），renderer 三分支区分文案。
//
// 单测形态（与 renderer-status-box-text.test.js 同款）：grep 源码字面量。
//   - buildRemovalMatchSummary 是 renderer-pending.js createRendererPending(deps) 闭包内私有函数，
//     未 export，无法直接 require 执行；故对 main.js + renderer-pending.js 源码断言关键不变量，
//     锁住「三态可区分」这一回归点（execute 级三态行为由手测清单 + integration 覆盖）。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_PATH = path.join(__dirname, '..', '..', 'src', 'main.js');
const RENDERER_PENDING_PATH = path.join(__dirname, '..', '..', 'src', 'renderer-pending.js');
const mainSource = fs.readFileSync(MAIN_PATH, 'utf8');
const rendererSource = fs.readFileSync(RENDERER_PENDING_PATH, 'utf8');

describe('I-R2-1 — matchRemoval 抛错路径返回可区分失败标记 (main.js)', () => {
  test('catch 块返回 removalMatchResult = { error: true }（不沿用 null）', () => {
    assert.ok(
      /removalMatchResult\s*=\s*\{\s*error:\s*true\s*\}/.test(mainSource),
      'matchRemoval catch 块应把 removalMatchResult 赋值为 { error: true } 失败标记，而非保留初值 null'
    );
  });

  test('removalMatchResult 初值仍为 null（countByMonth=0 无数据态保持 null，与 error 态区分）', () => {
    assert.ok(
      /let\s+removalMatchResult\s*=\s*null;/.test(mainSource),
      'removalMatchResult 初值必须保持 null —— 这是“无移除归档数据未触发核对”态，须与 error 态可区分'
    );
  });

  test('handler 仍把 removalMatch 透传给 renderer（status:success 路径）', () => {
    assert.ok(
      mainSource.includes('removalMatch: removalMatchResult'),
      'reconcile:run 返回体应携带 removalMatch: removalMatchResult'
    );
  });
});

describe('I-R2-1 — buildRemovalMatchSummary 三分支区分 (renderer-pending.js)', () => {
  test('error 态（{ error: true }）→「移除核对执行异常，请查看活动日志」', () => {
    // error 分支判定 + 专属文案都必须在源码中
    assert.ok(
      /if\s*\(\s*removalMatch\.error\s*\)/.test(rendererSource),
      'buildRemovalMatchSummary 必须含 removalMatch.error 分支判定'
    );
    assert.ok(
      rendererSource.includes('移除核对执行异常，请查看活动日志'),
      'error 态文案「移除核对执行异常，请查看活动日志」必须存在'
    );
  });

  test('正常对象态 → 三态摘要「已匹配 N / missing 未匹配 M / 移除未匹配 K」', () => {
    assert.ok(
      rendererSource.includes('移除核对：已匹配 ${matched} / missing 未匹配 ${missingUnmatched} / 移除未匹配 ${removedUnmatched}'),
      '正常对象态三态摘要文案必须保留'
    );
  });

  test('null 态（无数据）→「无移除归档数据，未执行移除核对」（保持原文案）', () => {
    assert.ok(
      rendererSource.includes('无移除归档数据，未执行移除核对'),
      'null（无移除归档数据）态文案必须保留，且与 error 态文案不同'
    );
  });

  test('error 文案 ≠ 无数据文案（两态不得混淆）', () => {
    const errMsg = '移除核对执行异常，请查看活动日志';
    const noDataMsg = '无移除归档数据，未执行移除核对';
    assert.notStrictEqual(errMsg, noDataMsg, 'error 态与无数据态文案必须不同（I-R2-1 核心：可区分）');
    assert.ok(
      !rendererSource.includes(`${errMsg}`) === false && rendererSource.includes(noDataMsg),
      '两段文案应同时存在于源码（三分支齐全）'
    );
  });
});
