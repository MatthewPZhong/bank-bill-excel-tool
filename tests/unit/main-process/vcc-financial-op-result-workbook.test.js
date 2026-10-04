'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../src/backend/vcc-financial-op-db/migrations');
const { SUPPORTED_CURRENCIES, SOURCE_TYPES } = require('../../../src/backend/vcc-financial-op/definitions');
const { buildRunRowKey } = require('../../../src/backend/vcc-financial-op/result-adjustments');
const { encodeAdjustmentLineageName } = require('../../../src/backend/vcc-financial-op/adjustment-lineage');
const { writeResultWorkbook } = require('../../../src/main-process/vcc-financial-op-result-workbook-writer');
const { writeRunWorkbooks } = require('../../../src/main-process/vcc-financial-op-writer');
const { normalizeRange } = require('../../../src/main-process/vcc-financial-op-result-workbook-validator');
const { AdaptiveSharedStringsProvider } = require('../../../src/backend/xlsx/shared-strings-provider');
const assetsDir = path.resolve(__dirname, '../../../assets');

function fixture(t, subjects = ['A主体', 'B主体']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-subject-workbook-'));
  const db = new DatabaseSync(path.join(root, 'fixture.sqlite'));
  ensureVccFinancialOpTablesSupport(db);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const runId = Number(db.prepare("INSERT INTO vcc_fin_op_runs(target_month,status,input_revisions_json,result_revision,input_fingerprint) VALUES('2026-06','archived','{}',1,'frozen-fixture')").run().lastInsertRowid);
  const rowKeys = [];
  for (let index = 0; index < subjects.length; index += 1) {
    const subject = subjects[index], factor = index + 1;
    for (const currency of SUPPORTED_CURRENCIES) {
      const period = currency === 'USD' ? factor * 10 : currency === 'EUR' ? factor * -2 : 0;
      const system = 100 + period + (currency === 'USD' ? 1 : 0);
      db.prepare('INSERT INTO vcc_fin_op_run_balances(run_id,subject,currency,opening_balance,period_amount,calculated_balance,system_balance,difference) VALUES(?,?,?,?,?,?,?,?)')
        .run(runId, subject, currency, '100', String(period), String(100 + period), String(system), currency === 'USD' ? '1' : '0');
    }
    db.prepare('INSERT INTO vcc_fin_op_run_rows(run_id,subject,row_kind,source_type,category_major,category_minor,currency,amount) VALUES(?,?,?,?,?,?,?,?)')
      .run(runId, subject, 'movement', SOURCE_TYPES.CHANNEL, 'CHANNEL', 'PRODUCT', 'USD', String(factor * 10));
    db.prepare('INSERT INTO vcc_fin_op_run_rows(run_id,subject,row_kind,source_type,category_major,category_minor,currency,amount) VALUES(?,?,?,?,?,?,?,?)')
      .run(runId, subject, 'pending', SOURCE_TYPES.PENDING, '当月移除pending', '', 'EUR', String(factor * -2));
    const rowKey = buildRunRowKey({ rowKind: 'movement', subject, sourceType: SOURCE_TYPES.CHANNEL, categoryMajor: 'CHANNEL', categoryMinor: 'PRODUCT' });
    rowKeys.push(rowKey);
    db.prepare('INSERT INTO vcc_fin_op_run_adjustments(run_id,row_key,subject,source_type,category_major,category_minor,currency,adjustment_amount,reason,sequence) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(runId, rowKey, subject, SOURCE_TYPES.CHANNEL, 'CHANNEL', 'PRODUCT', 'USD', String(factor), `${subject} 原因\n字面 _x0041_ & <校验>`, factor);
    db.prepare('INSERT INTO vcc_fin_op_pending_summary_rows(run_id,subject,channel_name,currency_mismatch,flow_currency,pending_currency,recon_type,flow_amount,pending_amount) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(runId, subject, `CHANNEL-${factor}`, 1, 'USD', 'EUR', 'VCC_clearing_credit', String(factor * 8), String(factor * -2));
    db.prepare('INSERT INTO vcc_fin_op_pending_currency_totals(run_id,subject,currency,amount) VALUES(?,?,?,?)')
      .run(runId, subject, 'EUR', String(factor * -2));
  }
  db.prepare('UPDATE vcc_fin_op_runs SET result_revision = ? WHERE id = ?').run(subjects.length, runId);
  return { root, db, runId, subjects, rowKeys, outputPath: path.join(root, '2026-06_VCC财务OP校验结果表.xlsx') };
}
async function runWriter(data, options = {}) {
  return writeResultWorkbook({ db: data.db, runId: data.runId, assetsDir, outputPaths: [data.outputPath], ...options });
}
async function mutate(filePath, update) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  await update(zip);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}
function comparableSheet(sheet) {
  return { rows: Array.from({ length: sheet.rowCount }, (_, index) => {
    const row = sheet.getRow(index + 1);
    return { height: row.height, hidden: row.hidden, outlineLevel: row.outlineLevel,
      cells: Array.from({ length: sheet.columnCount }, (_unused, column) => {
        const cell = row.getCell(column + 1); return { value: cell.value, style: cell.style };
      }) };
  }), columns: sheet.columns.map((column) => ({ width: column.width, hidden: column.hidden, outlineLevel: column.outlineLevel })),
  merges: Object.keys(sheet._merges).map((key) => sheet._merges[key].range).sort(),
  views: sheet.views, pageSetup: sheet.pageSetup, properties: sheet.properties, headerFooter: sheet.headerFooter, autoFilter: sheet.autoFilter };
}

test('整月一个真 XLSX，全部主体主表在前、Pending 在后，值/样式/打印与旧主体输出一致', async (t) => {
  const data = fixture(t);
  const result = await runWriter(data);
  assert.equal(result.layout, 'subject-sheets-v1'); assert.equal(result.subjectCount, 2); assert.equal(result.sheetCount, 4);
  assert.deepEqual(result.filePaths, [data.outputPath]); assert.equal(result.artifactCount, 1);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(data.outputPath);
  assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ['A主体-结果表', 'B主体-结果表', 'A主体-移除归档Pending发生额计算表', 'B主体-移除归档Pending发生额计算表']);
  const paths = data.subjects.map((_s, i) => path.join(data.root, `baseline-${i}.xlsx`));
  await writeRunWorkbooks({ db: data.db, runId: data.runId, assetsDir, outputPaths: paths });
  for (let index = 0; index < paths.length; index += 1) {
    const old = new ExcelJS.Workbook(); await old.xlsx.readFile(paths[index]);
    assert.deepEqual(comparableSheet(book.worksheets[index]), comparableSheet(old.worksheets[0]));
    assert.deepEqual(comparableSheet(book.worksheets[index + 2]), comparableSheet(old.worksheets[1]));
  }
  assert.equal(book.worksheets[0].getCell('A2').value, 'A主体');
  assert.equal(book.worksheets[1].getCell('A2').value, 'B主体');
  assert.equal(book.worksheets[2].getCell('F2').value, 8); assert.equal(book.worksheets[3].getCell('F2').value, 16);
  assert.ok(result.metrics.peakBufferedBytes < 16 * 1024 * 1024); assert.ok(result.validation.sha256);
});

