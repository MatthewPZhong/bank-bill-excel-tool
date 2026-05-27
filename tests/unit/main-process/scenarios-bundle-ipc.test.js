// v2.1.9 N7 Phase 7 T27/T30：scenarios:export-bundle / scenarios:import-bundle / scenarios:import-bundle-apply
// IPC handler 单元测试（同构 sham 函数复刻 handler 主体逻辑）
//
// 测试策略（与 scenarios-batch-ipc.test.js 同范式）：
//   - 抽出 main.js handler 内部主体逻辑为可测函数
//   - serialize / parse / detect 直接复用 src/backend/scenarios-bundle-io
//   - applyScenarioBundleImport 同构版本（事务包裹 + 缺失渠道处理 + 同名场景跳过）
//   - 用真实 SQLite tmpdir 文件 + AppDatabase（init 跑 N5 migration）
//   - 文件 IO（saveDialog / openDialog）由集成测试覆盖，本测试只测逻辑层
//
// 用户验证：grep 'scenarios:export-bundle\|scenarios:import-bundle\|scenarios:import-bundle-apply' src/main.js
//          与本文件 handler 主体逻辑必须一致（IO 层除外）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AppDatabase } = require('../../../src/backend/database');
const {
  serializeScenarioBundle,
  parseScenarioBundle,
  detectBundleType,
  SUPPORTED_SCENARIO_BUNDLE_VERSION
} = require('../../../src/backend/scenarios-bundle-io');

// ---- handler 内部主体逻辑同构（与 src/main.js 行 ~3007+ 三个 handler 一致）----

