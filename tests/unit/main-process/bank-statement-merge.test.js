// v2.1.16 阶段一 A5：银行对账单批量导入「合并对账」核心纯函数单测（🔴 资金红线）
//
// 由开发期临时脚本 scripts/tmp-a5-batch-import-check.js 的合并断言转正（node:test，纳入 release-check）。
//   tmp-a5 用真实 Electron-外 链路 + 自定义断言验证；本测试直接对抽离的 mergeBankStatementRows 纯函数断言，
//   并复刻 handler 合并流程（mockState 替代全局 session）覆盖双文件合并 / headers 拦截 / 单文件回归。
//
// 🔴 资金红线不变量（绝不能回退）：
//   1) 多文件合并 = 追加不覆盖：合并后行数 = 各文件行数之和
//   2) _rowId 全局唯一且连续（row_0..row_N，0-based 跨文件）——否则 dispatcher rowLockSet 漏对 / 误锁
//   3) headers 不一致 → 抛 BankStatementMergeError（异构表拒绝合并，不污染对账数据集）
//   4) 单文件（首份）= 原单选导入行为：建集、不校验 headers、_rowId 唯一

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeBankStatementRows,
  bankStatementHeadersEqual,
  BankStatementMergeError
} = require('../../../src/main-process/bank-statement-merge');

// 造 N 行（每行带文件内 _rowId，模拟 readBankStatement 注入的 row_0..row_{N-1}），tag 标来源文件。
function makeFileRows(n, tag) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({ _rowId: `row_${i}`, tag, seq: i });
  }
  return rows;
}

const HEADERS_44 = Object.freeze(Array.from({ length: 44 }, (_v, i) => `col_${i}`));

test.describe('bankStatementHeadersEqual', () => {
  test('相同 headers → true', () => {
    assert.equal(bankStatementHeadersEqual(['a', 'b', 'c'], ['a', 'b', 'c']), true);
  });
  test('列数不同 → false', () => {
    assert.equal(bankStatementHeadersEqual(['a', 'b'], ['a', 'b', 'c']), false);
  });
  test('列名不同 → false', () => {
    assert.equal(bankStatementHeadersEqual(['a', 'b'], ['a', 'X']), false);
  });
  test('顺序不同 → false（按位逐列比对）', () => {
    assert.equal(bankStatementHeadersEqual(['a', 'b'], ['b', 'a']), false);
  });
  test('非数组入参 → false', () => {
    assert.equal(bankStatementHeadersEqual(null, ['a']), false);
    assert.equal(bankStatementHeadersEqual(['a'], undefined), false);
  });
  test('String 归一比对（数字 1 与字符串 "1" 视为相等）', () => {
    assert.equal(bankStatementHeadersEqual([1, 2], ['1', '2']), true);
  });
});

test.describe('mergeBankStatementRows — 首份（建集，不校验 headers）', () => {
  test('existingRows=null → isAppend=false，rows = newRows，headers = newHeaders', () => {
    const newRows = makeFileRows(3, 'A');
    const merged = mergeBankStatementRows(null, newRows, null, HEADERS_44);
    assert.equal(merged.isAppend, false);
    assert.equal(merged.rows.length, 3);
    assert.deepEqual(merged.headers, HEADERS_44);
  });

  test('首份也统一重编号 _rowId（row_0..row_{N-1}）', () => {
    const merged = mergeBankStatementRows([], makeFileRows(5, 'A'), null, HEADERS_44);
    assert.deepEqual(merged.rows.map((r) => r._rowId), ['row_0', 'row_1', 'row_2', 'row_3', 'row_4']);
  });

  test('首份不校验 headers（existing 为空时即使 newHeaders 任意也不抛）', () => {
    assert.doesNotThrow(() => mergeBankStatementRows(null, makeFileRows(2, 'A'), null, ['x', 'y']));
  });

  test('newRows 为空数组 → 0 行（合法空集）', () => {
    const merged = mergeBankStatementRows(null, [], null, HEADERS_44);
    assert.equal(merged.rows.length, 0);
    assert.equal(merged.isAppend, false);
  });
});

