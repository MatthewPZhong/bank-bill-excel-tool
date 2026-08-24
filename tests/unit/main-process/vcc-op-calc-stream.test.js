// v2.1.12 流式改造（spec §9）— VCC业务OP计算：streamScanAndCompute 端到端单测（资金红线🔴）
// 用小 fixture xlsx（xlsx 写）经 exceljs 流式 reader → session 聚合，验证：
//   正常聚合/整数分精度/混币种全量/空金额计0/非法方向整批拒绝/多月份拒绝。
// 聚合口径与同步 scan/computeAmounts 共用 helper（validateAndExtractRow/centsToAmountString），此处验证流式路径。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { FLOW_HEADERS } = require('../../../src/backend/vcc-op-calc-db/columns');
const { createVccOpCalcSession } = require('../../../src/main-process/vcc-op-calc-session');
const { sourceSnapshotFromStat } = require('../../../src/main-process/archive-center/source-snapshot');

// FLOW_HEADERS 0-based 列位：账单日期=1 出入方向=8 对账金额=13 币种=14（见真实文件 sharedStrings 顺序）
const COL = { billDate: 1, direction: 8, amount: 13, currency: 14 };

const tmpDirs = [];

// 写小 fixture xlsx（用 exceljs 写，与 exceljs streaming reader 读写一致）：28 列 FLOW 表头 + 指定数据行
async function writeFixture(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(FLOW_HEADERS.slice());           // addRow(数组)：0-based 顺序填 A,B,C...
  for (const r of rows) {
    const line = new Array(FLOW_HEADERS.length).fill('');
    if (r.billDate !== undefined) line[COL.billDate] = r.billDate;
    if (r.direction !== undefined) line[COL.direction] = r.direction;
    if (r.amount !== undefined) line[COL.amount] = r.amount;
    if (r.currency !== undefined) line[COL.currency] = r.currency;
    ws.addRow(line);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-stream-'));
  tmpDirs.push(dir);
  const fp = path.join(dir, 'flow.xlsx');
  await wb.xlsx.writeFile(fp);
  return fp;
}

// 写多 sheet fixture：sheet1 = 透视/汇总（非 FLOW 表头），sheet2 = FLOW 数据表（仿真实 ..840 结构）
async function writeMultiSheetFixture(dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws1 = wb.addWorksheet('Sheet1');                 // 透视表（首个，应被 reader 跳过）
  ws1.addRow(['出入方向', '求和项:对账金额']);
  ws1.addRow(['入', '100']);
  const ws2 = wb.addWorksheet('1397996929830619138');    // 数据表（FLOW 28 列）
  ws2.addRow(FLOW_HEADERS.slice());
  for (const r of dataRows) {
    const line = new Array(FLOW_HEADERS.length).fill('');
    if (r.billDate !== undefined) line[COL.billDate] = r.billDate;
    if (r.direction !== undefined) line[COL.direction] = r.direction;
    if (r.amount !== undefined) line[COL.amount] = r.amount;
    if (r.currency !== undefined) line[COL.currency] = r.currency;
    ws2.addRow(line);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-multi-'));
  tmpDirs.push(dir);
  const fp = path.join(dir, 'flow.xlsx');
  await wb.xlsx.writeFile(fp);
  return fp;
}

// 写只含非 FLOW sheet 的 fixture（所有 sheet 表头都不匹配）
async function writeNonFlowFixture() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['列A', '列B', '列C']);
  ws.addRow(['x', 'y', 'z']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-nonflow-'));
  tmpDirs.push(dir);
  const fp = path.join(dir, 'flow.xlsx');
  await wb.xlsx.writeFile(fp);
  return fp;
}

function newSession() {
  return createVccOpCalcSession({ getDb: () => null });   // streamScanAndCompute 不碰 DB
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
});