function handlerExportBundle(database, payload) {
  try {
    const inputIds = Array.isArray(payload && payload.channelIds) ? payload.channelIds : [];
    const channelIds = inputIds
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (channelIds.length === 0) {
      return { status: 'failed', message: '请至少选择一个银行渠道' };
    }
    const allChannels = database.listChannels();
    const channelById = new Map(allChannels.map((c) => [Number(c.id), c]));
    const selectedChannels = [];
    const unknownIds = [];
    for (const id of channelIds) {
      if (channelById.has(id)) selectedChannels.push(channelById.get(id));
      else unknownIds.push(id);
    }
    if (selectedChannels.length === 0) {
      return { status: 'failed', message: `选中的渠道 id=${unknownIds.join(',')} 不存在` };
    }
    const scenariosByChannel = new Map();
    let totalScenarios = 0;
    for (const ch of selectedChannels) {
      const scenarios = database.listAllScenariosByChannelId(ch.id);
      scenariosByChannel.set(ch.id, scenarios);
      totalScenarios += scenarios.length;
    }
    const jsonText = serializeScenarioBundle(selectedChannels, scenariosByChannel, '2.1.9-test');
    return {
      status: 'ok',
      jsonText,
      exportedChannels: selectedChannels.length,
      exportedScenarios: totalScenarios
    };
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

function handlerImportBundleScan(database, jsonText) {
  try {
    let parsedRaw;
    try {
      parsedRaw = JSON.parse(jsonText);
    } catch (e) {
      return { status: 'failed', message: `场景模板文件格式错误：${e.message}` };
    }
    let bundleType;
    try {
      bundleType = detectBundleType(parsedRaw);
    } catch (e) {
      return { status: 'failed', message: String(e.message) };
    }
    if (bundleType !== 'scenarios') {
      return { status: 'failed', message: '文件类型不匹配' };
    }
    let bundle;
    try { bundle = parseScenarioBundle(jsonText); }
    catch (e) { return { status: 'failed', message: e.message }; }

    const allChannels = database.listChannels();
    const channelKeyToRecord = new Map(allChannels.map((c) => [`${c.name} ${c.ownerLocation}`, c]));
    const missingChannels = [];
    for (const ch of bundle.channels) {
      if (ch.isBuiltin) continue;
      const key = `${ch.name} ${ch.ownerLocation}`;
      if (!channelKeyToRecord.has(key)) {
        missingChannels.push({ name: ch.name, ownerLocation: ch.ownerLocation });
      }
    }
    if (missingChannels.length > 0) {
      return { status: 'needs-confirm', missingChannels, bundle };
    }
    const applyResult = applyImportSham(database, bundle, { confirmCreateMissingChannels: false });
    return Object.assign({ status: 'ok' }, applyResult);
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

function handlerImportBundleApply(database, payload) {
  try {
    const { bundle, confirmCreateMissingChannels } = payload || {};
    if (!bundle || !Array.isArray(bundle.channels)) {
      return { status: 'failed', message: 'apply: 缺少有效的 bundle 参数' };
    }
    const applyResult = applyImportSham(database, bundle, {
      confirmCreateMissingChannels: confirmCreateMissingChannels === true
    });
    return Object.assign({ status: 'ok' }, applyResult);
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

// applyScenarioBundleImport 同构（与 main.js 行 ~340 同步实现；事务包裹）
function applyImportSham(database, bundle, options) {
  const confirmCreateMissingChannels = options.confirmCreateMissingChannels === true;
  const conflicts = [];
  const createdChannels = [];
  let importedCount = 0;
  const db = database.db;
  db.exec('BEGIN');
  try {
    const allChannels = database.listChannels();
    const channelKeyToRecord = new Map(allChannels.map((c) => [`${c.name} ${c.ownerLocation}`, c]));
    for (const bundleChannel of bundle.channels) {
      const channelKey = `${bundleChannel.name} ${bundleChannel.ownerLocation}`;
      const channelLabel = `${bundleChannel.name}-${bundleChannel.ownerLocation}`;
      let targetChannel = channelKeyToRecord.get(channelKey);
      if (!targetChannel) {
        if (bundleChannel.isBuiltin) {
          targetChannel = database.getBuiltinGeneralChannel();
          channelKeyToRecord.set(channelKey, targetChannel);
        } else if (confirmCreateMissingChannels) {
          const newChannel = database.createChannel({
            name: bundleChannel.name,
            ownerLocation: bundleChannel.ownerLocation
          });
          channelKeyToRecord.set(channelKey, newChannel);
          targetChannel = newChannel;
          createdChannels.push({ id: newChannel.id, name: newChannel.name, ownerLocation: newChannel.ownerLocation });
        } else {
          for (const s of bundleChannel.scenarios) {
            conflicts.push({ channel: channelLabel, scenario: s.name, reason: 'channel-missing' });
          }
          continue;
        }
      }
      for (const bundleScenario of bundleChannel.scenarios) {
        const existingRow = db.prepare('SELECT id FROM scenarios WHERE name = ?').get(bundleScenario.name);
        if (existingRow) {
          conflicts.push({ channel: channelLabel, scenario: bundleScenario.name, reason: 'name-duplicate' });
          continue;
        }
        let configValue = bundleScenario.configJson;
        if (typeof configValue === 'string') {
          try { configValue = JSON.parse(configValue); } catch (_e) {}
        }
        const createResult = database.createScenario({
          category: bundleScenario.category,
          name: bundleScenario.name,
          priority: Number.isInteger(bundleScenario.sortOrder) ? bundleScenario.sortOrder : 0,
          enabled: bundleScenario.enabled === 1,
          config: configValue
        });
        db.prepare('UPDATE scenarios SET channel_id = ? WHERE id = ?').run(targetChannel.id, createResult.id);
        importedCount += 1;
      }
    }
    db.exec('COMMIT');
    return { importedCount, conflicts, createdChannels };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ---- 测试上下文 ----

let tmpDir;
let database;

function createScenarioFixture(name, channelId, category = 'extract-recon-id') {
  const config = {
    conditions: [{ field: 'CustomerRef', op: '包含', value: 'X' }],
    extractByFeature: null,
    extractByOtherField: { field: 'CustomerRef' }
  };
  const result = database.createScenario({
    category,
    name,
    priority: 1,
    enabled: true,
    config
  });
  database.db.prepare('UPDATE scenarios SET channel_id = ? WHERE id = ?').run(channelId, result.id);
  return result;
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-bundle-ipc-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  database = new AppDatabase(dbPath);
  database.init();
});

test.afterEach(() => {
  if (database && database.db) {
    try { database.db.close(); } catch (_) {}
  }
  database = null;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

// ============================================================================
// scenarios:export-bundle
// ============================================================================

test.describe('scenarios:export-bundle handler', () => {
  test('正常导出 — 含通用渠道', () => {
    // 基线：database.init 内置了 N 个 builtin 场景（all 落在通用 id=1）
    const baselineGeneral = database.listAllScenariosByChannelId(1).length;
    createScenarioFixture('通用s1', 1);
    const result = handlerExportBundle(database, { channelIds: [1] });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.exportedChannels, 1);
    assert.strictEqual(result.exportedScenarios, baselineGeneral + 1);
    const parsed = JSON.parse(result.jsonText);
    assert.strictEqual(parsed.scenarioBundleVersion, SUPPORTED_SCENARIO_BUNDLE_VERSION);
    assert.strictEqual(parsed.channels[0].name, '通用');
    assert.ok(parsed.channels[0].scenarios.some((s) => s.name === '通用s1'));
  });

  test('多渠道导出 — 含通用 + 工商', () => {
    const icbc = database.createChannel({ name: '工商', ownerLocation: '上海' });
    const baselineGeneral = database.listAllScenariosByChannelId(1).length;
    createScenarioFixture('通用s1', 1);
    createScenarioFixture('工商s1', icbc.id);
    createScenarioFixture('工商s2', icbc.id, 'gateway-recon-join');
    const result = handlerExportBundle(database, { channelIds: [1, icbc.id] });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.exportedChannels, 2);
    // 通用：baseline + 通用s1；工商：工商s1 + 工商s2
    assert.strictEqual(result.exportedScenarios, baselineGeneral + 1 + 2);
  });

  test('空 channelIds — 返 failed', () => {
    const result = handlerExportBundle(database, { channelIds: [] });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /至少选择一个/);
  });

  test('全部 channelIds 不存在 — 返 failed', () => {
    const result = handlerExportBundle(database, { channelIds: [9999] });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /不存在/);
  });

  test('部分 channelIds 不存在 — 仅导出存在的渠道（不抛错）', () => {
    createScenarioFixture('通用s1', 1);
    const result = handlerExportBundle(database, { channelIds: [1, 9999] });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.exportedChannels, 1);
  });

  test('disabled 场景也导出（含全部场景）', () => {
    const icbc = database.createChannel({ name: '工商', ownerLocation: '上海' });
    const s = createScenarioFixture('disabled-s', icbc.id);
    database.toggleScenarioEnabled(s.id, false);
    const result = handlerExportBundle(database, { channelIds: [icbc.id] });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.exportedScenarios, 1);
    const parsed = JSON.parse(result.jsonText);
    assert.strictEqual(parsed.channels[0].scenarios[0].enabled, 0);
  });
});

// ============================================================================
// scenarios:import-bundle (scan 阶段)
// ============================================================================

test.describe('scenarios:import-bundle handler (scan 阶段)', () => {
  test('合法 bundle + 无缺失渠道 → 直接 apply 成功', () => {
    const jsonText = JSON.stringify({
      scenarioBundleVersion: 1,
      appVersion: '2.1.9',
      channels: [{
        name: '通用',
        ownerLocation: '通用',
        isBuiltin: 1,
        scenarios: [{
          category: 'extract-recon-id',
          name: 'new-s1',
          sortOrder: 1,
          enabled: 1,
          configJson: { conditions: [{ field: 'CustomerRef', op: '包含', value: 'A' }], extractByFeature: null, extractByOtherField: { field: 'CustomerRef' } }
        }]
      }]
    });
    const result = handlerImportBundleScan(database, jsonText);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.importedCount, 1);
    assert.strictEqual(result.conflicts.length, 0);
    // DB 中已有 new-s1
    const all = database.listScenarios();
    assert.ok(all.some((s) => s.name === 'new-s1'));
  });

  test('误用 bundleVersion=4 文件 → 返 failed 「文件类型不匹配」', () => {
    const jsonText = JSON.stringify({
      bundleVersion: 4,
      exportedAt: '2026-05-27',
      templates: []
    });
    const result = handlerImportBundleScan(database, jsonText);
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /文件类型不匹配/);
  });

  test('损坏 JSON → 返 failed', () => {
    const result = handlerImportBundleScan(database, 'not-json{');
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /场景模板文件格式错误/);
  });

  test('版本号过高 → 返 failed', () => {
    const jsonText = JSON.stringify({
      scenarioBundleVersion: SUPPORTED_SCENARIO_BUNDLE_VERSION + 1,
      channels: []
    });
    const result = handlerImportBundleScan(database, jsonText);
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /高于当前应用支持的版本/);
  });

  test('含缺失渠道 → 返 needs-confirm', () => {
    const jsonText = JSON.stringify({
      scenarioBundleVersion: 1,
      channels: [{
        name: '工商',
        ownerLocation: '上海',
        isBuiltin: 0,
        scenarios: []
      }]
    });
    const result = handlerImportBundleScan(database, jsonText);
    assert.strictEqual(result.status, 'needs-confirm');
    assert.strictEqual(result.missingChannels.length, 1);
    assert.strictEqual(result.missingChannels[0].name, '工商');
    assert.strictEqual(result.missingChannels[0].ownerLocation, '上海');
    // DB 不应被改动
    const channels = database.listChannels();
    assert.strictEqual(channels.length, 1); // 仅「通用」
  });

  test('同名场景 → 跳过 + 收集到 conflicts', () => {
    // 先建一个场景 existing-s
    createScenarioFixture('existing-s', 1);
    const jsonText = JSON.stringify({
      scenarioBundleVersion: 1,
      channels: [{
        name: '通用',
        ownerLocation: '通用',
        isBuiltin: 1,
        scenarios: [{
          category: 'extract-recon-id',
          name: 'existing-s',
          sortOrder: 1,
          enabled: 1,
          configJson: { conditions: [{ field: 'CustomerRef', op: '包含', value: 'A' }], extractByFeature: null, extractByOtherField: { field: 'CustomerRef' } }
        }]
      }]
    });
    const result = handlerImportBundleScan(database, jsonText);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.importedCount, 0);
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0].scenario, 'existing-s');
    assert.strictEqual(result.conflicts[0].reason, 'name-duplicate');
  });
});

