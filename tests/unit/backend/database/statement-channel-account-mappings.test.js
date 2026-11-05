'use strict';

// v3.2.15 网银账单渠道：账户映射的渠道层、生效映射、冲突处理与模板包还原（D7、D8，TechDoc §3.4、§5.3）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');

let appDb;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-channel-mapping-'));
  appDb = new AppDatabase(path.join(tmpDir, 'tool-data.sqlite'));
  appDb.init();
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_error) { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function template(name) {
  return appDb.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers: [name] });
}

function createChannelFrom(templateId) {
  return appDb.saveMappings(templateId, [], [], [], undefined, null, { channelAssignment: { mode: 'create' } })
    .channelAssignment.channelId;
}

function seedConflict(channelId) {
  appDb.restoreTemplateBundleStatementChannels({
    channels: [],
    legacyChannelSources: [{
      name: appDb.getStatementChannel(channelId).name,
      sources: [
        { sourceName: '子模板一', mappings: [{ bankAccountId: '111', clearingAccountId: 'C1' }, { bankAccountId: '333', clearingAccountId: 'C3' }] },
        { sourceName: '子模板二', mappings: [{ bankAccountId: '111', clearingAccountId: 'C1X', noCurrency: true, currency: 'USD' }] }
      ]
    }],
    assignments: []
  });
}

test('账户映射按 scope 读写；数字与 { templateId } 等价；生效映射按渠道或模板取', () => {
  const normal = template('普通-北京');
  const child = template('招商银行-上海');
  const channelId = createChannelFrom(child.id);
  appDb.saveAccountMappings(normal.id, [{ bankAccountId: 'N1', clearingAccountId: 'CN1' }]);
  appDb.saveAccountMappings({ channelId }, [{ bankAccountId: 'K1', clearingAccountId: 'CK1', noCurrency: true, currency: 'HKD' }]);
  assert.deepEqual(appDb.listAccountMappings({ templateId: normal.id }).map((m) => m.bankAccountId), ['N1']);
  assert.deepEqual(appDb.listAccountMappings(normal.id).map((m) => m.bankAccountId), ['N1']);
  assert.deepEqual(appDb.listEffectiveAccountMappings(appDb.getTemplate(child.id)).map((m) => [m.bankAccountId, m.currency]), [['K1', 'HKD']]);
  assert.deepEqual(appDb.listEffectiveAccountMappings(appDb.getTemplate(normal.id)).map((m) => m.bankAccountId), ['N1']);
  assert.equal(appDb.countAllAccountMappings(), 2);
  assert.throws(() => appDb.saveAccountMappings({ channelId: 999 }, []), { code: 'CHANNEL_NOT_FOUND' });
});

test('迁移冲突：只接受登记中的账户号与候选下标，选定后追加到渠道映射并删除冲突', () => {
  const t = template('招商银行-上海');
  const channelId = createChannelFrom(t.id);
  seedConflict(channelId);
  assert.equal(appDb.countStatementChannelAccountMappingConflicts(channelId), 1);
  assert.deepEqual(appDb.listAccountMappings({ channelId }).map((m) => m.bankAccountId), ['333']);
  const [group] = appDb.listStatementChannelAccountMappingConflicts();
  assert.equal(group.channelName, '招商银行-上海');
  assert.deepEqual(group.conflicts[0].candidates.map((c) => [c.clearingAccountId, c.noCurrency, c.currency, c.sourceTemplateNames]), [
    ['C1', false, '', ['子模板一']],
    ['C1X', true, 'USD', ['子模板二']]
  ]);

  assert.throws(() => appDb.resolveStatementChannelAccountMappingConflicts(channelId, [{ bankAccountId: '111', candidateIndex: 2 }]),
    { code: 'CHANNEL_ACCOUNT_MAPPING_CONFLICT_STALE' });
  assert.throws(() => appDb.resolveStatementChannelAccountMappingConflicts(channelId, [{ bankAccountId: '999', candidateIndex: 0 }]),
    { code: 'CHANNEL_ACCOUNT_MAPPING_CONFLICT_STALE' });
  assert.throws(() => appDb.resolveStatementChannelAccountMappingConflicts(channelId, []),
    { code: 'CHANNEL_ACCOUNT_MAPPING_CONFLICT_STALE' });
  assert.equal(appDb.countStatementChannelAccountMappingConflicts(channelId), 1);

  const result = appDb.resolveStatementChannelAccountMappingConflicts(channelId, [{ bankAccountId: '111', candidateIndex: 1 }]);
  assert.equal(result.remaining, 0);
  assert.deepEqual(appDb.listAccountMappings({ channelId }).map((m) => [m.bankAccountId, m.clearingAccountId, Boolean(m.noCurrency), m.currency]), [
    ['333', 'C3', false, ''],
    ['111', 'C1X', true, 'USD']
  ]);
  assert.deepEqual(appDb.listStatementChannelAccountMappingConflicts(), []);
});

