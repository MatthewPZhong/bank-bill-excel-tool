'use strict';

// v3.2.18 模板管理【更新】：updateTemplateHeaders 只替换表头、源文件名与更新时间，
// 映射、大账号、固定值、币种大账号、字段筛选、按字段区分发生额与拆分配置全部保留；
// 期望表头不一致或模板不存在时拒绝写入。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AppDatabase } = require('../../../../src/backend/database');
const { MERCHANT_ID_CURRENCY_ONLY_MARKER } = require('../../../../src/backend/file-service/common');

const PRESERVED_TABLES = [
  'template_mappings',
  'template_big_accounts',
  'template_fixed_assignments',
  'template_currency_big_accounts',
  'template_amount_split_rules',
  'template_bill_split_mappings',
  'template_bill_split_rows',
  'template_bill_split_amount_rules',
  'template_bill_split_meta'
];

function createDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-header-update-'));
  const appDb = new AppDatabase(path.join(dir, 'test.sqlite'));
  appDb.init();
  // 先关库再删目录（Windows 上未关闭的库文件会导致 EBUSY）。
  t.after(() => {
    try { appDb.db.close(); } catch (_error) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return appDb;
}

function snapshot(appDb, templateId) {
  const templateRow = { ...appDb.db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId) };
  delete templateRow.headers_json;
  delete templateRow.source_file_name;
  delete templateRow.updated_at;
  const tables = Object.fromEntries(PRESERVED_TABLES.map((table) => [
    table,
    appDb.db.prepare(`SELECT * FROM ${table} WHERE template_id = ? ORDER BY rowid`).all(templateId).map((row) => ({ ...row }))
  ]));
  return { templateRow, tables };
}

function seedFullTemplate(appDb) {
  const template = appDb.upsertTemplate({
    name: '招商银行-上海',
    sourceFileName: 'old.xlsx',
    headers: ['交易日期', '交易金额', '借贷标志', '摘要', '对方户名']
  });
  appDb.saveMappings(template.id, [
    { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
    { templateField: 'MerchantId', mappedField: '__FIXED__:__MULTI_BIG_ACCOUNT__', mappedFields: [] },
    { templateField: 'Remark', mappedField: '需要拼接字段', mappedFields: ['摘要', '对方户名'] },
    { templateField: 'Description', mappedField: '字段筛选特征值', mappedFields: [] },
    { templateField: '按字段区分发生额', mappedField: '是', mappedFields: [] }
  ], [
    { merchantId: 'NET001', currency: 'CNY', accountNature: 'client' },
    { merchantId: 'OWN001', currency: 'USD', accountNature: 'own' }
  ], [
    { merchantId: 'NET001', currency: 'CNY', rowIndex: 0 }
  ], 'auto', [
    { targetField: 'Credit Amount', conditionField: '借贷标志', conditionValue: '贷', mappedField: '交易金额', rowIndex: 0 }
  ], {
    featureFilter: { sourceField: '摘要', separator: '空格', length: 6 }
  });
  appDb.saveBillSplitMappings(template.id, [
    { templateField: 'Remark', mappedField: '摘要', mappedFields: [], rowIndex: 0 }
  ]);
  appDb.saveBillSplitRowCount(template.id, 2);
  appDb.saveBillSplitRow(template.id, {
    seqNo: 1, currencySourceField: '__FIXED__:CNY', creditSourceField: '交易金额', debitSourceField: '', amountSourceField: '', rowStatus: 'completed'
  });
  appDb.saveBillSplitAmountRules(template.id, [
    { targetField: 'Debit Amount', conditionField: '借贷标志', conditionValue: '借', mappedField: '交易金额', rowIndex: 0 }
  ]);
  appDb.saveBillSplitMeta(template.id, { signedAmountSourceField: '交易金额' });
  appDb.saveTemplateFilenameFixedField(template.id, 'MerchantId');
  return appDb.getTemplate(template.id);
}

test('更新表头只改 headers_json / source_file_name / updated_at，其余配置逐表不变', (t) => {
  const appDb = createDatabase(t);
  const template = seedFullTemplate(appDb);
  const other = appDb.upsertTemplate({ name: '工商银行-北京', sourceFileName: 'icbc.xlsx', headers: ['日期', '金额'] });
  appDb.saveMappings(other.id, [
    { templateField: 'MerchantId', mappedField: MERCHANT_ID_CURRENCY_ONLY_MARKER, mappedFields: [] },
    { templateField: 'Currency', mappedField: '币种', mappedFields: [] }
  ], [], [], 'auto', null, { currencyBigAccounts: [{ currency: 'USD', merchantId: 'NET9' }] });

  const before = snapshot(appDb, template.id);
  const otherBefore = snapshot(appDb, other.id);
  assert.ok(before.tables.template_mappings.length > 0);
  assert.ok(before.tables.template_big_accounts.length === 2);
  assert.ok(before.tables.template_fixed_assignments.length === 1);
  assert.ok(before.tables.template_amount_split_rules.length === 1);
  assert.ok(before.tables.template_bill_split_rows.length === 2);
  assert.ok(otherBefore.tables.template_currency_big_accounts.length === 1);

  const nextHeaders = ['交易日期', '交易金额(元)', '借贷标志', '摘要', '对方户名', '附言'];
  const updated = appDb.updateTemplateHeaders(template.id, {
    expectedHeaders: template.headers,
    headers: nextHeaders,
    sourceFileName: 'new.xlsx'
  });

  assert.deepEqual(updated.headers, nextHeaders);
  assert.equal(updated.sourceFileName, 'new.xlsx');
  assert.equal(updated.name, template.name);
  assert.equal(updated.id, template.id);
  assert.deepEqual(snapshot(appDb, template.id), before);
  assert.deepEqual(snapshot(appDb, other.id), otherBefore);
  assert.deepEqual(appDb.getTemplate(other.id).headers, ['日期', '金额']);
  assert.deepEqual(appDb.getTemplate(template.id).featureFilter, template.featureFilter);
});

test('期望表头与当前不一致时拒绝写入（TEMPLATE_HEADERS_CHANGED），数据不变', (t) => {
  const appDb = createDatabase(t);
  const template = seedFullTemplate(appDb);
  const before = appDb.db.prepare('SELECT headers_json, source_file_name, updated_at FROM templates WHERE id = ?').get(template.id);

  assert.throws(() => appDb.updateTemplateHeaders(template.id, {
    expectedHeaders: ['交易日期', '交易金额'],
    headers: ['交易日期', '金额'],
    sourceFileName: 'new.xlsx'
  }), (error) => error.code === 'TEMPLATE_HEADERS_CHANGED');

  assert.deepEqual(
    { ...appDb.db.prepare('SELECT headers_json, source_file_name, updated_at FROM templates WHERE id = ?').get(template.id) },
    { ...before }
  );
});

test('模板不存在时拒绝写入（TEMPLATE_NOT_FOUND）', (t) => {
  const appDb = createDatabase(t);
  assert.throws(() => appDb.updateTemplateHeaders(9999, {
    expectedHeaders: [],
    headers: ['日期'],
    sourceFileName: 'x.xlsx'
  }), (error) => error.code === 'TEMPLATE_NOT_FOUND');
});