test('受管生成只返回一个 generation，支持外层只读事务且不提交该事务', async (t) => {
  const data = fixture(t, ['单主体']);
  const staging = path.join(data.root, 'owned-staging');
  data.db.exec('BEGIN DEFERRED');
  const result = await runWriter(data, { publicationStagingDirectory: staging });
  assert.equal(data.db.isTransaction, true); data.db.exec('ROLLBACK');
  assert.equal(result.generationFilePaths.length, 1); assert.ok(!fs.existsSync(data.outputPath));
  assert.deepEqual(fs.readdirSync(staging), [path.basename(result.generationFilePaths[0])]);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(result.generationFilePaths[0]);
  assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ['单主体-结果表', '单主体-移除归档Pending发生额计算表']);
});

const mutations = [
  ['第二主体原因缓存值不变但加入 shared formula', async (zip) => {
    const part = zip.file('xl/worksheets/sheet2.xml'); const xml = await part.async('string');
    assert.match(xml, /<c r="N4"/);
    zip.file(part.name, xml.replace(/(<c r="N4"[^>]*>)/, '$1<f t="shared" si="0">1+1</f>'));
  }, /公式|文本/],
  ['第二主体调整定义名称串到第一主体', async (zip) => {
    const part = zip.file('xl/workbook.xml'), xml = await part.async('string');
    assert.match(xml, /B主体-结果表/);
    zip.file(part.name, xml.replace(/(&apos;B主体-结果表&apos;!\$M\$4|'B主体-结果表'!\$M\$4)/, '&apos;A主体-结果表&apos;!$M$4'));
  }, /血缘/],
  ['第二主体合并从格注入值', async (zip) => {
    const part = zip.file('xl/worksheets/sheet2.xml'), xml = await part.async('string');
    assert.match(xml, /<c r="A3"[^>]*\/>/);
    zip.file(part.name, xml.replace(/<c r="A3"([^>]*)\/>/, '<c r="A3"$1><v>777</v></c>'));
  }, /合并|主体|内容/],
  ['第二主体 Pending 金额篡改', async (zip) => {
    const part = zip.file('xl/worksheets/sheet4.xml'), xml = await part.async('string');
    assert.match(xml, /<c r="F2"[^>]*><v>16<\/v><\/c>/);
    zip.file(part.name, xml.replace(/(<c r="F2"[^>]*><v>)16(<\/v>)/, '$1999$2'));
  }, /金额|内容/],
  ['第二主体打印范围指向第一主体', async (zip) => {
    const part = zip.file('xl/workbook.xml'), xml = await part.async('string');
    zip.file(part.name, xml.replace(/(<definedName name="_xlnm.Print_Area" localSheetId="1">)[\s\S]*?(<\/definedName>)/, '$1&apos;A主体-结果表&apos;!$$A$$1:$$L$$8$2'));
  }, /打印/],
  ['第二主体 USD 差异色改成第一主体零差异样式', async (zip) => {
    const first = await zip.file('xl/worksheets/sheet1.xml').async('string');
    const style = /<c r="L1" s="([^"]+)"/.exec(first)[1];
    const name = 'xl/worksheets/sheet2.xml', second = await zip.file(name).async('string');
    assert.notEqual(/<c r="L1" s="([^"]+)"/.exec(second)[1], style);
    zip.file(name, second.replace(/(<c r="L1" s=")[^"]+(")/, `$1${style}$2`));
  }, /样式|差异色/],
  ['SST 原因相同显示文本改成富文本 payload', async (zip) => {
    const name = 'xl/sharedStrings.xml', xml = await zip.file(name).async('string');
    zip.file(name, xml.replace(/<si><t([^>]*)>(B主体 原因[\s\S]*?)<\/t><\/si>/,
      '<si><r><t$1>$2</t></r></si>'));
  }, /富文本|payload/],
  ['第二主体 Pending 缺失', async (zip) => zip.remove('xl/worksheets/sheet4.xml'), /关系|存在|结构|部件/]
];
for (const [label, change, message] of mutations) test(`合法基线先通过，${label}必须拒绝并保护原文件`, async (t) => {
  const data = fixture(t);
  await runWriter(data);
  const before = fs.readFileSync(data.outputPath);
  await assert.rejects(runWriter(data, { beforeValidate: ({ filePath }) => mutate(filePath, change) }), message);
  assert.deepEqual(fs.readFileSync(data.outputPath), before);
  assert.equal(fs.readdirSync(data.root).filter((file) => /\.(tmp|bak)$/.test(file)).length, 0);
});

