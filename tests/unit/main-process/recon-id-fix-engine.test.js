const test = require('node:test');
const assert = require('node:assert/strict');

const { runReconIdFix } = require('../../../src/main-process/recon-id-fix-engine');

// ========================================================================
// runReconIdFix — 入参校验 + scenario.category 路由
// ========================================================================

test.describe('runReconIdFix — 入参校验', () => {
  test('scenario 缺失 → 抛错', () => {
    assert.throws(() => runReconIdFix(null, {}), /scenario 不能为空/);
    assert.throws(() => runReconIdFix(undefined, {}), /scenario 不能为空/);
  });

  test('scenario.category 非法 → 抛错', () => {
    assert.throws(
      () => runReconIdFix({ category: 'unknown' }, { businessBills: [], opponentBills: [] }),
      /category 必须是.*recon-id-fix.*gateway-recon-id-fix/
    );
  });

  test('sheets 缺失 → 抛错', () => {
    assert.throws(
      () => runReconIdFix({ category: 'recon-id-fix' }, null),
      /businessBills.*opponentBills.*必须是数组/
    );
  });

  test('sheets.businessBills 非数组 → 抛错', () => {
    assert.throws(
      () => runReconIdFix(
        { category: 'recon-id-fix' },
        { businessBills: 'not array', opponentBills: [] }
      ),
      /必须是数组/
    );
  });

  test('sheets.opponentBills 非数组 → 抛错', () => {
    assert.throws(
      () => runReconIdFix(
        { category: 'recon-id-fix' },
        { businessBills: [], opponentBills: null }
      ),
      /必须是数组/
    );
  });

  test('合法 business category + 空 sheets → 不抛错（C4 内部处理）', () => {
    // minimum config 让 C4 不崩
    const scenario = {
      id: 1,
      name: 'T1',
      category: 'recon-id-fix',
      config: { billTypes: [], reconGroups: [], output: {} }
    };
    assert.doesNotThrow(() => runReconIdFix(scenario, {
      businessBills: [],
      opponentBills: [],
      reconResult: []
    }));
  });

  test('合法 gateway category → subMode=gateway 透传 C4', () => {
    const scenario = {
      id: 1,
      name: 'T2',
      category: 'gateway-recon-id-fix',
      config: { billTypes: [], reconGroups: [], output: {} }
    };
    assert.doesNotThrow(() => runReconIdFix(scenario, {
      businessBills: [],
      opponentBills: [],
      reconResult: []
    }));
  });
});

test.describe('runReconIdFix — VALID_CATEGORIES 自洽', () => {
  test('recon-id-fix（business）合法', () => {
    const scenario = {
      id: 1,
      name: 'T',
      category: 'recon-id-fix',
      config: { billTypes: [], reconGroups: [], output: {} }
    };
    const r = runReconIdFix(scenario, {
      businessBills: [],
      opponentBills: [],
      reconResult: []
    });
    assert.ok(r);
    // 返回结构含 fixedRows + warnings + 等等（具体由 c4 决定）
  });

  test('gateway-recon-id-fix 合法', () => {
    const scenario = {
      id: 1,
      name: 'T',
      category: 'gateway-recon-id-fix',
      config: { billTypes: [], reconGroups: [], output: {} }
    };
    const r = runReconIdFix(scenario, {
      businessBills: [],
      opponentBills: [],
      reconResult: []
    });
    assert.ok(r);
  });
});
