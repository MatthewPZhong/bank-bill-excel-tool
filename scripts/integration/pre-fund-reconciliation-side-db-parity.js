// 前置资金对账「临时 MPT 网关账单 → per-month side DB」集成测试
//   覆盖：流式 txt/gz 导入、跨实例持久化、hash 幂等、文件冲突、批次新序号原子替换、
//         旧序号拒绝、失败回滚、稳定迭代、单批删除/全部清空、主库链接表零影响。
//
// 用法：node scripts/integration/pre-fund-reconciliation-side-db-parity.js

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const runDataStore = require('../../src/backend/run-data-store');
const { PreFundReconciliationStore } = require('../../src/backend/pre-fund-reconciliation-store');
const {
  createPreFundReconciliationRunStore
} = require('../../src/backend/pre-fund-reconciliation-run-store');
const {
  iterateDuplicateAuditRows
} = require('../../src/main-process/pre-fund-reconciliation/output-mapper');
const {
  writeChannelWorkbooks
} = require('../../src/main-process/pre-fund-reconciliation/excel-writer');
const {
  readReconIdFixFile
} = require('../../src/main-process/recon-id-fix-io');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER,
  OUTBOUND_FIELDS,
  SOURCE_TYPE_INBOUND,
  SOURCE_TYPE_OUTBOUND,
} = require('../../src/main-process/pre-fund-reconciliation/mpt-schema');

let passed = 0;
let failed = 0;
const failures = [];

function assertTrue(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ label, detail });
}

function assertEq(actual, expected, label) {
  assertTrue(Object.is(actual, expected), label, `expected=${expected} actual=${actual}`);
}

function valuesFor(fields, overrides) {
  return fields.map((field) => Object.prototype.hasOwnProperty.call(overrides, field) ? overrides[field] : '');
}

function inboundRow(overrides = {}) {
  return valuesFor(INBOUND_FIELDS, {
    batchNo: 'MPT_INBOUND_20260708', billDate: '2026-07-08', channel: 'CITI', merchantId: 'M1',
    tradeType: 'Inbound-VA', orderId: 'OI-1', reconId: 'RI-1', billReconId: 'BI-1',
    currency: 'USD', originAmount: '10.00', fee: '0', amount: '10.00', payerName: 'PAYER',
    payerAccount: 'CARD-I', valueDate: '2026-07-08', bookDate: '2026-07-08',
    created: '2026-07-08 01:02:03', tradeScope: 'INBOUND', ...overrides,
  });
}

function outboundRow(overrides = {}) {
  return valuesFor(OUTBOUND_FIELDS, {
    batchNo: 'MPT_OUTBOUND_20260707', billDate: '2026-07-07', tradeType: 'WITHDRAW',
    orderNo: 'OO-1', billReconId: 'BO-1', reconId: 'RO-1', name: 'PAYEE', cardNo: 'CARD-O',
    originCurrency: 'USD', targetCurrency: 'USD', originAmount: '8', fee: '0', originNetAmount: '8',
    targetAmount: '8', createTime: '2026-07-07 01:02:03', finishTime: '2026-07-07 01:03:04',
    channel: 'CITI', merchantId: 'M2', tradeScope: 'OUTBOUND', bankDebitCurrency: 'EUR',
    bankDebitAmount: '7.5', ...overrides,
  });
}

function rawObjectJsonOfLength(length, fill) {
  if (length === 2) return '{}';
  const marker = '中文"\\\n😀';
  const shellLength = JSON.stringify({ marker, payload: '' }).length;
  if (!Number.isSafeInteger(length) || length < shellLength) {
    throw new TypeError('集成测试原始 JSON 长度非法');
  }
  const rawJson = JSON.stringify({ marker, payload: String(fill).repeat(length - shellLength) });
  if (rawJson.length !== length) throw new Error(`原始 JSON 长度构造失败：${rawJson.length} !== ${length}`);
  return rawJson;
}

function writeFixture(root, fileName, header, rows) {
  const text = `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`;
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, fileName.endsWith('.gz')
    ? zlib.gzipSync(Buffer.from(text, 'utf8'))
    : text);
  return filePath;
}

async function expectErrorCode(action, code, label) {
  try {
    await action();
    assertTrue(false, label, `expected error code ${code}`);
  } catch (error) {
    assertEq(error.code, code, label);
  }
}

