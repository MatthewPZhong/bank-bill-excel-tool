// v2.1.10 N4-cont-1 T22 (Phase 4)：raw_json idle 自动清理保留窗口 settings 单键
//   spec §4.1.1 / §4.1.2 / 资金红线兜底（范围外回退 7）
//
// 测试覆盖：
//   1. ensureAcquiringBillCurrencyRawJsonRetentionSettings — 首次启动 seed 默认 7 + 幂等不覆盖既有值
//   2. getAcquiringBillRawJsonRetentionDays — 正常 / 缺失 / 非数字 / 范围外 / 空字符串回退
//   3. setAcquiringBillRawJsonRetentionDays — 范围内成功 / 范围外抛错 / 非整数抛错
//   4. AppDatabase 实例方法 wiring + sqlite UPDATE 重启行为（资金红线兜底）

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');
const {
  ensureAcquiringBillCurrencyRawJsonRetentionSettings,
  ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY,
  ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT,
} = require('../../../../src/backend/database/migrations');
const settingsRepo = require('../../../../src/backend/database/settings-repository');

function setupTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-json-retention-test-'));
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

describe('ensureAcquiringBillCurrencyRawJsonRetentionSettings (migration T22 / Phase 4)', () => {
  let ctx;
  beforeEach(() => { ctx = setupTempDb(); });
  afterEach(() => { teardown(ctx); });

  test('首次启动：seed 默认值 7', () => {
    const result = ensureAcquiringBillCurrencyRawJsonRetentionSettings(ctx.db);
    assert.strictEqual(result.status, 'seeded');
    assert.strictEqual(result.key, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY);

    const row = ctx.db.prepare('SELECT setting_value FROM app_settings WHERE setting_key=?')
      .get(ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY);
    assert.strictEqual(row.setting_value, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT);
    assert.strictEqual(row.setting_value, '7');
  });

  test('幂等：第二次启动不覆盖用户已改值（INSERT OR IGNORE）', () => {
    ensureAcquiringBillCurrencyRawJsonRetentionSettings(ctx.db);
    // 用户改成 14
    settingsRepo.setAcquiringBillRawJsonRetentionDays(ctx.db, 14);
    // 第二次启动
    ensureAcquiringBillCurrencyRawJsonRetentionSettings(ctx.db);
    const row = ctx.db.prepare('SELECT setting_value FROM app_settings WHERE setting_key=?')
      .get(ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY);
    assert.strictEqual(row.setting_value, '14', '用户已改值应保留，不被 seed 覆盖');
  });

  test('app_settings 表不存在 → 跳过', () => {
    ctx.db.exec('DROP TABLE app_settings');
    const result = ensureAcquiringBillCurrencyRawJsonRetentionSettings(ctx.db);
    assert.strictEqual(result.status, 'skipped-no-table');
  });
});

describe('getAcquiringBillRawJsonRetentionDays (settings-repository T22)', () => {
  let ctx;
  beforeEach(() => { ctx = setupTempDb(); });
  afterEach(() => { teardown(ctx); });

  test('未 seed → 回退默认 7', () => {
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 7);
  });

  test('已 seed 默认 7 → 返回 7', () => {
    ensureAcquiringBillCurrencyRawJsonRetentionSettings(ctx.db);
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 7);
  });

  test('用户改成 1（边界下限） → 返回 1', () => {
    settingsRepo.setAcquiringBillRawJsonRetentionDays(ctx.db, 1);
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 1);
  });

  test('用户改成 30（边界上限） → 返回 30', () => {
    settingsRepo.setAcquiringBillRawJsonRetentionDays(ctx.db, 30);
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 30);
  });

  test('DB 内值非数字 → 回退默认 7（资金红线兜底：clearStaleSuccessfulRawJson 不能用非法 retention）', () => {
    settingsRepo.setSetting(ctx.db, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY, 'abc');
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 7);
  });

  test('DB 内值范围外（0 / -1 / 31 / 100） → 回退默认 7（资金红线兜底）', () => {
    settingsRepo.setSetting(ctx.db, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY, '0');
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 7);
    settingsRepo.setSetting(ctx.db, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY, '-1');
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 7);
    settingsRepo.setSetting(ctx.db, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY, '31');
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 7);
    settingsRepo.setSetting(ctx.db, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY, '100');
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 7);
  });

  test('DB 内值空字符串 → 回退默认 7', () => {
    settingsRepo.setSetting(ctx.db, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY, '');
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 7);
  });
});

