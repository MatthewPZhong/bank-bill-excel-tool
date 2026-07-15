'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const runDataStore = require('../src/backend/run-data-store');
const {
  createPreFundReconciliationStore
} = require('../src/backend/pre-fund-reconciliation-store');
const {
  SOURCE_TYPE_INBOUND
} = require('../src/main-process/pre-fund-reconciliation/mpt-schema');

const MONTH_COUNT = Number.parseInt(process.env.DUPLICATE_INBOUND_BENCH_MONTHS || '6', 10);
const ROWS_PER_MONTH = Number.parseInt(
  process.env.DUPLICATE_INBOUND_BENCH_ROWS_PER_MONTH || '25000',
  10
);
const LOOKUPS_PER_MONTH = Number.parseInt(
  process.env.DUPLICATE_INBOUND_BENCH_LOOKUPS_PER_MONTH || '1000',
  10
);

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} 必须为正整数`);
}

function monthKeyAt(index) {
  const absoluteMonth = (2025 * 12) + index;
  const year = Math.floor(absoluteMonth / 12);
  const month = (absoluteMonth % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function insertMonth(userDataDir, monthIndex, criteria) {
  const monthKey = monthKeyAt(monthIndex);
  const compactDate = `${monthKey.replace('-', '')}01`;
  const sourceBatch = `MPT_INBOUND_${compactDate}`;
  const sourceFileName = `MPT_INBOUND_GATEWAY_${compactDate}001.txt`;
  const db = runDataStore.openSideDb(
    userDataDir,
    runDataStore.MODULE_PRE_FUND_RECONCILIATION,
    monthKey
  );
  try {
    db.exec('BEGIN IMMEDIATE');
    const batch = db.prepare(`
      INSERT INTO pre_fund_reconciliation_gateway_batches (
        source_type, source_batch, source_date, source_file_name, source_file_sequence,
        content_hash, declared_row_count, row_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      SOURCE_TYPE_INBOUND,
      sourceBatch,
      `${monthKey}-01`,
      sourceFileName,
      '001',
      `hash-${monthIndex}`,
      ROWS_PER_MONTH,
      ROWS_PER_MONTH
    );
    const batchId = Number(batch.lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO pre_fund_reconciliation_gateway_rows (
        batch_id, source_type, source_batch, source_date, source_file_name, source_file_sequence,
        source_row_number, reconciliation_id, gateway_date, channel, merchant_id, order_id,
        bill_recon_id, recon_bill_biz_id, currency, amount, trade_type, name, card_no,
        real_channel, clearing_network, raw_json, fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let rowIndex = 0; rowIndex < ROWS_PER_MONTH; rowIndex += 1) {
      const isTarget = rowIndex < LOOKUPS_PER_MONTH;
      const reconciliationId = isTarget
        ? `TARGET-${monthIndex}-${rowIndex}`
        : `NOISE-${monthIndex}-${rowIndex}`;
      if (isTarget) {
        criteria.push({
          lookupId: `BANK-${monthIndex}-${rowIndex}`,
          channel: 'CIT',
          merchantId: 'M-1',
          reconciliationId
        });
      }
      insert.run(
        batchId,
        SOURCE_TYPE_INBOUND,
        sourceBatch,
        `${monthKey}-01`,
        sourceFileName,
        '001',
        rowIndex + 2,
        reconciliationId,
        `${monthKey}-01`,
        'CIT',
        'M-1',
        `ORDER-${monthIndex}-${rowIndex}`,
        `BILL-${monthIndex}-${rowIndex}`,
        '',
        'USD',
        '100',
        'Inbound-VA',
        'NAME',
        'CARD',
        'CIT',
        'SWIFT',
        JSON.stringify({ business: 'BUSINESS', clientId: 'CLIENT', accId: 'ACCOUNT' }),
        `fingerprint-${monthIndex}-${rowIndex}`
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* 当前无活动事务时忽略 */ }
    throw error;
  } finally {
    db.close();
  }
}

function formatMiB(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function main() {
  assertPositiveInteger(MONTH_COUNT, '月份数');
  assertPositiveInteger(ROWS_PER_MONTH, '每月 MPT 行数');
  assertPositiveInteger(LOOKUPS_PER_MONTH, '每月查询键数');
  if (LOOKUPS_PER_MONTH > ROWS_PER_MONTH) {
    throw new TypeError('每月查询键数不能大于每月 MPT 行数');
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-benchmark-'));
  const criteria = [];
  try {
    const buildStartedAt = performance.now();
    for (let monthIndex = 0; monthIndex < MONTH_COUNT; monthIndex += 1) {
      insertMonth(userDataDir, monthIndex, criteria);
    }
    const fixtureMs = performance.now() - buildStartedAt;
    const store = createPreFundReconciliationStore(userDataDir);
    const memoryBefore = process.memoryUsage();
    const queryStartedAt = performance.now();
    const result = store.lookupInboundRows(criteria);
    const queryMs = performance.now() - queryStartedAt;
    const memoryAfter = process.memoryUsage();

    assert.equal(result.size, criteria.length);
    for (const criterion of criteria) {
      const collection = result.get(criterion.lookupId);
      assert.equal(collection.candidateCount, 1, `${criterion.lookupId} 应唯一命中`);
      assert.equal(collection.candidates.length, 1, `${criterion.lookupId} 应保留唯一候选`);
      assert.equal(collection.candidates[0].reconciliationId, criterion.reconciliationId);
    }

    console.log('==== 重复入金 MPT 批量查询基准 ====');
    console.log(`月份数：${MONTH_COUNT}`);
    console.log(`MPT 总行数：${MONTH_COUNT * ROWS_PER_MONTH}`);
    console.log(`银行查询键：${criteria.length}`);
    console.log(`fixture 构造：${fixtureMs.toFixed(1)} ms`);
    console.log(`批量查询：${queryMs.toFixed(1)} ms`);
    console.log(`RSS：${formatMiB(memoryBefore.rss)} -> ${formatMiB(memoryAfter.rss)} MiB`);
    console.log(`heapUsed：${formatMiB(memoryBefore.heapUsed)} -> ${formatMiB(memoryAfter.heapUsed)} MiB`);
    console.log('结果：全部查询键唯一命中，按月份各一次批量 SELECT');
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main();
