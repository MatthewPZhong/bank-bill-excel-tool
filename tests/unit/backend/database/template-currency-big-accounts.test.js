'use strict';

// v3.2.16：MerchantId「原始账单仅有币种无账户号」的 币种 → 大账号 存储（template_currency_big_accounts）。
//   - 启动迁移幂等；按维护顺序读写，币种统一存大写，同模板内币种不区分大小写唯一；
//   - 保存成其他 MerchantId 映射、同名 / 同 key 重新导入模板时清空，删除模板时级联删除；
//   - 不写入 template_big_accounts（不参与大账号识别、选择与渠道汇总）；模板包条目带上配置。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AppDatabase } = require('../../../../src/backend/database');
const { MERCHANT_ID_CURRENCY_ONLY_MARKER } = require('../../../../src/backend/file-service/common');

const CURRENCY_ONLY_MAPPINGS = [
  { templateField: 'MerchantId', mappedField: MERCHANT_ID_CURRENCY_ONLY_MARKER, mappedFields: [] },
  { templateField: 'Currency', mappedField: '币种', mappedFields: [] }
];

function createDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-currency-big-accounts-'));
  const appDb = new AppDatabase(path.join(dir, 'test.sqlite'));
  appDb.init();
  t.after(() => {
    try { appDb.db.close(); } catch (_error) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return appDb;
}

function createTemplate(appDb, overrides = {}) {
  return appDb.upsertTemplate({
    name: '招商银行-上海',
    sourceFileName: 'a.xlsx',
    headers: ['日期', '币种', '收入', '支出'],
    ...overrides
  });
}

function save(appDb, templateId, mappings, options = {}) {
  return appDb.saveMappings(templateId, mappings, [], [], 'auto', null, options);
}

test('迁移幂等；按维护顺序读写，币种存大写；不写入大账号表；模板摘要显示按币种', (t) => {
  const appDb = createDatabase(t);
  appDb.ensureTemplateCurrencyBigAccountSupport();
  appDb.ensureTemplateCurrencyBigAccountSupport();
  const template = createTemplate(appDb);

  save(appDb, template.id, CURRENCY_ONLY_MAPPINGS, {
    currencyBigAccounts: [
      { currency: 'usd', merchantId: 'NET1' },
      { currency: 'EUR', merchantId: 'NET2' },
      { currency: 'HKD', merchantId: 'NET1' }
    ]
  });

  assert.deepEqual(appDb.getTemplateCurrencyBigAccounts(template.id), [
    { currency: 'USD', merchantId: 'NET1', rowIndex: 0 },
    { currency: 'EUR', merchantId: 'NET2', rowIndex: 1 },
    { currency: 'HKD', merchantId: 'NET1', rowIndex: 2 }
  ]);
  assert.deepEqual(appDb.getTemplateBigAccounts(template.id, { includeOwn: true }), []);
  assert.deepEqual(appDb.getTemplateMappings(template.id).currencyBigAccounts.map((item) => item.currency), ['USD', 'EUR', 'HKD']);
  const summary = appDb.getTemplate(template.id);
  assert.equal(summary.bigAccountSummary, '按币种（2个大账号）');
  assert.equal(summary.bigAccountMode, 'by-currency');
  assert.equal(appDb.listTemplates().find((item) => item.id === template.id).bigAccountSummary, '按币种（2个大账号）');
});

test('同一模板内币种不区分大小写唯一', (t) => {
  const appDb = createDatabase(t);
  const template = createTemplate(appDb);
  save(appDb, template.id, CURRENCY_ONLY_MAPPINGS, { currencyBigAccounts: [{ currency: 'USD', merchantId: 'NET1' }] });

  assert.throws(() => appDb.db
    .prepare(`INSERT INTO template_currency_big_accounts
      (template_id, currency, merchant_id, row_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(template.id, 'usd', 'NET2', 1, 'x', 'x'), /UNIQUE/);
});

test('未传配置时保留本模式的现有配置；保存成其他 MerchantId 映射时清空', (t) => {
  const appDb = createDatabase(t);
  const template = createTemplate(appDb);
  save(appDb, template.id, CURRENCY_ONLY_MAPPINGS, { currencyBigAccounts: [{ currency: 'USD', merchantId: 'NET1' }] });

  save(appDb, template.id, CURRENCY_ONLY_MAPPINGS);
  assert.equal(appDb.getTemplateCurrencyBigAccounts(template.id).length, 1);

  save(appDb, template.id, [{ templateField: 'MerchantId', mappedField: '币种', mappedFields: [] }]);
  assert.deepEqual(appDb.getTemplateCurrencyBigAccounts(template.id), []);
  assert.equal(appDb.getTemplate(template.id).bigAccountSummary, '来自账单');

  // 传入配置但 MerchantId 不是本模式：不写入
  save(appDb, template.id, [{ templateField: 'MerchantId', mappedField: '币种', mappedFields: [] }], {
    currencyBigAccounts: [{ currency: 'USD', merchantId: 'NET1' }]
  });
  assert.deepEqual(appDb.getTemplateCurrencyBigAccounts(template.id), []);
});

test('同 key 重新导入模板时清空，删除模板时级联删除', (t) => {
  const appDb = createDatabase(t);
  const template = createTemplate(appDb);
  save(appDb, template.id, CURRENCY_ONLY_MAPPINGS, { currencyBigAccounts: [{ currency: 'USD', merchantId: 'NET1' }] });

  createTemplate(appDb, { templateKey: template.templateKey, headers: ['日期', '币种'] });
  assert.deepEqual(appDb.getTemplateCurrencyBigAccounts(template.id), []);

  save(appDb, template.id, CURRENCY_ONLY_MAPPINGS, { currencyBigAccounts: [{ currency: 'USD', merchantId: 'NET1' }] });
  appDb.deleteTemplate(template.id);
  assert.equal(appDb.db.prepare('SELECT COUNT(1) AS count FROM template_currency_big_accounts').get().count, 0);
});

test('模板包条目带上 币种 → 大账号；其他模式为空数组', (t) => {
  const appDb = createDatabase(t);
  const currencyOnly = createTemplate(appDb);
  const columnMode = createTemplate(appDb, { name: '中国银行-香港', headers: ['账号', '币种'] });
  save(appDb, currencyOnly.id, CURRENCY_ONLY_MAPPINGS, {
    currencyBigAccounts: [{ currency: 'USD', merchantId: 'NET1' }, { currency: 'EUR', merchantId: 'NET2' }]
  });
  save(appDb, columnMode.id, [{ templateField: 'MerchantId', mappedField: '账号', mappedFields: [] }]);

  const entries = appDb.listTemplateBundleEntries();
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  assert.deepEqual(byName.get('招商银行-上海').currencyBigAccounts, [
    { currency: 'USD', merchantId: 'NET1' },
    { currency: 'EUR', merchantId: 'NET2' }
  ]);
  assert.equal(byName.get('招商银行-上海').mappings.find((item) => item.templateField === 'MerchantId').mappedField, MERCHANT_ID_CURRENCY_ONLY_MARKER);
  assert.deepEqual(byName.get('中国银行-香港').currencyBigAccounts, []);
});
