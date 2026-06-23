// v3.0.11 需求3（批1 · 🔴 资金红线）：银行对账单处理模块统一 operation lock 单测。
//   背景：import(bank-statement:batch-import) / run(bank-statement:run) / export(bank-statement:export)
//   三动作共享全局会话态（bankStatementSession / processingResult / refundOrderSession），必须用同一把
//   互斥锁串行化，避免并发撕裂状态。
//
//   测试形态（main.js 是 Electron 主进程入口、无 module.exports、require 即引导 Electron，不能直接 require）：
//   - Part A：grep 真实源码，断言锁定义 + 三 handler 接线 + 争用文案 + finally 释放（仿 renderer-status-box-text.test.js 范式）。
//   - Part B：从真实源码抽出自包含的锁实现块 → new Function eval → 验证「三动作两两互斥 + 释放后可重入」语义（测真实实现，非副本）。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_PATH = path.join(__dirname, '..', '..', 'src', 'main.js');
const source = fs.readFileSync(MAIN_PATH, 'utf8');

// 从真实源码抽出 op-lock 实现块（自包含：仅引用块内 bankStatementOperationLock，无外部依赖）。
//   每次调用返回一份全新闭包实例（独立锁状态）→ 各用例互不干扰。
function loadRealLock() {
  const block = source.match(
    /const bankStatementOperationLock = \{[\s\S]*?\nfunction releaseBankStatementOpLock\(\) \{[\s\S]*?\n\}/
  );
  assert.ok(block, '应能从 src/main.js 抽出 bankStatementOperationLock 实现块');
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    `${block[0]}\nreturn { tryAcquireBankStatementOpLock, releaseBankStatementOpLock, bankStatementOperationLock };`
  );
  return factory();
}

describe('bank-statement op-lock — 源码接线 (v3.0.11 需求3 批1)', () => {
  test('统一互斥锁定义存在（一把锁，含 inFlight/operation）', () => {
    assert.ok(
      source.includes('const bankStatementOperationLock = { inFlight: false, operation: null };'),
      'bankStatementOperationLock 应为模块级单例锁对象'
    );
    assert.ok(source.includes('function tryAcquireBankStatementOpLock(operation)'),
      'tryAcquireBankStatementOpLock 获取函数应存在');
    assert.ok(source.includes('function releaseBankStatementOpLock()'),
      'releaseBankStatementOpLock 释放函数应存在');
  });

  test('三动作 handler 各自 acquire 同一把锁（import/run/export）', () => {
    assert.ok(source.includes("tryAcquireBankStatementOpLock('run')"), 'run handler 应 acquire');
    assert.ok(source.includes("tryAcquireBankStatementOpLock('export')"), 'export handler 应 acquire');
    assert.ok(source.includes("tryAcquireBankStatementOpLock('import')"), 'batch-import handler 应 acquire');
  });

  test('争用返回 { status:"failed", message:"正在处理中…" }', () => {
    assert.ok(source.includes("return { acquired: false, message: '正在处理中…' };"),
      '争用时 tryAcquire 应返回固定文案');
    const contention = source.match(/return \{ status: 'failed', message: opLock\.message \};/g) || [];
    assert.strictEqual(contention.length, 3, '三 handler 各有一处「争用即返回失败」短路');
  });

  test('三 handler 各在 finally 释放锁（恰 3 处 release）', () => {
    const releases = source.match(/releaseBankStatementOpLock\(\);/g) || [];
    assert.strictEqual(releases.length, 3, 'import/run/export 三处 finally 各释放一次');
  });
});

describe('bank-statement op-lock — 互斥语义 (三动作并发被挡)', () => {
  test('import 持锁时 run / export 并发被挡', () => {
    const { tryAcquireBankStatementOpLock } = loadRealLock();
    assert.deepStrictEqual(tryAcquireBankStatementOpLock('import'), { acquired: true });
    const run = tryAcquireBankStatementOpLock('run');
    assert.strictEqual(run.acquired, false, 'import 持锁 → run 被挡');
    assert.strictEqual(run.message, '正在处理中…');
    const exp = tryAcquireBankStatementOpLock('export');
    assert.strictEqual(exp.acquired, false, 'import 持锁 → export 被挡');
  });

  test('释放后另一动作可重新获取（不死锁）', () => {
    const { tryAcquireBankStatementOpLock, releaseBankStatementOpLock } = loadRealLock();
    assert.strictEqual(tryAcquireBankStatementOpLock('run').acquired, true);
    assert.strictEqual(tryAcquireBankStatementOpLock('export').acquired, false, '运行中 → 导出被挡');
    releaseBankStatementOpLock();
    assert.strictEqual(tryAcquireBankStatementOpLock('export').acquired, true, '释放后 → 导出可获取');
  });

  test('三动作两两互斥（共享同一把锁）', () => {
    const ops = ['import', 'run', 'export'];
    for (const first of ops) {
      const { tryAcquireBankStatementOpLock, releaseBankStatementOpLock } = loadRealLock();
      assert.strictEqual(tryAcquireBankStatementOpLock(first).acquired, true, `${first} 应可获取`);
      for (const second of ops) {
        assert.strictEqual(tryAcquireBankStatementOpLock(second).acquired, false,
          `${first} 持锁时 ${second} 必被挡`);
      }
      releaseBankStatementOpLock();
    }
  });
});
