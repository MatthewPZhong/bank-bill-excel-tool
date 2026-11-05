'use strict';

// v3.2.14 升级后首次启动的「更新说明」：随包数据门禁、启动判定与确认语义；
//   v3.2.15 老用户区间从 3.2.13（含）起、升级记录与设置入口区间（changes/v3.2.15/feat/release-notes-range/spec.md）。
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  LEGACY_FIRST_VERSION,
  createReleaseNotesState,
  normalizeLastUpgrade,
  normalizeReleaseNotes,
  resolveReleaseNotesHistory,
  resolveStartupReleaseNotes,
  selectReleaseNotes,
  selectUpgradeReleaseNotes
} = require('../../../src/main-process/release-notes/service');
const bundledNotes = require('../../../src/main-process/release-notes/release-notes.json');

const ROOT = path.join(__dirname, '..', '..', '..');

const NOTES = [
  { version: '3.2.16', date: '2026-11-11', highlights: ['十六'] },
  { version: '3.2.15', date: '2026-11-04', highlights: ['十五'] },
  { version: '3.2.14', date: '2026-10-30', highlights: ['十四'] },
  { version: '3.2.13', date: '2026-10-21', highlights: ['十三'] }
];

const versionsOf = (entries) => entries.map((entry) => entry.version);

function resolve(overrides) {
  return resolveStartupReleaseNotes({
    currentVersion: '3.2.16',
    acknowledgedVersion: null,
    databaseExisted: true,
    entries: NOTES,
    ...overrides
  });
}

// writes：只写确认版本时记版本字符串；确认版本与升级记录同一事务写入时记 { fromVersion, toVersion }。
function createStore(initial = null, lastUpgrade = null) {
  const writes = [];
  return {
    writes,
    value: initial,
    lastUpgrade,
    failWrites: false,
    getReleaseNotesAcknowledgedVersion() { return this.value; },
    getReleaseNotesLastUpgrade() { return this.lastUpgrade; },
    setReleaseNotesAcknowledgedVersion(version) {
      if (this.failWrites) throw new Error('磁盘只读');
      writes.push(version);
      this.value = version;
    },
    recordReleaseNotesUpgrade(upgrade) {
      if (this.failWrites) throw new Error('磁盘只读');
      writes.push({ ...upgrade });
      this.value = upgrade.toVersion;
      this.lastUpgrade = { ...upgrade };
    }
  };
}

const NONE = { pending: null, writeAcknowledged: null, writeUpgrade: null };

test.describe('随包更新说明数据（发版门禁）', () => {
  test('全部条目合格且按版本从新到旧排列', () => {
    const { entries, issues } = normalizeReleaseNotes(bundledNotes);
    assert.deepEqual(issues, []);
    assert.equal(entries.length, bundledNotes.length);
  });

  test('package.json 当前版本必须有更新说明条目', () => {
    const { version } = require(path.join(ROOT, 'package.json'));
    assert.ok(
      bundledNotes.some((entry) => entry.version === version),
      `release-notes.json 缺少 ${version} 的条目：发版时须在 C2 步骤编写本版 1–5 条要点`
    );
  });
});

test.describe('normalizeReleaseNotes', () => {
  test('不合格条目跳过并逐项说明原因', () => {
    const { entries, issues } = normalizeReleaseNotes([
      { version: '3.2.15', date: '2026-11-04', highlights: ['正常'] },
      { version: 'v3.2.14', date: '2026-10-30', highlights: ['带前缀'] },
      { version: '3.2.13', date: '2026-02-30', highlights: ['日期不存在'] },
      { version: '3.2.12', date: '2026-10-13', highlights: [] },
      { version: '3.2.11', date: '2026-10-04', highlights: ['多行\n文本'] },
      { version: '3.2.10', date: '2026-09-28', highlights: ['长'.repeat(121)] },
      { version: '3.2.9', date: '2026-09-19', highlights: ['1', '2', '3', '4', '5', '6'] },
      'not-an-object'
    ]);
    assert.deepEqual(versionsOf(entries), ['3.2.15']);
    assert.equal(issues.length, 7);
    assert.match(issues.join('\n'), /版本号无效/);
    assert.match(issues.join('\n'), /日期无效/);
    assert.match(issues.join('\n'), /单行非空/);
    assert.match(issues.join('\n'), /超过 120 字/);
    assert.match(issues.join('\n'), /1–5 条/);
  });

  test('重复版本只保留第一项，乱序记为问题但结果仍按新到旧', () => {
    const { entries, issues } = normalizeReleaseNotes([
      { version: '3.2.13', date: '2026-10-21', highlights: ['旧'] },
      { version: '3.2.14', date: '2026-10-30', highlights: ['新'] },
      { version: '3.2.14', date: '2026-10-31', highlights: ['重复'] }
    ]);
    assert.deepEqual(versionsOf(entries), ['3.2.14', '3.2.13']);
    assert.equal(entries[0].highlights[0], '新');
    assert.equal(issues.length, 2);
    assert.match(issues[0], /未按从新到旧排列/);
    assert.match(issues[1], /重复/);
  });

  test('非数组 → 无条目', () => {
    assert.deepEqual(normalizeReleaseNotes(null), { entries: [], issues: ['更新说明数据必须是数组'] });
  });
});

