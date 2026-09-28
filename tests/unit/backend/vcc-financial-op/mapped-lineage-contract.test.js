'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const baseline = require('./fixtures/lineage-contract-baseline.json');
const { SOURCE_TYPES } = require('../../../../src/backend/vcc-financial-op/definitions');
const mapper = require('../../../../src/backend/vcc-financial-op/row-mapper');
const hashContract = require('../../../../src/backend/vcc-financial-op/content-hash-contract');
const { assertMappedLineage, mappedContentHashForStoredVersion } = require('../../../../src/backend/vcc-financial-op/mapped-lineage-contract');
const writer = require('../../../../src/main-process/vcc-financial-op-dataset-writer');

for (const fixture of baseline.fixtures) {
  test(`固定旧实现 fixture：${fixture.name}`, () => {
    const mapped = mapper.mapDetailRow(fixture.input);
    assert.equal(mapped.disposition, null);
    assert.equal(mapped.contentHash, fixture.mapped.contentHash);
    assert.deepEqual(mapped.values, fixture.mapped.values);
    assert.equal(mapped.idempotencyKey, fixture.mapped.idempotencyKey);
    assert.equal(assertMappedLineage(fixture.expected, mapped), undefined);
    assert.equal(mappedContentHashForStoredVersion(fixture.expected, mapped), fixture.expected.content_hash);
  });
}

for (const fixture of baseline.rawContracts) {
  test(`Pending raw v${fixture.version} 保持字段顺序、文本和固定 hash`, () => {
    const canonical = mapper.pendingCanonicalValues(fixture.values, String(fixture.version));
    assert.deepEqual(canonical, fixture.canonical);
    assert.notEqual(canonical, fixture.values);
    assert.equal(mapper.pendingContentHash(fixture.values, fixture.version), fixture.hash);
    const expected = { ...baseline.fixtures.find(f => f.expected.source_type === SOURCE_TYPES.PENDING).expected,
      hash_version: 2, content_hash: fixture.hash };
    const mapped = { ...baseline.fixtures.find(f => f.expected.source_type === SOURCE_TYPES.PENDING).mapped,
      values: fixture.values, rawContractVersion: fixture.version };
    assert.equal(assertMappedLineage(expected, mapped), undefined);
  });
}

test('CHANNEL 主体按原 trim/null/数值规则参与 hash；其他类型忽略主体', () => {
  for (const fixture of baseline.channelSubjects) {
    assert.equal(mapper.contentHash(SOURCE_TYPES.CHANNEL, baseline.channelRaw, fixture.subject), fixture.hash);
  }
  assert.equal(mapper.contentHash(SOURCE_TYPES.RECHARGE, baseline.channelRaw, 'PPHK'),
    mapper.contentHash(SOURCE_TYPES.RECHARGE, baseline.channelRaw, 'PPSG'));
  assert.notEqual(baseline.channelSubjects[0].hash, baseline.channelSubjects[1].hash);
});

test('Pending 原始版本/字段数无效保持完整错误文案', () => {
  for (const [values, version, message] of [
    [[], 1, 'Pending 原始契约 v1 字段数无效：0'],
    [[], 2, 'Pending 原始契约 v2 字段数无效：0'],
    [null, 'bad', 'Pending 原始契约 vunknown 字段数无效：0'],
    [baseline.rawContracts[0].values, 2, 'Pending 原始契约 v2 字段数无效：48'],
    [baseline.rawContracts[1].values, 1, 'Pending 原始契约 v1 字段数无效：46'],
    [baseline.rawContracts[1].values, 9, 'Pending 原始契约 v9 字段数无效：46']
  ]) {
    assert.throws(() => mapper.pendingCanonicalValues(values, version), { message });
    assert.throws(() => mapper.pendingContentHash(values, version), { message });
  }
});

const mismatch = {
  code: 'archive-row-integrity-failure',
  message: '导入记录 17 原表第 2 行与当前有效数据的幂等键或内容哈希不一致'
};

