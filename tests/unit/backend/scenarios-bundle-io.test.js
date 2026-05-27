// v2.1.9 N7 Phase 7 T27：场景模板 bundle 序列化 / 解析 / 类型识别单元测试
//
// 覆盖：
// - serializeScenarioBundle 序列化输出（含 channels 顺序保持 + 空 scenarios 渠道 + config / configJson 二选一）
// - parseScenarioBundle 解析（合法 / 损坏 JSON / 版本号边界 / 缺字段）
// - detectBundleType 顶层 key 严格判型（scenarios / template / 两者都没 / 都有）
// - 序列化往返一致性
//
// 不依赖 SQLite，纯函数测试

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SUPPORTED_SCENARIO_BUNDLE_VERSION,
  serializeScenarioBundle,
  parseScenarioBundle,
  detectBundleType
} = require('../../../src/backend/scenarios-bundle-io');

// ============================================================================
// serializeScenarioBundle
// ============================================================================

test.describe('serializeScenarioBundle', () => {
  test('单渠道单场景 — 输出结构化 JSON 含 scenarioBundleVersion / channels / scenarios', () => {
    const channels = [{ id: 1, name: '通用', ownerLocation: '通用', isBuiltin: true }];
    const map = new Map([[1, [{
      category: 'extract-recon-id',
      name: '通用场景1',
      priority: 0,
      enabled: 1,
      config: { conditions: [{ field: 'CustomerRef', op: '包含', value: 'X' }] }
    }]]]);
    const jsonText = serializeScenarioBundle(channels, map, '2.1.9');
    const parsed = JSON.parse(jsonText);
    assert.strictEqual(parsed.scenarioBundleVersion, SUPPORTED_SCENARIO_BUNDLE_VERSION);
    assert.strictEqual(parsed.appVersion, '2.1.9');
    assert.ok(typeof parsed.exportedAt === 'string' && parsed.exportedAt.length > 0);
    assert.strictEqual(parsed.channels.length, 1);
    assert.strictEqual(parsed.channels[0].name, '通用');
    assert.strictEqual(parsed.channels[0].ownerLocation, '通用');
    assert.strictEqual(parsed.channels[0].isBuiltin, 1);
    assert.strictEqual(parsed.channels[0].scenarios.length, 1);
    const s = parsed.channels[0].scenarios[0];
    assert.strictEqual(s.category, 'extract-recon-id');
    assert.strictEqual(s.name, '通用场景1');
    assert.strictEqual(s.sortOrder, 0);
    assert.strictEqual(s.enabled, 1);
    assert.deepStrictEqual(s.configJson, { conditions: [{ field: 'CustomerRef', op: '包含', value: 'X' }] });
  });

  test('多渠道 — channels 顺序保持入参顺序', () => {
    const channels = [
      { id: 2, name: '工商', ownerLocation: '上海', isBuiltin: false },
      { id: 1, name: '通用', ownerLocation: '通用', isBuiltin: true },
      { id: 3, name: '招商', ownerLocation: '北京', isBuiltin: false }
    ];
    const map = new Map([[1, []], [2, []], [3, []]]);
    const parsed = JSON.parse(serializeScenarioBundle(channels, map, '2.1.9'));
    assert.deepStrictEqual(
      parsed.channels.map((c) => c.name),
      ['工商', '通用', '招商']
    );
  });

  test('空 scenarios — 渠道仍导出（合法空渠道）', () => {
    const channels = [{ id: 2, name: '工商', ownerLocation: '上海', isBuiltin: false }];
    const map = new Map([[2, []]]);
    const parsed = JSON.parse(serializeScenarioBundle(channels, map, '2.1.9'));
    assert.strictEqual(parsed.channels.length, 1);
    assert.deepStrictEqual(parsed.channels[0].scenarios, []);
  });

  test('scenarios 入参 sortOrder 缺失时 fallback 到 priority', () => {
    const channels = [{ id: 2, name: '工商', ownerLocation: '上海', isBuiltin: false }];
    const map = { 2: [{ category: 'extract-recon-id', name: 's1', priority: 3, enabled: 1, config: {} }] };
    const parsed = JSON.parse(serializeScenarioBundle(channels, map, '2.1.9'));
    assert.strictEqual(parsed.channels[0].scenarios[0].sortOrder, 3);
  });

  test('configJson 字符串入参 — 解析为对象后再写入 bundle（不嵌入 escaped 字符串）', () => {
    const channels = [{ id: 2, name: '工商', ownerLocation: '上海', isBuiltin: false }];
    const cfgString = JSON.stringify({ foo: 'bar', n: 42 });
    const map = new Map([[2, [{ category: 'extract-recon-id', name: 's1', priority: 0, enabled: 1, configJson: cfgString }]]]);
    const parsed = JSON.parse(serializeScenarioBundle(channels, map, '2.1.9'));
    assert.deepStrictEqual(parsed.channels[0].scenarios[0].configJson, { foo: 'bar', n: 42 });
  });

  test('enabled 字段归一化（boolean / 0 / 1 都接受）', () => {
    const channels = [{ id: 2, name: '工商', ownerLocation: '上海', isBuiltin: false }];
    const map = new Map([[2, [
      { category: 'extract-recon-id', name: 's1', priority: 0, enabled: true, config: {} },
      { category: 'extract-recon-id', name: 's2', priority: 0, enabled: false, config: {} },
      { category: 'extract-recon-id', name: 's3', priority: 0, enabled: 1, config: {} },
      { category: 'extract-recon-id', name: 's4', priority: 0, enabled: 0, config: {} }
    ]]]);
    const parsed = JSON.parse(serializeScenarioBundle(channels, map, '2.1.9'));
    assert.deepStrictEqual(
      parsed.channels[0].scenarios.map((s) => s.enabled),
      [1, 0, 1, 0]
    );
  });

  test('channels 非数组 — 抛错', () => {
    assert.throws(() => serializeScenarioBundle('not-array', {}, '2.1.9'), /channels 必须是数组/);
  });

  test('scenariosByChannel 非对象 — 抛错', () => {
    assert.throws(() => serializeScenarioBundle([], null, '2.1.9'), /scenariosByChannel 必须是/);
  });

  test('scenario 缺 config / configJson — 抛错', () => {
    const channels = [{ id: 2, name: '工商', ownerLocation: '上海', isBuiltin: false }];
    const map = new Map([[2, [{ category: 'extract-recon-id', name: 's1', priority: 0, enabled: 1 }]]]);
    assert.throws(() => serializeScenarioBundle(channels, map, '2.1.9'), /缺少 config/);
  });

  test('isBuiltin 转 1/0', () => {
    const channels = [{ id: 1, name: '通用', ownerLocation: '通用', isBuiltin: 1 }];
    const map = new Map([[1, []]]);
    const parsed = JSON.parse(serializeScenarioBundle(channels, map, '2.1.9'));
    assert.strictEqual(parsed.channels[0].isBuiltin, 1);

    const channels2 = [{ id: 2, name: '工商', ownerLocation: '上海', isBuiltin: 0 }];
    const map2 = new Map([[2, []]]);
    const parsed2 = JSON.parse(serializeScenarioBundle(channels2, map2, '2.1.9'));
    assert.strictEqual(parsed2.channels[0].isBuiltin, 0);
  });
});

