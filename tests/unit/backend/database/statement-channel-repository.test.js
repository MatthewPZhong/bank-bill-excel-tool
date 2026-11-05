'use strict';

// v3.2.15 网银账单渠道：渠道仓储、映射保存时的归属指令与【导入子模板】编号（spec §4.2–§4.6、§4.9，TechDoc §3.3）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');

let appDb;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-channel-repo-'));
  appDb = new AppDatabase(path.join(tmpDir, 'tool-data.sqlite'));
  appDb.init();
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_error) { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const MAPPINGS = [{ templateField: 'BillDate', mappedField: 'H', mappedFields: [] }];

function template(name, headers = [name]) {
  return appDb.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers });
}

function assign(templateId, channelAssignment, mappings = MAPPINGS) {
  return appDb.saveMappings(templateId, mappings, [], [], undefined, null, { channelAssignment }).channelAssignment;
}

function mappingRows(scope) {
  return appDb.listAccountMappings(scope).map((m) => [m.bankAccountId, m.clearingAccountId, Boolean(m.noCurrency), m.currency]);
}

test('勾选【渠道存在多个子模板】：新建同名渠道，模板成为第一个子模板，模板映射转为渠道映射', () => {
  const t = template('招商银行-上海');
  appDb.saveAccountMappings({ templateId: t.id }, [{ bankAccountId: '111', clearingAccountId: 'C111' }]);
  const result = assign(t.id, { mode: 'create' });
  assert.equal(result.changed, true);
  assert.deepEqual(result.createdChannel, { id: result.channelId, name: '招商银行-上海' });
  const summary = appDb.getTemplate(t.id);
  assert.equal(summary.channelId, result.channelId);
  assert.equal(summary.channelName, '招商银行-上海');
  assert.equal('isParent' in summary, false);
  assert.deepEqual(mappingRows({ channelId: result.channelId }), [['111', 'C111', false, '']]);
  assert.deepEqual(mappingRows({ templateId: t.id }), []);
  assert.deepEqual(appDb.getTemplateMappings(t.id).mappings.map((m) => m.mappedField), ['H']);
});

test('同名渠道已存在时不新建（D6），映射保存整体回滚', () => {
  const first = template('招商银行-上海');
  const channelId = assign(first.id, { mode: 'create' }).channelId;
  appDb.renameTemplate(first.id, '招商银行-上海-原');
  const second = template('招商银行-上海', ['另一个表头']);
  assert.throws(
    () => assign(second.id, { mode: 'create' }, [{ templateField: 'BillDate', mappedField: '另一个表头', mappedFields: [] }]),
    (error) => error.code === 'CHANNEL_NAME_DUPLICATED' && /设为子模板/.test(error.message)
  );
  assert.equal(appDb.getTemplate(second.id).channelId, null);
  assert.deepEqual(appDb.getTemplateMappings(second.id).mappings, []);
  assert.equal(appDb.listStatementChannels().length, 1);
  assert.equal(appDb.getStatementChannel(channelId).templateCount, 1);
});

test('加入已有渠道：无冲突的账户映射并入、相同去重；同一账户号设置不同则阻断并回滚（A9）', () => {
  const owner = template('招商银行-上海');
  const channelId = assign(owner.id, { mode: 'create' }).channelId;
  appDb.saveAccountMappings({ channelId }, [{ bankAccountId: '111', clearingAccountId: 'C111' }]);
  const joiner = template('CMB-SH');
  appDb.saveAccountMappings({ templateId: joiner.id }, [
    { bankAccountId: '111', clearingAccountId: 'C111' },
    { bankAccountId: '222', clearingAccountId: 'C222', noCurrency: true, currency: 'USD' }
  ]);
  assign(joiner.id, { mode: 'join', channelId });
  assert.deepEqual(mappingRows({ channelId }), [['111', 'C111', false, ''], ['222', 'C222', true, 'USD']]);
  assert.deepEqual(mappingRows({ templateId: joiner.id }), []);

  const conflicting = template('招行-浦东');
  appDb.saveAccountMappings({ templateId: conflicting.id }, [{ bankAccountId: '222', clearingAccountId: 'C222-OTHER' }]);
  assert.throws(() => assign(conflicting.id, { mode: 'join', channelId }), (error) => (
    error.code === 'CHANNEL_ACCOUNT_MAPPING_CONFLICT'
      && error.detailLines.length === 1
      && /222/.test(error.detailLines[0])
      && /C222-OTHER/.test(error.detailLines[0])
  ));
  assert.equal(appDb.getTemplate(conflicting.id).channelId, null);
  assert.deepEqual(appDb.getTemplateMappings(conflicting.id).mappings, []);
  assert.deepEqual(mappingRows({ templateId: conflicting.id }), [['222', 'C222-OTHER', false, '']]);
});

