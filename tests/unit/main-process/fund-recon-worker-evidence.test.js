'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { canonicalSha256 } = require('../../../src/main-process/background-execution/canonical-json-v1');
const {
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

function providerHarness({ scenarios = [], metaRef = { value: { version: 1 } } } = {}) {
  let closeCount = 0;
  const linkedRepo = {
    readMetaSnapshot() {
      return {
        'gateway-bill': null,
        'bank-deposit': null,
        'mid-allocation': metaRef.value
      };
    },
    readGatewayBillRowPoolsByChannels() {
      return { exactRows: [{ Channel: 'JPM' }], c3Rows: [{ Channel: 'jpm' }] };
    },
    readLinkedTableRows() {
      return [{ ReconciliationId: 'DEP-1' }];
    },
    readFundTransferReconRows() {
      return [{ ReconciliationId: 'MID-1' }];
    }
  };
  const provider = createFundReconEvidenceProvider({
    openSnapshot() {
      return { db: {}, close() { closeCount += 1; } };
    },
    linkedTableRepository: linkedRepo,
    scenariosRepository: { listDetailedScenarios: () => scenarios },
    channelsRepository: {}
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
      sourceSignature: canonicalSha256(metaRef.value)
    }
  });
  assert.equal(snapshot.reconRows.length, 1);
  snapshot.close();
  assert.equal(getCloseCount(), 3, '成功和两条失败路径都必须关闭 snapshot');
});
