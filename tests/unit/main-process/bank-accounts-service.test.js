'use strict';

// 设置 → 账户管理服务：表头识别与单元格文本、预检拦截、整份替换与失败回滚、原文件存放与清理、另存为原表。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const { ensureBankAccountSnapshotSupport } = require('../../../src/backend/database/migrations');
const repo = require('../../../src/backend/database/bank-account-repository');
const { cellText, parseBankAccountWorkbook } = require('../../../src/main-process/bank-accounts/workbook');
const { createBankAccountService } = require('../../../src/main-process/bank-accounts/service');

const HEADERS = ['银行/通道简称', '银行账号', '账户状态', '开户日期'];

function workbookBytes(sheets) {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), name);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function parse(bytes, expectedHeaders = HEADERS) {
  return parseBankAccountWorkbook(bytes, { fileName: 'a.xlsx', expectedHeaders, structureName: '清结算银行账户表', versionLabel: 'V1', channelHeader: '银行/通道简称' });
}

function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-accounts-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(':memory:');
  ensureBankAccountSnapshotSupport(db);
  const store = {
    readBankAccountSnapshot: () => repo.readSnapshot(db),
    listBankAccountChannels: () => repo.listChannels(db),
    countBankAccountRows: (options) => repo.countRows(db, options),
    listBankAccountRows: (options) => repo.listRows(db, options),
    replaceBankAccountSnapshot: (payload) => repo.replaceSnapshot(db, payload)
  };
  const logs = [];
  const changes = [];
  let structure = { status: 'builtin', versionId: 'v1', label: 'V1', headers: HEADERS };
  let clock = new Date(2026, 10, 5, 21, 30);
  const service = createBankAccountService({
    userDataRoot: root,
    store,
    resolveStructure: async () => structure,
    log: (entry) => logs.push(entry),
    onChanged: (payload) => changes.push(payload),
    now: () => clock,
    ...overrides
  });
  const file = (name, sheets) => {
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, workbookBytes(sheets));
    service.rememberPickedFile(filePath);
    return filePath;
  };
  return {
    root, db, store, service, logs, changes, file,
    stored: () => (fs.existsSync(path.join(root, 'bank-accounts')) ? fs.readdirSync(path.join(root, 'bank-accounts')).sort() : []),
    setStructure: (value) => { structure = value; },
    advance: (ms) => { clock = new Date(clock.getTime() + ms); }
  };
}

const rows = (...specs) => [HEADERS, ...specs];

test('单元格文本：字符串去首尾空格，数值、日期、布尔转为显示文本', () => {
  assert.equal(cellText('  招商银行 '), '招商银行');
  assert.equal(cellText(6222000012345678), '6222000012345678');
  assert.equal(cellText(-0), '0');
  assert.equal(cellText(new Date(2024, 0, 2)), '2024-01-02');
  assert.equal(cellText(new Date(2024, 0, 2, 9, 5, 7)), '2024-01-02 09:05:07');
  assert.equal(cellText(true), 'TRUE');
  assert.equal(cellText(null), '');
  assert.equal(cellText(Number.NaN), '');
});

test('表头识别：只认与当前结构完全一致的工作表；空行跳过但保留 Excel 行号；超出表头的列不读取', () => {
  const parsed = parse(workbookBytes([
    ['说明', [['这是说明页']]],
    ['账户', [[...HEADERS, ''], ['招商银行', 6222, '正常', new Date(2024, 0, 2), '多余'], [], ['', '', '', ''], [' 花旗 ', '88', '注销', '']]]
  ]));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sheetName, '账户');
  assert.deepEqual(parsed.rows, [
    { excelRowNumber: 2, channel: '招商银行', values: ['招商银行', '6222', '正常', '2024-01-02'] },
    { excelRowNumber: 5, channel: '花旗', values: ['花旗', '88', '注销', ''] }
  ]);
});

