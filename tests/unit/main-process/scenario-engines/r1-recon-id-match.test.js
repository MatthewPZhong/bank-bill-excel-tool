const test = require('node:test');
const assert = require('node:assert/strict');

const { runRound1ReconIdMatch } = require('../../../../src/main-process/scenario-engines/r1-recon-id-match');

// ========================================================================
// v2.1.16-beta.2 — R1 对账ID匹配引擎（TECH_DESIGN §5.1）
// 匹配口径：网关 reconciliationid（小写） === 银行 ReconciliationId（驼峰），大小写敏感。
// 严格 1v1（usedBankRowId 单向消费）；不改字段、不产 modification、不参与 first-match-wins 锁。
// ========================================================================

// 构造网关行（真实表头小写：对账ID = reconciliationid）
function gw(reconId, extra) {
  return Object.assign({ reconciliationid: reconId, TradeType: 'X' }, extra || {});
}
// 构造银行行（驼峰：对账ID = ReconciliationId；行唯一键 = _rowId）
function bank(rowId, reconId, extra) {
  return Object.assign({ _rowId: rowId, ReconciliationId: reconId, FundType: 'Charge' }, extra || {});
}

// 找出 pairs 中某网关行对应的银行行（按引用相等）
function bankPairedWith(result, gwRow) {
  const p = result.pairs.find((x) => x.gwRow === gwRow);
  return p ? p.bankRow : undefined;
}

test.describe('R1 — 正常 1v1 命中（① 引用关系正确）', () => {
  test('两条网关 ↔ 两条银行，各自精确命中，pairs gwRow/bankRow 为原引用', () => {
    const g1 = gw('R-001');
    const g2 = gw('R-002');
    const b1 = bank('rid-1', 'R-001');
    const b2 = bank('rid-2', 'R-002');
    const gwRows = [g1, g2];
    const bankRows = [b1, b2];

    const result = runRound1ReconIdMatch(bankRows, gwRows);

    assert.equal(result.matchedGwRows.length, 2);
    assert.equal(result.pairs.length, 2);
    // matchedGwRows 为原网关行引用
    assert.ok(result.matchedGwRows.includes(g1));
    assert.ok(result.matchedGwRows.includes(g2));
    // pairs 内 gwRow/bankRow 均为原引用，且配对正确（R-001 ↔ b1，R-002 ↔ b2）
    assert.strictEqual(bankPairedWith(result, g1), b1);
    assert.strictEqual(bankPairedWith(result, g2), b2);
    // 无 warning
    assert.equal(result.warnings.length, 0);
  });

  test('部分网关行无对应银行行 → 仅命中的进 matchedGwRows', () => {
    const g1 = gw('R-001');
    const gMiss = gw('R-404'); // 银行侧无此 reconid
    const b1 = bank('rid-1', 'R-001');

    const result = runRound1ReconIdMatch([b1], [g1, gMiss]);

    assert.equal(result.matchedGwRows.length, 1);
    assert.strictEqual(result.matchedGwRows[0], g1);
    assert.equal(result.pairs.length, 1);
    assert.strictEqual(bankPairedWith(result, g1), b1);
    assert.equal(bankPairedWith(result, gMiss), undefined);
  });
});

test.describe('R1 — ② 一个 reconid 对应多条银行行（取第一条 + warn + 单向消费）', () => {
  test('一条网关 reconid 命中两条银行行 → 取银行原序第一条 + multi-bank-match-r1 warning', () => {
    const g1 = gw('DUP');
    const b1 = bank('rid-1', 'DUP'); // 原序第一
    const b2 = bank('rid-2', 'DUP'); // 原序第二

    const result = runRound1ReconIdMatch([b1, b2], [g1]);

    assert.equal(result.pairs.length, 1);
    // 取银行原序第一条
    assert.strictEqual(bankPairedWith(result, g1), b1);

    const w = result.warnings.find((x) => x.code === 'multi-bank-match-r1');
    assert.ok(w, '应产出 multi-bank-match-r1 warning');
    assert.equal(w.reconId, 'DUP');
    assert.equal(w.scenarioId, 'R1');
    assert.equal(w.scenarioName, '对账ID匹配');
  });

  test('两条网关同 reconid + 两条银行同 reconid → 1v1 单向消费：第二条网关命中第二条银行', () => {
    const g1 = gw('DUP');
    const g2 = gw('DUP');
    const b1 = bank('rid-1', 'DUP');
    const b2 = bank('rid-2', 'DUP');

    const result = runRound1ReconIdMatch([b1, b2], [g1, g2]);

    assert.equal(result.pairs.length, 2);
    // g1 命中 b1（取第一条 + 因当时有 2 候选 → warn）
    assert.strictEqual(bankPairedWith(result, g1), b1);
    // g2 命中 b2（b1 已被 g1 消费 → 只剩 b2，单向消费生效）
    assert.strictEqual(bankPairedWith(result, g2), b2);
    // b1、b2 各被命中一次（无重复占用）
    const pairedBankRows = result.pairs.map((p) => p.bankRow);
    assert.equal(new Set(pairedBankRows).size, 2);
  });

  test('两条网关同 reconid 但只有一条银行行 → 第二条网关未命中（银行行被抢空）', () => {
    const g1 = gw('DUP');
    const g2 = gw('DUP');
    const b1 = bank('rid-1', 'DUP');

    const result = runRound1ReconIdMatch([b1], [g1, g2]);

    assert.equal(result.matchedGwRows.length, 1);
    assert.strictEqual(result.matchedGwRows[0], g1);
    assert.strictEqual(bankPairedWith(result, g1), b1);
    assert.equal(bankPairedWith(result, g2), undefined);
  });
});

