// v3.0.0 需求3（PR-4 bug 修订）🔴 资金红线（退款回填）：退款 session「就绪判据」从前端缓存改为实时查 单测护栏
//
// 背景（PR-4 bug）：导渠道账单 → 弹退款提醒 → 批量导入「仅退款表」批次（hasBankStatementOk=false）
//   → main 已落 refundOrderSession（真实就绪），但该批次走 else 分支只 updateBankStatementUi()、
//   不调 refreshBankStatementStatus → 前端缓存 state.refundOrderSession 滞后未刷新 → 点「开始运行」时
//   shouldPromptRefundAtRun 读滞后缓存误判「未导退款表」→ 重复弹退款提醒（不应弹）。
// 修复（方案A，与 PR-3 isGatewayBillReady 一致）：抽 isRefundOrderReady() 实时查 main 端
//   session-status 的 hasRefundOrder；shouldPromptRefundAtRun 的就绪门控改用 isRefundOrderReady()。
//
// 取函数策略：renderer.js 顶层有 performance.now()/window 等浏览器副作用，整文件 require 会立即抛错；
//   故从源码字符串按花括号配对切出 isRefundOrderReady 函数体，用 new Function 实例化并注入 mock
//   window.desktopApi.bankStatement.sessionStatus，测真实源码行为（不触发顶层副作用）。
//   参考 tests/unit/renderer-c3-gateway-ready-guard.test.js 同款护栏范式。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_PATH = path.join(__dirname, '..', '..', 'src', 'renderer.js');

const source = fs.readFileSync(RENDERER_PATH, 'utf8');

// 从源码切出 `(async )?function ${fnName}(...) { ... }` 整段（花括号配对）。
//   关键：若声明带前导 `async`，必须一并切入，否则 new Function 实例化时函数体内 await 非法。
function extractFunctionSource(src, fnName) {
  const signature = `function ${fnName}(`;
  let start = src.indexOf(signature);
  if (start === -1) throw new Error(`未在 renderer.js 找到 ${fnName} 定义`);
  const asyncPrefix = 'async ';
  if (src.slice(start - asyncPrefix.length, start) === asyncPrefix) {
    start -= asyncPrefix.length;
  }
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i);
}