test('表头不一致时列出与当前结构的差异；多个工作表一致时拒绝；第 1 行为空不按后续行识别', () => {
  const mismatch = parse(workbookBytes([['S', [['银行/通道简称', '银行账号', '账户状态', '开户时间']]]]));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.message, '无法识别为清结算银行账户表：a.xlsx');
  assert.ok(mismatch.detailLines.includes('第 4 列（D）：应为「开户日期」，实际为「开户时间」'), mismatch.detailLines.join('\n'));
  assert.ok(mismatch.detailLines.at(-1).includes('设置 → 模板文件'));
  const ambiguous = parse(workbookBytes([['A', rows()], ['B', rows()]]));
  assert.equal(ambiguous.message, '文件中有 2 个工作表与清结算银行账户表结构一致，无法确定使用哪一个：a.xlsx');
  assert.deepEqual(ambiguous.detailLines, ['工作表「A」', '工作表「B」']);
  assert.equal(parse(workbookBytes([['S', [[], HEADERS, ['招商银行', '1', '正常', '']]]])).ok, false);
  assert.equal(parse(Buffer.from('not a workbook at all')).ok, false);
});

test('预检拦截：未经选择框的路径、不支持的扩展名、空文件、超限、结构不可用或缺渠道列、无数据行', async (t) => {
  const env = setup(t, { readFileCapped: async (filePath, maxBytes) => {
    if (filePath.endsWith('big.xlsx')) throw Object.assign(new Error(`文件超过 ${maxBytes / 1024 / 1024} MiB`), { code: 'BANK_ACCOUNT_FILE_TOO_LARGE' });
    return fs.promises.readFile(filePath);
  } });
  const ok = env.file('ok.xlsx', [['S', rows(['招商银行', '1', '正常', ''])]]);
  assert.equal((await env.service.prepareImport({ filePath: path.join(env.root, 'other.xlsx') })).message, '请通过【导入银行账户信息】选择文件');
  const csv = path.join(env.root, 'a.csv');
  fs.writeFileSync(csv, 'x');
  env.service.rememberPickedFile(csv);
  assert.equal((await env.service.prepareImport({ filePath: csv })).message, '仅支持 .xlsx / .xls 文件：a.csv');
  const empty = path.join(env.root, 'empty.xlsx');
  fs.writeFileSync(empty, '');
  env.service.rememberPickedFile(empty);
  assert.equal((await env.service.prepareImport({ filePath: empty })).message, '文件为空：empty.xlsx');
  const big = env.file('big.xlsx', [['S', rows()]]);
  assert.equal((await env.service.prepareImport({ filePath: big })).message, '文件超过 20 MiB，无法导入：big.xlsx');
  env.setStructure({ status: 'unavailable', label: 'V2', message: '模板「清结算银行账户表」当前版本 V2 不可用：版本文件缺失' });
  assert.equal((await env.service.prepareImport({ filePath: ok })).message, '模板「清结算银行账户表」当前版本 V2 不可用：版本文件缺失');
  env.setStructure({ status: 'user', versionId: 'v2', label: 'V2', headers: HEADERS.filter((header) => header !== '银行/通道简称') });
  assert.match((await env.service.prepareImport({ filePath: ok })).message, /当前版本 V2 缺少「银行\/通道简称」列/);
  env.setStructure({ status: 'builtin', versionId: 'v1', label: 'V1', headers: HEADERS });
  const headerOnly = env.file('header-only.xlsx', [['S', rows()]]);
  assert.equal((await env.service.prepareImport({ filePath: headerOnly })).message, '文件中没有账户数据行：header-only.xlsx');
  assert.equal(env.store.readBankAccountSnapshot(), null);
  assert.deepEqual(env.stored(), []);
});

