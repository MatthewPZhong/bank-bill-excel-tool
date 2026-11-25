// v3.0.4 F3 单测：error-report 第 3 列「对账ID」三级回退链
//   覆盖 spec §4 F3 验收三态：reconid 非空 / 空回退 rowId / 全空 ''
//   + 5 列表头断言（'行号' → '对账ID'）+ resolveReconIdCell 纯函数三态
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  writeErrorReport,
  resolveReconIdCell,
  cleanupInterruptedErrorReportTemporaryFiles
} = require('../../../src/main-process/exceljs-writer');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v304-f3-'));
  return path.join(dir, name);
}

// ===== resolveReconIdCell 纯函数三态（spec §4 F3 回退链）=====
test('F3 resolveReconIdCell：reconciliationId 非空优先', () => {
  assert.strictEqual(
    resolveReconIdCell({ reconciliationId: 'AFT123', reconId: 'k1', rowId: 'row_5' }),
    'AFT123'
  );
});

test('F3 resolveReconIdCell：reconciliationId 是 number 也走 String+trim', () => {
  assert.strictEqual(resolveReconIdCell({ reconciliationId: 88888888 }), '88888888');
});

test('F3 resolveReconIdCell：reconciliationId 空 → 回退 reconId（R1 专用）', () => {
  assert.strictEqual(
    resolveReconIdCell({ reconciliationId: '', reconId: 'GW_KEY', rowId: 'row_3' }),
    'GW_KEY'
  );
  // 空白串也视为未命中继续回退
  assert.strictEqual(
    resolveReconIdCell({ reconciliationId: '   ', reconId: 'GW_KEY' }),
    'GW_KEY'
  );
});

test('F3 resolveReconIdCell：reconciliationId/reconId 均空 → 回退 rowId', () => {
  assert.strictEqual(resolveReconIdCell({ rowId: 'row_7' }), 'row_7');
  assert.strictEqual(
    resolveReconIdCell({ reconciliationId: null, reconId: undefined, rowId: 'row_7' }),
    'row_7'
  );
});

test('F3 resolveReconIdCell：三者全空 → 空串', () => {
  assert.strictEqual(resolveReconIdCell({ rowId: null }), '');
  assert.strictEqual(resolveReconIdCell({}), '');
  assert.strictEqual(
    resolveReconIdCell({ reconciliationId: '', reconId: '', rowId: '' }),
    ''
  );
});

// ===== 端到端写盘三态 + 5 列表头 =====
test('F3 writeErrorReport：5 列表头第 3 列 = 对账ID', async () => {
  const out = tmpFile('hdr.xlsx');
  await writeErrorReport([], out);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sheet = wb.getWorksheet('error-report');
  assert.strictEqual(sheet.getCell(1, 1).value, '时间戳', '表头 1');
  assert.strictEqual(sheet.getCell(1, 2).value, '场景名', '表头 2');
  assert.strictEqual(sheet.getCell(1, 3).value, '对账ID', '表头 3 = 对账ID');
  assert.strictEqual(sheet.getCell(1, 4).value, '原因', '表头 4');
  assert.strictEqual(sheet.getCell(1, 5).value, '可能原因', '表头 5');
});

test('F3 writeErrorReport：三态取值（reconid 非空 / 空回退 rowId / 全空 ）', async () => {
  const out = tmpFile('three-state.xlsx');
  const warnings = [
    // ① reconciliationId 非空 → 显示对账ID
    { scenarioId: 1, scenarioName: 'C1', rowId: 'row_0', reconciliationId: 'AFT123456789012', code: 'x', message: 'm1' },
    // ② reconciliationId 缺省 + reconId 缺省 → 回退 rowId（旧 shape 调用方未传 bankRows）
    { scenarioId: 2, scenarioName: 'C2', rowId: 'row_5', code: 'one-to-many', message: 'm2' },
    // ③ 全空（config 类 warning，rowId=null）→ 空串
    { scenarioId: 3, scenarioName: 'R5', rowId: null, code: 'y', message: 'm3' }
  ];
  await writeErrorReport(warnings, out);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sheet = wb.getWorksheet('error-report');
  assert.strictEqual(sheet.getCell(2, 3).value, 'AFT123456789012', '① reconid 非空显示对账ID');
  assert.strictEqual(sheet.getCell(3, 3).value, 'row_5', '② 空回退 rowId');
  // 全空：exceljs 空单元格读回为 null
  assert.ok(
    sheet.getCell(4, 3).value === '' || sheet.getCell(4, 3).value === null,
    '③ 全空 → 空串'
  );
});