test('selectReleaseNotes 取 (from, to] 并保持新到旧', () => {
  assert.deepEqual(versionsOf(selectReleaseNotes({ entries: NOTES, fromVersion: '3.2.13', toVersion: '3.2.15' })), ['3.2.15', '3.2.14']);
  assert.deepEqual(selectReleaseNotes({ entries: NOTES, fromVersion: '3.2.16', toVersion: '3.2.16' }), []);
});

test.describe('resolveStartupReleaseNotes', () => {
  test('全新安装：记录当前版本，不弹', () => {
    assert.deepEqual(resolve({ databaseExisted: false }), { ...NONE, writeAcknowledged: '3.2.16' });
  });

  test('已有数据且无记录（v3.2.14 之前的版本）：从 v3.2.13（含）起算，来源版本未知', () => {
    assert.equal(LEGACY_FIRST_VERSION, '3.2.13');
    const { pending, writeAcknowledged, writeUpgrade } = resolve({ currentVersion: '3.2.14' });
    assert.equal(writeAcknowledged, null);
    assert.equal(writeUpgrade, null);
    assert.equal(pending.fromVersion, null);
    assert.equal(pending.toVersion, '3.2.14');
    assert.deepEqual(versionsOf(pending.entries), ['3.2.14', '3.2.13']);
  });

  test('用户反馈场景：3.2.12 升到 3.2.15 显示 3.2.15、3.2.14、3.2.13', () => {
    const { pending } = resolve({ currentVersion: '3.2.15' });
    assert.deepEqual(versionsOf(pending.entries), ['3.2.15', '3.2.14', '3.2.13']);
  });

  test('记录为旧版本：列出跨过的全部版本，按新到旧', () => {
    const { pending } = resolve({ acknowledgedVersion: '3.2.13' });
    assert.equal(pending.fromVersion, '3.2.13');
    assert.deepEqual(versionsOf(pending.entries), ['3.2.16', '3.2.15', '3.2.14']);
  });

  test('同版本重启：不弹，不重复写', () => {
    assert.deepEqual(resolve({ acknowledgedVersion: '3.2.16' }), NONE);
  });

  test('降级：不弹，保留更高的已确认版本', () => {
    assert.deepEqual(resolve({ currentVersion: '3.2.15', acknowledgedVersion: '3.2.16' }), NONE);
  });

  test('已有数据、无记录：当前就是 3.2.13 时只显示 3.2.13；早于 3.2.13 时不弹并补写记录', () => {
    assert.deepEqual(versionsOf(resolve({ currentVersion: '3.2.13' }).pending.entries), ['3.2.13']);
    assert.deepEqual(resolve({ currentVersion: '3.2.12' }), { ...NONE, writeAcknowledged: '3.2.12' });
  });

  test('记录非法时按无记录处理', () => {
    const { pending } = resolve({ currentVersion: '3.2.14', acknowledgedVersion: 'garbage' });
    assert.equal(pending.fromVersion, null);
    assert.deepEqual(versionsOf(pending.entries), ['3.2.14', '3.2.13']);
  });

  test('升级但范围内没有说明条目：直接确认并记录本次升级，不弹空窗', () => {
    assert.deepEqual(resolve({ currentVersion: '3.2.17', acknowledgedVersion: '3.2.16' }), {
      ...NONE, writeAcknowledged: '3.2.17', writeUpgrade: { fromVersion: '3.2.16', toVersion: '3.2.17' }
    });
  });

  test('带构建元数据的正式版：按对应正式版判定，记录写入不带元数据的版本', () => {
    const { pending } = resolve({ currentVersion: '3.2.14+build.7' });
    assert.equal(pending.toVersion, '3.2.14');
    assert.deepEqual(versionsOf(pending.entries), ['3.2.14', '3.2.13']);
    assert.deepEqual(resolve({ currentVersion: '3.2.16+build.7', databaseExisted: false }), { ...NONE, writeAcknowledged: '3.2.16' });
  });

  test('开发版或预发布号：不弹，也不写记录', () => {
    for (const currentVersion of ['3.2.17-beta.1', '3.2.17-beta.1+build.3', '', null]) {
      assert.deepEqual(resolve({ currentVersion, databaseExisted: false }), NONE);
    }
  });
});