test.describe('mergeBankStatementRows — 追加合并（🔴 资金红线）', () => {
  test('双文件合并：rows 数 = 两文件之和（6629 + 3259 = 9888，不覆盖）', () => {
    const fileA = makeFileRows(6629, 'A');
    const fileB = makeFileRows(3259, 'B');
    const first = mergeBankStatementRows(null, fileA, null, HEADERS_44);
    const merged = mergeBankStatementRows(first.rows, fileB, first.headers, HEADERS_44);
    assert.equal(merged.isAppend, true);
    assert.equal(merged.rows.length, 9888, '合并 = 追加不覆盖，行数为两文件之和');
  });

  test('🔴 _rowId 全局唯一无重复且连续（row_0..row_9887，跨文件 0-based）', () => {
    const first = mergeBankStatementRows(null, makeFileRows(6629, 'A'), null, HEADERS_44);
    const merged = mergeBankStatementRows(first.rows, makeFileRows(3259, 'B'), first.headers, HEADERS_44);
    const ids = merged.rows.map((r) => r._rowId);
    // 全局唯一
    assert.equal(new Set(ids).size, 9888, '_rowId 全局唯一无重复');
    // 连续 0-based
    assert.equal(ids[0], 'row_0');
    assert.equal(ids[6628], 'row_6628'); // 文件 A 末行
    assert.equal(ids[6629], 'row_6629'); // 文件 B 首行（跨文件接续，不回到 row_0）
    assert.equal(ids[9887], 'row_9887'); // 文件 B 末行
    // 严格等于 row_0..row_9887 序列
    const expected = Array.from({ length: 9888 }, (_v, i) => `row_${i}`);
    assert.deepEqual(ids, expected, '_rowId 严格为 row_0..row_9887 连续序列');
  });

  test('合并后两文件来源行都保留（追加不丢行 + 文件 B 行原文件内 _rowId 被全局覆盖）', () => {
    const first = mergeBankStatementRows(null, makeFileRows(3, 'A'), null, HEADERS_44);
    const merged = mergeBankStatementRows(first.rows, makeFileRows(2, 'B'), first.headers, HEADERS_44);
    assert.equal(merged.rows.filter((r) => r.tag === 'A').length, 3);
    assert.equal(merged.rows.filter((r) => r.tag === 'B').length, 2);
    // 文件 B 首行原本是 row_0，合并后被重编号为 row_3（证明全局覆盖文件内编号）
    const firstBRow = merged.rows.find((r) => r.tag === 'B' && r.seq === 0);
    assert.equal(firstBRow._rowId, 'row_3', '文件 B 首行 _rowId 由 row_0 → row_3（全局重编号覆盖文件内编号）');
  });

  test('三文件连续合并：行数累加 + _rowId 始终全局连续', () => {
    let acc = mergeBankStatementRows(null, makeFileRows(10, 'A'), null, HEADERS_44);
    acc = mergeBankStatementRows(acc.rows, makeFileRows(20, 'B'), acc.headers, HEADERS_44);
    acc = mergeBankStatementRows(acc.rows, makeFileRows(30, 'C'), acc.headers, HEADERS_44);
    assert.equal(acc.rows.length, 60);
    assert.deepEqual(acc.rows.map((r) => r._rowId), Array.from({ length: 60 }, (_v, i) => `row_${i}`));
  });
});

test.describe('mergeBankStatementRows — headers 不一致拦截（🔴 异构表防护）', () => {
  test('追加时列数不同 → 抛 BankStatementMergeError', () => {
    const first = mergeBankStatementRows(null, makeFileRows(3, 'A'), null, HEADERS_44);
    assert.throws(
      () => mergeBankStatementRows(first.rows, makeFileRows(2, 'B'), first.headers, HEADERS_44.slice(0, 43)),
      (err) => err instanceof BankStatementMergeError && /表头与已导入银行对账单不一致/.test(err.message)
    );
  });

  test('追加时列名不同 → 抛 BankStatementMergeError', () => {
    const altHeaders = HEADERS_44.slice();
    altHeaders[0] = 'DIFFERENT';
    const first = mergeBankStatementRows(null, makeFileRows(3, 'A'), null, HEADERS_44);
    assert.throws(
      () => mergeBankStatementRows(first.rows, makeFileRows(2, 'B'), first.headers, altHeaders),
      BankStatementMergeError
    );
  });

  test('🔴 抛错时不改动 existingRows（session 不被污染）', () => {
    const first = mergeBankStatementRows(null, makeFileRows(3, 'A'), null, HEADERS_44);
    const before = first.rows.slice();
    const beforeIds = first.rows.map((r) => r._rowId);
    try {
      mergeBankStatementRows(first.rows, makeFileRows(2, 'B'), first.headers, ['x']);
      assert.fail('应抛 BankStatementMergeError');
    } catch (err) {
      assert.ok(err instanceof BankStatementMergeError);
    }
    // existingRows 数组长度、元素引用、_rowId 均未变
    assert.equal(first.rows.length, 3, '抛错后 existingRows 长度不变');
    assert.deepEqual(first.rows, before, '抛错后 existingRows 内容不变');
    assert.deepEqual(first.rows.map((r) => r._rowId), beforeIds, '抛错后 existingRows 的 _rowId 不变');
  });

  test('BankStatementMergeError 是 Error 子类且 name 正确（handler 据 instanceof / name 判定）', () => {
    const err = new BankStatementMergeError('x');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof BankStatementMergeError);
    assert.equal(err.name, 'BankStatementMergeError');
  });
});

