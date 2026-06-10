'use strict';
// 大表导入引擎 import-worker 纯函数单元测试（v3.0.3 块 D · PR-G2）
//
// 直接驱动 parseFile（解析子 worker 的核心纯函数，主线程调用不起 worker），覆盖：
//   - mapRow 三态：{params} 入 batch / {skip} 跳过 / {error} 累积
//   - 表头错 → headerError（engine 据此整批拒绝）
//   - 缺表头行 → headerError
//   - 空行（!hasAnyCellText）静默跳过
//   - monthKeyOf 每行提取
//   - useWhitelist 开关：true 用契约白名单（仅解码白名单列）/ false 全列解码
//   - mapRow 抛异常 / 返回非法形态 → 行级错误（防静默丢数据）

const { test } = require('node:test');
const assert = require('node:assert');

const { parseFile, MAX_COLLECTED_ERRORS } = require('../../../../src/backend/big-table-import/import-worker');
const { validateContract } = require('../../../../src/backend/big-table-import/contract');
const fx = require('./_fixtures');

// 基础测试契约（全列白名单）。
function baseContract(extra = {}) {
  return validateContract({
    expectedHeaders: ['日期', '主键', '金额'],
    valueColumnWhitelist: null,
    validateHeaders(cells) {
      const ok = cells[0] === '日期' && cells[1] === '主键' && cells[2] === '金额';
      return ok ? { ok: true } : { ok: false, error: '表头不匹配', detailLines: [`实际: ${cells.join(',')}`] };
    },
    mapRow({ values }) {
      const key = String(values[1] || '').trim();
      if (!key) return { error: { reason: '主键为空' } };
      if (key === 'SKIP') return { skip: true };
      return { params: [values[0], key, values[2]] };
    },
    insertSql: 'INSERT INTO t (d, k, a) VALUES (?, ?, ?)',
    requiredColumns: [0, 1, 2],
    monthKeyOf({ values }) {
      const m = String(values[0] || '').match(/^(\d{4})[-/](\d{1,2})/);
      return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : null;
    },
    ...extra
  });
}

