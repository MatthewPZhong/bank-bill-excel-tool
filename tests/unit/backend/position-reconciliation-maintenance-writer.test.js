'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  POSITION_IMPORT_COMMANDS
} = require('../../../src/backend/position-reconciliation-import/constants');
const {
  runPositionMaintenanceJob
} = require('../../../src/backend/position-reconciliation-import/maintenance-writer');
const {
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/constants');
const {
  stableHash
} = require('../../../src/main-process/position-reconciliation/common');
const {
  ensurePositionLargeImportSchemaAtPath
} = require('../../../src/main-process/position-reconciliation/large-import-schema');
const {
  createPositionReconciliationStore,
  serializeJson
} = require('../../../src/main-process/position-reconciliation/store');

function createModernSideDb(t, prefix) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const checkpoint = {
    identity: `${prefix}-identity`,
    generation: 0,
    token: `${prefix}-token`
  };
  const store = createPositionReconciliationStore(userDataDir, {
    initialCheckpoint: checkpoint
  });
  const sideDbPath = store.dbPath;
  store.close();
  ensurePositionLargeImportSchemaAtPath({
    sideDbPath,
    expectedCheckpoint: checkpoint,
    availableBytesProvider: () => 10n ** 15n
  });
  return { checkpoint, sideDbPath };
}

function sourcePayload(sourceType, overrides = {}) {
  return {
    ...Object.fromEntries(
      SOURCE_DEFINITIONS[sourceType].headers.map((header) => [header, ''])
    ),
    ...overrides
  };
}

function insertSource(db, {
  sourceType,
  businessKey,
  monthKey,
  row,
  rowNumber
}) {
  const rowHash = stableHash(row);
  const result = db.prepare(`
    INSERT INTO position_source_rows(
      source_type, business_key, event_date, month_key,
      source_file_path, source_file_name, source_sheet, source_row_number,
      row_hash, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'Sheet1', ?, ?, ?)
  `).run(
    sourceType,
    businessKey,
    `${monthKey}-01`,
    monthKey,
    `/tmp/${businessKey}.xlsx`,
    `${businessKey}.xlsx`,
    rowNumber,
    rowHash,
    serializeJson(row)
  );
  return { id: Number(result.lastInsertRowid), rowHash };
}

function insertLink(db, source, {
  sourceType,
  businessKey,
  rowNumber,
  legIndex = 0
}) {
  db.prepare(`
    INSERT INTO position_link_rows(
      source_type, business_key, source_record_key, source_row_id,
      source_row_number, ordinal, leg_index, visible, linked_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, '{}')
  `).run(
    sourceType,
    businessKey,
    source.rowHash,
    source.id,
    rowNumber,
    source.id,
    legIndex
  );
}

function insertBank(db, {
  bizId,
  channel,
  monthKey,
  order
}) {
  db.prepare(`
    INSERT INTO position_bank_rows(
      biz_id, channel, month_key, bill_date, status,
      source_file_path, source_file_name, source_sheet, source_row_number,
      import_order, original_fund_type, working_fund_type,
      original_json, working_json
    ) VALUES (?, ?, ?, ?, '未处理', '/tmp/bank.xlsx', 'bank.xlsx',
              '渠道对账单', ?, ?, 'Inbound', 'Inbound', '{}', '{}')
  `).run(bizId, channel, monthKey, `${monthKey}-01`, order + 1, order);
}