// ============================================================================
// scenarios:import-bundle-apply (apply 阶段)
// ============================================================================

test.describe('scenarios:import-bundle-apply handler', () => {
  test('confirmCreateMissingChannels=true → 创建新渠道 + 插入新场景', () => {
    const bundle = {
      scenarioBundleVersion: 1,
      channels: [{
        name: '工商',
        ownerLocation: '上海',
        isBuiltin: 0,
        scenarios: [{
          category: 'extract-recon-id',
          name: 'new-icbc-s1',
          sortOrder: 1,
          enabled: 1,
          configJson: { conditions: [{ field: 'CustomerRef', op: '包含', value: 'X' }], extractByFeature: null, extractByOtherField: { field: 'CustomerRef' } }
        }]
      }]
    };
    const result = handlerImportBundleApply(database, { bundle, confirmCreateMissingChannels: true });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.importedCount, 1);
    assert.strictEqual(result.createdChannels.length, 1);
    assert.strictEqual(result.createdChannels[0].name, '工商');
    // 验证 DB
    const channels = database.listChannels();
    assert.ok(channels.some((c) => c.name === '工商' && c.ownerLocation === '上海'));
    const all = database.listScenarios();
    assert.ok(all.some((s) => s.name === 'new-icbc-s1'));
  });

  test('confirmCreateMissingChannels=false → 跳过缺失渠道下场景 + 收集 conflicts', () => {
    const bundle = {
      scenarioBundleVersion: 1,
      channels: [{
        name: '工商',
        ownerLocation: '上海',
        isBuiltin: 0,
        scenarios: [
          { category: 'extract-recon-id', name: 's1', sortOrder: 1, enabled: 1, configJson: {} },
          { category: 'extract-recon-id', name: 's2', sortOrder: 1, enabled: 1, configJson: {} }
        ]
      }]
    };
    const result = handlerImportBundleApply(database, { bundle, confirmCreateMissingChannels: false });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.importedCount, 0);
    assert.strictEqual(result.createdChannels.length, 0);
    assert.strictEqual(result.conflicts.length, 2);
    assert.strictEqual(result.conflicts[0].reason, 'channel-missing');
  });

  test('bundle 为空对象 → 返 failed', () => {
    const result = handlerImportBundleApply(database, {});
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /缺少有效的 bundle/);
  });

  test('多渠道混合：通用（已存在）+ 工商（缺失但 confirm=true）', () => {
    const bundle = {
      scenarioBundleVersion: 1,
      channels: [
        {
          name: '通用',
          ownerLocation: '通用',
          isBuiltin: 1,
          scenarios: [{
            category: 'extract-recon-id',
            name: 'general-s1',
            sortOrder: 1,
            enabled: 1,
            configJson: { conditions: [{ field: 'CustomerRef', op: '包含', value: 'X' }], extractByFeature: null, extractByOtherField: { field: 'CustomerRef' } }
          }]
        },
        {
          name: '工商',
          ownerLocation: '上海',
          isBuiltin: 0,
          scenarios: [{
            category: 'extract-recon-id',
            name: 'icbc-s1',
            sortOrder: 1,
            enabled: 1,
            configJson: { conditions: [{ field: 'CustomerRef', op: '包含', value: 'Y' }], extractByFeature: null, extractByOtherField: { field: 'CustomerRef' } }
          }]
        }
      ]
    };
    const result = handlerImportBundleApply(database, { bundle, confirmCreateMissingChannels: true });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.importedCount, 2);
    assert.strictEqual(result.createdChannels.length, 1);
  });

  test('apply 内部 throw → 事务回滚（半状态不留）', () => {
    // 构造一个会失败的 bundle：第二个 scenario.configJson 是 undefined 让 createScenario 抛
    // 注：scenariosRepository.createScenario 内 serializeConfig 对 null/undefined config 会抛
    const bundle = {
      scenarioBundleVersion: 1,
      channels: [{
        name: '通用',
        ownerLocation: '通用',
        isBuiltin: 1,
        scenarios: [
          {
            category: 'extract-recon-id',
            name: 'good-s',
            sortOrder: 1,
            enabled: 1,
            configJson: { conditions: [{ field: 'CustomerRef', op: '包含', value: 'X' }], extractByFeature: null, extractByOtherField: { field: 'CustomerRef' } }
          },
          {
            category: 'extract-recon-id',
            name: 'bad-s',
            sortOrder: 1,
            enabled: 1,
            configJson: null // 触发 createScenario → serializeConfig 抛「config 不能为空」
          }
        ]
      }]
    };
    const result = handlerImportBundleApply(database, { bundle, confirmCreateMissingChannels: false });
    assert.strictEqual(result.status, 'failed');
    // 验证事务回滚：good-s 也未落库
    const all = database.listScenarios();
    assert.ok(!all.some((s) => s.name === 'good-s'), '事务回滚失败：good-s 不应留在 DB');
    assert.ok(!all.some((s) => s.name === 'bad-s'));
  });
});