test('任意名称的模板都能加入渠道（取消名称包含校验，D3）；移出渠道时复制渠道映射（A10）', () => {
  const owner = template('招商银行-上海');
  const channelId = assign(owner.id, { mode: 'create' }).channelId;
  appDb.saveAccountMappings({ channelId }, [{ bankAccountId: '111', clearingAccountId: 'C111' }]);
  const other = template('完全不同的名字');
  assign(other.id, { mode: 'join', channelId });
  assert.equal(appDb.getTemplate(other.id).channelName, '招商银行-上海');
  const left = assign(other.id, { mode: 'none' });
  assert.equal(left.previousChannelId, channelId);
  assert.equal(appDb.getTemplate(other.id).channelId, null);
  assert.deepEqual(mappingRows({ templateId: other.id }), [['111', 'C111', false, '']]);
  assert.deepEqual(mappingRows({ channelId }), [['111', 'C111', false, '']]);
  assert.equal(assign(owner.id, { mode: 'keep' }).changed, false);
});

test('渠道重命名：去空白、非空、不重复；删除渠道后子模板恢复为普通模板并获得映射副本', () => {
  const a = template('招商银行-上海');
  const channelId = assign(a.id, { mode: 'create' }).channelId;
  const b = template('招商银行-上海-B');
  assign(b.id, { mode: 'join', channelId });
  const other = template('工行-深圳');
  const otherChannel = assign(other.id, { mode: 'create' }).channelId;
  assert.throws(() => appDb.renameStatementChannel(channelId, '  '), { code: 'CHANNEL_NAME_REQUIRED' });
  assert.throws(() => appDb.renameStatementChannel(channelId, ' 工行-深圳 '), { code: 'CHANNEL_NAME_DUPLICATED' });
  assert.throws(() => appDb.renameStatementChannel(999, '新名'), { code: 'CHANNEL_NOT_FOUND' });
  const renamed = appDb.renameStatementChannel(channelId, ' 招商银行-浦东 ');
  assert.equal(renamed.previous.name, '招商银行-上海');
  assert.equal(renamed.channel.name, '招商银行-浦东');
  assert.equal(appDb.getTemplate(b.id).channelName, '招商银行-浦东');

  appDb.saveAccountMappings({ channelId }, [{ bankAccountId: '111', clearingAccountId: 'C111' }]);
  const deleted = appDb.deleteStatementChannel(channelId);
  assert.deepEqual(deleted.releasedTemplates.map((item) => item.name), ['招商银行-上海', '招商银行-上海-B']);
  assert.equal(appDb.getStatementChannel(channelId), null);
  assert.equal(appDb.getTemplate(a.id).channelId, null);
  assert.equal(appDb.getTemplate(b.id).channelId, null);
  assert.deepEqual(mappingRows({ templateId: b.id }), [['111', 'C111', false, '']]);
  assert.equal(appDb.db.prepare('SELECT COUNT(1) AS cnt FROM statement_channel_account_mappings WHERE channel_id = ?').get(channelId).cnt, 0);
  assert.equal(appDb.getStatementChannel(otherChannel).templateCount, 1);
  assert.equal(appDb.listTemplates().length, 3);
});

test('删除子模板不删除渠道；渠道列表按名称排序并带子模板数', () => {
  const a = template('乙-渠道');
  const channelA = assign(a.id, { mode: 'create' }).channelId;
  const b = template('甲-渠道');
  assign(b.id, { mode: 'create' });
  appDb.deleteTemplate(a.id);
  const channels = appDb.listStatementChannels();
  // 按名称的 SQLite 默认（二进制）排序：乙 U+4E59 在 甲 U+7532 之前
  assert.deepEqual(channels.map((channel) => [channel.name, channel.templateCount]), [['乙-渠道', 0], ['甲-渠道', 1]]);
  assert.equal(appDb.getStatementChannel(channelA).templateCount, 0);
});