test('按 relationship 解析非连续 sheetId/任意合法部件名，错关系及重复引用拒绝', async (t) => {
  const data = fixture(t);
  const result = await runWriter(data, { beforeValidate: ({ filePath }) => mutate(filePath, async (zip) => {
    const source = 'xl/worksheets/sheet2.xml', target = 'xl/worksheets/subject-renamed.xml';
    zip.file(target, await zip.file(source).async('nodebuffer')); zip.remove(source);
    for (const name of ['[Content_Types].xml', 'xl/_rels/workbook.xml.rels']) {
      zip.file(name, (await zip.file(name).async('string')).replaceAll('worksheets/sheet2.xml', 'worksheets/subject-renamed.xml'));
    }
    zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml').async('string')).replace('sheetId="2"', 'sheetId="37"'));
  }) });
  assert.equal(result.sheetCount, 4);
  await assert.rejects(runWriter(data, { beforeValidate: ({ filePath }) => mutate(filePath, async (zip) => {
    const name = 'xl/_rels/workbook.xml.rels';
    zip.file(name, (await zip.file(name).async('string')).replace('worksheets/sheet2.xml', 'worksheets/sheet1.xml'));
  }) }), /关系|重复/);
});

test('Sheet 名含单引号和逗号，调整引用仍精确对应原始主体', async (t) => {
  const data = fixture(t, ["O'Brien,甲", 'A/B', 'A?B', `很长${'😀主体'.repeat(12)}`]);
  const result = await runWriter(data);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(data.outputPath);
  for (let index = 0; index < data.subjects.length; index += 1) {
    const subject = result.subjects[index];
    assert.equal(book.worksheets[index].getCell('A2').value, subject);
    const name = encodeAdjustmentLineageName(data.rowKeys[data.subjects.indexOf(subject)], 'USD');
    const found = book.definedNames.model.find((entry) => entry.name === name);
    assert.ok(found); assert.equal(normalizeRange(found.ranges[0]), normalizeRange(`'${result.sheetMapping[index].name.replace(/'/g, "''")}'!$M$4`));
  }
});