// ============================================================================
// 端到端往返
// ============================================================================

test.describe('export + import 端到端往返', () => {
  test('单渠道 export → import 到空库 → 渠道 + 场景一致', () => {
    // Setup A 库：通用 + 工商，各有场景
    const icbc = database.createChannel({ name: '工商', ownerLocation: '上海' });
    createScenarioFixture('通用s1', 1);
    createScenarioFixture('工商s1', icbc.id);
    const exportResult = handlerExportBundle(database, { channelIds: [1, icbc.id] });
    assert.strictEqual(exportResult.status, 'ok');

    // 拆掉 A 库 → 新 B 库
    database.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-bundle-roundtrip-'));
    const newDbPath = path.join(tmpDir, 'test.sqlite');
    database = new AppDatabase(newDbPath);
    database.init();

    // 导入 — 工商缺失 → needs-confirm → apply
    const scanResult = handlerImportBundleScan(database, exportResult.jsonText);
    assert.strictEqual(scanResult.status, 'needs-confirm');
    assert.strictEqual(scanResult.missingChannels.length, 1);
    assert.strictEqual(scanResult.missingChannels[0].name, '工商');

    const applyResult = handlerImportBundleApply(database, {
      bundle: scanResult.bundle,
      confirmCreateMissingChannels: true
    });
    assert.strictEqual(applyResult.status, 'ok');
    assert.strictEqual(applyResult.importedCount, 2);
    assert.strictEqual(applyResult.createdChannels.length, 1);

    // 验证 B 库
    const channels = database.listChannels();
    assert.ok(channels.some((c) => c.name === '通用'));
    assert.ok(channels.some((c) => c.name === '工商' && c.ownerLocation === '上海'));
    const all = database.listScenarios();
    assert.ok(all.some((s) => s.name === '通用s1'));
    assert.ok(all.some((s) => s.name === '工商s1'));
  });
});