// ============================================================================
// parseScenarioBundle
// ============================================================================

test.describe('parseScenarioBundle', () => {
  test('合法 bundle — 解析成功', () => {
    const text = JSON.stringify({
      scenarioBundleVersion: 1,
      exportedAt: '2026-05-27T10:00:00.000Z',
      appVersion: '2.1.9',
      channels: [
        {
          name: '工商',
          ownerLocation: '上海',
          isBuiltin: 0,
          scenarios: [
            { category: 'extract-recon-id', name: 's1', sortOrder: 1, enabled: 1, configJson: { x: 1 } }
          ]
        }
      ]
    });
    const bundle = parseScenarioBundle(text);
    assert.strictEqual(bundle.scenarioBundleVersion, 1);
    assert.strictEqual(bundle.appVersion, '2.1.9');
    assert.strictEqual(bundle.channels.length, 1);
    assert.strictEqual(bundle.channels[0].name, '工商');
    assert.strictEqual(bundle.channels[0].scenarios.length, 1);
    assert.strictEqual(bundle.channels[0].scenarios[0].category, 'extract-recon-id');
    assert.deepStrictEqual(bundle.channels[0].scenarios[0].configJson, { x: 1 });
  });

  test('空字符串 — 抛错', () => {
    assert.throws(() => parseScenarioBundle(''), /必须是非空字符串/);
  });

  test('非字符串 — 抛错', () => {
    assert.throws(() => parseScenarioBundle(null), /必须是非空字符串/);
  });

  test('损坏 JSON — 抛错（含友好前缀）', () => {
    assert.throws(() => parseScenarioBundle('not-json{'), /场景模板文件格式错误/);
  });

  test('数组顶层 — 抛错', () => {
    assert.throws(() => parseScenarioBundle('[]'), /根节点必须是对象/);
  });

  test('缺 scenarioBundleVersion — 抛错', () => {
    assert.throws(
      () => parseScenarioBundle(JSON.stringify({ exportedAt: '...', channels: [] })),
      /缺少 scenarioBundleVersion/
    );
  });

  test('版本号 > SUPPORTED — 抛错（提示升级应用）', () => {
    assert.throws(
      () => parseScenarioBundle(JSON.stringify({
        scenarioBundleVersion: SUPPORTED_SCENARIO_BUNDLE_VERSION + 1,
        channels: []
      })),
      /高于当前应用支持的版本/
    );
  });

  test('版本号 < 1 — 抛错（不合法版本）', () => {
    assert.throws(
      () => parseScenarioBundle(JSON.stringify({ scenarioBundleVersion: 0, channels: [] })),
      /版本号非法/
    );
  });

  test('版本号 NaN — 抛错', () => {
    assert.throws(
      () => parseScenarioBundle(JSON.stringify({ scenarioBundleVersion: 'abc', channels: [] })),
      /版本号非法/
    );
  });

  test('channels 缺失 — 返空数组（兼容）', () => {
    const bundle = parseScenarioBundle(JSON.stringify({ scenarioBundleVersion: 1 }));
    assert.deepStrictEqual(bundle.channels, []);
  });

  test('channel name 空 — 抛错', () => {
    assert.throws(
      () => parseScenarioBundle(JSON.stringify({
        scenarioBundleVersion: 1,
        channels: [{ name: '', ownerLocation: '上海' }]
      })),
      /渠道 name \/ ownerLocation 不能为空/
    );
  });

  test('scenario category 空 — 抛错', () => {
    assert.throws(
      () => parseScenarioBundle(JSON.stringify({
        scenarioBundleVersion: 1,
        channels: [{
          name: '工商',
          ownerLocation: '上海',
          scenarios: [{ category: '', name: 's1' }]
        }]
      })),
      /category \/ name 不能为空/
    );
  });
});

