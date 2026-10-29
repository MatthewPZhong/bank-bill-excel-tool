'use strict';

// v3.2.14 升级后首次启动的「更新说明」：随包数据门禁、启动判定与确认语义。
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  LEGACY_BASELINE_VERSION,
  createReleaseNotesState,
  normalizeReleaseNotes,
  resolveStartupReleaseNotes,
  selectReleaseNotes
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

function createStore(initial = null) {
  const writes = [];
  return {
    writes,
    value: initial,
    failWrites: false,
    getReleaseNotesAcknowledgedVersion() { return this.value; },
    setReleaseNotesAcknowledgedVersion(version) {
      if (this.failWrites) throw new Error('磁盘只读');
      writes.push(version);
      this.value = version;
    }
  };
}

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
    assert.deepEqual(resolve({ databaseExisted: false }), { pending: null, writeAcknowledged: '3.2.16' });
  });

  test('已有数据且无记录：从 v3.2.13 之后起算，来源版本未知', () => {
    assert.equal(LEGACY_BASELINE_VERSION, '3.2.13');
    const { pending, writeAcknowledged } = resolve({ currentVersion: '3.2.14' });
    assert.equal(writeAcknowledged, null);
    assert.equal(pending.fromVersion, null);
    assert.equal(pending.toVersion, '3.2.14');
    assert.deepEqual(versionsOf(pending.entries), ['3.2.14']);
  });

  test('记录为旧版本：列出跨过的全部版本，按新到旧', () => {
    const { pending } = resolve({ acknowledgedVersion: '3.2.13' });
    assert.equal(pending.fromVersion, '3.2.13');
    assert.deepEqual(versionsOf(pending.entries), ['3.2.16', '3.2.15', '3.2.14']);
  });

  test('同版本重启：不弹，不重复写', () => {
    assert.deepEqual(resolve({ acknowledgedVersion: '3.2.16' }), { pending: null, writeAcknowledged: null });
  });

  test('降级：不弹，保留更高的已确认版本', () => {
    assert.deepEqual(resolve({ currentVersion: '3.2.15', acknowledgedVersion: '3.2.16' }), { pending: null, writeAcknowledged: null });
  });

  test('已有数据、无记录且当前就是基线版本：不弹，补写记录', () => {
    assert.deepEqual(resolve({ currentVersion: '3.2.13' }), { pending: null, writeAcknowledged: '3.2.13' });
  });

  test('记录非法时按无记录处理', () => {
    const { pending } = resolve({ currentVersion: '3.2.14', acknowledgedVersion: 'garbage' });
    assert.equal(pending.fromVersion, null);
    assert.deepEqual(versionsOf(pending.entries), ['3.2.14']);
  });

  test('升级但范围内没有说明条目：直接确认，不弹空窗', () => {
    assert.deepEqual(resolve({ currentVersion: '3.2.17', acknowledgedVersion: '3.2.16' }), { pending: null, writeAcknowledged: '3.2.17' });
  });

  test('带构建元数据的正式版：按对应正式版判定，记录写入不带元数据的版本', () => {
    const { pending } = resolve({ currentVersion: '3.2.14+build.7' });
    assert.equal(pending.toVersion, '3.2.14');
    assert.deepEqual(versionsOf(pending.entries), ['3.2.14']);
    assert.deepEqual(resolve({ currentVersion: '3.2.16+build.7', databaseExisted: false }), { pending: null, writeAcknowledged: '3.2.16' });
  });

  test('开发版或预发布号：不弹，也不写记录', () => {
    for (const currentVersion of ['3.2.17-beta.1', '3.2.17-beta.1+build.3', '', null]) {
      assert.deepEqual(resolve({ currentVersion, databaseExisted: false }), { pending: null, writeAcknowledged: null });
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
    assert.deepEqual(store.writes, ['3.2.16']);
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
    assert.deepEqual(store.writes, ['3.2.16']);
  });

  test('本版没有条目时 current 为 null', () => {
    const state = createReleaseNotesState({ store: createStore('3.2.17'), currentVersion: '3.2.17', databaseExisted: true, rawNotes: NOTES });
    assert.deepEqual(state.getSnapshot(), { current: null, pending: null });
  });
});