test('disposition、幂等键和内容不一致均拒绝；未知版本保留独立错误', () => {
  for (const fixture of baseline.fixtures) {
    for (const change of [{ disposition: 'invalid' }, { idempotencyKey: 'other' }]) {
      assert.throws(() => assertMappedLineage(fixture.expected, { ...fixture.mapped, ...change }), mismatch);
    }
    assert.throws(() => assertMappedLineage({ ...fixture.expected, content_hash: 'invalid' }, fixture.mapped), mismatch);
    assert.throws(() => assertMappedLineage({ ...fixture.expected, hash_version: 99 }, fixture.mapped), {
      code: 'archive-row-integrity-failure',
      message: '导入记录 17 原表第 2 行使用未知内容哈希版本 99'
    });
  }
});

test('disposition 先于未知版本；未知版本和旧 Pending 原始结构错误先于键失配', () => {
  const fixture = baseline.fixtures.find(f => f.expected.source_type === SOURCE_TYPES.PENDING);
  const unknown = { ...fixture.expected, hash_version: 99 };
  assert.throws(() => assertMappedLineage(unknown, { ...fixture.mapped, disposition: 'invalid' }), mismatch);
  assert.throws(() => assertMappedLineage(unknown, { ...fixture.mapped, idempotencyKey: 'other' }), {
    code: 'archive-row-integrity-failure',
    message: '导入记录 17 原表第 2 行使用未知内容哈希版本 99'
  });
  const malformed = { ...fixture.mapped, values: [], idempotencyKey: 'other' };
  assert.throws(() => assertMappedLineage(fixture.expected, malformed), {
    message: 'Pending 原始契约 v2 字段数无效：0'
  });
  assert.throws(() => assertMappedLineage(fixture.expected, { ...malformed, disposition: 'invalid' }), mismatch);
});


test('兼容导出保持同一函数对象和版本常量，没有第二份实现', () => {
  for (const name of ['HASH_VERSION', 'PENDING_HASH_VERSION', 'contentHash', 'pendingCanonicalValues', 'pendingContentHash']) {
    assert.equal(mapper[name], hashContract[name], name);
  }
  assert.equal(hashContract.HASH_VERSION, 2);
  assert.equal(hashContract.PENDING_HASH_VERSION, 3);
  assert.equal(writer.assertMappedLineage, assertMappedLineage);
});

test('纯合同的冷加载闭包只允许 node:crypto 和两个合同及 definitions', () => {
  const root = path.resolve(__dirname, '../../../../src/backend/vcc-financial-op');
  const script = `
    const Module = require('node:module');
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const root = ${JSON.stringify(root)};
    const allowed = new Set(['node:crypto', ...['definitions', 'content-hash-contract', 'mapped-lineage-contract'].map(name => path.join(root, name + '.js'))]);
    const loaded = new Set();
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent);
      if (!allowed.has(resolved)) throw new Error('纯合同加载了禁止依赖：' + resolved);
      loaded.add(resolved);
      return original.call(this, request, parent, isMain);
    };
    const hash = require(root + '/content-hash-contract.js');
    const lineage = require(root + '/mapped-lineage-contract.js');
    assert.equal(typeof hash.contentHash('recharge_refund', '[]'), 'string');
    assert.equal(lineage.assertMappedLineage({ source_type: 'recharge_refund', hash_version: 2, idempotency_key: 'key', content_hash: 'hash' }, { idempotencyKey: 'key', contentHash: 'hash' }), undefined);
    assert.deepEqual([...loaded].sort(), [...allowed].sort());
    process.stdout.write('pure dependency closure PASS');
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, 'pure dependency closure PASS');
});

test('review plan 冷加载不再加载 dataset writer', () => {
  const planPath = require.resolve('../../../../src/backend/vcc-financial-op/review-export-plan');
  const writerPath = require.resolve('../../../../src/main-process/vcc-financial-op-dataset-writer');
  const script = `
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
      if (Module._resolveFilename(request, parent) === ${JSON.stringify(writerPath)}) throw new Error('review plan 仍加载 dataset writer');
      return original.call(this, request, parent, isMain);
    };
    require(${JSON.stringify(planPath)});
    process.stdout.write('review dependency direction PASS');
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, 'review dependency direction PASS');
});