test('预算/第二主体失败/取消不交付部分正式结果，并保留原文件', async (t) => {
  const data = fixture(t); fs.writeFileSync(data.outputPath, 'original-protected');
  await assert.rejects(runWriter(data, { resourceLimits: { maxSubjectSourceRows: 1 } }), { code: 'vcc-result-export-resource-limit' });
  await assert.rejects(runWriter(data, { beforeSubjectWrite: ({ ordinal }) => { if (ordinal === 1) throw new Error('第二主体失败'); } }), /第二主体失败/);
  const control = new AbortController();
  await assert.rejects(runWriter(data, { abortSignal: control.signal, beforeSubjectWrite: ({ ordinal }) => { if (ordinal === 1) control.abort(); } }), /取消/);
  assert.equal(fs.readFileSync(data.outputPath, 'utf8'), 'original-protected');
  assert.equal(fs.readdirSync(data.root).filter((file) => /\.(tmp|bak)$/.test(file)).length, 0);
});


test('有汇总无明细及零差异主体仍保留主表与空 Pending 附表', async (t) => {
  const data = fixture(t);
  for (const table of ['vcc_fin_op_run_rows', 'vcc_fin_op_run_adjustments', 'vcc_fin_op_pending_summary_rows', 'vcc_fin_op_pending_currency_totals']) {
    data.db.prepare(`DELETE FROM ${table} WHERE run_id = ? AND subject = 'B主体'`).run(data.runId);
  }
  data.db.prepare("UPDATE vcc_fin_op_run_balances SET period_amount='0',calculated_balance='100',system_balance='100',difference='0' WHERE run_id=? AND subject='B主体'").run(data.runId);
  data.db.prepare('UPDATE vcc_fin_op_runs SET result_revision=1 WHERE id=?').run(data.runId);
  const result = await runWriter(data);
  assert.equal(result.subjectCount, 2); assert.equal(result.sheetCount, 4);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(data.outputPath);
  assert.equal(book.worksheets[1].rowCount, 5);
  assert.equal(book.worksheets[1].getCell('L2').value, 100);
  assert.equal(book.worksheets[1].getCell('L5').value, 0);
  assert.equal(book.worksheets[3].rowCount, 2);
  assert.equal(book.worksheets[3].getCell('F2').value, null);
});