test.describe('createReleaseNotesState', () => {
  test('有待显示内容：快照含本版与待显示条目，确认后写入并清空', () => {
    const store = createStore('3.2.14');
    const state = createReleaseNotesState({ store, currentVersion: '3.2.16', databaseExisted: true, rawNotes: NOTES });
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.current.version, '3.2.16');
    assert.deepEqual(versionsOf(snapshot.pending.entries), ['3.2.16', '3.2.15']);
    snapshot.pending.entries[0].highlights.push('被调用方改写');
    assert.deepEqual(state.getSnapshot().pending.entries[0].highlights, ['十六'], '快照须为副本');
    assert.deepEqual(store.writes, []);

    assert.deepEqual(state.acknowledge('3.2.15'), { status: 'ignored' });
    assert.deepEqual(store.writes, []);
    assert.deepEqual(state.acknowledge('3.2.16'), { status: 'ok', acknowledgedVersion: '3.2.16' });
    assert.deepEqual(store.writes, [{ fromVersion: '3.2.14', toVersion: '3.2.16' }], '确认版本与本次升级区间一起写入');
    assert.equal(state.getSnapshot().pending, null);
    assert.equal(state.getSnapshot().current.version, '3.2.16', '确认后设置入口仍可查看本版');
    assert.deepEqual(state.acknowledge('3.2.16'), { status: 'ignored' }, '重复确认不再写');
  });

  test('全新安装：启动即写入当前版本，没有待显示内容', () => {
    const store = createStore(null);
    const state = createReleaseNotesState({ store, currentVersion: '3.2.16', databaseExisted: false, rawNotes: NOTES });
    assert.deepEqual(store.writes, ['3.2.16']);
    assert.equal(state.getSnapshot().pending, null);
    assert.deepEqual(state.acknowledge('3.2.16'), { status: 'ignored' });
  });

  test('确认写入失败：返回 failed，保留待显示内容并记录日志', () => {
    const logs = [];
    const store = createStore('3.2.15');
    const state = createReleaseNotesState({ store, currentVersion: '3.2.16', databaseExisted: true, rawNotes: NOTES, log: (entry) => logs.push(entry) });
    store.failWrites = true;
    assert.deepEqual(state.acknowledge('3.2.16'), { status: 'failed', message: '磁盘只读' });
    assert.notEqual(state.getSnapshot().pending, null);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].message, '确认更新说明失败');
  });

  test('启动写入失败不抛出，只记录日志', () => {
    const logs = [];
    const store = createStore(null);
    store.failWrites = true;
    const state = createReleaseNotesState({ store, currentVersion: '3.2.16', databaseExisted: false, rawNotes: NOTES, log: (entry) => logs.push(entry) });
    assert.equal(state.getSnapshot().pending, null);
    assert.deepEqual(logs.map((entry) => entry.message), ['记录更新说明版本失败']);
  });

  test('数据有不合格条目：跳过并记录一次警告，合格条目照常使用', () => {
    const logs = [];
    const state = createReleaseNotesState({
      store: createStore('3.2.15'),
      currentVersion: '3.2.16',
      databaseExisted: true,
      rawNotes: [...NOTES, { version: 'bad', date: '', highlights: [] }],
      log: (entry) => logs.push(entry)
    });
    assert.deepEqual(versionsOf(state.getSnapshot().pending.entries), ['3.2.16']);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'warning');
  });

  test('带构建元数据的正式版：设置入口与启动弹窗都取对应正式版的说明，确认写入正式版', () => {
    const store = createStore('3.2.15');
    const state = createReleaseNotesState({ store, currentVersion: '3.2.16+build.7', databaseExisted: true, rawNotes: NOTES });
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.current.version, '3.2.16');
    assert.equal(snapshot.pending.toVersion, '3.2.16');
    assert.deepEqual(state.acknowledge(snapshot.pending.toVersion), { status: 'ok', acknowledgedVersion: '3.2.16' });
    assert.deepEqual(store.writes, [{ fromVersion: '3.2.15', toVersion: '3.2.16' }]);
  });

  test('本版没有条目时 current 为 null，设置入口无条目', () => {
    const state = createReleaseNotesState({ store: createStore('3.2.17'), currentVersion: '3.2.17', databaseExisted: true, rawNotes: NOTES });
    assert.deepEqual(state.getSnapshot(), {
      current: null,
      pending: null,
      history: { kind: 'current', fromVersion: null, toVersion: '3.2.17', entries: [] }
    });
  });
});