test('来源删除按月份分批执行并依赖 FK cascade 清理链接行', async (t) => {
  const { checkpoint, sideDbPath } = createModernSideDb(
    t,
    'position-maintenance-source-delete'
  );
  const db = new DatabaseSync(sideDbPath);
  const targetA = insertSource(db, {
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    businessKey: 'IN-A',
    monthKey: '2026-07',
    rowNumber: 2,
    row: sourcePayload(SOURCE_TYPES.GATEWAY_INBOUND, { bizId: 'IN-A' })
  });
  const targetB = insertSource(db, {
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    businessKey: 'IN-B',
    monthKey: '2026-07',
    rowNumber: 3,
    row: sourcePayload(SOURCE_TYPES.GATEWAY_INBOUND, { bizId: 'IN-B' })
  });
  const retained = insertSource(db, {
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    businessKey: 'IN-C',
    monthKey: '2026-08',
    rowNumber: 4,
    row: sourcePayload(SOURCE_TYPES.GATEWAY_INBOUND, { bizId: 'IN-C' })
  });
  insertLink(db, targetA, {
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    businessKey: 'IN-A',
    rowNumber: 2
  });
  insertLink(db, targetB, {
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    businessKey: 'IN-B',
    rowNumber: 3
  });
  insertLink(db, retained, {
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    businessKey: 'IN-C',
    rowNumber: 4
  });
  db.close();

  const result = await runPositionMaintenanceJob({
    command: POSITION_IMPORT_COMMANDS.DELETE_SOURCE,
    sideDbPath,
    expectedCheckpoint: checkpoint,
    operationToken: 'delete-source-operation',
    payload: {
      sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
      months: ['2026-07']
    },
    batchSize: 1
  });
  assert.equal(result.deletedCount, 2);
  assert.equal(result.nextCheckpoint.generation, 1);

  const verify = new DatabaseSync(sideDbPath, { readOnly: true });
  assert.deepEqual(
    verify.prepare(`
      SELECT business_key AS businessKey
      FROM position_source_rows
      ORDER BY id
    `).all().map((row) => ({ ...row })),
    [{ businessKey: 'IN-C' }]
  );
  assert.equal(
    verify.prepare('SELECT COUNT(*) AS count FROM position_link_rows').get().count,
    1
  );
  assert.equal(
    verify.prepare(`
      SELECT revision
      FROM position_revisions
      WHERE kind = 'source' AND scope_key = ?
    `).get(SOURCE_TYPES.GATEWAY_INBOUND).revision,
    1
  );
  assert.equal(
    verify.prepare(`
      SELECT revision
      FROM position_revisions
      WHERE kind = 'linked' AND scope_key = ?
    `).get(SOURCE_TYPES.GATEWAY_INBOUND).revision,
    1
  );
  verify.close();

  const empty = await runPositionMaintenanceJob({
    command: POSITION_IMPORT_COMMANDS.DELETE_SOURCE,
    sideDbPath,
    expectedCheckpoint: result.nextCheckpoint,
    operationToken: 'delete-source-empty-operation',
    payload: {
      sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
      months: ['2026-07']
    }
  });
  assert.equal(empty.deletedCount, 0);
  assert.equal(empty.nextCheckpoint.generation, 2);
});