test('快照内多轮读取不混入第二连接对 Pending 的并发更改', async (t) => {
  const data = fixture(t); data.db.exec('PRAGMA journal_mode=WAL');
  const other = new DatabaseSync(path.join(data.root, 'fixture.sqlite'));
  try {
    const result = await runWriter(data, { beforeSubjectWrite: ({ ordinal }) => {
      if (ordinal === 1) other.prepare("UPDATE vcc_fin_op_pending_summary_rows SET flow_amount='999' WHERE run_id=? AND subject='B主体'").run(data.runId);
    } });
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(result.filePaths[0]);
    assert.equal(book.worksheets[3].getCell('F2').value, 16);
    assert.equal(other.prepare("SELECT flow_amount FROM vcc_fin_op_pending_summary_rows WHERE subject='B主体'").get().flow_amount, '999');
  } finally {
    // 公共 fixture 的 after 会删除目录；第二连接须在交还清理责任前关闭。
    other.close();
  }
});

test('全 run revision、孤儿主体和 SST 预算异常均失败，不遗留本次临时字符串文件', async (t) => {
  const data = fixture(t);
  data.db.prepare('UPDATE vcc_fin_op_runs SET result_revision=1 WHERE id=?').run(data.runId);
  await assert.rejects(runWriter(data), { code: 'result-revision-inconsistent' });
  data.db.prepare('UPDATE vcc_fin_op_runs SET result_revision=2 WHERE id=?').run(data.runId);
  data.db.prepare("UPDATE vcc_fin_op_pending_summary_rows SET subject='孤儿主体' WHERE run_id=? AND subject='B主体'").run(data.runId);
  await assert.rejects(runWriter(data), /有效主体集合/);
  data.db.prepare("UPDATE vcc_fin_op_pending_summary_rows SET subject='B主体' WHERE run_id=? AND subject='孤儿主体'").run(data.runId);
  await assert.rejects(runWriter(data, { resourceLimits: { maxSharedStringsXmlBytes: 1 } }), { code: 'vcc-result-export-resource-limit' });
  assert.ok(!fs.existsSync(data.outputPath)); assert.equal(data.db.isTransaction, false);
  assert.equal(fs.readdirSync(data.root).filter((file) => /sst-|\.(tmp|bak)$/.test(file)).length, 0);
});


function forceValidationSpill(t, observedRoots) {
  const append = AdaptiveSharedStringsProvider.prototype.append;
  t.mock.method(AdaptiveSharedStringsProvider.prototype, 'append', function (value) {
    if (path.basename(this.tempRoot).startsWith('result-sst-validation-')) {
      observedRoots.add(this.tempRoot);
      // 只降低故障注入预算，真实 provider 仍走生产 spill、读回和严格关闭路径。
      this.memoryBudgetBytes = 1;
    }
    return append.call(this, value);
  });
}

test('校验 SST spill 只占用本次 generation 目录，成功严格关闭后无遗留', async (t) => {
  const data = fixture(t), roots = new Set();
  forceValidationSpill(t, roots);
  const staging = path.join(data.root, 'owned-staging');
  const result = await runWriter(data, { publicationStagingDirectory: staging });
  assert.equal(roots.size, 1);
  for (const root of roots) { assert.equal(path.dirname(root), staging); assert.equal(fs.existsSync(root), false); }
  assert.deepEqual(fs.readdirSync(staging), [path.basename(result.generationFilePaths[0])]);
});

test('校验 SST spill 身份变化时保留替换内容和恢复凭据，禁止父 owner 递归清理', async (t) => {
  const data = fixture(t), roots = new Set();
  fs.writeFileSync(data.outputPath, 'protected-original');
  forceValidationSpill(t, roots);
  const lstat = fs.promises.lstat.bind(fs.promises);
  let replacedPath;
  t.mock.method(fs.promises, 'lstat', async (file, ...args) => {
    if (!replacedPath && roots.has(path.dirname(file)) && path.basename(file) === 'sst.bin') {
      fs.renameSync(file, file + '.original');
      fs.writeFileSync(file, 'replacement-evidence');
      replacedPath = file;
    }
    return lstat(file, ...args);
  });
  await assert.rejects(runWriter(data), (error) => {
    assert.equal(error.preserveTemporaryFiles, true);
    assert.ok(error.recoveryPaths.some((root) => roots.has(root)));
    assert.ok(error.cause);
    return true;
  });
  assert.ok(replacedPath); assert.equal(fs.readFileSync(replacedPath, 'utf8'), 'replacement-evidence');
  assert.equal(fs.readFileSync(data.outputPath, 'utf8'), 'protected-original');
  assert.ok(fs.readdirSync(data.root).some((name) => name.endsWith('.tmp')));
});