// 去掉 `//` 行注释（保留代码），用于「不再用前端缓存」类断言——避免命中注释里出现的变量名。
function stripLineComments(src) {
  return src.split('\n').map((line) => {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

// 实例化 isRefundOrderReady：注入 mock window（含 desktopApi.bankStatement.sessionStatus）+ console。
function loadIsRefundOrderReady(sessionStatusImpl) {
  const fnSource = extractFunctionSource(source, 'isRefundOrderReady');
  let callCount = 0;
  const win = {
    desktopApi: {
      bankStatement: {
        sessionStatus: async () => {
          callCount += 1;
          return sessionStatusImpl();
        }
      }
    }
  };
  const consoleStub = { warn() {}, error() {}, log() {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function('window', 'console', `${fnSource}\nreturn isRefundOrderReady;`);
  return { fn: factory(win, consoleStub), getCallCount: () => callCount };
}

describe('isRefundOrderReady — 行为（PR-4 bug 修订：实时查 session-status hasRefundOrder）', () => {
  test('status=ok 且 hasRefundOrder=true → true（main 端退款已就绪）', async () => {
    const { fn, getCallCount } = loadIsRefundOrderReady(() => ({ status: 'ok', hasRefundOrder: true }));
    assert.strictEqual(await fn(), true);
    // 🔴 必须实时查一次 session-status（不读前端缓存）
    assert.strictEqual(getCallCount(), 1);
  });

  test('status=ok 但 hasRefundOrder=false → false（本批未导退款表 = 未就绪 = 仍提醒）', async () => {
    const { fn } = loadIsRefundOrderReady(() => ({ status: 'ok', hasRefundOrder: false }));
    assert.strictEqual(await fn(), false);
  });

  test('hasRefundOrder 缺失 / null / undefined / 0 / "" → 一律 false（falsy 即未就绪）', async () => {
    const bad = [
      { status: 'ok' },                          // 缺失
      { status: 'ok', hasRefundOrder: null },
      { status: 'ok', hasRefundOrder: undefined },
      { status: 'ok', hasRefundOrder: 0 },
      { status: 'ok', hasRefundOrder: '' }
    ];
    for (const r of bad) {
      const { fn } = loadIsRefundOrderReady(() => r);
      assert.strictEqual(await fn(), false, `${JSON.stringify(r)} 应判未就绪`);
    }
  });

  test('status=failed（即便 hasRefundOrder=true）→ false（非 ok 一律未就绪）', async () => {
    const { fn } = loadIsRefundOrderReady(() => ({ status: 'failed', hasRefundOrder: true }));
    assert.strictEqual(await fn(), false);
  });

  test('返回 null / undefined / 空对象 → false（短路保护）', async () => {
    for (const r of [null, undefined, {}]) {
      const { fn } = loadIsRefundOrderReady(() => r);
      assert.strictEqual(await fn(), false, `${JSON.stringify(r)} 应判未就绪`);
    }
  });

  test('IPC reject（throw）→ catch 返回 false（保守防漏回填，按未就绪仍提醒）', async () => {
    const { fn } = loadIsRefundOrderReady(() => { throw new Error('ipc boom'); });
    assert.strictEqual(await fn(), false);
  });
});

// ---- 源码 grep 护栏：锁关键不变量 ----

describe('isRefundOrderReady — 源码护栏（实时查 / catch 兜底 / 运行点门控改用）', () => {
  test('① isRefundOrderReady 存在且实时查 session-status', () => {
    assert.ok(/async\s+function\s+isRefundOrderReady\s*\(/.test(source),
      '应存在 async function isRefundOrderReady');
    assert.ok(source.includes('window.desktopApi.bankStatement.sessionStatus()'),
      'isRefundOrderReady 应实时查 window.desktopApi.bankStatement.sessionStatus()');
  });

  test('② 判据：status===ok && hasRefundOrder', () => {
    const fn = extractFunctionSource(source, 'isRefundOrderReady');
    assert.ok(/status\.status\s*===\s*'ok'\s*&&\s*status\.hasRefundOrder/.test(fn),
      '就绪判据应为 status.status===ok && status.hasRefundOrder');
  });

  test('③ 异常按未就绪：catch 内 return false', () => {
    const fn = extractFunctionSource(source, 'isRefundOrderReady');
    assert.ok(/catch\s*\([^)]*\)\s*\{[\s\S]*return\s+false;[\s\S]*\}/.test(fn),
      'isRefundOrderReady catch 分支应 return false（保守防漏回填）');
  });

  test('④ 🔴 运行点门控改用 isRefundOrderReady()：shouldPromptRefundAtRun 不再读 state.refundOrderSession', () => {
    const fn = extractFunctionSource(source, 'shouldPromptRefundAtRun');
    assert.ok(/if\s*\(\s*await\s+isRefundOrderReady\(\)\s*\)\s*return false/.test(fn),
      'shouldPromptRefundAtRun 应有 if (await isRefundOrderReady()) return false;');
    const code = stripLineComments(fn);
    assert.ok(!code.includes('state.refundOrderSession'),
      '🔴 PR-4 bug 修订核心：shouldPromptRefundAtRun 代码不得再用前端缓存 state.refundOrderSession 作就绪门控');
  });

  test('⑤ maybePromptRefundOrderImport（导入后提醒）判据基于本批 results，不依赖 state.refundOrderSession', () => {
    // 导入后提醒应据本批 results 是否含 zhongtai-refund-order ok 决定，不读 state 缓存。
    const fn = extractFunctionSource(source, 'maybePromptRefundOrderImport');
    const code = stripLineComments(fn);
    assert.ok(!code.includes('state.refundOrderSession'),
      'maybePromptRefundOrderImport 不应依赖 state.refundOrderSession（判据是本批 results 的 hasRefundOk）');
    assert.ok(fn.includes("r.tableKey === 'zhongtai-refund-order'"),
      '导入后提醒判据应基于本批 results 的 zhongtai-refund-order ok');
  });
});
