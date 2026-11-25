'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { canonicalSha256 } = require('../../../src/main-process/background-execution/canonical-json-v1');
const {
  createAccountMappingSignature,
  createFundReconEvidenceProvider,
  openReadSnapshot
} = require('../../../src/main-process/fund-recon-worker/evidence-provider');

test('openReadSnapshot固定query_only事务且禁止写入', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-recon-evidence-'));
  const databasePath = path.join(tempDir, 'tool-data.sqlite');
  const writable = new DatabaseSync(databasePath);
  writable.exec('CREATE TABLE evidence_probe (id INTEGER PRIMARY KEY, value TEXT);');
  writable.prepare('INSERT INTO evidence_probe(value) VALUES (?)').run('before');
  writable.close();

  const snapshot = openReadSnapshot(databasePath);
  try {
    assert.equal(Number(snapshot.db.prepare('PRAGMA query_only').get().query_only), 1);
    assert.equal(snapshot.db.prepare('SELECT COUNT(*) AS count FROM evidence_probe').get().count, 1);
    assert.throws(
      () => snapshot.db.prepare('INSERT INTO evidence_probe(value) VALUES (?)').run('after'),
      /readonly|read-only|not authorized/i
    );
  } finally {
    snapshot.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function providerHarness({
  scenarios = [],
  metaRef = { value: { version: 1 } },
  mappingRef = { value: new Map() },
  reconRowsRef = { value: [{ ReconciliationId: 'MID-1' }] },
  blankChannelRows = [],
  blankChannelCalls = [],
  idReadCalls = []
} = {}) {
  let closeCount = 0;
  const snapshotDb = {};
  const linkedRepo = {
    readMetaSnapshot() {
      return {
        'gateway-bill': null,
        'bank-deposit': null,
        'mid-allocation': metaRef.value
      };
    },
    readGatewayBillRowPoolsByChannels(_db, channels, options) {
      const pools = { exactRows: [{ Channel: 'JPM' }], c3Rows: [{ Channel: 'jpm' }] };
      if (!options || !options.outOfPoolDiagnostic) return pools;
      blankChannelCalls.push({ channels, ...options.outOfPoolDiagnostic });
      blankChannelRows.forEach((row, index) => options.outOfPoolDiagnostic.collect(row, index + 1));
      return pools;
    },
    readGatewayBillRowsByIds(db, ids, onRow) {
      idReadCalls.push({ db, ids: Array.from(ids) });
      for (const id of ids) {
        if (blankChannelRows[id - 1]) onRow(blankChannelRows[id - 1], id);
      }
    },
    readLinkedTableRows() {
      return [{ ReconciliationId: 'DEP-1' }];
    },
    readFundTransferReconRows() {
      return reconRowsRef.value;
    }
  };
  const provider = createFundReconEvidenceProvider({
    openSnapshot() {
      return { db: snapshotDb, close() { closeCount += 1; } };
    },
    linkedTableRepository: linkedRepo,
    scenariosRepository: { listDetailedScenarios: () => scenarios },
    channelsRepository: {},
    fundTransferAccountMappingRepository: { getMappingMap: () => mappingRef.value }
  });
  return { provider, getCloseCount: () => closeCount };
}

test('snapshot签名覆盖场景、meta与派生行，且每次读取都关闭事务', () => {
  const metaRef = { value: { version: 1 } };
  const { provider, getCloseCount } = providerHarness({ metaRef });
  const first = provider.openRunSnapshot({
    databasePath: '/tmp/fake.sqlite',
    bankRows: [{ Channel: 'JPM' }]
  });
  assert.deepEqual(first.gatewayPools.exactRows, [{ Channel: 'JPM' }]);
  const firstSignature = first.evidenceSignature;
  first.close();

  metaRef.value = { version: 2 };
  const secondSignature = provider.readCurrentSignature({
    databasePath: '/tmp/fake.sqlite',
    bankRows: [{ Channel: 'JPM' }]
  });
  assert.notEqual(secondSignature, firstSignature);
  assert.equal(getCloseCount(), 2);
});

test('启用调拨消费方时缺失或过期派生证据均fail closed', () => {
  const scenario = {
    id: 7,
    name: '调拨回填功能管理',
    enabled: 1,
    isBuiltin: true,
    category: 'builtin-fixed',
    config: {
      funcCategory: 'platform-order',
      subCategory: 'fund-transfer-backfill',
      reconSourceMid: true,
      dateMatchEnabled: true,
      dateToleranceDays: 1
    }
  };
  const metaRef = { value: { version: 4, rowCount: 2 } };
  const { provider, getCloseCount } = providerHarness({ scenarios: [scenario], metaRef });
  assert.throws(
    () => provider.openRunSnapshot({ databasePath: '/tmp/fake.sqlite', bankRows: [] }),
    (error) => error.code === 'FUND_RECON_DERIVATION_NOT_PREPARED'
  );
  assert.throws(
    () => provider.openRunSnapshot({
      databasePath: '/tmp/fake.sqlite',
      bankRows: [],
      derivationEvidence: {
        prepared: true,
        signature: 'a'.repeat(64),
        sourceSignature: 'b'.repeat(64)
      }
    }),
    (error) => error.code === 'FUND_RECON_DERIVATION_SOURCE_STALE'
  );

  const snapshot = provider.openRunSnapshot({
    databasePath: '/tmp/fake.sqlite',
    bankRows: [],
    derivationEvidence: {
      prepared: true,
      signature: 'a'.repeat(64),
      sourceSignature: canonicalSha256(metaRef.value),
      accountMappingSignature: createAccountMappingSignature(new Map())
    }
  });
  assert.equal(snapshot.reconRows.length, 1);
  snapshot.close();
  assert.equal(getCloseCount(), 3, '成功和两条失败路径都必须关闭 snapshot');
});

test('v3.2.22：派生证据须绑定派生时的账户映射，映射在派生后变化则拒绝', () => {
  const scenario = {
    id: 7,
    name: '调拨回填功能管理',
    enabled: 1,
    isBuiltin: true,
    category: 'builtin-fixed',
    config: {
      funcCategory: 'platform-order',
      subCategory: 'fund-transfer-backfill',
      reconSourceMid: true,
      dateMatchEnabled: true,
      dateToleranceDays: 1
    }
  };
  const metaRef = { value: { version: 4, rowCount: 2 } };
  const mappingRef = { value: new Map([['GW-ACC-1', 'CLR-ACC-1']]) };
  const { provider, getCloseCount } = providerHarness({ scenarios: [scenario], metaRef, mappingRef });
  const evidence = (mapping) => ({
    prepared: true,
    signature: 'a'.repeat(64),
    sourceSignature: canonicalSha256(metaRef.value),
    accountMappingSignature: createAccountMappingSignature(mapping)
  });

  const derivedWith = new Map([['GW-ACC-1', 'CLR-ACC-1']]);
  const ok = provider.openRunSnapshot({ databasePath: '/tmp/fake.sqlite', bankRows: [], derivationEvidence: evidence(derivedWith) });
  assert.equal(ok.accountMappingMap.get('GW-ACC-1'), 'CLR-ACC-1');
  ok.close();

  // 派生后映射被改：快照读到新映射，与派生证据不一致 → 拒绝
  mappingRef.value = new Map([['GW-ACC-1', 'CLR-ACC-2']]);
  assert.throws(
    () => provider.openRunSnapshot({ databasePath: '/tmp/fake.sqlite', bankRows: [], derivationEvidence: evidence(derivedWith) }),
    (error) => error.code === 'FUND_RECON_DERIVATION_ACCOUNT_MAPPING_STALE'
  );
  // 缺摘要（旧证据）同样拒绝
  assert.throws(
    () => provider.openRunSnapshot({
      databasePath: '/tmp/fake.sqlite',
      bankRows: [],
      derivationEvidence: { ...evidence(derivedWith), accountMappingSignature: undefined }
    }),
    (error) => error.code === 'FUND_RECON_DERIVATION_ACCOUNT_MAPPING_STALE'
  );
  assert.equal(getCloseCount(), 3, '成功与失败路径都关闭 snapshot');
});

test('v3.2.22（🔴）worker 与主路径同口径逐行核对派生行：转义写法的行并入同一条告警，大账号与映射不一致则拒绝', () => {
  const { FT_RECON_FIELD_MAP } = require('../../../src/constants/fund-transfer-recon-fields');
  const R = FT_RECON_FIELD_MAP.recon;
  const scenario = {
    id: 7,
    name: '调拨回填功能管理',
    enabled: 1,
    isBuiltin: true,
    category: 'builtin-fixed',
    config: { funcCategory: 'platform-order', subCategory: 'fund-transfer-backfill', reconSourceMid: true, dateMatchEnabled: true, dateToleranceDays: 1 }
  };
  const metaRef = { value: { version: 4, rowCount: 2 } };
  const mapping = new Map([['GW-ACC-1', 'CLR-ACC-1']]);
  const mappingRef = { value: mapping };
  const reconRow = (fundType, account, bigAccount) => ({
    [R.fundType]: fundType,
    [fundType === FT_RECON_FIELD_MAP.FUND_TYPE_IN ? R.payeeAccount : R.payAccount]: account,
    [R.bigAccount]: bigAccount
  });
  const reconRowsRef = {
    value: [
      reconRow(FT_RECON_FIELD_MAP.FUND_TYPE_OUT, 'A_x0000_B', ''),
      reconRow(FT_RECON_FIELD_MAP.FUND_TYPE_IN, 'GW-ACC-1', 'CLR-ACC-1')
    ]
  };
  const { provider, getCloseCount } = providerHarness({ scenarios: [scenario], metaRef, mappingRef, reconRowsRef });
  const derivationEvidence = {
    prepared: true,
    signature: 'a'.repeat(64),
    sourceSignature: canonicalSha256(metaRef.value),
    accountMappingSignature: createAccountMappingSignature(mapping)
  };
  const snapshot = provider.openRunSnapshot({ databasePath: '/tmp/fake.sqlite', bankRows: [], derivationEvidence });
  const ambiguous = snapshot.initialWarnings.filter((w) => w.code === 'fund-transfer-recon-mapped-account-ambiguous');
  assert.equal(ambiguous.length, 1, '与主路径同一条结构化告警');
  assert.match(ambiguous[0].message, /有 1 行的账户号含 Excel 转义写法/);
  snapshot.close();

  reconRowsRef.value = [reconRow(FT_RECON_FIELD_MAP.FUND_TYPE_IN, 'GW-ACC-1', 'GW-ACC-1')];
  assert.throws(
    () => provider.openRunSnapshot({ databasePath: '/tmp/fake.sqlite', bankRows: [], derivationEvidence }),
    (error) => error.code === 'FUND_RECON_DERIVATION_ACCOUNT_MAPPING_STALE' && error.details && error.details.staleCount === 1
  );
  assert.equal(getCloseCount(), 2, '成功与失败路径都关闭 snapshot');
});

function gatewaySourceOwnerScenario() {
  return {
    id: 7,
    name: '调拨回填功能管理',
    enabled: 1,
    isBuiltin: true,
    category: 'builtin-fixed',
    config: {
      funcCategory: 'platform-order',
      subCategory: 'fund-transfer-backfill',
      reconSourceMid: false,
      dateMatchEnabled: true,
      dateToleranceDays: 1
    }
  };
}

test('v3.2.22：没有映射消费方时不读取账户映射（读表失败不影响与映射无关的对账）', () => {
  const throwingMapping = { get value() { throw new Error('mapping table unavailable'); } };
  const { provider } = providerHarness({ mappingRef: throwingMapping });
  const snapshot = provider.openRunSnapshot({ databasePath: '/tmp/fake.sqlite', bankRows: [] });
  assert.equal(snapshot.flags.r5s2GatewaySourceEnabled, false);
  assert.equal(snapshot.accountMappingMap.size, 0);
  snapshot.close();

  const { provider: gatewayProvider } = providerHarness({ scenarios: [gatewaySourceOwnerScenario()], mappingRef: throwingMapping });
  assert.throws(
    () => gatewayProvider.openRunSnapshot({ databasePath: '/tmp/fake.sqlite', bankRows: [] }),
    /mapping table unavailable/,
    '网关来源开启时读映射失败必须中止'
  );
});

test('v3.2.22：账户映射进入快照并参与签名（映射变化使已跑结果失效）', () => {
  const mappingRef = { value: new Map([['GW-ACC-1', 'CLR-ACC-1']]) };
  const { provider } = providerHarness({ scenarios: [gatewaySourceOwnerScenario()], mappingRef });
  const first = provider.openRunSnapshot({ databasePath: '/tmp/fake.sqlite', bankRows: [] });
  assert.equal(first.accountMappingMap.get('GW-ACC-1'), 'CLR-ACC-1', '快照透传映射供 R5s2 网关来源使用');
  const firstSignature = first.evidenceSignature;
  first.close();

  assert.equal(
    provider.readCurrentSignature({ databasePath: '/tmp/fake.sqlite', bankRows: [] }),
    firstSignature,
    '映射未变 → 签名稳定'
  );

  mappingRef.value = new Map([['GW-ACC-1', 'CLR-ACC-2']]);
  assert.notEqual(
    provider.readCurrentSignature({ databasePath: '/tmp/fake.sqlite', bankRows: [] }),
    firstSignature,
    '映射值变化 → 签名变化'
  );

  mappingRef.value = new Map();
  assert.notEqual(
    provider.readCurrentSignature({ databasePath: '/tmp/fake.sqlite', bankRows: [] }),
    firstSignature,
    '清空映射 → 签名变化'
  );
});

test('v3.2.22：网关来源与主路径同口径，在读池的同一次扫描暂存池外诊断候选，R5 运行时在同一快照按 id 回读，不并入网关可写池', () => {
  const blankChannelRows = [
    { TradeType: 'FundTransfer-in', merchantid: 'GW-ACC-1', currency: 'USD', amount: 100, reconciliationid: 'GW-BLANK', Channel: '' },
    { TradeType: 'FundTransfer-in', merchantid: 'UNRELATED', currency: 'USD', amount: 100, reconciliationid: 'GW-OTHER', Channel: '' }
  ];
  const bankRowsAtR5 = [{ FundType: 'FundTransfer-in', MerchantId: 'CLR-ACC-1', Currency: 'USD', 'Credit Amount': 100, 'Debit Amount': 0, Channel: 'JPM' }];
  const mappingRef = { value: new Map([['GW-ACC-1', 'CLR-ACC-1']]) };
  const calls = [];
  const idReadCalls = [];
  const { provider } = providerHarness({
    scenarios: [gatewaySourceOwnerScenario()],
    mappingRef,
    blankChannelRows,
    blankChannelCalls: calls,
    idReadCalls
  });
  const snapshot = provider.openRunSnapshot({ databasePath: '/tmp/fake.sqlite', bankRows: [{ Channel: 'JPM' }] });
  assert.equal(calls.length, 1, '打开快照时随读池一并暂存，R5 运行时不再扫网关表');
  assert.equal(idReadCalls.length, 0, '打开快照时不回读');
  assert.deepEqual(calls[0].channels, ['JPM'], '按读池用的渠道取补集');
  assert.deepEqual(calls[0].tradeTypes.slice().sort(), ['FundTransfer-in', 'FundTransfer-out']);
  assert.deepEqual(calls[0].accounts.slice().sort(), ['CLR-ACC-1', 'GW-ACC-1'], '按本轮映射键值粗筛');
  assert.deepEqual(
    snapshot.r5ChannelMissingDiagnosticSource({ bankRows: bankRowsAtR5 }).map((row) => row.reconciliationid),
    ['GW-BLANK']
  );
  assert.equal(calls.length, 1);
  assert.equal(idReadCalls.length, 1);
  assert.strictEqual(idReadCalls[0].db, snapshot.db, '在同一只读快照事务内回读');
  assert.deepEqual(idReadCalls[0].ids, [1], '账号不在映射内的行不暂存、不回读');
  assert.deepEqual(snapshot.gatewayPools, { exactRows: [{ Channel: 'JPM' }], c3Rows: [{ Channel: 'jpm' }] }, '可写池不含诊断行');
  snapshot.close();

  const { provider: midProvider } = providerHarness({ mappingRef, blankChannelRows, blankChannelCalls: calls });
  const midSnapshot = midProvider.openRunSnapshot({ databasePath: '/tmp/fake.sqlite', bankRows: [{ Channel: 'JPM' }] });
  assert.equal(midSnapshot.r5ChannelMissingDiagnosticSource, null, '网关来源未启用时不提供读取器');
  midSnapshot.close();
});