describe('setAcquiringBillRawJsonRetentionDays (settings-repository T22)', () => {
  let ctx;
  beforeEach(() => { ctx = setupTempDb(); });
  afterEach(() => { teardown(ctx); });

  test('范围内整数 7 → 成功落库', () => {
    settingsRepo.setAcquiringBillRawJsonRetentionDays(ctx.db, 7);
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 7);
  });

  test('范围外（0 / 31 / -1 / 100） → 抛错（资金红线严校验）', () => {
    for (const bad of [0, 31, -1, 100, 50, 1000]) {
      assert.throws(
        () => settingsRepo.setAcquiringBillRawJsonRetentionDays(ctx.db, bad),
        /1-30 天范围/,
        `值 ${bad} 应抛错`
      );
    }
  });

  test('非整数（浮点 / null / undefined / NaN / 空字符串 / 非数字字符串） → 抛错', () => {
    for (const bad of [1.5, null, undefined, NaN, '', 'abc']) {
      assert.throws(
        () => settingsRepo.setAcquiringBillRawJsonRetentionDays(ctx.db, bad),
        /必须是整数|1-30 天范围/,
        `值 ${JSON.stringify(bad)} 应抛错`
      );
    }
  });

  test('数字字符串如 "14" → 容错接受（前端 input.value 是 string）', () => {
    // setter 内部 Number(x) → Integer 通过；这是有意宽容的容错行为
    settingsRepo.setAcquiringBillRawJsonRetentionDays(ctx.db, '14');
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 14);
  });

  test('边界值 1 / 30 成功', () => {
    settingsRepo.setAcquiringBillRawJsonRetentionDays(ctx.db, 1);
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 1);
    settingsRepo.setAcquiringBillRawJsonRetentionDays(ctx.db, 30);
    assert.strictEqual(settingsRepo.getAcquiringBillRawJsonRetentionDays(ctx.db), 30);
  });
});

// 集成层扩展（沿用 N1-settings test 范式 / 资金红线兜底）：
//   模拟运维直接 sqlite UPDATE app_settings 改 retention 后 → AppDatabase 重启 → getter 行为
const { AppDatabase } = require('../../../../src/backend/database');

describe('sqlite UPDATE 后 AppDatabase 重启行为（raw_json retention）', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-json-retention-restart-'));
    dbPath = path.join(tmpDir, 'tool-data.sqlite');
  });

  afterEach(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      tmpDir = null;
    }
  });

  test('sqlite UPDATE 写合法值 14 后重新 init AppDatabase → getter 返回 14', () => {
    // 1. 首次 init AppDatabase → seed 默认 7
    const appDb1 = new AppDatabase(dbPath);
    appDb1.init();
    assert.strictEqual(appDb1.getAcquiringBillRawJsonRetentionDays(), 7, '首次启动默认 7');
    appDb1.db.close();

    // 2. 直接执行 SQL UPDATE 把 retention 改成 14（模拟运维直接改 DB）
    const rawDb = new DatabaseSync(dbPath);
    rawDb.prepare("UPDATE app_settings SET setting_value='14' WHERE setting_key='acquiring_bill_raw_json_retention_days'").run();
    rawDb.close();

    // 3. 重新 init AppDatabase（模拟用户重启 app）→ getter 返回 14
    const appDb2 = new AppDatabase(dbPath);
    appDb2.init();
    assert.strictEqual(
      appDb2.getAcquiringBillRawJsonRetentionDays(),
      14,
      'sqlite UPDATE 后重启读取应是新值 14（migration INSERT OR IGNORE 不覆盖用户已改值）'
    );
    appDb2.db.close();
  });

  test('sqlite UPDATE 写范围外非法值（0 / 100）→ 重启 getter 兜底返回默认 7', () => {
    // 1. 首次 init
    const appDb1 = new AppDatabase(dbPath);
    appDb1.init();
    appDb1.db.close();

    // 2. 用 SQL 绕过 setter 校验直接写非法值 '0'（< MIN=1）
    const rawDb = new DatabaseSync(dbPath);
    rawDb.prepare("UPDATE app_settings SET setting_value='0' WHERE setting_key='acquiring_bill_raw_json_retention_days'").run();
    rawDb.close();

    // 3. 重启 init → getter 兜底回默认 7（资金红线：clearStaleSuccessfulRawJson 永不能用非法 retention 误清正常数据）
    const appDb2 = new AppDatabase(dbPath);
    appDb2.init();
    assert.strictEqual(
      appDb2.getAcquiringBillRawJsonRetentionDays(),
      7,
      'sqlite UPDATE 写 0（< MIN=1）→ getter 兜底回默认 7'
    );
    appDb2.db.close();

    // 4. 再写 '100'（> MAX=30）→ 同样兜底回 7
    const rawDb2 = new DatabaseSync(dbPath);
    rawDb2.prepare("UPDATE app_settings SET setting_value='100' WHERE setting_key='acquiring_bill_raw_json_retention_days'").run();
    rawDb2.close();

    const appDb3 = new AppDatabase(dbPath);
    appDb3.init();
    assert.strictEqual(
      appDb3.getAcquiringBillRawJsonRetentionDays(),
      7,
      'sqlite UPDATE 写 100（> MAX=30）→ getter 兜底回默认 7'
    );
    appDb3.db.close();
  });

  test('sqlite UPDATE 写非数字 abc → 重启 getter parseInt 解析失败兜底回 7', () => {
    // 1. 首次 init
    const appDb1 = new AppDatabase(dbPath);
    appDb1.init();
    appDb1.db.close();

    // 2. 用 SQL 写非数字 'abc'（绕过 setter 校验）
    const rawDb = new DatabaseSync(dbPath);
    rawDb.prepare("UPDATE app_settings SET setting_value='abc' WHERE setting_key='acquiring_bill_raw_json_retention_days'").run();
    rawDb.close();

    // 3. 重启 init → parseInt('abc') = NaN → 兜底回 7
    const appDb2 = new AppDatabase(dbPath);
    appDb2.init();
    assert.strictEqual(
      appDb2.getAcquiringBillRawJsonRetentionDays(),
      7,
      'sqlite UPDATE 写 abc → parseInt NaN → 兜底回默认 7'
    );
    appDb2.db.close();
  });
});