test('银行删除只提交实际命中 scope，空选择结果不推进 checkpoint', async (t) => {
  const { checkpoint, sideDbPath } = createModernSideDb(
    t,
    'position-maintenance-bank-delete'
  );
  const db = new DatabaseSync(sideDbPath);
  insertBank(db, { bizId: 'DBS-JUL-1', channel: 'DBS', monthKey: '2026-07', order: 1 });
  insertBank(db, { bizId: 'DBS-JUL-2', channel: 'DBS', monthKey: '2026-07', order: 2 });
  insertBank(db, { bizId: 'DBS-AUG', channel: 'DBS', monthKey: '2026-08', order: 3 });
  insertBank(db, { bizId: 'CITI-JUL', channel: 'CITI', monthKey: '2026-07', order: 4 });
  db.close();

  const result = await runPositionMaintenanceJob({
    command: POSITION_IMPORT_COMMANDS.DELETE_BANK,
    sideDbPath,
    expectedCheckpoint: checkpoint,
    operationToken: 'delete-bank-operation',
    payload: { channels: ['DBS'], months: ['2026-07'] },
    batchSize: 1
  });
  assert.equal(result.deletedCount, 2);
  assert.deepEqual(result.scopes, [{ channel: 'DBS', monthKey: '2026-07' }]);

  const verify = new DatabaseSync(sideDbPath, { readOnly: true });
  assert.deepEqual(
    verify.prepare(`
      SELECT biz_id AS bizId
      FROM position_bank_rows
      ORDER BY id
    `).all().map((row) => ({ ...row })),
    [{ bizId: 'DBS-AUG' }, { bizId: 'CITI-JUL' }]
  );
  assert.equal(
    verify.prepare(`
      SELECT revision
      FROM position_revisions
      WHERE kind = 'bank' AND scope_key = ?
    `).get('DBS\u00002026-07').revision,
    1
  );
  verify.close();

  await assert.rejects(
    () => runPositionMaintenanceJob({
      command: POSITION_IMPORT_COMMANDS.DELETE_BANK,
      sideDbPath,
      expectedCheckpoint: result.nextCheckpoint,
      operationToken: 'delete-bank-empty-operation',
      payload: { channels: ['DBS'], months: ['2026-07'] }
    }),
    (error) => error && error.code === 'position-bank-delete-empty'
  );
  const afterFailure = new DatabaseSync(sideDbPath, { readOnly: true });
  assert.equal(
    afterFailure.prepare(`
      SELECT value
      FROM position_meta
      WHERE key = 'position_database_generation_v1'
    `).get().value,
    '1'
  );
  afterFailure.close();
});