// ============================================================================
// detectBundleType
// ============================================================================

test.describe('detectBundleType', () => {
  test('含 scenarioBundleVersion → scenarios', () => {
    assert.strictEqual(
      detectBundleType({ scenarioBundleVersion: 1, channels: [] }),
      'scenarios'
    );
  });

  test('含 bundleVersion → template', () => {
    assert.strictEqual(
      detectBundleType({ bundleVersion: 4, templates: [] }),
      'template'
    );
  });

  test('都没有 → 抛错', () => {
    assert.throws(
      () => detectBundleType({ exportedAt: '2026-05-27' }),
      /既无 scenarioBundleVersion 也无 bundleVersion/
    );
  });

  test('同时含两者 → 抛错（拒绝歧义）', () => {
    assert.throws(
      () => detectBundleType({ scenarioBundleVersion: 1, bundleVersion: 4 }),
      /同时含 scenarioBundleVersion 和 bundleVersion/
    );
  });

  test('非对象入参 — 抛错', () => {
    assert.throws(() => detectBundleType(null), /入参必须是对象/);
    assert.throws(() => detectBundleType('str'), /入参必须是对象/);
    assert.throws(() => detectBundleType([]), /入参必须是对象/);
  });
});

// ============================================================================
// 往返一致性 — serialize + parse
// ============================================================================

test.describe('serialize + parse 往返一致', () => {
  test('单渠道单场景往返 — 字段一致', () => {
    const channels = [
      { id: 1, name: '通用', ownerLocation: '通用', isBuiltin: true },
      { id: 2, name: '工商', ownerLocation: '上海', isBuiltin: false }
    ];
    const map = new Map([
      [1, [{ category: 'extract-recon-id', name: '通用s1', priority: 0, enabled: 1, config: { a: 1 } }]],
      [2, [
        { category: 'gateway-recon-join', name: '工商s1', priority: 2, enabled: 1, config: { b: 2 } },
        { category: 'extract-recon-id', name: '工商s2', priority: 1, enabled: 0, config: { c: 3 } }
      ]]
    ]);
    const jsonText = serializeScenarioBundle(channels, map, '2.1.9');
    const bundle = parseScenarioBundle(jsonText);
    assert.strictEqual(bundle.scenarioBundleVersion, SUPPORTED_SCENARIO_BUNDLE_VERSION);
    assert.strictEqual(bundle.channels.length, 2);
    assert.strictEqual(bundle.channels[0].name, '通用');
    assert.strictEqual(bundle.channels[0].isBuiltin, 1);
    assert.strictEqual(bundle.channels[1].scenarios.length, 2);
    assert.strictEqual(bundle.channels[1].scenarios[0].name, '工商s1');
    assert.strictEqual(bundle.channels[1].scenarios[1].enabled, 0);
    assert.deepStrictEqual(bundle.channels[1].scenarios[0].configJson, { b: 2 });
  });

  test('detectBundleType 验证 serialize 输出为 scenarios 类型', () => {
    const channels = [{ id: 1, name: '通用', ownerLocation: '通用', isBuiltin: true }];
    const jsonText = serializeScenarioBundle(channels, new Map([[1, []]]), '2.1.9');
    const parsed = JSON.parse(jsonText);
    assert.strictEqual(detectBundleType(parsed), 'scenarios');
  });
});
