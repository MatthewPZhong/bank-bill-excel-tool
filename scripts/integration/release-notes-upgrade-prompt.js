// v3.2.14 升级后首次启动「更新说明」集成验证（真实主库 AppDatabase + 临时目录）
//   覆盖：全新安装写基线不弹、升级后跨重启保持待显示直到确认、确认后重启不再弹、
//         本功能之前的旧库从 v3.2.13（含）起弹出（v3.2.15）、降级不改记录、随包数据与 package.json 版本一致；
//         v3.2.15 起确认时把本次升级区间写入主库，设置入口（快照 history）跨重启显示上一个版本到当前版本。
//
// 每次“启动”都按 Main 的顺序：先判断主库文件是否存在，再打开并 init，最后计算启动状态；
// 确认版本落在主库 app_settings，验证跨进程重启的保留语义。
// 用法：node scripts/integration/release-notes-upgrade-prompt.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppDatabase } = require('../../src/backend/database');
const { createReleaseNotesState } = require('../../src/main-process/release-notes/service');

const ROOT = path.resolve(__dirname, '..', '..');
const NOTES = [
  { version: '3.2.16', date: '2026-11-11', highlights: ['十六'] },
  { version: '3.2.15', date: '2026-11-04', highlights: ['十五'] },
  { version: '3.2.14', date: '2026-10-30', highlights: ['十四'] },
  { version: '3.2.13', date: '2026-10-21', highlights: ['十三'] }
];
const versionsOf = (entries) => entries.map((entry) => entry.version);

function startup(dbPath, currentVersion, rawNotes = NOTES) {
  const databaseExisted = fs.existsSync(dbPath);
  const database = new AppDatabase(dbPath);
  database.init();
  const state = createReleaseNotesState({ store: database, currentVersion, databaseExisted, rawNotes });
  return { database, state, snapshot: state.getSnapshot() };
}

function withStartup(dbPath, currentVersion, work, rawNotes) {
  const run = startup(dbPath, currentVersion, rawNotes);
  try {
    return work(run);
  } finally {
    run.database.close();
  }
}

