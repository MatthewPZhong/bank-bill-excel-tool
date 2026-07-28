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

// 从真实源码抽出 op-lock 实现块，并注入安装过渡闸门依赖。
//   每次调用返回一份全新闭包实例（独立锁状态）→ 各用例互不干扰。
function loadRealLock({ installTransitionActive = false } = {}) {
  const block = source.match(
    /const bankStatementOperationLock = \{[\s\S]*?\nfunction releaseBankStatementOpLock\(\) \{[\s\S]*?\n\}/
  );
  assert.ok(block, '应能从 src/main.js 抽出 bankStatementOperationLock 实现块');
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'businessOperationRegistry',
    'INSTALL_BUSY_MESSAGE',
    `${block[0]}\nreturn { tryAcquireBankStatementOpLock, releaseBankStatementOpLock, bankStatementOperationLock };`
  );
  return factory(
    { isInstallTransitionActive: () => installTransitionActive },
    '正在准备升级，暂时不能开始新的任务。'
  );
}

const EXISTING_OPS = [
  'run', 'export', 'import', 'linked-import', 'linked-delete', 'account-mapping-save'
];
const PRE_FUND_OPS = [
  'pre-fund-import-bank', 'pre-fund-import-mpt', 'pre-fund-delete-temp',
  'pre-fund-export-mpt-errors', 'pre-fund-repair-mpt-errors',
  'pre-fund-delete-temp-by-date-range', 'pre-fund-clear-temp', 'pre-fund-run', 'pre-fund-export'
];
const DUPLICATE_INBOUND_OPS = [
  'duplicate-inbound-import-files', 'duplicate-inbound-run', 'duplicate-inbound-export'
];
const POSITION_RECONCILIATION_OPS = [
  'bank-import', 'bank-import-apply', 'source-import', 'source-import-apply',
  'mapping-save', 'bank-delete', 'source-delete', 'bank-export', 'linked-export',
  'raw-export', 'run', 'result-export', 'result-import', 'result-confirm'
].map((operation) => `position-reconciliation-${operation}`);
const ALL_LOCKED_OPS = [
  ...EXISTING_OPS,
  ...PRE_FUND_OPS,
  ...DUPLICATE_INBOUND_OPS,
  ...POSITION_RECONCILIATION_OPS
];

describe('bank-statement op-lock — 源码接线 (v3.0.11 至 v3.1.0)', () => {
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

  test('既有、前置资金、重复入金和平盘动作均 acquire 同一把锁', () => {
    assert.ok(source.includes("tryAcquireBankStatementOpLock('run')"), 'run handler 应 acquire');
    assert.ok(source.includes("tryAcquireBankStatementOpLock('export')"), 'export handler 应 acquire');
    assert.ok(source.includes("tryAcquireBankStatementOpLock('import')"), 'batch-import handler 应 acquire');
    // v3.0.11 codex-P2 补强：链接表写入（import / delete-by-date-range）纳入同一把锁
    //   —— 链接表是 bank-statement run（R1-R5）输入，防 run 数据准备让出窗口内并发改表撕裂快照。
    assert.ok(source.includes("tryAcquireBankStatementOpLock('linked-import')"), 'linked-table:import 应 acquire');
    assert.ok(source.includes("tryAcquireBankStatementOpLock('linked-delete')"), 'linked-table:delete-by-date-range 应 acquire');
    // v3.0.12 PR#82 codex-P2 补强：账户映射保存（改写调拨派生 big_account，同为 bank-statement run 输入）纳入同一把锁。
    assert.ok(source.includes("tryAcquireBankStatementOpLock('account-mapping-save')"), 'fund-transfer-account-mapping:save 应 acquire');
    for (const operation of PRE_FUND_OPS) {
      assert.ok(
        source.includes(`tryAcquireBankStatementOpLock('${operation}')`),
        `${operation} handler 应 acquire`
      );
    }
    for (const operation of DUPLICATE_INBOUND_OPS) {
      assert.ok(
        source.includes(`tryAcquireBankStatementOpLock('${operation}')`),
        `${operation} handler 应 acquire`
      );
    }
    assert.ok(
      source.includes('tryAcquireBankStatementOpLock(`position-reconciliation-${operation}`)'),
      '平盘动作统一由 withPositionReconciliationLock acquire 同一把锁'
    );
    for (const operation of POSITION_RECONCILIATION_OPS) {
      const localOperation = operation.replace('position-reconciliation-', '');
      assert.ok(
        source.includes(`withPositionReconciliationLock('${localOperation}'`),
        `${operation} handler 应走平盘统一锁包装`
      );
    }
  });

  test('争用返回 { status:"failed", message:"正在处理中…" }', () => {
    assert.ok(source.includes("return { acquired: false, message: '正在处理中…' };"),
      '争用时 tryAcquire 应返回固定文案');
    const contention = source.match(/return \{ status: 'failed', message: opLock\.message \};/g) || [];
    assert.strictEqual(contention.length, 6, '六 handler（run/export/import + linked-import/linked-delete + account-mapping-save）各有一处「争用即返回失败」短路');
    const preFundContention = source.match(/return \{ status: 'busy', message: lock\.message \};/g) || [];
    assert.strictEqual(
      preFundContention.length,
      PRE_FUND_OPS.length + DUPLICATE_INBOUND_OPS.length + 1,
      '前置资金9个、重复入金3个 handler及平盘统一包装各有 busy 短路'
    );
  });

  test('直接 handler 与平盘统一包装都在 finally 释放锁', () => {
    const releases = source.match(/releaseBankStatementOpLock\(\);/g) || [];
    assert.strictEqual(
      releases.length,
      EXISTING_OPS.length + PRE_FUND_OPS.length + DUPLICATE_INBOUND_OPS.length + 1,
      '既有6个、前置资金9个、重复入金3个直接入口，加平盘统一包装各释放一次'
    );
  });
});