test.describe('streamScanAndCompute（流式聚合，资金红线🔴）', () => {
  test('正常聚合：入/出/小数精度/混币种全量', async () => {
    const fp = await writeFixture([
      { billDate: '2026-04-01', direction: '入', amount: '100.00', currency: 'CNY' },
      { billDate: '2026-04-02', direction: '出', amount: '30.50', currency: 'USD' },
      { billDate: '2026-04-03', direction: '入', amount: '0.01', currency: 'CNY' }   // 小数精度
    ]);
    const r = await newSession().streamScanAndCompute([fp]);
    assert.equal(r.ok, true);
    assert.equal(r.yearMonth, '2026-04');
    assert.equal(r.totalRows, 3);
    assert.equal(r.totals.totalIn, '100.01');    // 100.00 + 0.01（整数分无浮点漂移）
    assert.equal(r.totals.totalOut, '30.50');
    assert.equal(r.totals.totalAmount, '69.51'); // 100.01 - 30.50
    assert.equal(r.totals.currency, 'CNY,USD');  // 混币种全量合并，排序列表
    assert.equal(r.perFile.length, 1);
    assert.equal(r.perFile[0].rowCount, 3);
  });

  test('空对账金额行 → 计 0（不报错，spec Q5）', async () => {
    const fp = await writeFixture([
      { billDate: '2026-04-01', direction: '入', amount: '50.00', currency: 'CNY' },
      { billDate: '2026-04-02', direction: '出', amount: '', currency: 'CNY' }       // 空金额计 0
    ]);
    const r = await newSession().streamScanAndCompute([fp]);
    assert.equal(r.ok, true);
    assert.equal(r.totals.totalIn, '50.00');
    assert.equal(r.totals.totalOut, '0.00');
    assert.equal(r.totals.totalAmount, '50.00');
  });

  test('非法出入方向 → 整批拒绝 + errorRows（不静默跳过）', async () => {
    const fp = await writeFixture([
      { billDate: '2026-04-01', direction: '入', amount: '100.00', currency: 'CNY' },
      { billDate: '2026-04-02', direction: '转账', amount: '20.00', currency: 'CNY' }  // 非法方向
    ]);
    const r = await newSession().streamScanAndCompute([fp]);
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.errorRows) && r.errorRows.length >= 1);
    assert.match(r.errorRows[0].reason, /出入方向非法/);
  });

  test('非数值对账金额 → 整批拒绝', async () => {
    const fp = await writeFixture([
      { billDate: '2026-04-01', direction: '入', amount: 'abc', currency: 'CNY' }
    ]);
    const r = await newSession().streamScanAndCompute([fp]);
    assert.equal(r.ok, false);
    assert.match(r.errorRows[0].reason, /对账金额非数值/);
  });

  test('一次导入多月份混杂 → 整批拒绝', async () => {
    const fp = await writeFixture([
      { billDate: '2026-04-01', direction: '入', amount: '10.00', currency: 'CNY' },
      { billDate: '2026-05-01', direction: '入', amount: '20.00', currency: 'CNY' }   // 跨月
    ]);
    const r = await newSession().streamScanAndCompute([fp]);
    assert.equal(r.ok, false);
    assert.ok(r.errorRows.some((e) => /跨多个月份/.test(e.reason)));
  });

  test('onProgress 回调被触发（收尾至少一次）', async () => {
    const fp = await writeFixture([
      { billDate: '2026-04-01', direction: '入', amount: '1.00', currency: 'CNY' }
    ]);
    let lastProgress = -1;
    const r = await newSession().streamScanAndCompute([fp], { onProgress: (n) => { lastProgress = n; } });
    assert.equal(r.ok, true);
    assert.ok(lastProgress >= 1, 'onProgress 应至少回调一次并报告行数');
  });

  test('多文件同月聚合 + perFile 明细', async () => {
    const fpA = await writeFixture([{ billDate: '2026-04-01', direction: '入', amount: '100.00', currency: 'CNY' }]);
    const fpB = await writeFixture([{ billDate: '2026-04-02', direction: '出', amount: '40.00', currency: 'CNY' }]);
    const r = await newSession().streamScanAndCompute([fpA, fpB]);
    assert.equal(r.ok, true);
    assert.equal(r.totals.totalAmount, '60.00');   // 100 - 40
    assert.equal(r.perFile.length, 2);
    assert.equal(r.perFile[0].amountIn, '100.00');
    assert.equal(r.perFile[1].amountOut, '40.00');
  });

  test('E03-A 真实 Parser Worker/Pipeline 与 legacy 逐字段等价，成功返回前已采用冻结 snapshot', async () => {
    const fpA = await writeFixture([
      { billDate: '2026-04-01', direction: '入', amount: '100.01', currency: 'USD' },
      { billDate: '2026-04-02', direction: '出', amount: '40.00', currency: 'CNY' }
    ]);
    const fpB = await writeFixture([
      { billDate: '2026-04-03', direction: '入', amount: '0.20', currency: 'CNY' }
    ]);
    const legacy = await newSession().streamScanAndCompute([fpA, fpB]);
    const pipelineSession = newSession();
    const pipelined = await pipelineSession.parserPipelineScanAndCompute([fpA, fpB].map((filePath) => ({
      filePath,
      sourceSnapshot: sourceSnapshotFromStat(fs.statSync(filePath, { bigint: true }))
    })));

    assert.deepEqual({
      ok: pipelined.ok,
      yearMonth: pipelined.yearMonth,
      totalRows: pipelined.totalRows,
      totals: pipelined.totals,
      perFile: pipelined.perFile
    }, legacy);
    const cache = pipelineSession.getComputeCache();
    assert.ok(cache.inputEvidenceHash);
    assert.equal(Object.isFrozen(cache), true);
    assert.equal(Object.isFrozen(cache.perFile), true);
  });

  test('E03-A 真实 Parser Worker/Pipeline 与 legacy 错误顺序、分类和拒绝结果等价', async () => {
    const fp = await writeFixture([
      { billDate: '2026-04-01', direction: '入', amount: '1.00', currency: 'CNY' },
      { billDate: '2026-05-01', direction: '出', amount: '0.25', currency: 'USD' },
      { billDate: '2026-04-03', direction: '非法', amount: '9.00', currency: 'CNY' }
    ]);
    const legacySession = newSession();
    const pipelineSession = newSession();
    const legacy = await legacySession.streamScanAndCompute([fp]);
    const pipelined = await pipelineSession.parserPipelineScanAndCompute([{
      filePath: fp,
      sourceSnapshot: sourceSnapshotFromStat(fs.statSync(fp, { bigint: true }))
    }]);

    assert.deepEqual(pipelined, legacy);
    assert.equal(pipelined.ok, false);
    assert.equal(pipelined.errorCount, 2);
    assert.match(pipelined.errorRows[0].reason, /出入方向非法/);
    assert.match(pipelined.errorRows[1].reason, /跨多个月份/);
    assert.equal(pipelineSession.getComputeCache(), null);
  });

  test('保存缓存：streamScanAndCompute 成功后 getComputeCache 可取（供 saveRun）', async () => {
    const fp = await writeFixture([{ billDate: '2026-04-01', direction: '入', amount: '5.00', currency: 'CNY' }]);
    const session = newSession();
    await session.streamScanAndCompute([fp]);
    const cache = session.getComputeCache();
    assert.ok(cache, '应缓存聚合结果');
    assert.equal(cache.yearMonth, '2026-04');
    assert.equal(cache.totals.totalAmount, '5.00');
  });

  test('多 sheet：跳过透视 Sheet1，定位 FLOW 数据 sheet（资金红线🔴 防读错 sheet）', async () => {
    const fp = await writeMultiSheetFixture([
      { billDate: '2026-04-01', direction: '入', amount: '200.00', currency: 'CNY' },
      { billDate: '2026-04-02', direction: '出', amount: '50.00', currency: 'CNY' }
    ]);
    const r = await newSession().streamScanAndCompute([fp]);
    assert.equal(r.ok, true);
    assert.equal(r.yearMonth, '2026-04');
    assert.equal(r.totals.totalAmount, '150.00');   // 200 - 50（读到 sheet2 数据，而非透视 Sheet1）
  });

  test('所有 sheet 表头均不匹配 → 抛"未找到流水数据表"', async () => {
    const fp = await writeNonFlowFixture();
    await assert.rejects(
      () => newSession().streamScanAndCompute([fp]),
      (e) => e && e.name === 'FileValidationError' && /未找到流水数据表/.test(e.message)
    );
  });

  test('表头超出 28 列（尾部多余列）→ 拒绝（Minor② codex review，对齐同步 SheetJS 严格性）', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow([...FLOW_HEADERS.slice(), '额外列A', '额外列B']);   // 30 列 = 前 28 FLOW + 尾部 2 多余列
    const line = new Array(30).fill('');
    line[COL.billDate] = '2026-05-01'; line[COL.direction] = '入'; line[COL.amount] = '10';
    ws.addRow(line);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-over-'));
    tmpDirs.push(dir);
    const fp = path.join(dir, 'over.xlsx');
    await wb.xlsx.writeFile(fp);
    await assert.rejects(
      () => newSession().streamScanAndCompute([fp]),
      (e) => e && e.name === 'FileValidationError' && /列数超出模板 28 列|第 30 列/.test(e.message)
    );
  });
});