async function run() {
  console.log('==== 升级后更新说明 集成验证 ====');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-upgrade-'));
  const dbPathFor = (name) => {
    const directory = path.join(temporary, name);
    fs.mkdirSync(directory);
    return path.join(directory, 'tool-data.sqlite');
  };
  const cases = [
    ['全新安装不弹并写入当前版本；同版本重启仍不弹；设置入口只显示本版', () => {
      const dbPath = dbPathFor('fresh');
      withStartup(dbPath, '3.2.14', ({ database, snapshot }) => {
        assert.equal(snapshot.pending, null);
        assert.equal(snapshot.current.version, '3.2.14');
        assert.equal(database.getReleaseNotesAcknowledgedVersion(), '3.2.14');
        assert.equal(database.getReleaseNotesLastUpgrade(), null, '全新安装不写升级记录');
      });
      withStartup(dbPath, '3.2.14', ({ snapshot }) => {
        assert.equal(snapshot.pending, null);
        assert.deepEqual([snapshot.history.kind, versionsOf(snapshot.history.entries)], ['current', ['3.2.14']]);
      });
    }],
    ['跨版本升级后弹出全部新版本；未确认时重启继续弹，确认后重启不再弹', () => {
      const dbPath = dbPathFor('upgrade');
      withStartup(dbPath, '3.2.14', () => {});
      withStartup(dbPath, '3.2.16', ({ snapshot }) => {
        assert.equal(snapshot.pending.fromVersion, '3.2.14');
        assert.deepEqual(versionsOf(snapshot.pending.entries), ['3.2.16', '3.2.15']);
      });
      withStartup(dbPath, '3.2.16', ({ database, state, snapshot }) => {
        assert.notEqual(snapshot.pending, null, '未确认（如关闭前退出）时下次启动再弹');
        assert.equal(database.getReleaseNotesLastUpgrade(), null, '未确认前不写升级记录');
        assert.deepEqual(state.acknowledge('3.2.16'), { status: 'ok', acknowledgedVersion: '3.2.16' });
        assert.equal(database.getReleaseNotesAcknowledgedVersion(), '3.2.16');
        assert.deepEqual(database.getReleaseNotesLastUpgrade(), { fromVersion: '3.2.14', toVersion: '3.2.16' });
      });
      withStartup(dbPath, '3.2.16', ({ snapshot }) => {
        assert.equal(snapshot.pending, null);
        assert.equal(snapshot.current.version, '3.2.16');
        assert.deepEqual([snapshot.history.fromVersion, versionsOf(snapshot.history.entries)], ['3.2.14', ['3.2.16', '3.2.15']],
          '重启后设置入口仍显示上一个版本到当前版本');
      });
    }],
    ['本功能之前的旧库（无记录）升级：从 v3.2.13（含）起弹出，来源版本未知；之后的升级按记录', () => {
      const dbPath = dbPathFor('legacy');
      const legacy = new AppDatabase(dbPath);
      legacy.init();
      assert.equal(legacy.getReleaseNotesAcknowledgedVersion(), null, '主库 init 不得写入确认版本');
      legacy.close();
      withStartup(dbPath, '3.2.14', ({ database, state, snapshot }) => {
        assert.equal(snapshot.pending.fromVersion, null);
        assert.deepEqual(versionsOf(snapshot.pending.entries), ['3.2.14', '3.2.13']);
        state.acknowledge('3.2.14');
        assert.deepEqual(database.getReleaseNotesLastUpgrade(), { fromVersion: null, toVersion: '3.2.14' });
      });
      withStartup(dbPath, '3.2.14', ({ snapshot }) => {
        assert.deepEqual([snapshot.history.kind, snapshot.history.fromVersion, versionsOf(snapshot.history.entries)],
          ['upgrade', null, ['3.2.14', '3.2.13']], '设置入口显示 3.2.13 起的区间');
      });
      withStartup(dbPath, '3.2.15', ({ database, state, snapshot }) => {
        assert.equal(snapshot.pending.fromVersion, '3.2.14');
        assert.deepEqual(versionsOf(snapshot.pending.entries), ['3.2.15']);
        state.acknowledge('3.2.15');
        assert.deepEqual(database.getReleaseNotesLastUpgrade(), { fromVersion: '3.2.14', toVersion: '3.2.15' });
      });
    }],
    ['用户反馈场景：3.2.12 的旧库直接升到 3.2.15，弹出 3.2.15、3.2.14、3.2.13', () => {
      const dbPath = dbPathFor('legacy-direct');
      const legacy = new AppDatabase(dbPath);
      legacy.init();
      legacy.close();
      withStartup(dbPath, '3.2.15', ({ snapshot }) => {
        assert.equal(snapshot.pending.fromVersion, null);
        assert.deepEqual(versionsOf(snapshot.pending.entries), ['3.2.15', '3.2.14', '3.2.13']);
        assert.deepEqual(versionsOf(snapshot.history.entries), ['3.2.15', '3.2.14', '3.2.13'], '未确认时设置入口与弹窗同一区间');
      });
    }],
    ['降级不弹且保留更高的确认版本，回到原版本也不重复弹', () => {
      const dbPath = dbPathFor('downgrade');
      withStartup(dbPath, '3.2.16', () => {});
      withStartup(dbPath, '3.2.15', ({ database, snapshot }) => {
        assert.equal(snapshot.pending, null);
        assert.equal(database.getReleaseNotesAcknowledgedVersion(), '3.2.16');
        assert.deepEqual([snapshot.history.kind, versionsOf(snapshot.history.entries)], ['current', ['3.2.15']], '降级后设置入口只显示本版');
      });
      withStartup(dbPath, '3.2.16', ({ snapshot }) => assert.equal(snapshot.pending, null));
    }],
    ['随包数据：当前 package.json 版本有本版说明，全新安装写入该版本', () => {
      const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      const dbPath = dbPathFor('bundled');
      withStartup(dbPath, version, ({ database, snapshot }) => {
        assert.equal(snapshot.current.version, version);
        assert.ok(snapshot.current.highlights.length >= 1);
        assert.equal(database.getReleaseNotesAcknowledgedVersion(), version);
      }, require('../../src/main-process/release-notes/release-notes.json'));
    }]
  ];

  let passed = 0;
  const failures = [];
  try {
    for (const [label, work] of cases) {
      try {
        await work();
        passed += 1;
        console.log(`PASS ${label}`);
      } catch (error) {
        failures.push({ label, error });
        console.error(`FAIL ${label}: ${error.stack || error}`);
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`\n==== ${passed}/${cases.length} PASS ====`);
  if (failures.length) {
    console.error('FAILURES:');
    failures.forEach((failure) => console.error(`  - ${failure.label}: ${failure.error.message}`));
    process.exit(1);
  }
}

run().catch((error) => { console.error(error); process.exit(1); });