// 复刻 main.js handler 合并流程（mockState 替代全局 session），端到端覆盖路由 + 合并 + 拦截 + 单文件。
test.describe('mergeBankStatementRows — 复刻 handler 流程（合并语义集成）', () => {
  // 模拟 readBankStatement(filePath) 的返回（含 result.rows 文件内 _rowId）
  function fakeRead(fileName, rowCount, tag, headers = HEADERS_44) {
    return { filePath: `/x/${fileName}`, fileName, rows: makeFileRows(rowCount, tag), headers, rowCount };
  }
  // 复刻 refactor 后 handler 的银行对账单分支
  function applyOne(read, st) {
    const isAppend = st.bankStatementMerged;
    let merged;
    try {
      merged = mergeBankStatementRows(
        isAppend ? st.bankStatementSession.rows : null, read.rows,
        isAppend ? st.bankStatementSession.headers : null, read.headers
      );
    } catch (err) {
      if (err instanceof BankStatementMergeError) {
        return { fileName: read.fileName, status: 'invalid', message: err.message };
      }
      throw err;
    }
    if (!isAppend) {
      st.bankStatementSession = { filePath: read.filePath, fileName: read.fileName, rows: merged.rows, headers: merged.headers, importedAt: 1, sourceFiles: [read.fileName] };
      st.processingResult = null; st.gatewayReconSession = null; st.bankStatementMerged = true;
    } else {
      st.bankStatementSession.rows = merged.rows; st.bankStatementSession.sourceFiles.push(read.fileName);
    }
    return { fileName: read.fileName, status: 'ok', rowCount: read.rowCount, merged: isAppend, mergedRowCount: st.bankStatementSession.rows.length, sourceFileCount: st.bankStatementSession.sourceFiles.length };
  }

  test('双文件批量：首个建 session（清 processingResult/gatewayReconSession），第二个追加合并', () => {
    const st = { bankStatementSession: null, processingResult: 'STALE', gatewayReconSession: 'STALE', bankStatementMerged: false };
    const r1 = applyOne(fakeRead('a.xlsx', 6629, 'A'), st);
    const r2 = applyOne(fakeRead('b.xlsx', 3259, 'B'), st);
    assert.equal(r1.merged, false);
    assert.equal(r2.merged, true);
    assert.equal(r2.mergedRowCount, 9888);
    assert.equal(r2.sourceFileCount, 2);
    assert.equal(st.bankStatementSession.rows.length, 9888);
    assert.equal(new Set(st.bankStatementSession.rows.map((r) => r._rowId)).size, 9888, '_rowId 全局唯一');
    assert.equal(st.processingResult, null, '整批清一次 processingResult');
    assert.equal(st.gatewayReconSession, null, '整批清一次 gatewayReconSession');
    assert.deepEqual(st.bankStatementSession.sourceFiles, ['a.xlsx', 'b.xlsx']);
  });

  test('headers 不一致的第二个文件 → invalid 且 session 未污染（行数/来源文件不变）', () => {
    const st = { bankStatementSession: null, processingResult: 'STALE', gatewayReconSession: 'STALE', bankStatementMerged: false };
    applyOne(fakeRead('a.xlsx', 6629, 'A'), st);
    const r2 = applyOne(fakeRead('bad.xlsx', 100, 'B', HEADERS_44.slice(0, 43)), st);
    assert.equal(r2.status, 'invalid');
    assert.match(r2.message, /表头与已导入银行对账单不一致/);
    assert.equal(st.bankStatementSession.rows.length, 6629, '拦截后 rows 仍为首文件 6629（未追加）');
    assert.deepEqual(st.bankStatementSession.sourceFiles, ['a.xlsx'], '拦截后 sourceFiles 未追加 bad.xlsx');
  });

  test('单文件批量 = 单选导入行为（merged=false / sourceFileCount=1 / _rowId 唯一 / 清缓存）', () => {
    const st = { bankStatementSession: null, processingResult: 'STALE', gatewayReconSession: 'STALE', bankStatementMerged: false };
    const r = applyOne(fakeRead('only.xlsx', 6629, 'A'), st);
    assert.equal(r.status, 'ok');
    assert.equal(r.merged, false);
    assert.equal(r.sourceFileCount, 1);
    assert.equal(st.bankStatementSession.rows.length, 6629);
    assert.equal(new Set(st.bankStatementSession.rows.map((x) => x._rowId)).size, 6629);
    assert.equal(st.processingResult, null);
    assert.equal(st.gatewayReconSession, null);
  });
});