test.describe('import-worker.parseFile', () => {
  test.after(() => fx.cleanupTmpDirs());

  test('mapRow 三态：params 入 batch / skip 跳过 / error 累积 + monthKey 每行', async () => {
    const fp = await fx.writeFixtureExcelJS({
      rows: [
        ['日期', '主键', '金额'],
        ['2026-03-01', 'K1', '10'],
        ['2026-03-02', 'SKIP', '20'],   // skip
        ['2026-03-03', '', '30'],       // error（主键空）
        ['2026-03-04', 'K4', '40']
      ]
    });
    const r = await parseFile({ filePath: fp, contract: baseContract(), useWhitelist: true });
    assert.equal(r.importedCount, 2, 'K1 + K4 入 batch');
    assert.deepEqual(r.batch.map((b) => b.params[1]), ['K1', 'K4'], 'batch 仅含有效行主键');
    assert.deepEqual(r.monthKeys, ['2026-03', '2026-03'], 'monthKeys 与 batch 等长对齐');
    assert.equal(r.errors.length, 1, '1 个错误（主键空）');
    assert.equal(r.errors[0].reason, '主键为空');
    assert.equal(r.headerError, null, '表头正常无 headerError');
  });

  test('表头不匹配 → headerError（含 message + detailLines）', async () => {
    const fp = await fx.writeFixtureExcelJS({
      rows: [
        ['错误表头A', '错误表头B', '错误表头C'],
        ['2026-03-01', 'K1', '10']
      ]
    });
    const r = await parseFile({ filePath: fp, contract: baseContract(), useWhitelist: true });
    assert.ok(r.headerError, '表头错应产 headerError');
    assert.match(r.headerError.message, /表头不匹配/);
    assert.ok(Array.isArray(r.headerError.detailLines) && r.headerError.detailLines.length > 0, 'headerError 带 detailLines');
    assert.equal(r.importedCount, 0, '表头错 → 不解析数据行');
  });

  test('缺表头行（首行即数据行，r=1 不是表头）→ headerError', async () => {
    // r=1 行内容是数据但 validateHeaders 不通过（首行恒被当表头校验）。
    const fp = await fx.writeFixtureExcelJS({
      rows: [
        ['2026-03-01', 'K1', '10'],   // r=1 被当表头 → validateHeaders 失败
        ['2026-03-02', 'K2', '20']
      ]
    });
    const r = await parseFile({ filePath: fp, contract: baseContract(), useWhitelist: true });
    assert.ok(r.headerError, '首行非表头 → headerError');
  });

  test('空行（全空）静默跳过，不计 importedCount/不报错', async () => {
    const fp = await fx.writeFixtureExcelJS({
      rows: [
        ['日期', '主键', '金额'],
        ['2026-03-01', 'K1', '10'],
        ['', '', ''],                 // 空行
        ['2026-03-03', 'K3', '30']
      ]
    });
    const r = await parseFile({ filePath: fp, contract: baseContract(), useWhitelist: true });
    assert.equal(r.importedCount, 2, '空行跳过 → 2 有效行');
    assert.equal(r.errors.length, 0, '空行不报错');
  });

  test('useWhitelist=true：仅解码白名单列（外列恒空，mapRow 读不到外列值）', async () => {
    // 契约白名单 {0,1}（不含金额列 2）+ requiredColumns 也只 {0,1}（避免第 1 层防护拦截）。
    const contract = baseContract({
      valueColumnWhitelist: [0, 1],
      requiredColumns: [0, 1],
      mapRow({ values }) {
        // 金额列 2 不在白名单 → 恒空串。
        return { params: [values[0], String(values[1] || '').trim(), values[2] /* 应为 '' */] };
      }
    });
    const fp = await fx.writeFixtureExcelJS({
      rows: [
        ['日期', '主键', '金额'],
        ['2026-03-01', 'K1', '999']   // 金额 999 但白名单外 → 读到 ''
      ]
    });
    const r = await parseFile({ filePath: fp, contract, useWhitelist: true });
    assert.equal(r.batch[0].params[2], '', '白名单外列（金额）恒空串');
    assert.equal(r.batch[0].params[1], 'K1', '白名单内列正常取值');
  });

  test('useWhitelist=false：全列解码（白名单契约也读得到外列 → byte-for-byte 对照组语义）', async () => {
    const contract = baseContract({
      valueColumnWhitelist: [0, 1],
      requiredColumns: [0, 1],
      mapRow({ values }) {
        return { params: [values[0], String(values[1] || '').trim(), values[2]] };
      }
    });
    const fp = await fx.writeFixtureExcelJS({
      rows: [
        ['日期', '主键', '金额'],
        ['2026-03-01', 'K1', '999']
      ]
    });
    const r = await parseFile({ filePath: fp, contract, useWhitelist: false });
    assert.equal(r.batch[0].params[2], '999', 'useWhitelist=false 全列解码 → 金额列取到真值');
  });

  test('mapRow 抛异常 → 行级错误累积（不静默丢）', async () => {
    const contract = baseContract({
      mapRow({ values }) {
        if (values[1] === 'BOOM') throw new Error('mapRow 内部炸了');
        return { params: [values[0], values[1], values[2]] };
      }
    });
    const fp = await fx.writeFixtureExcelJS({
      rows: [
        ['日期', '主键', '金额'],
        ['2026-03-01', 'BOOM', '10'],
        ['2026-03-02', 'K2', '20']
      ]
    });
    const r = await parseFile({ filePath: fp, contract, useWhitelist: true });
    assert.equal(r.importedCount, 1, '正常行 K2 入库');
    assert.equal(r.errors.length, 1, 'BOOM 行抛异常 → 行级错误');
    assert.match(r.errors[0].reason, /炸了/);
  });

  test('mapRow 返回非法形态（无 params/skip/error）→ 行级错误', async () => {
    const contract = baseContract({
      mapRow({ values }) {
        if (values[1] === 'BAD') return { foo: 'bar' };   // 非法形态
        return { params: [values[0], values[1], values[2]] };
      }
    });
    const fp = await fx.writeFixtureExcelJS({
      rows: [
        ['日期', '主键', '金额'],
        ['2026-03-01', 'BAD', '10'],
        ['2026-03-02', 'K2', '20']
      ]
    });
    const r = await parseFile({ filePath: fp, contract, useWhitelist: true });
    assert.equal(r.importedCount, 1, 'K2 正常');
    assert.equal(r.errors.length, 1, '非法形态行 → 行级错误');
    assert.match(r.errors[0].reason, /非法/);
  });

  test('MAX_COLLECTED_ERRORS=100 导出常量', () => {
    assert.equal(MAX_COLLECTED_ERRORS, 100, '与 spec §2.3 / 收单同口径');
  });
});
