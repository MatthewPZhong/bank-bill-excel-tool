'use strict';

// v3.2.15 网银账单渠道：主/子模板一次性迁移为渠道（spec §4.7，TechDoc §3.2）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');
const { ensureStatementChannelSupport } = require('../../../../src/backend/database/migrations');

let appDb;
let db;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-channel-migration-'));
  appDb = new AppDatabase(path.join(tmpDir, 'tool-data.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_error) { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = '2026-11-01T00:00:00.000Z';

function insertTemplate(name, { isParent = false, parentId = null } = {}) {
  const id = Number(db.prepare(`
    INSERT INTO templates (template_key, name, source_file_name, headers_json, created_at, updated_at)
    VALUES (?, ?, ?, '["H"]', ?, ?)
  `).run(`key-${name}`, name, `${name}.xlsx`, NOW, NOW).lastInsertRowid);
  db.prepare('UPDATE templates SET is_parent = ?, parent_template_id = ? WHERE id = ?').run(isParent ? 1 : 0, parentId, id);
  return id;
}

function insertAccountMapping(templateId, bankAccountId, clearingAccountId, { noCurrency = false, currency = '' } = {}) {
  const rowIndex = db.prepare('SELECT COUNT(1) AS cnt FROM account_mappings WHERE template_id = ?').get(templateId).cnt;
  db.prepare(`
    INSERT INTO account_mappings (template_id, bank_account_id, clearing_account_id, no_currency, currency, row_index, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(templateId, bankAccountId, clearingAccountId, noCurrency ? 1 : 0, currency, rowIndex, NOW, NOW);
}

function templateRows() {
  return db.prepare(`
    SELECT t.id, t.name, t.is_parent AS isParent, t.parent_template_id AS parentTemplateId, c.name AS channelName
    FROM templates t LEFT JOIN statement_channels c ON c.id = t.channel_id ORDER BY t.id
  `).all().map((row) => ({ ...row }));
}

function channelId(name) {
  return db.prepare('SELECT id FROM statement_channels WHERE name = ?').get(name).id;
}

test('主模板与子模板迁移为同名渠道，主模板也成为子模板，旧标记清零', () => {
  const parent = insertTemplate('招商银行-上海', { isParent: true });
  insertTemplate('招商银行-上海-B', { parentId: parent });
  insertTemplate('普通-北京');
  const backups = [];
  const result = ensureStatementChannelSupport(db, (label) => { backups.push(label); return `/tmp/${label}`; });

  assert.equal(result.status, 'migrated');
  assert.equal(result.channelCount, 1);
  assert.equal(result.templateCount, 2);
  assert.deepEqual(backups, ['pre-statement-channels']);
  assert.deepEqual(templateRows().map(({ name, isParent, parentTemplateId, channelName }) => [name, isParent, parentTemplateId, channelName]), [
    ['招商银行-上海', 0, null, '招商银行-上海'],
    ['招商银行-上海-B', 0, null, '招商银行-上海'],
    ['普通-北京', 0, null, null]
  ]);
});

test('被引用但未标主模板的模板也作为渠道来源；多级链取根模板名为渠道名', () => {
  const root = insertTemplate('工行-深圳');
  const middle = insertTemplate('工行-深圳-中', { parentId: root });
  insertTemplate('工行-深圳-末', { parentId: middle });
  const result = ensureStatementChannelSupport(db, () => null);
  assert.equal(result.status, 'migrated');
  assert.deepEqual(templateRows().map((row) => row.channelName), ['工行-深圳', '工行-深圳', '工行-深圳']);
});

test('重复运行为空操作；删除渠道后再次运行不会重建', () => {
  const parent = insertTemplate('中行-北京', { isParent: true });
  insertTemplate('中行-北京-明细', { parentId: parent });
  assert.equal(ensureStatementChannelSupport(db, () => null).status, 'migrated');
  let backupCalls = 0;
  assert.equal(ensureStatementChannelSupport(db, () => { backupCalls += 1; }).status, 'skipped');
  appDb.deleteStatementChannel(channelId('中行-北京'));
  assert.equal(ensureStatementChannelSupport(db, () => { backupCalls += 1; }).status, 'skipped');
  assert.equal(db.prepare('SELECT COUNT(1) AS cnt FROM statement_channels').get().cnt, 0);
  assert.equal(backupCalls, 0);
  assert.deepEqual(templateRows().map((row) => row.channelName), [null, null]);
});

test('没有旧标记时不备份、不建渠道', () => {
  insertTemplate('普通-北京');
  let backupCalls = 0;
  assert.equal(ensureStatementChannelSupport(db, () => { backupCalls += 1; }).status, 'skipped');
  assert.equal(backupCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(1) AS cnt FROM statement_channels').get().cnt, 0);
});

test('账户映射合并：相同去重，清结算账号、无币种标记或兜底币种不同登记为冲突；普通模板映射保留', () => {
  const parent = insertTemplate('招商银行-上海', { isParent: true });
  const childB = insertTemplate('招商银行-上海-B', { parentId: parent });
  const childC = insertTemplate('CMB-SH', { parentId: parent });
  const normal = insertTemplate('普通-北京');
  insertAccountMapping(parent, '111', 'C111');
  insertAccountMapping(childB, '111', 'C111');
  // 不勾无币种时币种栏不参与输出，不算冲突
  insertAccountMapping(childC, '111', 'C111', { currency: 'EUR' });
  insertAccountMapping(childB, '222', 'C222');
  insertAccountMapping(childC, '222', 'C222X');
  insertAccountMapping(parent, '333', 'C333');
  insertAccountMapping(childB, '333', 'C333', { noCurrency: true, currency: 'USD' });
  insertAccountMapping(childB, '444', 'C444', { noCurrency: true, currency: 'usd' });
  insertAccountMapping(childC, '444', 'C444', { noCurrency: true, currency: 'HKD' });
  insertAccountMapping(childC, '555', 'C555', { noCurrency: true, currency: 'usd' });
  insertAccountMapping(childB, '555', 'C555', { noCurrency: true, currency: 'USD' });
  insertAccountMapping(normal, '999', 'C999');

  const result = ensureStatementChannelSupport(db, () => null);
  assert.equal(result.mergedMappingCount, 2);
  assert.equal(result.conflictCount, 3);
  const id = channelId('招商银行-上海');
  assert.deepEqual(appDb.listAccountMappings({ channelId: id }).map((m) => [m.bankAccountId, m.clearingAccountId, m.noCurrency, m.currency]), [
    ['111', 'C111', 0, ''],
    ['555', 'C555', 1, 'USD']
  ]);
  const conflicts = appDb.listStatementChannelAccountMappingConflicts(id)[0].conflicts;
  // 按账户号首次出现的顺序登记
  assert.deepEqual(conflicts.map((conflict) => conflict.bankAccountId), ['333', '222', '444']);
  const byAccount = new Map(conflicts.map((conflict) => [conflict.bankAccountId, conflict.candidates]));
  assert.deepEqual(byAccount.get('222'), [
    { clearingAccountId: 'C222', noCurrency: false, currency: '', sourceTemplateNames: ['招商银行-上海-B'] },
    { clearingAccountId: 'C222X', noCurrency: false, currency: '', sourceTemplateNames: ['CMB-SH'] }
  ]);
  assert.deepEqual(byAccount.get('333').map((candidate) => [candidate.noCurrency, candidate.sourceTemplateNames]), [
    [false, ['招商银行-上海']],
    [true, ['招商银行-上海-B']]
  ]);
  assert.deepEqual(byAccount.get('444').map((candidate) => candidate.currency), ['USD', 'HKD']);
  assert.deepEqual(
    db.prepare('SELECT template_id AS templateId, bank_account_id AS bankAccountId FROM account_mappings').all().map((row) => ({ ...row })),
    [{ templateId: normal, bankAccountId: '999' }]
  );
});

test('列出模板名银行段或所在地段与渠道名不同的模板（种子文件不搬移，D5）', () => {
  const parent = insertTemplate('招商银行-上海', { isParent: true });
  insertTemplate('招商银行-上海-B', { parentId: parent });
  insertTemplate('CMB-SH', { parentId: parent });
  insertTemplate('招商银行-北京', { parentId: parent });
  const result = ensureStatementChannelSupport(db, () => null);
  assert.deepEqual(result.outputChanges.map((change) => [change.templateName, change.fromBankName, change.toBankName, change.fromLocation, change.toLocation]), [
    ['CMB-SH', 'CMB', '招商银行', 'SH', '上海'],
    ['招商银行-北京', '招商银行', '招商银行', '北京', '上海']
  ]);
});

test('事务中途失败整体回滚：旧标记与模板级映射保留，渠道与冲突不残留', () => {
  const parent = insertTemplate('招商银行-上海', { isParent: true });
  const child = insertTemplate('招商银行-上海-B', { parentId: parent });
  insertAccountMapping(child, '111', 'C111');
  db.exec(`
    CREATE TRIGGER statement_channel_migration_fail BEFORE UPDATE OF channel_id ON templates
    WHEN NEW.channel_id IS NOT NULL AND NEW.name = '招商银行-上海-B'
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
  `);
  const result = ensureStatementChannelSupport(db, () => null);
  assert.equal(result.status, 'migration-failed');
  assert.match(String(result.error && result.error.message), /injected failure/);
  assert.equal(db.prepare('SELECT COUNT(1) AS cnt FROM statement_channels').get().cnt, 0);
  assert.deepEqual(templateRows().map((row) => [row.isParent, row.parentTemplateId, row.channelName]), [[1, null, null], [0, parent, null]]);
  assert.equal(db.prepare('SELECT COUNT(1) AS cnt FROM account_mappings').get().cnt, 1);
});

test('备份失败时不改动数据，返回 backup-failed', () => {
  const parent = insertTemplate('招商银行-上海', { isParent: true });
  insertTemplate('招商银行-上海-B', { parentId: parent });
  const result = ensureStatementChannelSupport(db, () => { throw new Error('disk full'); });
  assert.equal(result.status, 'backup-failed');
  assert.equal(db.prepare('SELECT COUNT(1) AS cnt FROM statement_channels').get().cnt, 0);
  assert.equal(db.prepare('SELECT COUNT(1) AS cnt FROM templates WHERE is_parent = 1').get().cnt, 1);
});

test('启动迁移入口记录结果，迁移渠道的导入子模板编号从 1 开始', () => {
  const parent = insertTemplate('招商银行-上海', { isParent: true });
  insertTemplate('招商银行-上海-B', { parentId: parent });
  const result = appDb.runStatementChannelMigration();
  assert.equal(result.status, 'migrated');
  const channel = appDb.getStatementChannelByName('招商银行-上海');
  assert.equal(channel.nextChildNo, 1);
  assert.equal(channel.templateCount, 2);
});

// PR #246 审查：v1.5.1 旧账户映射迁移尚未分配（标记为 true）时，全部模板都属于主/子模板组——迁移把模板级映射搬到渠道后，
//   分配弹窗既无数据也无目标，两个导入入口被永久阻断。启动核对时清除标记；仍有普通模板持有映射时保留，由用户分配。
test('旧账户映射迁移标记：模板全部归入渠道后启动即清除；仍有普通模板持有映射时保留', () => {
  const parent = insertTemplate('招商银行-上海', { isParent: true });
  const child = insertTemplate('招商银行-上海-B', { parentId: parent });
  insertAccountMapping(parent, '111', 'C1');
  insertAccountMapping(child, '111', 'C1');
  appDb.setSetting('account_mapping_migration_pending', 'true');
  appDb.runStatementChannelMigration();
  assert.equal(appDb.getSetting('account_mapping_migration_pending'), 'false');
  assert.deepEqual(appDb.listAccountMappings({ channelId: channelId('招商银行-上海') }).map((m) => m.bankAccountId), ['111'],
    '映射已在渠道层');

  const ordinary = insertTemplate('工行-深圳');
  insertAccountMapping(ordinary, '222', 'C2');
  appDb.setSetting('account_mapping_migration_pending', 'true');
  appDb.runStatementChannelMigration();
  assert.equal(appDb.getSetting('account_mapping_migration_pending'), 'true', '工行-深圳 仍有待分配的映射');
});