describe('bank-statement op-lock — 互斥语义 (三动作并发被挡)', () => {
  test('安装过渡开始后拒绝新动作且不占用业务锁', () => {
    const { tryAcquireBankStatementOpLock, bankStatementOperationLock } = loadRealLock({
      installTransitionActive: true
    });

    assert.deepStrictEqual(tryAcquireBankStatementOpLock('run'), {
      acquired: false,
      message: '正在准备升级，暂时不能开始新的任务。'
    });
    assert.strictEqual(bankStatementOperationLock.inFlight, false);
  });

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

  test('全部已登记动作两两互斥（共享同一把锁）', () => {
    for (const first of ALL_LOCKED_OPS) {
      const { tryAcquireBankStatementOpLock, releaseBankStatementOpLock } = loadRealLock();
      assert.strictEqual(tryAcquireBankStatementOpLock(first).acquired, true, `${first} 应可获取`);
      for (const second of ALL_LOCKED_OPS) {
        assert.strictEqual(tryAcquireBankStatementOpLock(second).acquired, false,
          `${first} 持锁时 ${second} 必被挡`);
      }
      releaseBankStatementOpLock();
    }
  });

  // v3.0.12 PR#82 codex-P2：账户映射保存（改写调拨派生 big_account）必须在 run/export 持锁期间被拒——
  //   否则 run 轮次间 yield 窗口内保存 → 清 processingResult 后被仍在跑的 run 用旧映射结果覆盖 → 可导出 stale。
  test('run/export 持锁期间 account-mapping-save 被拒（防清 processingResult 后被 stale run 覆盖）', () => {
    for (const holder of ['run', 'export']) {
      const { tryAcquireBankStatementOpLock, releaseBankStatementOpLock } = loadRealLock();
      assert.strictEqual(tryAcquireBankStatementOpLock(holder).acquired, true, `${holder} 应可获取`);
      const save = tryAcquireBankStatementOpLock('account-mapping-save');
      assert.strictEqual(save.acquired, false, `${holder} 持锁期间 account-mapping-save 必被拒`);
      assert.strictEqual(save.message, '正在处理中…', '被拒返回统一争用文案');
      releaseBankStatementOpLock();
      assert.strictEqual(tryAcquireBankStatementOpLock('account-mapping-save').acquired, true,
        '释放后 account-mapping-save 可获取（不死锁）');
    }
  });
});
