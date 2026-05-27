// v2.1.9 N1-settings (T32b-c)：idle cleanup 阈值 settings 化
//   spec.md §13.2 / tasks.md T32b / 资金红线兜底（范围外回退 30）
//
// 测试覆盖：
//   1. ensureAcquiringBillIdleCleanupMinutesSetting — 首次启动 seed 默认 30 + 幂等不覆盖既有值
//   2. getAcquiringBillIdleCleanupMinutes — 正常 / 缺失 / 非数字 / 范围外回退
//   3. setAcquiringBillIdleCleanupMinutes — 范围内成功 / 范围外抛错 / 非整数抛错
//   4. AppDatabase 实例方法 wiring

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');
const {
  ensureAcquiringBillIdleCleanupMinutesSetting,
  ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY,
  ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT,
} = require('../../../../src/backend/database/migrations');
const settingsRepo = require('../../../../src/backend/database/settings-repository');

function setupTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-cleanup-test-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return { db, dir, dbPath };
}

function teardown({ db, dir }) {
  try { db.close(); } catch (_) {}
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('ensureAcquiringBillIdleCleanupMinutesSetting (migration T32b)', () => {
  let ctx;
  beforeEach(() => { ctx = setupTempDb(); });
  afterEach(() => { teardown(ctx); });

  test('首次启动：seed 默认值 30', () => {
    const result = ensureAcquiringBillIdleCleanupMinutesSetting(ctx.db);
    assert.strictEqual(result.status, 'seeded');
    assert.strictEqual(result.key, ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY);

    const row = ctx.db.prepare('SELECT setting_value FROM app_settings WHERE setting_key=?')
      .get(ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY);
    assert.strictEqual(row.setting_value, ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT);
    assert.strictEqual(row.setting_value, '30');
  });

  test('幂等：第二次启动不覆盖用户已改值（INSERT OR IGNORE）', () => {
    ensureAcquiringBillIdleCleanupMinutesSetting(ctx.db);
    // 用户改成 60
    settingsRepo.setAcquiringBillIdleCleanupMinutes(ctx.db, 60);
    // 第二次启动
    ensureAcquiringBillIdleCleanupMinutesSetting(ctx.db);
    const row = ctx.db.prepare('SELECT setting_value FROM app_settings WHERE setting_key=?')
      .get(ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY);
    assert.strictEqual(row.setting_value, '60', '用户已改值应保留，不被 seed 覆盖');
  });

  test('app_settings 表不存在 → 跳过', () => {
    // 删表
    ctx.db.exec('DROP TABLE app_settings');
    const result = ensureAcquiringBillIdleCleanupMinutesSetting(ctx.db);
    assert.strictEqual(result.status, 'skipped-no-table');
  });
});

describe('getAcquiringBillIdleCleanupMinutes (settings-repository)', () => {
  let ctx;
  beforeEach(() => { ctx = setupTempDb(); });
  afterEach(() => { teardown(ctx); });

  test('未 seed → 回退默认 30', () => {
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 30);
  });

  test('已 seed 默认 30 → 返回 30', () => {
    ensureAcquiringBillIdleCleanupMinutesSetting(ctx.db);
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 30);
  });

  test('用户改成 5（边界下限） → 返回 5', () => {
    settingsRepo.setAcquiringBillIdleCleanupMinutes(ctx.db, 5);
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 5);
  });

  test('用户改成 180（边界上限） → 返回 180', () => {
    settingsRepo.setAcquiringBillIdleCleanupMinutes(ctx.db, 180);
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 180);
  });

  test('DB 内值非数字 → 回退默认 30（资金红线兜底）', () => {
    // 手动塞非法值（绕过 setter 校验）
    settingsRepo.setSetting(ctx.db, ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY, 'invalid');
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 30);
  });

  test('DB 内值范围外（如 4 / 200） → 回退默认 30（资金红线兜底：never let cleanup never trigger）', () => {
    settingsRepo.setSetting(ctx.db, ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY, '4');
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 30);
    settingsRepo.setSetting(ctx.db, ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY, '200');
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 30);
  });

  test('DB 内值空字符串 → 回退默认 30', () => {
    settingsRepo.setSetting(ctx.db, ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY, '');
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 30);
  });
});

describe('setAcquiringBillIdleCleanupMinutes (settings-repository)', () => {
  let ctx;
  beforeEach(() => { ctx = setupTempDb(); });
  afterEach(() => { teardown(ctx); });

  test('范围内整数 30 → 成功落库', () => {
    settingsRepo.setAcquiringBillIdleCleanupMinutes(ctx.db, 30);
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 30);
  });

  test('范围外（4 / 181 / 0 / -1） → 抛错（资金红线严校验）', () => {
    for (const bad of [4, 181, 0, -1, 200, 1000]) {
      assert.throws(
        () => settingsRepo.setAcquiringBillIdleCleanupMinutes(ctx.db, bad),
        /5-180 分钟范围/,
        `值 ${bad} 应抛错`
      );
    }
  });

  test('非整数（浮点 / null / undefined / NaN / 空字符串 / 非数字字符串） → 抛错', () => {
    // 注：合法的数字字符串如 '30' Number(x)==30 是 Integer，setter 容错接受（前端 input 自然带字符串）
    for (const bad of [3.5, null, undefined, NaN, '', 'abc']) {
      assert.throws(
        () => settingsRepo.setAcquiringBillIdleCleanupMinutes(ctx.db, bad),
        /必须是整数|5-180 分钟范围/,
        `值 ${JSON.stringify(bad)} 应抛错`
      );
    }
  });

  test('数字字符串如 "30" → 容错接受（前端 input.value 是 string）', () => {
    // setter 内部 Number(x) → Integer 通过；这是有意宽容的容错行为
    settingsRepo.setAcquiringBillIdleCleanupMinutes(ctx.db, '60');
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 60);
  });

  test('边界值 5 / 180 成功', () => {
    settingsRepo.setAcquiringBillIdleCleanupMinutes(ctx.db, 5);
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 5);
    settingsRepo.setAcquiringBillIdleCleanupMinutes(ctx.db, 180);
    assert.strictEqual(settingsRepo.getAcquiringBillIdleCleanupMinutes(ctx.db), 180);
  });
});