test.describe('R1 — ③ 空 reconid 跳过（网关侧 / 银行侧）', () => {
  test('网关行空/空白 reconid → 跳过不参与匹配', () => {
    const gEmpty = gw('');
    const gBlank = gw('   '); // normalizeCellValue trim 后为空
    const gNull = gw(null);
    const gUndef = gw(undefined);
    const gOk = gw('R-OK');
    const b1 = bank('rid-1', 'R-OK');

    const result = runRound1ReconIdMatch([b1], [gEmpty, gBlank, gNull, gUndef, gOk]);

    assert.equal(result.matchedGwRows.length, 1);
    assert.strictEqual(result.matchedGwRows[0], gOk);
  });

  test('银行行空/空白 reconid → 不入索引，不会被命中', () => {
    const g1 = gw(''); // 网关空 reconid（即便不跳过也不该命中银行空 reconid）
    const g2 = gw('R-OK');
    const bEmpty = bank('rid-empty', '');
    const bBlank = bank('rid-blank', '  ');
    const bOk = bank('rid-ok', 'R-OK');

    const result = runRound1ReconIdMatch([bEmpty, bBlank, bOk], [g1, g2]);

    assert.equal(result.pairs.length, 1);
    assert.strictEqual(bankPairedWith(result, g2), bOk);
    // 空 reconid 的银行行未被任何配对占用
    const pairedBankRows = result.pairs.map((p) => p.bankRow);
    assert.ok(!pairedBankRows.includes(bEmpty));
    assert.ok(!pairedBankRows.includes(bBlank));
  });
});

test.describe('R1 — ④ gwRows 为空/非数组 → no-gateway-rows warning + 空结果', () => {
  test('gwRows = [] → warning + 空结果', () => {
    const result = runRound1ReconIdMatch([bank('rid-1', 'R-001')], []);
    assert.deepEqual(result.matchedGwRows, []);
    assert.deepEqual(result.pairs, []);
    const w = result.warnings.find((x) => x.code === 'no-gateway-rows');
    assert.ok(w, '应产出 no-gateway-rows warning');
    assert.equal(w.scenarioId, 'R1');
  });

  test('gwRows = null / undefined → warning + 空结果（不崩）', () => {
    for (const bad of [null, undefined]) {
      const result = runRound1ReconIdMatch([bank('rid-1', 'R-001')], bad);
      assert.deepEqual(result.matchedGwRows, []);
      assert.deepEqual(result.pairs, []);
      assert.ok(result.warnings.some((x) => x.code === 'no-gateway-rows'));
    }
  });

  test('bankRows 为空但 gwRows 有值 → 无命中、无 warning（非 no-gateway-rows 场景）', () => {
    const result = runRound1ReconIdMatch([], [gw('R-001')]);
    assert.deepEqual(result.matchedGwRows, []);
    assert.deepEqual(result.pairs, []);
    assert.equal(result.warnings.length, 0);
  });
});

test.describe('R1 — ⑤ 契约：不改字段 + modifications=[] + lockedRowIds.size===0', () => {
  test('modifications 恒为空数组、lockedRowIds 为空 Set，且输入 bankRows/gwRows 字段未被改动', () => {
    const g1 = gw('R-001', { amount: 100, orderid: 'O-1' });
    const b1 = bank('rid-1', 'R-001', { 'Credit Amount': 100, 'Debit Amount': 0 });

    // 深拷贝输入快照（用于事后逐字段比对）
    const gwSnapshot = structuredClone([g1]);
    const bankSnapshot = structuredClone([b1]);

    const result = runRound1ReconIdMatch([b1], [g1]);

    // 命中成立（确保不是因为没匹配才没改）
    assert.equal(result.pairs.length, 1);

    // R1 不产 modification、不参与锁
    assert.deepEqual(result.modifications, []);
    assert.ok(result.lockedRowIds instanceof Set);
    assert.equal(result.lockedRowIds.size, 0);

    // 输入行字段逐字段未被改动（含 _rowId / reconid / 金额 / FundType 等）
    assert.deepEqual([g1], gwSnapshot);
    assert.deepEqual([b1], bankSnapshot);
  });
});

test.describe('R1 — ⑥ 大小写敏感（当前默认行为，记录之）', () => {
  test("网关 reconid 'abc' vs 银行 'ABC' → 大小写不同 → 不命中", () => {
    const gLower = gw('abc');
    const bUpper = bank('rid-1', 'ABC');

    const result = runRound1ReconIdMatch([bUpper], [gLower]);

    assert.equal(result.matchedGwRows.length, 0);
    assert.equal(result.pairs.length, 0);
    assert.equal(result.warnings.length, 0); // 未命中 ≠ 多匹配，不产 warning
  });

  test('大小写完全一致才命中（同 case 命中）', () => {
    const g1 = gw('abc');
    const b1 = bank('rid-1', 'abc');
    const result = runRound1ReconIdMatch([b1], [g1]);
    assert.equal(result.pairs.length, 1);
    assert.strictEqual(bankPairedWith(result, g1), b1);
  });
});