test('【导入子模板】编号：从 1 连续递增，删除不回收，名称被占用时顺延，渠道改名后用新名', () => {
  const owner = template('招商银行-上海');
  const channelId = assign(owner.id, { mode: 'create' }).channelId;
  const first = appDb.createChildTemplate(channelId, { sourceFileName: 'a.xlsx', headers: ['A'] });
  const second = appDb.createChildTemplate(channelId, { sourceFileName: 'b.xlsx', headers: ['B'] });
  assert.deepEqual([first.name, second.name], ['招商银行-上海-子模板-1', '招商银行-上海-子模板-2']);
  assert.equal(first.template.channelId, channelId);
  assert.equal(first.template.sourceFileName, 'a.xlsx');
  assert.deepEqual(second.template.headers, ['B']);
  appDb.deleteTemplate(second.templateId);
  template('招商银行-上海-子模板-3', ['占位']);
  const third = appDb.createChildTemplate(channelId, { sourceFileName: 'c.xlsx', headers: ['C'] });
  assert.equal(third.name, '招商银行-上海-子模板-4');
  appDb.renameStatementChannel(channelId, '招商银行-浦东');
  const fourth = appDb.createChildTemplate(channelId, { sourceFileName: 'd.xlsx', headers: ['D'] });
  assert.equal(fourth.name, '招商银行-浦东-子模板-5');
  assert.equal(appDb.getTemplate(first.templateId).name, '招商银行-上海-子模板-1');
});

test('【导入子模板】失败回滚不占用编号；渠道不存在报 CHANNEL_NOT_FOUND', () => {
  const owner = template('招商银行-上海');
  const channelId = assign(owner.id, { mode: 'create' }).channelId;
  appDb.db.exec(`
    CREATE TRIGGER child_template_fail BEFORE INSERT ON templates WHEN NEW.source_file_name = 'bad.xlsx'
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
  `);
  assert.throws(() => appDb.createChildTemplate(channelId, { sourceFileName: 'bad.xlsx', headers: ['X'] }), /injected failure/);
  assert.equal(appDb.getStatementChannel(channelId).nextChildNo, 1);
  assert.equal(appDb.createChildTemplate(channelId, { sourceFileName: 'ok.xlsx', headers: ['Y'] }).name, '招商银行-上海-子模板-1');
  assert.throws(() => appDb.createChildTemplate(999, { sourceFileName: 'x.xlsx', headers: ['Z'] }), { code: 'CHANNEL_NOT_FOUND' });
});

test('模板包条目输出渠道名而非主/子字段', () => {
  const owner = template('招商银行-上海');
  assign(owner.id, { mode: 'create' });
  template('普通-北京');
  const entries = appDb.listTemplateBundleEntries();
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get('招商银行-上海').channelName, '招商银行-上海');
  assert.equal(byName.get('普通-北京').channelName, null);
  assert.equal('isParent' in byName.get('普通-北京'), false);
  assert.equal('parentTemplateKey' in byName.get('普通-北京'), false);
});

test('子模板改为新建渠道：先移出原渠道，新渠道取原渠道映射副本，原渠道不变', () => {
  const owner = template('招商银行-上海');
  const channelId = assign(owner.id, { mode: 'create' }).channelId;
  appDb.saveAccountMappings({ channelId }, [{ bankAccountId: '111', clearingAccountId: 'C111' }]);
  const child = template('CMB-SH');
  assign(child.id, { mode: 'join', channelId });
  const result = assign(child.id, { mode: 'create' });
  assert.equal(result.previousChannelId, channelId);
  assert.notEqual(result.channelId, channelId);
  assert.equal(appDb.getTemplate(child.id).channelName, 'CMB-SH');
  assert.deepEqual(mappingRows({ channelId: result.channelId }), [['111', 'C111', false, '']]);
  assert.deepEqual(mappingRows({ channelId }), [['111', 'C111', false, '']]);
  assert.equal(appDb.getStatementChannel(channelId).templateCount, 1);
});