// v2.1.9 集成层扩展（Task 3 PRD §13.2 / 资金红线兜底）：
//   模拟运维直接 sqlite UPDATE app_settings 改阈值后 → AppDatabase 重新 init / 重启 → getter 行为
//   不能用 :memory: DB（重启即丢），需 tmpdir 文件 sqlite + 实例化 AppDatabase
const { AppDatabase } = require('../../../../src/backend/database');

describe('sqlite UPDATE 后 AppDatabase 重启行为（idle cleanup 阈值）', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-cleanup-restart-'));
    dbPath = path.join(tmpDir, 'tool-data.sqlite');
  });

  afterEach(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      tmpDir = null;
    }
  });

  test('sqlite UPDATE 写合法值 60 后重新 init AppDatabase → getter 返回 60', () => {
    // 1. 首次 init AppDatabase → seed 默认 30
    const appDb1 = new AppDatabase(dbPath);
    appDb1.init();
    assert.strictEqual(appDb1.getAcquiringBillIdleCleanupMinutes(), 30, '首次启动默认 30');
    appDb1.db.close();

    // 2. 直接执行 SQL UPDATE 把阈值改成 60（模拟运维直接改 DB）
    const rawDb = new DatabaseSync(dbPath);
    rawDb.prepare("UPDATE app_settings SET setting_value='60' WHERE setting_key='acquiring_bill_idle_cleanup_minutes'").run();
    rawDb.close();

    // 3. 重新 init AppDatabase（模拟用户重启 app）→ getter 返回 60
    const appDb2 = new AppDatabase(dbPath);
    appDb2.init();
    assert.strictEqual(
      appDb2.getAcquiringBillIdleCleanupMinutes(),
      60,
      'sqlite UPDATE 后重启读取应是新值 60（migration INSERT OR IGNORE 不覆盖用户已改值）'
    );
    appDb2.db.close();
  });

  test('sqlite UPDATE 写范围外非法值（0 / 300）→ 重启 getter 兜底返回默认 30', () => {
    // 1. 首次 init
    const appDb1 = new AppDatabase(dbPath);
    appDb1.init();
    appDb1.db.close();

    // 2. 用 SQL 绕过 setter 校验直接写非法值 '0'（< MIN=5）
    const rawDb = new DatabaseSync(dbPath);
    rawDb.prepare("UPDATE app_settings SET setting_value='0' WHERE setting_key='acquiring_bill_idle_cleanup_minutes'").run();
    rawDb.close();

    // 3. 重启 init → getter 兜底回默认 30（资金红线：never let cleanup never trigger）
    const appDb2 = new AppDatabase(dbPath);
    appDb2.init();
    assert.strictEqual(
      appDb2.getAcquiringBillIdleCleanupMinutes(),
      30,
      'sqlite UPDATE 写 0（< MIN=5）→ getter 兜底回默认 30'
    );
    appDb2.db.close();

    // 4. 再写 '300'（> MAX=180）→ 同样兜底回 30
    const rawDb2 = new DatabaseSync(dbPath);
    rawDb2.prepare("UPDATE app_settings SET setting_value='300' WHERE setting_key='acquiring_bill_idle_cleanup_minutes'").run();
    rawDb2.close();

    const appDb3 = new AppDatabase(dbPath);
    appDb3.init();
    assert.strictEqual(
      appDb3.getAcquiringBillIdleCleanupMinutes(),
      30,
      'sqlite UPDATE 写 300（> MAX=180）→ getter 兜底回默认 30'
    );
    appDb3.db.close();
  });

  test('sqlite UPDATE 写非数字 abc → 重启 getter parseInt 解析失败兜底回 30', () => {
    // 1. 首次 init
    const appDb1 = new AppDatabase(dbPath);
    appDb1.init();
    appDb1.db.close();

    // 2. 用 SQL 写非数字 'abc'（绕过 setter 校验）
    const rawDb = new DatabaseSync(dbPath);
    rawDb.prepare("UPDATE app_settings SET setting_value='abc' WHERE setting_key='acquiring_bill_idle_cleanup_minutes'").run();
    rawDb.close();

    // 3. 重启 init → parseInt('abc') = NaN → 兜底回 30
    const appDb2 = new AppDatabase(dbPath);
    appDb2.init();
    assert.strictEqual(
      appDb2.getAcquiringBillIdleCleanupMinutes(),
      30,
      'sqlite UPDATE 写 abc → parseInt NaN → 兜底回默认 30'
    );
    appDb2.db.close();
  });
});