test('F3 writeErrorReport：reconId（R1 专用字段）在 reconciliationId 空时生效', async () => {
  const out = tmpFile('r1.xlsx');
  const warnings = [
    { scenarioId: 1, scenarioName: 'R1', rowId: null, reconId: 'AFT999', code: 'multi-bank-match-r1', message: 'r1' }
  ];
  await writeErrorReport(warnings, out);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sheet = wb.getWorksheet('error-report');
  assert.strictEqual(sheet.getCell(2, 3).value, 'AFT999', 'R1 reconId 兜底显示');
});

test('v3.0.26 writeErrorReport：R5 非法 Extra Fee 的行血缘、原始值和可能原因均可见', async () => {
  const out = tmpFile('r5-invalid-extra-fee.xlsx');
  await writeErrorReport([
    {
      scenarioName: '中台调拨订单对账ID回填',
      rowId: 'bank-row-26',
      code: 'r5-invalid-extra-fee',
      message: '银行行 Extra Fee 原始值「abc」不是合法金额，已退出 R5 候选'
    }
  ], out);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sheet = wb.getWorksheet('error-report');
  assert.strictEqual(sheet.getCell(2, 3).value, 'bank-row-26');
  assert.match(sheet.getCell(2, 4).value, /abc/);
  assert.match(sheet.getCell(2, 5).value, /Extra Fee/);
  assert.notStrictEqual(sheet.getCell(2, 5).value, '未知错误');
});

test('v3.2.22 writeErrorReport：超过单表上限时续写新表并重复表头，不截断记录', async () => {
  const out = tmpFile('split.xlsx');
  const warnings = Array.from({ length: 5 }, (_, i) => ({
    scenarioName: '中台调拨订单对账ID回填',
    rowId: `row_${i + 1}`,
    code: 'r5-mapped-account-contention',
    message: `告警 ${i + 1}`
  }));
  await writeErrorReport(warnings, out, { maxDataRowsPerSheet: 2 });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  assert.deepStrictEqual(
    wb.worksheets.map((sheet) => sheet.name),
    ['error-report', 'error-report_2', 'error-report_3']
  );
  const messages = [];
  for (const sheet of wb.worksheets) {
    assert.strictEqual(sheet.getCell(1, 3).value, '对账ID', `${sheet.name} 重复表头`);
    for (let r = 2; r <= sheet.rowCount; r += 1) messages.push(sheet.getCell(r, 4).value);
  }
  assert.deepStrictEqual(messages, ['告警 1', '告警 2', '告警 3', '告警 4', '告警 5']);
});

test('v3.2.22 writeErrorReport：未超上限时仍只有一张 error-report', async () => {
  const out = tmpFile('single.xlsx');
  await writeErrorReport([{ scenarioName: 'S', rowId: 'row_1', code: 'x', message: 'm' }], out, { maxDataRowsPerSheet: 1 });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  assert.deepStrictEqual(wb.worksheets.map((sheet) => sheet.name), ['error-report']);
});

test('v3.2.22 writeErrorReport：流式写出保留表头样式与水印，成功后不留临时文件', async () => {
  const out = tmpFile('stream.xlsx');
  await writeErrorReport([{ scenarioName: 'S', rowId: 'row_1', code: 'x', message: 'm' }], out);
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['stream.xlsx']);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  assert.strictEqual(wb.lastModifiedBy, 'pzhong');
  const sheet = wb.getWorksheet('error-report');
  assert.strictEqual(sheet.getCell(1, 1).font.bold, true);
  assert.strictEqual(sheet.getCell(1, 1).font.size, 10);
  assert.strictEqual(sheet.getCell(2, 4).value, 'm');
});

test('v3.2.22 writeErrorReport：写出失败时删除临时文件，不留下半份报告', async () => {
  const out = tmpFile('fail.xlsx');
  const poisoned = { scenarioName: 'S', rowId: 'row_1', code: 'x', get message() { throw new Error('boom'); } };
  await assert.rejects(writeErrorReport([poisoned], out), /boom/);
  assert.deepEqual(fs.readdirSync(path.dirname(out)), []);
});

function withinMs(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`超过 ${ms}ms 未结束`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

test('v3.2.22 writeErrorReport：目录不存在时立即失败，不挂起导出', async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v3222-er-')), 'missing-dir', 'report.xlsx');
  const warnings = Array.from({ length: 5000 }, (_v, i) => ({ scenarioName: 'S', rowId: `row_${i}`, code: 'x', message: 'm' }));
  await assert.rejects(withinMs(writeErrorReport(warnings, out), 5000), (error) => error.code === 'ENOENT');
});