test.describe('v3.2.15 升级记录与设置入口区间', () => {
  test('selectUpgradeReleaseNotes：来源已知取 (from, to]，来源未知取 [3.2.13, to]', () => {
    assert.deepEqual(versionsOf(selectUpgradeReleaseNotes({ entries: NOTES, fromVersion: '3.2.14', toVersion: '3.2.16' })), ['3.2.16', '3.2.15']);
    assert.deepEqual(versionsOf(selectUpgradeReleaseNotes({ entries: NOTES, fromVersion: null, toVersion: '3.2.15' })), ['3.2.15', '3.2.14', '3.2.13']);
  });

  test('normalizeLastUpgrade：版本号须为正式版且 from 低于 to，不合格视为没有记录', () => {
    assert.deepEqual(normalizeLastUpgrade({ fromVersion: '3.2.14', toVersion: '3.2.16' }), { fromVersion: '3.2.14', toVersion: '3.2.16' });
    assert.deepEqual(normalizeLastUpgrade({ fromVersion: null, toVersion: '3.2.16' }), { fromVersion: null, toVersion: '3.2.16' });
    for (const value of [
      null, 'x', [], {},
      { fromVersion: '3.2.16', toVersion: '3.2.16' },
      { fromVersion: '3.2.16', toVersion: '3.2.15' },
      { fromVersion: 'v3.2.14', toVersion: '3.2.16' },
      { fromVersion: '3.2.14', toVersion: '3.2.16-beta.1' },
      { fromVersion: '', toVersion: '3.2.16' }
    ]) {
      assert.equal(normalizeLastUpgrade(value), null, JSON.stringify(value));
    }
  });

  test('resolveReleaseNotesHistory：待显示 → 最近一次升级到当前版本 → 只有本版', () => {
    const pending = { fromVersion: '3.2.14', toVersion: '3.2.16', entries: NOTES.slice(0, 2) };
    assert.deepEqual(resolveReleaseNotesHistory({ entries: NOTES, currentVersion: '3.2.16', pending, lastUpgrade: null }),
      { kind: 'upgrade', fromVersion: '3.2.14', toVersion: '3.2.16', entries: pending.entries });

    const known = resolveReleaseNotesHistory({ entries: NOTES, currentVersion: '3.2.16', pending: null, lastUpgrade: { fromVersion: '3.2.13', toVersion: '3.2.16' } });
    assert.deepEqual([known.kind, known.fromVersion, versionsOf(known.entries)], ['upgrade', '3.2.13', ['3.2.16', '3.2.15', '3.2.14']]);

    const legacy = resolveReleaseNotesHistory({ entries: NOTES, currentVersion: '3.2.15', pending: null, lastUpgrade: { fromVersion: null, toVersion: '3.2.15' } });
    assert.deepEqual([legacy.kind, legacy.fromVersion, versionsOf(legacy.entries)], ['upgrade', null, ['3.2.15', '3.2.14', '3.2.13']]);

    // 记录的是另一版本（降级后、或记录未更新）：只显示本版
    const other = resolveReleaseNotesHistory({ entries: NOTES, currentVersion: '3.2.15', pending: null, lastUpgrade: { fromVersion: '3.2.14', toVersion: '3.2.16' } });
    assert.deepEqual([other.kind, other.toVersion, versionsOf(other.entries)], ['current', '3.2.15', ['3.2.15']]);

    const fresh = resolveReleaseNotesHistory({ entries: NOTES, currentVersion: '3.2.16+build.7', pending: null, lastUpgrade: null });
    assert.deepEqual([fresh.kind, fresh.toVersion, versionsOf(fresh.entries)], ['current', '3.2.16', ['3.2.16']]);
  });

  test('确认后设置入口仍显示本次升级区间，重启后从主库记录恢复', () => {
    const store = createStore('3.2.14');
    const state = createReleaseNotesState({ store, currentVersion: '3.2.16', databaseExisted: true, rawNotes: NOTES });
    assert.deepEqual(versionsOf(state.getSnapshot().history.entries), ['3.2.16', '3.2.15'], '未确认时与启动弹窗同一区间');
    state.acknowledge('3.2.16');
    const afterAck = state.getSnapshot().history;
    assert.deepEqual([afterAck.kind, afterAck.fromVersion, versionsOf(afterAck.entries)], ['upgrade', '3.2.14', ['3.2.16', '3.2.15']]);

    const restarted = createReleaseNotesState({ store, currentVersion: '3.2.16', databaseExisted: true, rawNotes: NOTES }).getSnapshot();
    assert.equal(restarted.pending, null);
    assert.deepEqual([restarted.history.fromVersion, versionsOf(restarted.history.entries)], ['3.2.14', ['3.2.16', '3.2.15']]);
  });

  test('老用户确认后写入 { null, 当前版本 }，设置入口显示 3.2.13 起的区间', () => {
    const store = createStore(null);
    const state = createReleaseNotesState({ store, currentVersion: '3.2.15', databaseExisted: true, rawNotes: NOTES });
    assert.deepEqual(versionsOf(state.getSnapshot().pending.entries), ['3.2.15', '3.2.14', '3.2.13']);
    assert.deepEqual(state.acknowledge('3.2.15'), { status: 'ok', acknowledgedVersion: '3.2.15' });
    assert.deepEqual(store.writes, [{ fromVersion: null, toVersion: '3.2.15' }]);
    const history = createReleaseNotesState({ store, currentVersion: '3.2.15', databaseExisted: true, rawNotes: NOTES }).getSnapshot().history;
    assert.deepEqual([history.kind, history.fromVersion, versionsOf(history.entries)], ['upgrade', null, ['3.2.15', '3.2.14', '3.2.13']]);
  });

  test('区间内没有说明的升级：启动即写入升级记录；全新安装与同版本不写升级记录', () => {
    const upgraded = createStore('3.2.16');
    createReleaseNotesState({ store: upgraded, currentVersion: '3.2.17', databaseExisted: true, rawNotes: NOTES });
    assert.deepEqual(upgraded.writes, [{ fromVersion: '3.2.16', toVersion: '3.2.17' }]);

    const fresh = createStore(null);
    const freshState = createReleaseNotesState({ store: fresh, currentVersion: '3.2.16', databaseExisted: false, rawNotes: NOTES });
    assert.deepEqual(fresh.writes, ['3.2.16']);
    assert.equal(fresh.lastUpgrade, null);
    assert.equal(freshState.getSnapshot().history.kind, 'current');

    const same = createStore('3.2.16', { fromVersion: '3.2.14', toVersion: '3.2.16' });
    createReleaseNotesState({ store: same, currentVersion: '3.2.16', databaseExisted: true, rawNotes: NOTES });
    assert.deepEqual(same.writes, []);
  });

  test('读取升级记录失败：记录日志，设置入口只显示本版', () => {
    const logs = [];
    const store = createStore('3.2.16');
    store.getReleaseNotesLastUpgrade = () => { throw new Error('数据库忙'); };
    const state = createReleaseNotesState({ store, currentVersion: '3.2.16', databaseExisted: true, rawNotes: NOTES, log: (entry) => logs.push(entry) });
    assert.deepEqual(versionsOf(state.getSnapshot().history.entries), ['3.2.16']);
    assert.deepEqual(logs.map((entry) => entry.message), ['读取更新说明升级记录失败']);
  });

  test('快照中的 history 为副本', () => {
    const state = createReleaseNotesState({ store: createStore('3.2.14'), currentVersion: '3.2.16', databaseExisted: true, rawNotes: NOTES });
    state.getSnapshot().history.entries[0].highlights.push('被调用方改写');
    assert.deepEqual(state.getSnapshot().history.entries[0].highlights, ['十六']);
  });
});