test('导入：确认后写入原文件与账户行并通知；再次导入删除旧原文件；预检令牌只能用一次', async (t) => {
  const env = setup(t);
  const first = env.file('第一份.xlsx', [['S', rows(['招商银行', '1', '正常', ''], ['花旗', '2', '注销', ''])]]);
  const prepared = await env.service.prepareImport({ filePath: first });
  assert.deepEqual({ ...prepared, importToken: typeof prepared.importToken }, {
    status: 'success', importToken: 'string', fileName: '第一份.xlsx', sheetName: 'S', structureLabel: 'V1',
    rowCount: 2, channelCount: 2, previousRowCount: 0, previousFileName: ''
  });
  assert.deepEqual(env.stored(), [], '预检不落盘');
  const committed = await env.service.commitImport({ importToken: prepared.importToken });
  assert.deepEqual(committed, { status: 'success', snapshotNo: 1, fileName: '第一份.xlsx', rowCount: 2, channelCount: 2 });
  assert.deepEqual(env.changes, [{ snapshotNo: 1 }]);
  assert.equal(env.stored().length, 1);
  assert.equal((await env.service.commitImport({ importToken: prepared.importToken })).message, '导入预检已失效，请重新选择文件');

  const second = env.file('第二份.xlsx', [['S', rows(['汇丰', '3', '正常', ''])]]);
  const again = await env.service.prepareImport({ filePath: second });
  assert.deepEqual([again.previousRowCount, again.previousFileName], [2, '第一份.xlsx']);
  assert.equal((await env.service.commitImport({ importToken: again.importToken })).status, 'success');
  assert.equal(env.stored().length, 1);
  assert.ok(env.stored()[0].endsWith('.xlsx'));
  assert.equal(env.service.getSnapshotMeta().fileName, '第二份.xlsx');
  assert.deepEqual(env.service.listAccounts(), [{ excelRowNumber: 2, channel: '汇丰', record: { '银行/通道简称': '汇丰', 银行账号: '3', 账户状态: '正常', 开户日期: '' } }]);
  assert.ok(env.logs.some((entry) => entry.message === '账户管理：导入银行账户信息成功' && entry.details.includes('账户行数：2 → 1')));
});

test('预检后账户表已被另一次导入替换：确认时提示重新导入，不写入、不留下原文件', async (t) => {
  const env = setup(t);
  const first = env.file('a.xlsx', [['S', rows(['招商银行', '1', '正常', ''])]]);
  const second = env.file('b.xlsx', [['S', rows(['花旗', '2', '正常', ''])]]);
  const stale = await env.service.prepareImport({ filePath: second });
  const winner = await env.service.prepareImport({ filePath: first });
  assert.equal((await env.service.commitImport({ importToken: winner.importToken })).status, 'success');
  const before = env.stored();
  assert.equal((await env.service.commitImport({ importToken: stale.importToken })).message, '账户表在预检之后已被替换，请重新导入银行账户信息');
  assert.deepEqual(env.stored(), before);
  assert.equal(env.service.getSnapshotMeta().fileName, 'a.xlsx');
});

test('保存原文件失败或写库失败：账户表不变，新原文件被清理', async (t) => {
  const writeFailure = setup(t, { writeStoredFile: async () => { throw new Error('ENOSPC: no space left on device'); } });
  const file = writeFailure.file('a.xlsx', [['S', rows(['招商银行', '1', '正常', ''])]]);
  const prepared = await writeFailure.service.prepareImport({ filePath: file });
  assert.equal((await writeFailure.service.commitImport({ importToken: prepared.importToken })).message,
    '保存原表文件失败，账户表未改变：ENOSPC: no space left on device');
  assert.equal(writeFailure.store.readBankAccountSnapshot(), null);

  const dbFailure = setup(t);
  dbFailure.store.replaceBankAccountSnapshot = () => { throw new Error('database is locked'); };
  const other = dbFailure.file('b.xlsx', [['S', rows(['花旗', '2', '正常', ''])]]);
  const preparedOther = await dbFailure.service.prepareImport({ filePath: other });
  assert.equal((await dbFailure.service.commitImport({ importToken: preparedOther.importToken })).message, '写入账户表失败，账户表未改变：database is locked');
  assert.deepEqual(dbFailure.stored(), []);
  assert.deepEqual(dbFailure.changes, []);
});

test('预检暂存最多 2 份且 30 分钟后失效；放弃的预检不能再提交', async (t) => {
  const env = setup(t);
  const file = env.file('a.xlsx', [['S', rows(['招商银行', '1', '正常', ''])]]);
  const first = await env.service.prepareImport({ filePath: file });
  const second = await env.service.prepareImport({ filePath: file });
  const third = await env.service.prepareImport({ filePath: file });
  assert.equal((await env.service.commitImport({ importToken: first.importToken })).status, 'failed', '最早的一份被淘汰');
  env.service.discardImport(second.importToken);
  assert.equal((await env.service.commitImport({ importToken: second.importToken })).status, 'failed');
  env.advance(31 * 60 * 1000);
  await env.service.prepareImport({ filePath: file });
  assert.equal((await env.service.commitImport({ importToken: third.importToken })).status, 'failed', '过期的预检被清理');
});