test('v3.2.22 writeErrorReport：失败时先关闭写入流再删除临时文件', async () => {
  const out = tmpFile('closed.xlsx');
  const streams = [];
  const createOutput = (name) => {
    const stream = fs.createWriteStream(name, { flags: 'wx', mode: 0o600 });
    streams.push(stream);
    return stream;
  };
  const poisoned = { scenarioName: 'S', rowId: 'row_1', code: 'x', get message() { throw new Error('boom'); } };
  await assert.rejects(writeErrorReport([{ scenarioName: 'S', rowId: 'row_0', code: 'x', message: 'm' }, poisoned], out, { createOutput }), /boom/);
  assert.strictEqual(streams.length, 1);
  assert.strictEqual(streams[0].closed, true);
  assert.deepEqual(fs.readdirSync(path.dirname(out)), []);
});

test('v3.2.22 writeErrorReport：输出流不消费时按背压暂停取数，流出错后结束', async () => {
  const { Writable } = require('node:stream');
  let output;
  const createOutput = () => {
    output = new Writable({ highWaterMark: 1024, write() { /* 模拟磁盘卡住：永不回调 */ } });
    return output;
  };
  const total = 300000;
  let pulled = 0;
  function* warnings() {
    for (let i = 0; i < total; i += 1) {
      pulled += 1;
      yield { scenarioName: 'S', rowId: `row_${i}`, code: 'x', message: `第 ${i} 条告警 ${'说明'.repeat(10)}` };
    }
  }
  const pending = writeErrorReport(warnings(), tmpFile('stalled.xlsx'), { createOutput });
  pending.catch(() => {});
  // 队列达到预算（8 MB）前仍会取数；之后连续两次采样不再增长即视为已按背压暂停。
  const deadline = Date.now() + 15000;
  let previous = -1;
  while (pulled !== previous && Date.now() < deadline) {
    previous = pulled;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.strictEqual(pulled, previous, `输出不消费时不应持续取数，已取 ${pulled}`);
  assert.ok(pulled < total, `应在背压下暂停，已取 ${pulled}`);
  output.destroy(new Error('disk gone'));
  await assert.rejects(withinMs(pending, 5000), /disk gone/);
});

test('v3.2.22 writeErrorReportOutputToPath：对账ID 逐条补全，输出不消费时不预先遍历全部告警', async () => {
  const { Writable } = require('node:stream');
  const { writeErrorReportOutputToPath } = require('../../../src/main-process/bank-statement-io');
  let output;
  const createOutput = () => {
    output = new Writable({ highWaterMark: 1024, write() { /* 模拟磁盘卡住 */ } });
    return output;
  };
  const total = 300000;
  const touchedIndexes = new Set();
  const warnings = Array.from({ length: total }, (_v, i) => ({
    scenarioName: 'S',
    code: 'x',
    message: `第 ${i} 条告警 ${'说明'.repeat(10)}`,
    get rowId() { touchedIndexes.add(i); return `row_${i % 3}`; }
  }));
  const bankRows = [{ _rowId: 'row_0', ReconciliationId: 'AFT-0' }];
  const pending = writeErrorReportOutputToPath({
    warnings, outputPath: tmpFile('lazy.xlsx'), bankRows, writerOptions: { createOutput }
  });
  pending.catch(() => {});
  const deadline = Date.now() + 15000;
  let previous = -1;
  while (touchedIndexes.size !== previous && Date.now() < deadline) {
    previous = touchedIndexes.size;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.strictEqual(touchedIndexes.size, previous, `输出不消费时不应持续补全，已补全 ${touchedIndexes.size}`);
  assert.ok(touchedIndexes.size < total, `应按背压逐条补全，已补全 ${touchedIndexes.size}`);
  output.destroy(new Error('disk gone'));
  await assert.rejects(withinMs(pending, 5000), /disk gone/);
});

test('v3.2.22（🔴）writeErrorReportOutputToPath：对账ID 与主输出同口径按来源编码（银行原值读回原值、回填值按原文）', async () => {
  const XLSX = require('xlsx');
  const { writeErrorReportOutputToPath } = require('../../../src/main-process/bank-statement-io');
  const outputPath = tmpFile('recon-id-source.xlsx');
  await writeErrorReportOutputToPath({
    warnings: ['r1', 'r2', 'r3', 'r4'].map((rowId) => ({ scenarioName: 'S', rowId, code: 'x', message: 'm' })),
    outputPath,
    bankRows: [
      { _rowId: 'r1', ReconciliationId: 'A_x0000_B' },
      { _rowId: 'r2', ReconciliationId: 'A\u0000B' },
      { _rowId: 'r3', _modifiedColumns: new Set(['ReconciliationId']), ReconciliationId: 'RID_x005F_x0041_' },
      // 🔴 改写值是已解码文本（C1 提取 / C3 自定义值，编排器标 _decodedModifiedColumns）：与主输出同口径读回字面值。
      { _rowId: 'r4', _modifiedColumns: new Set(['ReconciliationId']), _decodedModifiedColumns: new Set(['ReconciliationId']),
        ReconciliationId: 'C1_x0041_' }
    ]
  });
  const expected = ['A_x0000_B', 'A\u0000B', 'RID_x0041_', 'C1_x0041_'];
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(outputPath).Sheets['error-report'], { header: 1, raw: true });
  assert.deepStrictEqual(rows.slice(1).map((row) => row[2]), expected, 'SheetJS 读回：字面账号与含 NUL 的账号可区分');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const sheet = workbook.getWorksheet('error-report');
  const text = (cell) => (cell.value && cell.value.richText ? cell.value.richText.map((run) => run.text).join('') : cell.value);
  assert.deepStrictEqual([2, 3, 4, 5].map((r) => text(sheet.getCell(r, 3))), expected, 'ExcelJS 读回');
});

test('v3.2.22 writeErrorReportOutputToPath：补全后的对账ID 写入第 3 列', async () => {
  const { writeErrorReportOutputToPath } = require('../../../src/main-process/bank-statement-io');
  const out = tmpFile('enrich.xlsx');
  await writeErrorReportOutputToPath({
    warnings: [{ scenarioName: 'S', rowId: 'row_0', code: 'x', message: 'm' }, { scenarioName: 'S', rowId: 'row_9', code: 'x', message: 'n' }],
    outputPath: out,
    bankRows: [{ _rowId: 'row_0', ReconciliationId: 'AFT-0' }]
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sheet = wb.getWorksheet('error-report');
  assert.strictEqual(sheet.getCell(2, 3).value, 'AFT-0');
  assert.strictEqual(sheet.getCell(3, 3).value, 'row_9');
});

test('v3.2.22 writeErrorReport：临时文件删不掉时保留原错误并写明需手动清理的路径',
  { skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0) }, async () => {
    const out = tmpFile('locked.xlsx');
    const dir = path.dirname(out);
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3222-error-report-locked-markers-'));
    const createOutput = (name) => {
      const stream = fs.createWriteStream(name, { flags: 'wx', mode: 0o600 });
      // 临时文件已建立后收回目录写权限，使删除失败（EACCES）。
      stream.once('open', () => fs.chmodSync(dir, 0o500));
      return stream;
    };
    const poisoned = { scenarioName: 'S', rowId: 'row_1', code: 'x', get message() { throw new Error('boom'); } };
    try {
      await assert.rejects(
        writeErrorReport([{ scenarioName: 'S', rowId: 'row_0', code: 'x', message: 'm' }, poisoned], out,
          { createOutput, temporaryFileMarkerDir: markerDir }),
        (error) => {
          assert.match(error.message, /^boom（错误报告临时文件未能删除，请手动清理：/);
          assert.ok(error.temporaryFileCleanup && error.temporaryFileCleanup.path.startsWith(`${out}.`));
          assert.strictEqual(error.temporaryFileCleanup.code, 'EACCES');
          return true;
        }
      );
      assert.strictEqual(fs.readdirSync(markerDir).length, 1, '删不掉时保留登记，供下次启动重试');
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(markerDir, { recursive: true, force: true });
    }
  });

test('v3.2.22 writeErrorReport：告警文本中的 NUL 等控制字符无损写出', async () => {
  const out = tmpFile('nul-report.xlsx');
  await writeErrorReport([
    { scenarioName: 'S', reconciliationId: 'R\u0000X', code: 'x', message: '账号 A\u0000B / _x0041_' },
    { scenarioName: 'S', reconciliationId: '_x0041\u0000', code: 'x', message: '边界账号 _x0041\u0000' },
    { scenarioName: 'S', reconciliationId: 'Ax0000_', code: 'x', message: '边界账号 Ax0000_' }
  ], out);
  // 流式写出为内联字符串；Excel 与 SheetJS 按 OOXML ST_Xstring 解码（ExcelJS 读取器只解码共享字符串，不用于此处核对）。
  const XLSX = require('xlsx');
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets['error-report'], { header: 1, raw: true });
  assert.strictEqual(rows[1][2], 'R\u0000X');
  assert.strictEqual(rows[1][3], '账号 A\u0000B / A', '控制字符编码，同格已成对的 `_x0041_` 按原文写出');
  assert.strictEqual(rows[2][2], '_x0041\u0000');
  assert.strictEqual(rows[2][3], '边界账号 _x0041\u0000');
  assert.strictEqual(rows[3][2], 'Ax0000_');
  assert.strictEqual(rows[3][3], '边界账号 Ax0000_');
});

test('v3.2.22 cleanupInterruptedErrorReportTemporaryFiles：进程被终止后按登记回收临时文件，不碰未登记的同名文件', async () => {
  const { execFileSync } = require('node:child_process');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v3222-error-report-marker-'));
  const markerDir = path.join(base, 'markers');
  const reportDir = path.join(base, 'error-reports', '2026-11-24');
  fs.mkdirSync(reportDir, { recursive: true });
  const savePath = path.join(reportDir, '20261124-101010-error-report.xlsx');
  // 子进程开始写报告、临时文件建立后立即退出（模拟强制关闭），留下临时文件与登记。
  const writerPath = require.resolve('../../../src/main-process/exceljs-writer');
  execFileSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { writeErrorReport } = require(${JSON.stringify(writerPath)});
    const createOutput = (name) => {
      const stream = fs.createWriteStream(name, { flags: 'wx' });
      stream.once('open', () => process.exit(0));
      return stream;
    };
    writeErrorReport([{ scenarioName: 'S', rowId: 'r', code: 'x', message: 'm' }], ${JSON.stringify(savePath)},
      { createOutput, temporaryFileMarkerDir: ${JSON.stringify(markerDir)} });
    setInterval(() => {}, 1000);
  `]);
  const leftovers = fs.readdirSync(reportDir);
  assert.strictEqual(leftovers.length, 1, '子进程退出后留下一个临时文件');
  assert.match(leftovers[0], /^20261124-101010-error-report\.xlsx\.[0-9a-f-]{36}\.tmp$/);
  assert.strictEqual(fs.readdirSync(markerDir).length, 1, '留下一条登记');
  // 同目录另一写出器的同名后缀文件、其他实例未登记的文件不应被碰。
  const foreign = path.join(reportDir, '20261124-filtered-source.xlsx.0f8fad5b-d9cb-469f-a165-70867728950e.tmp');
  fs.writeFileSync(foreign, 'x');

  const result = await cleanupInterruptedErrorReportTemporaryFiles(markerDir);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.removed, [path.join(reportDir, leftovers[0])]);
  assert.deepEqual(fs.readdirSync(reportDir), [path.basename(foreign)], '只删登记过的临时文件');
  assert.deepEqual(fs.readdirSync(markerDir), [], '登记已撤销');
  fs.rmSync(base, { recursive: true, force: true });
});

test('v3.2.22 cleanupInterruptedErrorReportTemporaryFiles：本进程正在写的、名不符或已被换成链接的登记不删除文件', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v3222-error-report-marker-guard-'));
  const markerDir = path.join(base, 'markers');
  const outside = path.join(base, 'outside.xlsx');
  fs.writeFileSync(outside, 'keep');
  // 本进程正在写：经输出流工厂拿到登记后挂起，不让写出结束。
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // 临时文件建立（登记已写完、输出流工厂已调用）的信号：等它再做清理检查，不按固定时长猜。
  let outputCreated;
  const outputReady = new Promise((resolve) => { outputCreated = resolve; });
  const createOutput = (name) => {
    const { Writable } = require('node:stream');
    fs.writeFileSync(name, 'partial');
    outputCreated();
    return new Writable({ write(_chunk, _enc, callback) { gate.then(() => callback()); } });
  };
  const inFlight = writeErrorReport([{ scenarioName: 'S', rowId: 'r', code: 'x', message: 'm' }],
    path.join(base, 'live.xlsx'), { createOutput, temporaryFileMarkerDir: markerDir });
  inFlight.catch(() => {});
  await outputReady;
  const liveTemp = fs.readdirSync(base).find((name) => name.startsWith('live.xlsx.'));
  assert.ok(liveTemp, '临时文件已建立');

  const uuidA = '11111111-1111-4111-8111-111111111111';
  const uuidB = '22222222-2222-4222-8222-222222222222';
  // 名不符：登记的 UUID 与临时文件名不一致。
  fs.writeFileSync(path.join(markerDir, `${uuidA}.json`), JSON.stringify({ owner: 'other', temporaryPath: outside }));
  // 已被换成链接：不跟随、不删除目标。
  const linkPath = path.join(base, `link.xlsx.${uuidB}.tmp`);
  let linked = true;
  try { fs.symlinkSync(outside, linkPath); } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    linked = false;
  }
  if (linked) fs.writeFileSync(path.join(markerDir, `${uuidB}.json`), JSON.stringify({ owner: 'other', temporaryPath: linkPath }));

  const result = await cleanupInterruptedErrorReportTemporaryFiles(markerDir);
  assert.deepEqual(result.removed, []);
  assert.ok(fs.existsSync(path.join(base, liveTemp)), '本进程正在写的临时文件保留');
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
  if (linked) assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), '链接本身也不动');
  assert.deepEqual(fs.readdirSync(markerDir).filter((name) => name !== `${uuidA}.json` && name !== `${uuidB}.json`).length, 1,
    '本进程的登记保留');
  assert.ok(!fs.existsSync(path.join(markerDir, `${uuidA}.json`)), '无效登记撤销');
  release();
  await inFlight;
  assert.deepEqual(fs.readdirSync(markerDir), [], '写完后撤销本进程登记');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
});

test('v3.2.22 登记先写清理器不识别的临时名再改名：启动清理与登记重叠时不会读到写了一半的登记并撤销', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v3222-error-report-marker-race-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const markerDir = path.join(base, 'markers');
  const savePath = path.join(base, 'report.xlsx');
  const originalRename = fs.promises.rename;
  const seenDuringRegistration = [];
  t.after(() => { fs.promises.rename = originalRename; });
  fs.promises.rename = async (from, to) => {
    if (String(from).endsWith('.json.partial')) {
      // 改名前（登记内容已写完、尚未以 <UUID>.json 出现）跑一次启动清理：不应读取、撤销或计入失败。
      seenDuringRegistration.push(fs.readdirSync(markerDir));
      const result = await cleanupInterruptedErrorReportTemporaryFiles(markerDir);
      assert.deepEqual(result, { removed: [], failures: [], skipped: [] });
      assert.deepEqual(fs.readdirSync(markerDir), seenDuringRegistration[0], '写了一半的登记不被清理器碰');
    }
    return originalRename(from, to);
  };
  await writeErrorReport([{ scenarioName: 'S', rowId: 'r', code: 'x', message: 'm' }], savePath, { temporaryFileMarkerDir: markerDir });
  assert.equal(seenDuringRegistration.length, 1);
  assert.match(seenDuringRegistration[0].join(','), /^\.[0-9a-f-]{36}\.json\.partial$/);
  assert.ok(fs.existsSync(savePath));
  assert.deepEqual(fs.readdirSync(markerDir), [], '报告写完后登记已撤销，不留临时名');
});

test('v3.2.22 cleanupInterruptedErrorReportTemporaryFiles：登记目录不存在或是链接时无事可做', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v3222-error-report-marker-root-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  assert.deepEqual(await cleanupInterruptedErrorReportTemporaryFiles(path.join(base, 'absent')),
    { removed: [], failures: [], skipped: [] });
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  const temporaryPath = path.join(base, `x.xlsx.33333333-3333-4333-8333-333333333333.tmp`);
  fs.writeFileSync(temporaryPath, 'x');
  fs.writeFileSync(path.join(target, '33333333-3333-4333-8333-333333333333.json'),
    JSON.stringify({ owner: 'other', temporaryPath }));
  try {
    fs.symlinkSync(target, path.join(base, 'markers'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('无权创建目录链接'); return; }
    throw error;
  }
  assert.deepEqual(await cleanupInterruptedErrorReportTemporaryFiles(path.join(base, 'markers')),
    { removed: [], failures: [], skipped: [] });
  assert.ok(fs.existsSync(temporaryPath));
});

test('v3.2.22 writeErrorReport：登记目录是符号链接时不写报告（与启动清理同一真实目录检查）', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v3222-error-report-marker-link-'));
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  const markerDir = path.join(base, 'markers');
  try {
    fs.symlinkSync(target, markerDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('无权创建目录链接'); return; }
    throw error;
  }
  const out = path.join(base, 'report.xlsx');
  await assert.rejects(
    writeErrorReport([{ scenarioName: 'S', rowId: 'row_0', code: 'x', message: 'm' }], out, { temporaryFileMarkerDir: markerDir }),
    (error) => error.code === 'ERROR_REPORT_MARKER_DIR_INVALID'
  );
  assert.deepEqual(fs.readdirSync(target), [], '不在链接目标里登记');
  assert.deepEqual(fs.readdirSync(base).sort(), ['markers', 'target'], '不建临时文件、不写报告');
});

test('v3.2.22 writeErrorReport：超过单元格上限的告警拆成连续行，项目读取器与 SheetJS 都能读回完整正文', async () => {
  const XLSX = require('xlsx');
  const { openSingleSheetRichWorkbook } = require('../../../src/backend/xlsx/rich-workbook');
  const out = tmpFile('long-cell.xlsx');
  const bizA = 'B'.repeat(16500);
  const bizB = `${'C'.repeat(31999 - 34 - 16500 - 12)}😀${'C'.repeat(16480)}`;
  const longMessage = `R5 网关调拨：账户映射后网关记录 ${bizA}（对账ID GW-A）未匹配，其可用银行行已被网关记录 ${bizB}（对账ID GW-B）匹配并占用`;
  assert.ok(longMessage.length > 32767);
  assert.strictEqual(longMessage.indexOf('\u{1F600}'), 31999, '代理对正好跨第一段末尾');
  await writeErrorReport([
    { scenarioName: 'S', reconciliationId: 'RID-LONG', code: 'r5-mapped-account-contention', message: longMessage },
    { scenarioName: 'S', reconciliationId: 'RID-SHORT', code: 'x', message: '短告警' }
  ], out);

  const workbook = await openSingleSheetRichWorkbook(out);
  try {
    let rowCount = 0;
    await workbook.scan(() => { rowCount += 1; });
    assert.strictEqual(rowCount, 4, '表头 + 两段续行 + 短告警');
  } finally {
    await workbook.close();
  }
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets['error-report'], { header: 1, raw: true });
  assert.strictEqual(rows.length, 4);
  assert.deepEqual(rows.slice(1, 3).map((row) => row[2]), ['RID-LONG', 'RID-LONG'], '续行重复对账ID');
  assert.match(rows[1][3], /^（第 1\/2 段）/);
  assert.match(rows[2][3], /^（第 2\/2 段）/);
  for (const row of rows) for (const cell of row) assert.ok(String(cell).length <= 32767);
  const joined = rows.slice(1, 3).map((row) => row[3].replace(/^（第 \d\/2 段）/, '')).join('');
  assert.strictEqual(joined, longMessage, '拼接后与原文一致（不拆开代理对）');
  assert.deepEqual(rows[3].slice(2, 4), ['RID-SHORT', '短告警'], '未超限的告警仍为一行、无前缀');
});

test('v3.2.22 writeErrorReport：含 & 的对账ID 与告警经 ExcelJS、SheetJS 读回都与原值一致', async () => {
  const XLSX = require('xlsx');
  const out = tmpFile('ampersand.xlsx');
  const warnings = [
    { scenarioName: 'S', reconciliationId: 'A&amp;B', code: 'x', message: '对账ID A&amp;B &lt;tag&gt;' },
    { scenarioName: 'S', reconciliationId: 'A&B', code: 'x', message: '对账ID A&B <tag>' }
  ];
  await writeErrorReport(warnings, out);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(out);
  const sheet = workbook.getWorksheet('error-report');
  const text = (cell) => (cell.value && cell.value.richText ? cell.value.richText.map((run) => run.text).join('') : cell.value);
  assert.deepEqual([2, 3].map((r) => [text(sheet.getCell(r, 3)), text(sheet.getCell(r, 4))]),
    warnings.map((w) => [w.reconciliationId, w.message]), 'ExcelJS 读回可区分');
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets['error-report'], { header: 1, raw: true });
  assert.deepEqual(rows.slice(1).map((row) => [row[2], row[3]]), warnings.map((w) => [w.reconciliationId, w.message]), 'SheetJS 读回可区分');
});

test('v3.2.22 cleanupInterruptedErrorReportTemporaryFiles：登记读不到（权限等）时保留登记、记入失败，临时文件不动；JSON 损坏的登记才撤销', async (t) => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    t.skip('需要 POSIX 权限位且非 root');
    return;
  }
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v3222-error-report-marker-unreadable-'));
  t.after(() => {
    try { fs.chmodSync(path.join(base, 'markers', `${uuid}.json`), 0o600); } catch (_e) { /* ignore */ }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const markerDir = path.join(base, 'markers');
  const reportDir = path.join(base, 'error-reports', '2026-11-24');
  fs.mkdirSync(markerDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  const temporaryPath = path.join(reportDir, `report.xlsx.${uuid}.tmp`);
  fs.writeFileSync(temporaryPath, 'partial');
  const markerPath = path.join(markerDir, `${uuid}.json`);
  fs.writeFileSync(markerPath, JSON.stringify({ owner: 'other-process', temporaryPath }));
  fs.chmodSync(markerPath, 0o000);

  const blocked = await cleanupInterruptedErrorReportTemporaryFiles(markerDir);
  assert.deepEqual(blocked.removed, []);
  assert.deepEqual(blocked.failures.map((f) => f.path), [markerPath], '读不到的登记记入失败');
  assert.ok(fs.existsSync(markerPath), '保留登记，下次启动重试');
  assert.ok(fs.existsSync(temporaryPath), '临时文件不动');

  fs.chmodSync(markerPath, 0o600);
  const retried = await cleanupInterruptedErrorReportTemporaryFiles(markerDir);
  assert.deepEqual(retried.failures, []);
  assert.deepEqual(retried.removed, [temporaryPath], '恢复可读后按登记回收');
  assert.deepEqual(fs.readdirSync(markerDir), []);

  const corruptUuid = '6fa459ea-ee8a-4ca4-894e-db77e160355e';
  fs.writeFileSync(path.join(markerDir, `${corruptUuid}.json`), '{"owner":');
  const corrupt = await cleanupInterruptedErrorReportTemporaryFiles(markerDir);
  assert.deepEqual(corrupt.failures, []);
  assert.deepEqual(fs.readdirSync(markerDir), [], 'JSON 损坏（写登记中被终止）的登记撤销');
});

test('v3.2.22 writeErrorReport：流式导入的转义原文与编码后的控制字符经 ExcelJS、SheetJS 读回一致（与主输出同口径）', async () => {
  const XLSX = require('xlsx');
  const out = tmpFile('xstring.xlsx');
  await writeErrorReport([
    { scenarioName: 'S', reconciliationId: 'RID_x005F_x0041_', code: 'x', message: '对账ID RID_x005F_x0041_' },
    { scenarioName: 'S', reconciliationId: 'R\u0000X', code: 'x', message: '账号 A\u0000B / _x0041_' },
    { scenarioName: 'S', reconciliationId: 'PLAIN', code: 'x', message: '普通告警' }
  ], out);
  const expected = [['RID_x0041_', '对账ID RID_x0041_'], ['R\u0000X', '账号 A\u0000B / A'], ['PLAIN', '普通告警']];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(out);
  const sheet = workbook.getWorksheet('error-report');
  const text = (cell) => (cell.value && cell.value.richText ? cell.value.richText.map((run) => run.text).join('') : cell.value);
  assert.deepEqual([2, 3, 4].map((r) => [text(sheet.getCell(r, 3)), text(sheet.getCell(r, 4))]), expected,
    'ExcelJS 读回与主输出一致（按 ID 关联两份报表不漏行）');
  assert.strictEqual(sheet.getCell(4, 3).value, 'PLAIN', '不含 & 与转义写法的文本仍是普通字符串');
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets['error-report'], { header: 1, raw: true });
  assert.deepEqual(rows.slice(1).map((row) => [row[2], row[3]]), expected, 'SheetJS 读回');
});

test('v3.2.22 writeErrorReport：超长告警分段不切断 `_xHHHH_` 写法与代理对，各段读回拼接即整格读回值', async () => {
  const XLSX = require('xlsx');
  const { openSingleSheetRichWorkbook } = require('../../../src/backend/xlsx/rich-workbook');
  const cases = [
    // 流式导入的转义原文跨第一段末尾（32,000 处落在 `_x005F_` 中间）。
    { raw: `${'P'.repeat(31997)}_x005F_x0041_${'Q'.repeat(1000)}`, visible: `${'P'.repeat(31997)}_x0041_${'Q'.repeat(1000)}` },
    // 含控制字符的整格编码后，`_x0000_` 跨第一段末尾；同格已成对的 `_x0041_` 按原文写出。
    { raw: `${'P'.repeat(31995)}\u0000_x0041_${'Q'.repeat(1000)}`, visible: `${'P'.repeat(31995)}\u0000A${'Q'.repeat(1000)}` },
    // 两个转义写法组成的代理对，分界正好落在两者之间（32,000 处）。
    { raw: `${'P'.repeat(31993)}_xD83D__xDE00_${'Q'.repeat(1000)}`, visible: `${'P'.repeat(31993)}\u{1F600}${'Q'.repeat(1000)}` }
  ];
  for (const [index, { raw, visible }] of cases.entries()) {
    const out = tmpFile(`long-escape-${index}.xlsx`);
    await writeErrorReport([{ scenarioName: 'S', reconciliationId: 'RID', code: 'x', message: raw }], out);
    const rows = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets['error-report'], { header: 1, raw: true });
    const joined = rows.slice(1).map((row) => row[3].replace(/^（第 \d+\/\d+ 段）/, '')).join('');
    assert.strictEqual(joined, visible, `SheetJS 拼接读回（用例 ${index}）`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(out);
    const sheet = workbook.getWorksheet('error-report');
    const text = (cell) => (cell.value && cell.value.richText ? cell.value.richText.map((run) => run.text).join('') : cell.value);
    const parts = [];
    for (let r = 2; r <= sheet.rowCount; r += 1) parts.push(String(text(sheet.getCell(r, 4))).replace(/^（第 \d+\/\d+ 段）/, ''));
    assert.strictEqual(parts.join(''), visible, `ExcelJS 拼接读回（用例 ${index}）`);
    const projectWorkbook = await openSingleSheetRichWorkbook(out);
    try {
      let rowCount = 0;
      await projectWorkbook.scan(() => { rowCount += 1; });
      assert.strictEqual(rowCount, rows.length, `项目读取器逐段读回（各段都是合法 UTF-16，用例 ${index}）`);
    } finally {
      await projectWorkbook.close();
    }
  }
});