test('写出 SST 临时文件身份变化时显式保留恢复凭据，不能删除替换内容', async (t) => {
  const data = fixture(t); fs.writeFileSync(data.outputPath, 'protected-original');
  let replacedPath;
  await assert.rejects(runWriter(data, { beforeSubjectWrite: ({ ordinal }) => {
    if (ordinal !== 0) return;
    const name = fs.readdirSync(data.root).find((value) => /\.sst-.*\.xml$/.test(value));
    assert.ok(name);
    replacedPath = path.join(data.root, name);
    fs.renameSync(replacedPath, replacedPath + '.original');
    fs.writeFileSync(replacedPath, 'replacement-evidence');
  } }), (error) => {
    assert.equal(error.preserveTemporaryFiles, true);
    assert.ok(error.recoveryPaths.includes(replacedPath));
    return /所有权/.test(error.message);
  });
  assert.equal(fs.readFileSync(replacedPath, 'utf8'), 'replacement-evidence');
  assert.equal(fs.readFileSync(data.outputPath, 'utf8'), 'protected-original');
  assert.ok(fs.readdirSync(data.root).some((name) => name.endsWith('.tmp')));
});


for (const subjects of [['Straße', 'STRASSE'], ['σ', 'ς'], ['ﬀ', 'FF'], ['ß', 'ẞ']]) {
  test(`Unicode 碰撞主体 ${subjects.join(' / ')} 经真实 Writer 与 Validator 后保留独立金额和调整引用`, async (t) => {
    const data = fixture(t, subjects);
    const result = await runWriter(data);
    assert.equal(result.subjectCount, 2); assert.equal(result.sheetCount, 4);
    assert.equal(result.validation.sheetCount, 4); assert.ok(result.validation.sha256);
    assert.deepEqual(new Set(result.subjects), new Set(subjects));
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(data.outputPath);
    const names = book.worksheets.map((sheet) => sheet.name);
    assert.equal(book.worksheets.length, 4); assert.equal(new Set(names.map((name) => name.toUpperCase())).size, 4);
    assert.deepEqual(names, result.sheetMapping.map((sheet) => sheet.name));
    for (let index = 0; index < result.subjects.length; index += 1) {
      const subject = result.subjects[index], factor = subjects.indexOf(subject) + 1;
      const main = book.worksheets[index], pending = book.worksheets[index + 2];
      assert.equal(main.getCell('A2').value, subject);
      assert.equal(main.getCell('L3').value, factor * 10);
      assert.equal(main.getCell('L4').value, factor);
      assert.equal(main.getCell('M4').value, factor);
      assert.equal(main.getCell('N4').value, `${subject} 原因\n字面 _x0041_ & <校验>`);
      assert.equal(pending.getCell('F2').value, factor * 8);
      assert.equal(pending.getCell('G2').value, factor * -2);
      const lineageName = encodeAdjustmentLineageName(data.rowKeys[factor - 1], 'USD');
      const found = book.definedNames.model.find((entry) => entry.name === lineageName);
      assert.ok(found);
      assert.deepEqual(found.ranges.map(normalizeRange), [normalizeRange(`'${main.name}'!$M$4`)]);
    }
    const repeated = await runWriter(data, { outputPaths: [path.join(data.root, 'repeat.xlsx')] });
    assert.deepEqual(repeated.sheetMapping, result.sheetMapping);
    assert.equal(repeated.validation.sheetCount, 4);
  });
}