async function run() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-fund-side-db-integration-'));
  console.log('==== 前置资金对账临时 MPT side DB 集成验证 ====');
  try {
    const mainDbPath = path.join(tmpdir, 'tool-data.sqlite');
    const mainDb = new DatabaseSync(mainDbPath);
    mainDb.exec('CREATE TABLE linked_gateway_bill (id INTEGER PRIMARY KEY, raw_json TEXT NOT NULL)');
    mainDb.prepare('INSERT INTO linked_gateway_bill VALUES (1, ?)').run('{"keep":true}');
    mainDb.close();

    const store = new PreFundReconciliationStore(tmpdir, { writeBatchSize: 1 });
    const resultDb = runDataStore.openSideDb(
      tmpdir,
      runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
      '2026-07'
    );
    resultDb.prepare(`
      INSERT INTO pre_fund_reconciliation_runs
        (scenario, snapshot_json, bank_files_json, status, summary_json)
      VALUES ('missing-gateway', '{}', '[]', 'success', '{}')
    `).run();
    const resultStore = createPreFundReconciliationRunStore(tmpdir);
    const insertCandidate = resultStore.createGatewayCandidateInserter(resultDb, 1);
    const candidateBase = {
      reconciliationId: 'MATCH-1',
      sourceOrder: 0,
      name: '',
      cardNo: '',
      location: {},
      fields: { date: '2026-07-01', channel: 'CITI', amount: '10', currency: 'USD' },
      rawJson: '{"match":true}'
    };
    const matchCandidates = [
      { ...candidateBase, source: '临时网关对账单', sourcePriority: 0, fingerprint: 'wrong-channel', fields: { ...candidateBase.fields, channel: 'DBS' } },
      { ...candidateBase, source: '临时网关对账单', sourcePriority: 0, sourceOrder: 1, fingerprint: 'wrong-amount', fields: { ...candidateBase.fields, amount: '10.01' } },
      { ...candidateBase, source: '临时网关对账单', sourcePriority: 0, sourceOrder: 2, fingerprint: 'wrong-currency', fields: { ...candidateBase.fields, currency: 'EUR' } },
      { ...candidateBase, source: '网关对账单', sourcePriority: 1, sourceOrder: 3, fingerprint: 'exact' }
    ];
    assertTrue(matchCandidates.every((candidate) => insertCandidate(candidate)), '四字段匹配候选全部入池');
    const consumeCandidate = resultStore.createGatewayConsumer(resultDb, 1);
    const exact = consumeCandidate({
      reconciliationId: 'MATCH-1', channel: 'CITI', amount: '10', currency: 'USD'
    }, 0);
    assertEq(exact && exact.source, '网关对账单', 'SQL 跳过要素不符的临时候选并消费完整匹配候选');
    assertEq(exact && exact.fields.amount, '10', 'SQL 匹配金额使用规范十进制值');
    assertEq(consumeCandidate({
      reconciliationId: 'MATCH-1', channel: 'CITI', amount: '10', currency: 'USD'
    }, 1), null, '完整匹配候选只消费一次');
    assertEq(resultStore.gatewayStats(resultDb, 1).unusedCount, 3, '三条要素不符候选保持未消费');

    const auditRunId = resultStore.createRun(resultDb, {
      scenario: 'missing-gateway', snapshot: {}, bankFiles: ['bank.xlsx']
    });
    const keptRawBySourceRecordId = new Map();
    const auditInsert = resultStore.createGatewayCandidateInserter(resultDb, auditRunId, {
      resolveKeptRawJson: (candidate) => keptRawBySourceRecordId.get(candidate.location.sourceRecordId)
    });
    const expectedAuditRaw = new Map();
    const auditLengths = [2, 30000, 30001, 60000, 60001];
    for (let index = 0; index < auditLengths.length; index += 1) {
      const length = auditLengths[index];
      const keptRaw = rawObjectJsonOfLength(length, 'K');
      const foldedRaw = rawObjectJsonOfLength(length, 'F');
      const common = {
        sourcePriority: 1,
        source: '网关对账单',
        reconciliationId: `AUDIT-${index}`,
        fingerprint: `FP-${index}`,
        fields: {
          date: '2026-07-01', channel: 'AUDIT', merchantId: `M-${index}`,
          orderId: `O-${index}`, billReconId: `B-${index}`, currency: 'USD',
          amount: String(index + 1), tradeType: 'PAY', realChannel: 'AUDIT',
          clearingNetwork: 'SWIFT'
        },
        name: 'Kept', cardNo: 'K'
      };
      keptRawBySourceRecordId.set(index * 2 + 1, keptRaw);
      auditInsert({
        ...common,
        sourceOrder: index * 2,
        location: { sourceRecordId: index * 2 + 1, sourceRowNumber: index * 2 + 1 },
        rawJson: keptRaw
      });
      auditInsert({
        ...common,
        sourceOrder: index * 2 + 1,
        location: { sourceRecordId: index * 2 + 2, sourceRowNumber: index * 2 + 2 },
        rawJson: foldedRaw
      });
      expectedAuditRaw.set(
        `保留记录|网关对账单|linked_gateway_bill#${index * 2 + 1}`,
        keptRaw
      );
      expectedAuditRaw.set(
        `被折叠记录|网关对账单|linked_gateway_bill#${index * 2 + 2}`,
        foldedRaw
      );
      if (index === 0) {
        const extraRowNumber = 1000;
        const extraFoldedRaw = rawObjectJsonOfLength(30001, 'X');
        auditInsert({
          ...common,
          sourceOrder: auditLengths.length * 2,
          location: { sourceRecordId: extraRowNumber, sourceRowNumber: extraRowNumber },
          rawJson: extraFoldedRaw
        });
        expectedAuditRaw.set(
          `被折叠记录|网关对账单|linked_gateway_bill#${extraRowNumber}`,
          extraFoldedRaw
        );
      }
    }
    const auditSummary = resultStore.summarizeChannels(resultDb, auditRunId);
    assertEq(auditSummary.length, 1, '重复专属渠道进入渠道并集');
    assertEq(auditSummary[0].channel, 'AUDIT', '重复专属渠道名称正确');
    resultStore.finishRun(resultDb, auditRunId, {
      gatewayCollapsedDuplicateRows: auditLengths.length + 1,
      duplicateGroupCount: auditLengths.length,
      channelCount: 1
    });
    resultDb.close();

    const auditOutputDir = path.join(tmpdir, 'audit-exports');
    const auditFiles = await writeChannelWorkbooks({
      templatePath: path.resolve(__dirname, '../../assets/资金对账导出不平.xlsx'),
      outputDirectory: auditOutputDir,
      exportDate: new Date(2026, 6, 10, 12, 0, 0),
      channelExports: (function* channelExports() {
        for (const channelExport of resultStore.iterateChannelExports('2026-07', auditRunId)) {
          yield {
            ...channelExport,
            duplicateRows: iterateDuplicateAuditRows(channelExport.duplicateRecords)
          };
        }
      }())
    });
    assertEq(auditFiles.length, 1, '重复专属渠道只导出一个文件');
    const auditWorkbook = XLSX.readFile(auditFiles[0].filePath, { raw: false });
    assertEq(auditWorkbook.SheetNames.length, 6, '重复专属渠道动态导出6-sheet');
    assertEq(auditWorkbook.SheetNames[5], '重复网关账单', '重复审计 sheet 位于末尾');
    const auditRows = XLSX.utils.sheet_to_json(auditWorkbook.Sheets['重复网关账单'], { defval: '' });
    const reconstructed = new Map();
    for (const row of auditRows) {
      const key = [
        row['对象类型'],
        row['数据来源'],
        row['数据位置']
      ].join('|');
      const current = reconstructed.get(key) || [];
      current[Number(row['分片序号']) - 1] = row['原始数据JSON分片'];
      reconstructed.set(key, current);
    }
    for (const [key, expectedRaw] of expectedAuditRaw.entries()) {
      const actualRaw = (reconstructed.get(key) || []).join('');
      assertTrue(
        actualRaw === expectedRaw,
        `长 JSON 无损重组 ${key}`,
        `expectedLength=${expectedRaw.length} actualLength=${actualRaw.length} `
          + `expectedPrefix=${JSON.stringify(expectedRaw.slice(0, 48))} `
          + `actualPrefix=${JSON.stringify(actualRaw.slice(0, 48))}`
      );
    }
    const firstGroupRows = auditRows.filter((row) => [
      'linked_gateway_bill#1',
      'linked_gateway_bill#2',
      'linked_gateway_bill#1000'
    ].includes(row['数据位置']));
    assertEq(new Set(firstGroupRows.map((row) => row['折叠记录ID'])).size, 1, '同组1+N共用折叠记录ID');
    assertEq(
      new Set(firstGroupRows
        .filter((row) => row['对象类型'] === '被折叠记录')
        .map((row) => row['数据位置'])).size,
      2,
      '同一折叠组1+N被折叠对象按数据位置独立重组'
    );
    const c4Read = readReconIdFixFile(auditFiles[0].filePath, 'gateway');
    assertEq(c4Read.sheets.reconResult.length, 0, 'C4 接受6-sheet且不消费重复审计行');
    assertEq(c4Read.sheets.businessBills.length, 0, 'C4 网关候选不混入重复审计行');
    const inboundV1 = writeFixture(
      tmpdir,
      'MPT_INBOUND_GATEWAY_20260708_100.txt',
      ['20260708', 'MPT_INBOUND_20260708', '2'],
      [inboundRow({ reconId: 'I-1' }), inboundRow({ reconId: 'I-2', orderId: 'OI-2' })]
    );
    const outbound = writeFixture(
      tmpdir,
      'MPT_OUTBOUND_GATEWAY_20260707101.gz',
      ['MPT_OUTBOUND_20260707', '1', '20260707'],
      [outboundRow({ reconId: 'O-1' })]
    );

    assertEq((await store.importFile(inboundV1)).status, 'imported', 'INBOUND txt 导入');
    assertEq((await store.importFile(outbound)).status, 'imported', 'OUTBOUND gz 导入');
    assertTrue(runDataStore.sideDbExists(tmpdir, runDataStore.MODULE_PRE_FUND_RECONCILIATION, '2026-07'), '月侧库已创建');
    assertEq(store.listBatches().length, 2, '不同 sourceType+sourceBatch 追加');
    assertEq([...store.iterateRows()].length, 3, '规范行全部持久化');
    assertEq([...store.iterateRows({ reconciliationId: 'O-1' })][0].amount, '7.5', 'OUTBOUND bankDebit 金额落库');
    assertEq([...store.iterateRows({ reconciliationId: 'O-1' })][0].currency, 'EUR', 'OUTBOUND bankDebit 币种成对落库');

    const reopened = new PreFundReconciliationStore(tmpdir);
    assertEq(reopened.listBatches().length, 2, '跨实例/重启仍可查询');
    const order1 = [...reopened.iterateRows()].map((row) => row.reconciliationId).join(',');
    const order2 = [...reopened.iterateRows()].map((row) => row.reconciliationId).join(',');
    assertEq(order1, order2, '稳定迭代顺序');
    assertEq((await reopened.importFile(inboundV1)).status, 'noop', '同文件同 hash no-op');

    writeFixture(
      tmpdir,
      path.basename(inboundV1),
      ['20260708', 'MPT_INBOUND_20260708', '1'],
      [inboundRow({ reconId: 'CONFLICT' })]
    );
    await expectErrorCode(
      () => reopened.importFile(inboundV1),
      'MPT_FILE_IDENTITY_CONFLICT',
      '同文件名不同 hash 拒绝'
    );
    assertTrue([...reopened.iterateRows()].some((row) => row.reconciliationId === 'I-1'), '文件冲突后旧行保留');

    const inboundV2 = writeFixture(
      tmpdir,
      'MPT_INBOUND_GATEWAY_20260708_102.txt',
      ['20260708', 'MPT_INBOUND_20260708', '1'],
      [inboundRow({ reconId: 'I-NEW' })]
    );
    assertEq((await reopened.importFile(inboundV2)).status, 'replaced', '同批次更高序号原子替换');
    assertTrue(![...reopened.iterateRows()].some((row) => row.reconciliationId === 'I-1'), '替换后旧批次行消失');
    assertTrue([...reopened.iterateRows()].some((row) => row.reconciliationId === 'I-NEW'), '替换后新批次行存在');

    const stale = writeFixture(
      tmpdir,
      'MPT_INBOUND_GATEWAY_20260708_099.txt',
      ['20260708', 'MPT_INBOUND_20260708', '1'],
      [inboundRow({ reconId: 'STALE' })]
    );
    await expectErrorCode(
      () => reopened.importFile(stale),
      'MPT_BATCH_SEQUENCE_STALE',
      '同批次旧序号拒绝'
    );

    const broken = writeFixture(
      tmpdir,
      'MPT_INBOUND_GATEWAY_20260708_103.txt',
      ['20260708', 'MPT_INBOUND_20260708', '2'],
      [inboundRow({ reconId: 'PARTIAL' }), inboundRow({ reconId: 'BROKEN', amount: 'bad' })]
    );
    await expectErrorCode(
      () => reopened.importFile(broken),
      'MPT_DECIMAL_INVALID',
      '替换文件中途失败'
    );
    assertEq([...reopened.iterateRows({ sourceBatch: 'MPT_INBOUND_20260708' })][0].reconciliationId, 'I-NEW', '失败后旧批次完整恢复');

    const rangeCount = reopened.countByDateRange('2026-07-07', '2026-07-08', {
      sourceType: SOURCE_TYPE_INBOUND
    });
    assertEq(rangeCount.batchCount, 1, '日期范围预统计批次数');
    assertEq(rangeCount.rowCount, 1, '日期范围预统计行数');
    const outboundRangeCount = reopened.countByDateRange('2026-07-07', '2026-07-08', {
      sourceType: SOURCE_TYPE_OUTBOUND
    });
    assertEq(outboundRangeCount.batchCount, 1, 'OUTBOUND 逻辑表独立预统计');
    const deleted = await reopened.deleteByDateRange('2026-07-07', '2026-07-08', {
      sourceType: SOURCE_TYPE_INBOUND
    });
    assertEq(deleted.deletedBatches, 1, '按 sourceType+sourceDate 闭区间删除批次');
    assertEq(deleted.deletedRows, 1, '按 sourceType+sourceDate 闭区间删除行数');
    assertEq(deleted.deletedFiles, 0, '另一逻辑表有数据时不回收共享月库');
    assertEq(reopened.listBatches().length, 1, '另一 sourceType 批次保留');
    assertEq(reopened.listBatches()[0].sourceType, SOURCE_TYPE_OUTBOUND, 'INBOUND 删除不影响 OUTBOUND');

    assertEq((await reopened.importFile(inboundV2)).status, 'imported', '反向删除前恢复 INBOUND 批次');
    const reverseDeleted = await reopened.deleteByDateRange('2026-07-07', '2026-07-08', {
      sourceType: SOURCE_TYPE_OUTBOUND
    });
    assertEq(reverseDeleted.deletedBatches, 1, '反向按 sourceType 删除 OUTBOUND 批次');
    assertEq(reverseDeleted.deletedFiles, 0, 'INBOUND 仍有数据时反向删除不回收共享月库');
    assertEq(reopened.listBatches().length, 1, '反向删除后 INBOUND 批次保留');
    assertEq(reopened.listBatches()[0].sourceType, SOURCE_TYPE_INBOUND, 'OUTBOUND 删除不影响 INBOUND');

    const cleared = await reopened.clearAll();
    assertEq(cleared.deletedBatches, 1, '全部清空批次计数');
    assertEq(reopened.listBatches().length, 0, '全部清空后为 0');
    assertEq(runDataStore.listSideDbFiles(tmpdir, runDataStore.MODULE_PRE_FUND_RECONCILIATION).length, 0, '清临时批次后回收临时月库文件');
    const preservedResultDb = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
      tmpdir,
      runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
      '2026-07'
    ));
    try {
      assertEq(preservedResultDb.prepare('SELECT COUNT(*) AS count FROM pre_fund_reconciliation_runs').get().count, 2, '清临时批次不影响独立结果侧库');
    } finally {
      preservedResultDb.close();
    }

    const mainCheck = new DatabaseSync(mainDbPath, { readOnly: true });
    try {
      const linked = mainCheck.prepare('SELECT * FROM linked_gateway_bill').all();
      assertEq(linked.length, 1, '主库 linked_gateway_bill 行数不变');
      assertEq(linked[0].raw_json, '{"keep":true}', '主库 linked_gateway_bill 内容不变');
    } finally {
      mainCheck.close();
    }
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    for (const failure of failures) console.error(`  - ${failure.label}: ${failure.detail}`);
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