test('删除渠道时冲突随渠道清除，返回清除数量', () => {
  const t = template('招商银行-上海');
  const channelId = createChannelFrom(t.id);
  seedConflict(channelId);
  const deleted = appDb.deleteStatementChannel(channelId);
  assert.equal(deleted.conflictCount, 1);
  assert.equal(appDb.db.prepare('SELECT COUNT(1) AS cnt FROM statement_channel_account_mapping_conflicts').get().cnt, 0);
  assert.deepEqual(appDb.listAccountMappings({ templateId: t.id }).map((m) => m.bankAccountId), ['333']);
});

test('模板包 v5 还原：渠道映射与冲突整体替换，模板按 channelName 归属并去掉模板级映射', () => {
  const a = template('A-1');
  const b = template('B-1');
  appDb.saveAccountMappings({ templateId: a.id }, [{ bankAccountId: 'X', clearingAccountId: 'CX' }]);
  const result = appDb.restoreTemplateBundleStatementChannels({
    channels: [
      {
        name: '渠道-甲',
        accountMappings: [{ bankAccountId: '111', clearingAccountId: 'C111' }],
        accountMappingConflicts: [{ bankAccountId: '222', candidates: [
          { clearingAccountId: 'C2', noCurrency: false, currency: '', sourceTemplateNames: ['A-1'] },
          { clearingAccountId: 'C2X', noCurrency: false, currency: '', sourceTemplateNames: ['B-1'] }
        ] }]
      },
      { name: '空渠道', accountMappings: [], accountMappingConflicts: [] }
    ],
    legacyChannelSources: [],
    assignments: [{ templateId: a.id, channelName: '渠道-甲' }, { templateId: b.id, channelName: null }]
  });
  assert.equal(result.channelCount, 2);
  assert.equal(result.conflictCount, 1);
  const channel = appDb.getStatementChannelByName('渠道-甲');
  assert.equal(appDb.getTemplate(a.id).channelId, channel.id);
  assert.equal(appDb.getTemplate(b.id).channelId, null);
  assert.deepEqual(appDb.listAccountMappings({ templateId: a.id }), []);
  assert.deepEqual(appDb.listAccountMappings({ channelId: channel.id }).map((m) => m.bankAccountId), ['111']);
  assert.equal(appDb.countStatementChannelAccountMappingConflicts(channel.id), 1);
  assert.equal(appDb.getStatementChannelByName('空渠道').templateCount, 0);
});

test('渠道有待处理冲突时，子模板不能移出或转入其他渠道（避免带走缺冲突账户号的映射副本）', () => {
  const t = template('招商银行-上海');
  const channelId = createChannelFrom(t.id);
  seedConflict(channelId);
  const other = template('工行-深圳');
  const otherChannel = createChannelFrom(other.id);
  for (const assignment of [{ mode: 'none' }, { mode: 'create' }, { mode: 'join', channelId: otherChannel }]) {
    assert.throws(
      () => appDb.saveMappings(t.id, [], [], [], undefined, null, { channelAssignment: assignment }),
      (error) => error.code === 'CHANNEL_ACCOUNT_MAPPING_CONFLICT_PENDING' && /招商银行-上海/.test(error.message),
      assignment.mode
    );
  }
  assert.equal(appDb.getTemplate(t.id).channelId, channelId);
  assert.equal(appDb.saveMappings(t.id, [], [], [], undefined, null, { channelAssignment: { mode: 'keep' } }).channelAssignment.changed, false);
  appDb.resolveStatementChannelAccountMappingConflicts(channelId, [{ bankAccountId: '111', candidateIndex: 0 }]);
  appDb.saveMappings(t.id, [], [], [], undefined, null, { channelAssignment: { mode: 'none' } });
  assert.deepEqual(appDb.listAccountMappings({ templateId: t.id }).map((m) => [m.bankAccountId, m.clearingAccountId]), [['333', 'C3'], ['111', 'C1']]);
});

test('在渠道层显式设置冲突账户号的映射即视为已处理该冲突；其他冲突保留', () => {
  const t = template('招商银行-上海');
  const channelId = createChannelFrom(t.id);
  appDb.restoreTemplateBundleStatementChannels({
    channels: [],
    legacyChannelSources: [{
      name: '招商银行-上海',
      sources: [
        { sourceName: '子模板一', mappings: [{ bankAccountId: '111', clearingAccountId: 'C1' }, { bankAccountId: '222', clearingAccountId: 'C2' }] },
        { sourceName: '子模板二', mappings: [{ bankAccountId: '111', clearingAccountId: 'C1X' }, { bankAccountId: '222', clearingAccountId: 'C2X' }] }
      ]
    }],
    assignments: []
  });
  assert.equal(appDb.countStatementChannelAccountMappingConflicts(channelId), 2);
  const result = appDb.saveAccountMappings({ channelId }, [{ bankAccountId: '111', clearingAccountId: 'C1-MANUAL' }]);
  assert.deepEqual(result.resolvedConflictBankAccountIds, ['111']);
  assert.deepEqual(appDb.listStatementChannelAccountMappingConflicts(channelId)[0].conflicts.map((c) => c.bankAccountId), ['222']);
  assert.deepEqual(appDb.listAccountMappings({ channelId }).map((m) => [m.bankAccountId, m.clearingAccountId]), [['111', 'C1-MANUAL']]);
});