test('FundTransfer 映射重建逐行派生 0/hidden/visible 双腿且取消整体回滚', async (t) => {
  const { checkpoint, sideDbPath } = createModernSideDb(
    t,
    'position-maintenance-mapping'
  );
  const db = new DatabaseSync(sideDbPath);
  const visible = insertSource(db, {
    sourceType: SOURCE_TYPES.FUND_TRANSFER,
    businessKey: 'FT-VISIBLE',
    monthKey: '2026-07',
    rowNumber: 2,
    row: sourcePayload(SOURCE_TYPES.FUND_TRANSFER, {
      调拨单号: 'FT-VISIBLE',
      调拨状态: '付款成功',
      渠道流水号: 'RECON-VISIBLE',
      交易时间: '2026-07-01',
      '付款账户（卡号）': 'MID-PAY',
      '收款账户（卡号）': 'MID-RECEIVE',
      付款金额: '100',
      付款币种: 'USD',
      收款金额: '90',
      收款币种: 'EUR'
    })
  });
  insertSource(db, {
    sourceType: SOURCE_TYPES.FUND_TRANSFER,
    businessKey: 'FT-HIDDEN',
    monthKey: '2026-07',
    rowNumber: 3,
    row: sourcePayload(SOURCE_TYPES.FUND_TRANSFER, {
      调拨单号: 'FT-HIDDEN',
      调拨状态: '付款成功',
      渠道流水号: 'RECON-HIDDEN',
      交易时间: '2026-07-02',
      '付款账户（卡号）': 'MID-PAY',
      '收款账户（卡号）': 'MID-RECEIVE',
      付款金额: '100',
      付款币种: 'USD',
      收款金额: '100',
      收款币种: 'USD'
    })
  });
  insertSource(db, {
    sourceType: SOURCE_TYPES.FUND_TRANSFER,
    businessKey: 'FT-ZERO',
    monthKey: '2026-07',
    rowNumber: 4,
    row: sourcePayload(SOURCE_TYPES.FUND_TRANSFER, {
      调拨单号: 'FT-ZERO',
      调拨状态: '处理中'
    })
  });
  db.prepare(`
    INSERT INTO position_account_mappings(mid_account_id, clearing_account_id)
    VALUES ('OLD', 'OLD-MAPPED')
  `).run();
  insertLink(db, visible, {
    sourceType: SOURCE_TYPES.FUND_TRANSFER,
    businessKey: 'FT-VISIBLE',
    rowNumber: 2
  });
  db.close();

  const result = await runPositionMaintenanceJob({
    command: POSITION_IMPORT_COMMANDS.REBUILD_FUND_TRANSFER_MAPPING,
    sideDbPath,
    expectedCheckpoint: checkpoint,
    operationToken: 'mapping-rebuild-operation',
    payload: {
      mappings: [
        { midAccountId: 'MID-PAY', clearingAccountId: 'CLEAR-PAY' },
        { midAccountId: 'MID-RECEIVE', clearingAccountId: 'CLEAR-RECEIVE' }
      ]
    },
    batchSize: 1
  });
  assert.equal(result.count, 2);
  assert.equal(result.sourceRowCount, 3);
  assert.equal(result.linkedRowCount, 4);
  assert.equal(result.visibleLinkedRowCount, 2);

  const verify = new DatabaseSync(sideDbPath, { readOnly: true });
  assert.deepEqual(
    verify.prepare(`
      SELECT mid_account_id AS midAccountId,
             clearing_account_id AS clearingAccountId
      FROM position_account_mappings
      ORDER BY rowid
    `).all().map((row) => ({ ...row })),
    [
      { midAccountId: 'MID-PAY', clearingAccountId: 'CLEAR-PAY' },
      { midAccountId: 'MID-RECEIVE', clearingAccountId: 'CLEAR-RECEIVE' }
    ]
  );
  assert.deepEqual(
    verify.prepare(`
      SELECT business_key AS businessKey, leg_index AS legIndex,
             merchant_id AS merchantId, visible
      FROM position_link_rows
      ORDER BY source_row_id, leg_index, id
    `).all().map((row) => ({ ...row })),
    [
      {
        businessKey: 'FT-VISIBLE',
        legIndex: 0,
        merchantId: 'CLEAR-PAY',
        visible: 1
      },
      {
        businessKey: 'FT-VISIBLE',
        legIndex: 1,
        merchantId: 'CLEAR-RECEIVE',
        visible: 1
      },
      {
        businessKey: 'FT-HIDDEN',
        legIndex: 0,
        merchantId: 'CLEAR-PAY',
        visible: 0
      },
      {
        businessKey: 'FT-HIDDEN',
        legIndex: 1,
        merchantId: 'CLEAR-RECEIVE',
        visible: 0
      }
    ]
  );
  assert.equal(
    verify.prepare(`
      SELECT COUNT(*) AS count
      FROM position_revisions
      WHERE kind = 'source' AND scope_key = ?
    `).get(SOURCE_TYPES.FUND_TRANSFER).count,
    0
  );
  verify.close();

  const cancelToken = { cancelled: false };
  await assert.rejects(
    () => runPositionMaintenanceJob({
      command: POSITION_IMPORT_COMMANDS.REBUILD_FUND_TRANSFER_MAPPING,
      sideDbPath,
      expectedCheckpoint: result.nextCheckpoint,
      operationToken: 'mapping-cancel-operation',
      payload: {
        mappings: [{ midAccountId: 'NEW', clearingAccountId: 'NEW-MAPPED' }]
      },
      cancelToken,
      batchSize: 1,
      onProgress: () => {
        cancelToken.cancelled = true;
      }
    }),
    (error) => error && error.code === 'position-import-cancelled'
  );
  const afterCancel = new DatabaseSync(sideDbPath, { readOnly: true });
  assert.equal(
    afterCancel.prepare(`
      SELECT COUNT(*) AS count
      FROM position_account_mappings
      WHERE mid_account_id = 'MID-PAY'
    `).get().count,
    1
  );
  assert.equal(
    afterCancel.prepare(`
      SELECT value
      FROM position_meta
      WHERE key = 'position_database_generation_v1'
    `).get().value,
    '1'
  );
  afterCancel.close();
});