test('首次读取概况时清理未被引用的旧原文件与写入中断的临时文件，其他文件不动', async (t) => {
  const env = setup(t);
  const file = env.file('a.xlsx', [['S', rows(['招商银行', '1', '正常', ''])]]);
  const prepared = await env.service.prepareImport({ filePath: file });
  await env.service.commitImport({ importToken: prepared.importToken });
  const [kept] = env.stored();
  const directory = path.join(env.root, 'bank-accounts');
  const orphan = `${'c'.repeat(64)}.xls`;
  const temporary = `${'d'.repeat(64)}.xlsx.tmp-123-456`;
  for (const name of [orphan, temporary, 'readme.txt']) fs.writeFileSync(path.join(directory, name), 'x');
  const restarted = createBankAccountService({ userDataRoot: env.root, store: env.store, resolveStructure: async () => null });
  const overview = await restarted.getOverview();
  assert.equal(overview.snapshot.fileName, 'a.xlsx');
  assert.deepEqual(env.stored(), [kept, 'readme.txt'].sort());
});

test('另存为原表：字节一致；拒绝相对路径与存放目录；原文件被改动时拒绝且不改写目标', async (t) => {
  const env = setup(t);
  assert.deepEqual(env.service.resolveOriginal(), { status: 'failed', message: '尚未导入银行账户信息', detailLines: [] });
  const file = env.file('原表.xlsx', [['S', rows(['招商银行', '1', '正常', ''])]]);
  const prepared = await env.service.prepareImport({ filePath: file });
  await env.service.commitImport({ importToken: prepared.importToken });
  assert.deepEqual(env.service.resolveOriginal(), { status: 'success', fileName: '原表.xlsx', extension: 'xlsx' });
  const target = path.join(env.root, 'out', '导出.xlsx');
  fs.mkdirSync(path.dirname(target));
  assert.equal((await env.service.exportOriginal({ targetPath: target })).status, 'success');
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(file));
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['导出.xlsx'], '不留临时文件');
  assert.equal((await env.service.exportOriginal({ targetPath: 'relative.xlsx' })).message, '保存位置无效');
  const storedPath = path.join(env.root, 'bank-accounts', env.stored()[0]);
  assert.equal((await env.service.exportOriginal({ targetPath: storedPath })).message, '不能保存到账户管理的存放目录，请选择其他位置');
  fs.writeFileSync(target, 'user document');
  fs.appendFileSync(storedPath, 'tamper');
  assert.equal((await env.service.exportOriginal({ targetPath: target })).message, '原表文件已被修改，请重新导入银行账户信息');
  assert.equal(fs.readFileSync(target, 'utf8'), 'user document');
});

test('分页查询：渠道筛选、页大小上限与未导入时的空结果', async (t) => {
  const env = setup(t);
  assert.deepEqual(env.service.list({}), { status: 'success', snapshotNo: 0, headers: [], channel: '', total: 0, offset: 0, limit: 200, rows: [] });
  const data = Array.from({ length: 7 }, (_value, index) => [index % 2 ? '花旗' : '招商银行', String(index), '正常', '']);
  const file = env.file('a.xlsx', [['S', rows(...data)]]);
  const prepared = await env.service.prepareImport({ filePath: file });
  await env.service.commitImport({ importToken: prepared.importToken });
  const page = env.service.list({ channel: '花旗', offset: 1, limit: 2 });
  assert.deepEqual([page.total, page.rows.map((row) => row.values[1]), page.headers], [3, ['3', '5'], HEADERS]);
  assert.equal(env.service.list({ limit: 10000 }).limit, 500);
  assert.equal(env.service.list({ limit: -1, offset: -5 }).offset, 0);
  assert.deepEqual((await env.service.getOverview()).channels, [{ channel: '花旗', rowCount: 3 }, { channel: '招商银行', rowCount: 4 }]);
});
