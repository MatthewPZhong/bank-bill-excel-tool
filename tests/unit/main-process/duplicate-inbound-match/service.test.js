'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');

const { BANK_STATEMENT_FIELDS } = require('../../../../src/constants/bank-statement-fields');
const { BILL_HEADERS } = require('../../../../src/backend/acquiring-bill-currency-db/columns');
const {
  ensureDuplicateInboundMatchRunMetadataSupport
} = require('../../../../src/backend/database/migrations');
const mirrorRepository = require('../../../../src/backend/database/duplicate-inbound-match-run-repository');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER,
  OUTBOUND_FIELDS,
  SOURCE_TYPE_INBOUND
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-schema');
const {
  createDuplicateInboundMatchService
} = require('../../../../src/main-process/duplicate-inbound-match/service');

const ROOT = path.resolve(__dirname, '../../../..');
const MAIL_TEMPLATE = path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx');
const BANK_TEMPLATE = path.join(ROOT, 'assets', '银行对账单.xlsx');

function bankRow(values = {}) {
  return BANK_STATEMENT_FIELDS.map((field) => values[field] ?? '');
}

function writeBankFile(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([BANK_STATEMENT_FIELDS.slice(), ...rows]),
    '渠道对账单'
  );
  XLSX.writeFile(workbook, filePath);
}

function documentRow(values = {}) {
  return BILL_HEADERS.map((field) => values[field] ?? '');
}

function writeDocumentFile(filePath, rows = []) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([BILL_HEADERS.slice(), ...rows]),
    '单据对账单'
  );
  XLSX.writeFile(workbook, filePath);
}

function matchingDocumentRows(overrides = {}) {
  return ['ORDER-1', 'ORDER-2'].map((orderId, index) => documentRow({
    '业务订单号': orderId,
    '用户编号': 'DOCUMENT-USER',
    '账户号': '000-DOCUMENT-ACCOUNT',
    '业务部门': 'OPP-BU',
    originBillBizId: `DOC-${index + 1}`,
    ...overrides
  }));
}

function duplicateGroup({ prefix, amount, channel = 'CIT', currency = 'USD', inboundCount = 2 }) {
  const common = {
    Channel: channel,
    MerchantId: 'M-1',
    Currency: currency,
    'Payee Name': `Payee-${prefix}`,
    'Payee CardNo': `P-${prefix}`,
    'Drawee Name': `Drawee-${prefix}`,
    'Drawee CardNo': `D-${prefix}`
  };
  const rows = [bankRow({
    ...common,
    BizId: `${prefix}-R`,
    BillDate: '2026-07-14',
    FundType: 'Reversal',
    'Debit Amount': amount
  })];
  for (let index = 1; index <= inboundCount; index += 1) {
    rows.push(bankRow({
      ...common,
      BizId: `${prefix}-I${index}`,
      FundType: 'Inbound',
      'Credit Amount': amount,
      ReconciliationId: `${prefix}-RECON-${index}`
    }));
  }
  return rows;
}

function inboundMptRow(overrides = {}) {
  const values = {
    batchNo: 'MPT_INBOUND_20260714',
    billDate: '2026-07-14',
    channel: 'CIT',
    merchantId: 'M-1',
    business: 'BUSINESS',
    oppBu: 'OPP-BU',
    tradeType: 'Inbound-VA',
    orderId: 'ORDER',
    reconId: 'SUCCESS-RECON-1',
    billReconId: 'BILL-RECON',
    clientId: 'CLIENT',
    accId: 'ACCOUNT',
    cardNo: 'CARD',
    currency: 'USD',
    originAmount: '100',
    fee: '0',
    amount: '100',
    payerName: 'PAYER',
    payerAccount: 'PAYER-CARD',
    valueDate: '2026-07-14',
    bookDate: '2026-07-14',
    created: '2026-07-14 01:02:03',
    tradeScope: 'INBOUND',
    businessDate: '2026-07-14',
    realChannel: 'CIT',
    clearingNetwork: 'SWIFT',
    batchSeq: '1',
    ...overrides
  };
  return INBOUND_FIELDS.map((field) => values[field] ?? '');
}

function writeMptFile(filePath, sourceDate, rows) {
  const sourceBatch = `MPT_INBOUND_${sourceDate}`;
  const header = [sourceDate, sourceBatch, String(rows.length)];
  fs.writeFileSync(
    filePath,
    `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
}

function outboundMptRow(overrides = {}) {
  const values = {
    batchNo: 'MPT_OUTBOUND_20260714',
    billDate: '2026-07-14',
    tradeType: 'WITHDRAW',
    orderNo: 'OUTBOUND-ORDER',
    billReconId: 'OUTBOUND-BILL-RECON',
    reconId: 'OUTBOUND-RECON',
    name: 'OUTBOUND-NAME',
    cardNo: 'OUTBOUND-CARD',
    originCurrency: 'USD',
    targetCurrency: 'USD',
    originAmount: '10',
    fee: '0',
    originNetAmount: '10',
    targetAmount: '10',
    createTime: '2026-07-14 01:02:03',
    finishTime: '2026-07-14 01:03:04',
    channel: 'CIT',
    merchantId: 'M-1',
    tradeScope: 'OUTBOUND',
    bankDebitCurrency: 'USD',
    bankDebitAmount: '10',
    businessDate: '2026-07-14',
    realChannel: 'CIT',
    clearingNetwork: 'SWIFT',
    batchSeq: '1',
    ...overrides
  };
  return OUTBOUND_FIELDS.map((field) => values[field] ?? '');
}

function writeOutboundMptFile(filePath, sourceDate, rows) {
  const sourceBatch = `MPT_OUTBOUND_${sourceDate}`;
  const header = [sourceDate, sourceBatch, String(rows.length)];
  fs.writeFileSync(
    filePath,
    `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
}

function createMirrorDatabase() {
  const db = new DatabaseSync(':memory:');
  ensureDuplicateInboundMatchRunMetadataSupport(db);
  return {
    db,
    facade: {
      createDuplicateInboundMatchRunMirror: (payload) => mirrorRepository.createRunMirror(db, payload),
      finishDuplicateInboundMatchRunMirror: (id, summary) => mirrorRepository.finishRunMirror(db, id, summary),
      failDuplicateInboundMatchRunMirror: (id, error) => mirrorRepository.failRunMirror(db, id, error),
      markDuplicateInboundMatchRunMirrorUnavailable: (id, status, message) => (
        mirrorRepository.markRunMirrorUnavailable(db, id, status, message)
      ),
      listDuplicateInboundMatchRunMirrors: () => mirrorRepository.listRunMirrors(db)
    }
  };
}

test.describe('DuplicateInboundMatchService', () => {
  let userDataDir;
  let bankFile;
  let documentFile;
  let mirror;
  let service;

  test.beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-service-'));
    bankFile = path.join(userDataDir, 'bank.xlsx');
    documentFile = path.join(userDataDir, 'document.xlsx');
    writeDocumentFile(documentFile, matchingDocumentRows());
    mirror = createMirrorDatabase();
    service = createDuplicateInboundMatchService({
      userDataDir,
      database: mirror.facade,
      mailTemplatePath: MAIL_TEMPLATE,
      bankTemplatePath: BANK_TEMPLATE,
      now: () => new Date(2026, 6, 14, 12, 0, 0)
    });
  });

  test.afterEach(() => {
    mirror.db.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('完整执行银行分组、MPT 回填、人工分流和双 sheet 导出', async () => {
    const pureInbound = bankRow({
      BizId: 'PURE-I', FundType: 'Inbound', 'Credit Amount': '300', Channel: 'CIT',
      MerchantId: 'M-1', Currency: 'USD', 'Payee Name': 'PURE', 'Payee CardNo': 'P-PURE',
      'Drawee Name': 'D-PURE', 'Drawee CardNo': 'D-PURE'
    });
    writeBankFile(bankFile, [
      ...duplicateGroup({ prefix: 'SUCCESS', amount: '100.00' }),
      ...duplicateGroup({ prefix: 'MANUAL', amount: '200', inboundCount: 1 }),
      pureInbound
    ]);
    const mptFile = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260714001.txt');
    writeMptFile(mptFile, '20260714', [
      inboundMptRow({
        reconId: 'SUCCESS-RECON-1', orderId: 'ORDER-1', batchSeq: '1',
        clientId: 'IGNORED-CLIENT-A', accId: 'IGNORED-ACCOUNT-A'
      }),
      inboundMptRow({
        reconId: 'SUCCESS-RECON-2', orderId: 'ORDER-2', batchSeq: '2',
        clientId: 'IGNORED-CLIENT-B', accId: 'IGNORED-ACCOUNT-B'
      })
    ]);
    await service.tempStore.importLegacyFile(mptFile);

    const imported = await service.importFiles([bankFile, documentFile]);
    assert.equal(imported.bank.rowCount, 6);
    assert.equal(imported.bank.reversalCount, 2);
    assert.equal(imported.bank.inboundCount, 4);
    assert.equal(imported.document.rowCount, 2);
    assert.equal(service.status().canRun, true);

    const result = await service.run();
    assert.equal(result.status, 'success');
    assert.equal(result.summary.finalSuccessGroupCount, 1);
    assert.equal(result.summary.mailRowCount, 1);
    assert.equal(result.summary.manualGroupCount, 1);
    assert.equal(result.summary.manualRowCount, 2);
    assert.equal(result.summary.bankGroupCount, 3);
    assert.equal(result.summary.pureInboundRowCount, 1);
    assert.deepEqual(result.summary.reversalConservation, {
      input: 2, success: 1, manual: 1, isBalanced: true
    });
    assert.equal(service.status().canExport, true);
    const persisted = service.store.readResult(service.lastRun.monthKey, service.lastRun.sideRunId);
    assert.equal(persisted.auditRows.length, 2);
    assert.equal(persisted.auditRows[0].disposition, 'success');
    assert.deepEqual(
      persisted.auditRows[0].bankLineage.map((row) => row.bizId),
      ['SUCCESS-R', 'SUCCESS-I1', 'SUCCESS-I2']
    );
    assert.deepEqual(
      persisted.auditRows[0].mptLineage.map((row) => row.candidateId),
      ['2026-07:1', '2026-07:2']
    );
    assert.deepEqual(
      persisted.auditRows[0].documentLineage.map((row) => row.excelRowNumber),
      [2, 3]
    );

    const outputPath = path.join(userDataDir, service.buildDefaultFileName());
    const exported = await service.export({ savePath: outputPath });
    assert.equal(exported.status, 'success');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
      '邮件模板', '匹配不成功需人工判定'
    ]);
    assert.equal(workbook.getWorksheet('邮件模板').getCell('F2').value, 'ORDER-1、ORDER-2');
    assert.equal(workbook.getWorksheet('邮件模板').getCell('E2').numFmt ?? 'General', 'General');
    assert.equal(workbook.getWorksheet('邮件模板').getCell('G2').value, 'OPP-BU');
    assert.equal(workbook.getWorksheet('邮件模板').getCell('H2').value, 'DOCUMENT-USER');
    assert.equal(workbook.getWorksheet('邮件模板').getCell('I2').value, '000-DOCUMENT-ACCOUNT');
    assert.equal(workbook.getWorksheet('邮件模板').getCell('H2').numFmt, '@');
    assert.equal(workbook.getWorksheet('邮件模板').getCell('I2').numFmt, '@');
    assert.equal(workbook.getWorksheet('邮件模板').getCell('J2').value, '重复入账后被Reverse');
    assert.match(
      String(workbook.getWorksheet('匹配不成功需人工判定').getCell('AU2').value),
      /1条 Inbound/
    );

    const mirrorRow = mirrorRepository.getRunMirror(mirror.db, result.runId);
    assert.equal(mirrorRow.status, 'success');
    assert.equal(mirrorRow.summary.mailRowCount, 1);
    assert.equal(mirrorRow.documentFileName, 'document.xlsx');
    const mainDbText = JSON.stringify(mirrorRow);
    assert.doesNotMatch(mainDbText, /Payee-SUCCESS|P-SUCCESS|Drawee-SUCCESS/);
  });

  test('单据订单零候选只把对应成功候选组转人工并保留审计血缘', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'DOCUMENT-MISSING', amount: '100' }));
    const mptFile = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260714001.txt');
    writeMptFile(mptFile, '20260714', [
      inboundMptRow({
        reconId: 'DOCUMENT-MISSING-RECON-1', orderId: 'ORDER-1', batchSeq: '1'
      }),
      inboundMptRow({
        reconId: 'DOCUMENT-MISSING-RECON-2', orderId: 'ORDER-NOT-FOUND', batchSeq: '2'
      })
    ]);
    await service.tempStore.importLegacyFile(mptFile);
    await service.importFiles([bankFile, documentFile]);

    const result = await service.run();
    assert.equal(result.summary.finalSuccessGroupCount, 0);
    assert.equal(result.summary.documentManualGroupCount, 1);
    assert.equal(result.summary.manualGroupCount, 1);
    assert.equal(result.summary.manualRowCount, 3);
    assert.equal(
      result.summary.reasonCounts['duplicate-inbound-document-candidate-count-zero'],
      1
    );
    assert.deepEqual(result.summary.reversalConservation, {
      input: 1, success: 0, manual: 1, isBalanced: true
    });
    assert.equal(service.status().canExport, true);

    const persisted = service.store.readResult(service.lastRun.monthKey, service.lastRun.sideRunId);
    assert.deepEqual(
      persisted.auditRows[0].documentLineage.map((lineage) => lineage.candidateCount),
      [1, 0]
    );
    assert.deepEqual(
      persisted.auditRows[0].mptLineage.map((lineage) => lineage.candidateCount),
      [1, 1]
    );
  });

  test('BizId 为空或 trim 后重复会拒绝导入并清空旧会话', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'OLD', amount: '10' }));
    await service.importFiles([bankFile, documentFile]);
    assert.equal(service.status().canRun, true);

    writeBankFile(bankFile, [
      bankRow({ BizId: ' SAME ', FundType: 'Inbound', 'Credit Amount': '1' }),
      bankRow({ BizId: 'SAME', FundType: 'Inbound', 'Credit Amount': '1' }),
      bankRow({ BizId: '', FundType: 'Reversal', 'Debit Amount': '1' })
    ]);
    await assert.rejects(
      () => service.importFiles([bankFile, documentFile]),
      (error) => error.code === 'duplicate-inbound-invalid-biz-id'
        && error.detailLines.length === 2
    );
    assert.equal(service.status().bank, null);
    assert.equal(service.status().document, null);
    assert.equal(service.status().canRun, false);
  });

  test('双文件落库后源文件读取失败会物理回收整个新会话', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'HASH-FAIL', amount: '10' }));
    const originalCreateImportBundle = service.store.createImportBundle.bind(service.store);
    service.store.createImportBundle = async (payload) => {
      const imported = await originalCreateImportBundle(payload);
      fs.rmSync(documentFile, { force: true });
      return imported;
    };

    await assert.rejects(
      () => service.importFiles([bankFile, documentFile]),
      (error) => error && error.code === 'ENOENT'
    );
    assert.equal(service.status().bank, null);
    assert.equal(service.status().document, null);
    assert.equal(service.status().canRun, false);
    assert.deepEqual(service.store.clearAll(), { deletedFiles: 0 });
  });

  test('银行解析前后 hash 不一致时拒绝绑定错误版本', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'HASH-RACE', amount: '10' }));
    const originalFileHasher = service.fileHasher;
    let bankHashCallCount = 0;
    service.fileHasher = async (filePath) => {
      if (filePath === bankFile) {
        bankHashCallCount += 1;
        return bankHashCallCount === 1 ? 'bank-version-a' : 'bank-version-b';
      }
      return originalFileHasher(filePath);
    };

    await assert.rejects(
      () => service.importFiles([bankFile, documentFile]),
      (error) => error && error.code === 'duplicate-inbound-input-changed-during-import'
    );
    assert.equal(bankHashCallCount, 2);
    assert.equal(service.status().canRun, false);
    assert.deepEqual(service.store.clearAll(), { deletedFiles: 0 });
  });

  test('双文件数量、类型和单据严格表头不符时整批拒绝', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'VALID', amount: '10' }));
    await assert.rejects(
      () => service.importFiles([bankFile]),
      (error) => error.code === 'duplicate-inbound-input-file-count'
    );

    const secondBankFile = path.join(userDataDir, 'second-bank.xlsx');
    writeBankFile(secondBankFile, duplicateGroup({ prefix: 'SECOND', amount: '20' }));
    await assert.rejects(
      () => service.importFiles([bankFile, secondBankFile]),
      (error) => error.code === 'duplicate-inbound-input-type-ambiguous'
    );

    const wrongHeaders = BILL_HEADERS.slice();
    [wrongHeaders[0], wrongHeaders[1]] = [wrongHeaders[1], wrongHeaders[0]];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([wrongHeaders, documentRow({ '业务订单号': 'ORDER-1' })]),
      '单据对账单'
    );
    XLSX.writeFile(workbook, documentFile);
    await assert.rejects(
      () => service.importFiles([documentFile, bankFile]),
      (error) => error.code === 'duplicate-inbound-document-header-mismatch'
    );

    const status = service.status();
    assert.equal(status.bank, null);
    assert.equal(status.document, null);
    assert.equal(status.canRun, false);
    assert.equal(status.canExport, false);
  });

  test('标准 .xls 银行对账单与 .xlsx 使用同一严格导入契约', async () => {
    const xlsFile = path.join(userDataDir, 'bank.xls');
    writeBankFile(xlsFile, duplicateGroup({ prefix: 'XLS', amount: '10' }));
    const imported = await service.importFiles([documentFile, xlsFile]);
    assert.equal(imported.bank.fileName, 'bank.xls');
    assert.equal(imported.bank.rowCount, 3);
    assert.equal(imported.bank.reversalCount, 1);
    assert.equal(imported.bank.inboundCount, 2);
    assert.equal(service.status().canRun, true);
  });

  test('新运行清理侧库失败时旧结果仍立即失效', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'SUCCESS', amount: '100' }));
    const mptFile = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260714001.txt');
    writeMptFile(mptFile, '20260714', [
      inboundMptRow({ reconId: 'SUCCESS-RECON-1', orderId: 'ORDER-1', batchSeq: '1' }),
      inboundMptRow({ reconId: 'SUCCESS-RECON-2', orderId: 'ORDER-2', batchSeq: '2' })
    ]);
    await service.tempStore.importLegacyFile(mptFile);
    await service.importFiles([bankFile, documentFile]);
    await service.run();
    assert.equal(service.status().canExport, true);

    service.store.clearRuns = () => { throw new Error('injected clearRuns failure'); };
    await assert.rejects(() => service.run(), /injected clearRuns failure/);
    const status = service.status();
    assert.equal(status.run, null);
    assert.equal(status.canExport, false);
    assert.equal(status.canRun, true);
  });

  test('新文件清理侧库失败时旧输入和结果仍立即失效', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'SUCCESS', amount: '100' }));
    const mptFile = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260714001.txt');
    writeMptFile(mptFile, '20260714', [
      inboundMptRow({ reconId: 'SUCCESS-RECON-1', orderId: 'ORDER-1', batchSeq: '1' }),
      inboundMptRow({ reconId: 'SUCCESS-RECON-2', orderId: 'ORDER-2', batchSeq: '2' })
    ]);
    await service.tempStore.importLegacyFile(mptFile);
    await service.importFiles([bankFile, documentFile]);
    await service.run();
    assert.equal(service.status().canExport, true);

    service.store.clearAll = () => { throw new Error('injected clearAll failure'); };
    await assert.rejects(() => service.importFiles([bankFile, documentFile]), /injected clearAll failure/);
    const status = service.status();
    assert.equal(status.bank, null);
    assert.equal(status.document, null);
    assert.equal(status.run, null);
    assert.equal(status.canRun, false);
    assert.equal(status.canExport, false);
  });

  test('新导入镜像失效失败时仍继续物理回收旧侧库', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'MIRROR-IMPORT', amount: '100' }));
    const mptFile = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260714001.txt');
    writeMptFile(mptFile, '20260714', [
      inboundMptRow({ reconId: 'MIRROR-IMPORT-RECON-1', orderId: 'ORDER-1', batchSeq: '1' }),
      inboundMptRow({ reconId: 'MIRROR-IMPORT-RECON-2', orderId: 'ORDER-2', batchSeq: '2' })
    ]);
    await service.tempStore.importLegacyFile(mptFile);
    await service.importFiles([bankFile, documentFile]);
    await service.run();

    const originalMarkUnavailable = service.database.markDuplicateInboundMatchRunMirrorUnavailable;
    let clearAllCalls = 0;
    const originalClearAll = service.store.clearAll.bind(service.store);
    service.database.markDuplicateInboundMatchRunMirrorUnavailable = () => {
      throw new Error('injected mirror invalidation failure');
    };
    service.store.clearAll = () => {
      clearAllCalls += 1;
      return originalClearAll();
    };
    try {
      await assert.rejects(
        () => service.importFiles([bankFile, documentFile]),
        /injected mirror invalidation failure/
      );
      assert.equal(clearAllCalls, 1);
      assert.deepEqual(originalClearAll(), { deletedFiles: 0 });
      assert.equal(service.status().canRun, false);
      assert.equal(service.status().canExport, false);
    } finally {
      service.database.markDuplicateInboundMatchRunMirrorUnavailable = originalMarkUnavailable;
      service.store.clearAll = originalClearAll;
    }
  });

  test('新运行镜像失效失败时仍继续删除旧侧库结果', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'MIRROR-RUN', amount: '100' }));
    const mptFile = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260714001.txt');
    writeMptFile(mptFile, '20260714', [
      inboundMptRow({ reconId: 'MIRROR-RUN-RECON-1', orderId: 'ORDER-1', batchSeq: '1' }),
      inboundMptRow({ reconId: 'MIRROR-RUN-RECON-2', orderId: 'ORDER-2', batchSeq: '2' })
    ]);
    await service.tempStore.importLegacyFile(mptFile);
    await service.importFiles([bankFile, documentFile]);
    const completed = await service.run();
    const oldSideRunId = service.lastRun.sideRunId;

    const originalMarkUnavailable = service.database.markDuplicateInboundMatchRunMirrorUnavailable;
    const originalClearRuns = service.store.clearRuns.bind(service.store);
    let clearRunsCalls = 0;
    service.database.markDuplicateInboundMatchRunMirrorUnavailable = () => false;
    service.store.clearRuns = (monthKey) => {
      clearRunsCalls += 1;
      return originalClearRuns(monthKey);
    };
    try {
      await assert.rejects(
        () => service.run(),
        /主库运行镜像失效写入失败/
      );
      assert.equal(clearRunsCalls, 1);
      assert.equal(service.store.getRun(service.bankSession.monthKey, oldSideRunId), null);
      assert.equal(service.status().canRun, true);
      assert.equal(service.status().canExport, false);
      assert.equal(mirrorRepository.getRunMirror(mirror.db, completed.runId).status, 'success');
    } finally {
      service.database.markDuplicateInboundMatchRunMirrorUnavailable = originalMarkUnavailable;
      service.store.clearRuns = originalClearRuns;
    }
  });

  test('运行硬错误在主库镜像中只保存脱敏 code', async () => {
    writeBankFile(bankFile, [bankRow({
      BizId: 'PRIVATE-BIZ-ID', FundType: 'Reversal', 'Debit Amount': 'not-an-amount',
      Channel: 'CIT', Currency: 'USD'
    })]);
    await service.importFiles([bankFile, documentFile]);
    await assert.rejects(
      () => service.run(),
      (error) => error.code === 'duplicate-inbound-invalid-amount'
        && /PRIVATE-BIZ-ID/.test(error.message)
    );
    const failedMirror = mirrorRepository.listRunMirrors(mirror.db).at(-1);
    assert.equal(failedMirror.status, 'failed');
    assert.match(failedMirror.errorMessage, /duplicate-inbound-invalid-amount/);
    assert.doesNotMatch(failedMirror.errorMessage, /PRIVATE-BIZ-ID|not-an-amount/);
  });

  test('MPT 批次变化后旧结果立即禁止导出', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'SUCCESS', amount: '100' }));
    const firstMpt = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260714001.txt');
    writeMptFile(firstMpt, '20260714', [
      inboundMptRow({ reconId: 'SUCCESS-RECON-1', orderId: 'ORDER-1', batchSeq: '1' }),
      inboundMptRow({ reconId: 'SUCCESS-RECON-2', orderId: 'ORDER-2', batchSeq: '2' })
    ]);
    await service.tempStore.importLegacyFile(firstMpt);
    await service.importFiles([bankFile, documentFile]);
    await service.run();
    assert.equal(service.status().canExport, true);

    const outboundMpt = path.join(userDataDir, 'MPT_OUTBOUND_GATEWAY_20260714001.txt');
    writeOutboundMptFile(outboundMpt, '20260714', [outboundMptRow()]);
    await service.tempStore.importLegacyFile(outboundMpt);
    assert.equal(service.status().run.stale, false);
    assert.equal(service.status().canExport, true);

    const secondMpt = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260715001.txt');
    writeMptFile(secondMpt, '20260715', [
      inboundMptRow({
        batchNo: 'MPT_INBOUND_20260715', billDate: '2026-07-15', businessDate: '2026-07-15',
        valueDate: '2026-07-15', bookDate: '2026-07-15', created: '2026-07-15 01:00:00',
        reconId: 'UNRELATED', batchSeq: '1'
      })
    ]);
    await service.tempStore.importLegacyFile(secondMpt);
    const status = service.status();
    assert.equal(status.run.stale, true);
    assert.equal(status.canExport, false);
    await assert.rejects(
      () => service.export({ savePath: path.join(userDataDir, 'stale.xlsx') }),
      (error) => error.code === 'duplicate-inbound-run-stale'
    );
  });

  test('侧库 run 记录缺失或损坏时禁止导出并同步主库镜像失效', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'SIDE-RUN', amount: '100' }));
    const mptFile = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260714001.txt');
    writeMptFile(mptFile, '20260714', [
      inboundMptRow({ reconId: 'SIDE-RUN-RECON-1', orderId: 'ORDER-1', batchSeq: '1' }),
      inboundMptRow({ reconId: 'SIDE-RUN-RECON-2', orderId: 'ORDER-2', batchSeq: '2' })
    ]);
    await service.tempStore.importLegacyFile(mptFile);
    await service.importFiles([bankFile, documentFile]);
    const completed = await service.run();

    const sidePath = path.join(
      userDataDir,
      'run-data',
      'duplicate-inbound-match',
      `month-${service.lastRun.monthKey}.sqlite`
    );
    const sideDb = new DatabaseSync(sidePath);
    try {
      sideDb.prepare(`
        UPDATE duplicate_inbound_match_runs SET summary_json = '{'
        WHERE id = ?
      `).run(service.lastRun.sideRunId);
    } finally {
      sideDb.close();
    }

    const originalMarkUnavailable = service.database.markDuplicateInboundMatchRunMirrorUnavailable;
    service.database.markDuplicateInboundMatchRunMirrorUnavailable = () => {
      throw new Error('injected mirror write failure');
    };
    assert.throws(() => service.status(), /injected mirror write failure/);
    assert.equal(
      mirrorRepository.getRunMirror(mirror.db, completed.runId).status,
      'success',
      '镜像写失败不得伪报已同步失效'
    );
    service.database.markDuplicateInboundMatchRunMirrorUnavailable = originalMarkUnavailable;

    const status = service.status();
    assert.equal(status.run.unavailable, true);
    assert.equal(status.canExport, false);
    assert.equal(
      mirrorRepository.getRunMirror(mirror.db, completed.runId).status,
      'invalid-side-db'
    );
    await assert.rejects(
      () => service.export({ savePath: path.join(userDataDir, 'invalid-side-run.xlsx') }),
      (error) => error.code === 'duplicate-inbound-run-unavailable'
    );
  });

  test('成功 run 的结果明细少行时标记侧库失效并禁止发布不完整 Excel', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'MISSING-RESULT', amount: '100' }));
    const mptFile = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260714001.txt');
    writeMptFile(mptFile, '20260714', [
      inboundMptRow({ reconId: 'MISSING-RESULT-RECON-1', orderId: 'ORDER-1', batchSeq: '1' }),
      inboundMptRow({ reconId: 'MISSING-RESULT-RECON-2', orderId: 'ORDER-2', batchSeq: '2' })
    ]);
    await service.tempStore.importLegacyFile(mptFile);
    await service.importFiles([bankFile, documentFile]);
    const completed = await service.run();

    const sidePath = path.join(
      userDataDir,
      'run-data',
      'duplicate-inbound-match',
      `month-${service.lastRun.monthKey}.sqlite`
    );
    const sideDb = new DatabaseSync(sidePath);
    try {
      sideDb.prepare(`
        DELETE FROM duplicate_inbound_match_mail_rows WHERE run_id = ?
      `).run(service.lastRun.sideRunId);
    } finally {
      sideDb.close();
    }

    const status = service.status();
    assert.equal(status.run.unavailable, true);
    assert.equal(status.canExport, false);
    assert.equal(
      mirrorRepository.getRunMirror(mirror.db, completed.runId).status,
      'invalid-side-db'
    );
    await assert.rejects(
      () => service.export({ savePath: path.join(userDataDir, 'missing-result.xlsx') }),
      (error) => error.code === 'duplicate-inbound-run-unavailable'
    );
    assert.equal(fs.existsSync(path.join(userDataDir, 'missing-result.xlsx')), false);
  });

  test('INBOUND 批次替换和删除都会使旧结果过期', async () => {
    writeBankFile(bankFile, duplicateGroup({ prefix: 'SUCCESS', amount: '100' }));
    const firstMpt = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260714001.txt');
    writeMptFile(firstMpt, '20260714', [
      inboundMptRow({ reconId: 'SUCCESS-RECON-1', orderId: 'ORDER-1', batchSeq: '1' }),
      inboundMptRow({ reconId: 'SUCCESS-RECON-2', orderId: 'ORDER-2', batchSeq: '2' })
    ]);
    await service.tempStore.importLegacyFile(firstMpt);
    await service.importFiles([bankFile, documentFile]);
    await service.run();
    assert.equal(service.status().canExport, true);

    const replacement = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260714002.txt');
    writeMptFile(replacement, '20260714', [
      inboundMptRow({ reconId: 'UNRELATED', orderId: 'REPLACEMENT', batchSeq: '1' })
    ]);
    const replaced = await service.tempStore.importLegacyFile(replacement);
    assert.equal(replaced.status, 'replaced');
    assert.equal(service.status().run.stale, true);
    assert.equal(service.status().canExport, false);

    await service.run();
    assert.equal(service.status().canExport, true, '替换后重跑产生人工结果，可供导出');
    const removed = await service.tempStore.deleteBatch({
      sourceType: SOURCE_TYPE_INBOUND,
      sourceBatch: 'MPT_INBOUND_20260714',
      monthKey: '2026-07'
    });
    assert.equal(removed.deletedBatches, 1);
    assert.equal(service.status().run.stale, true);
    assert.equal(service.status().canExport, false);
  });

  test('纯 Inbound 只统计且没有可导出结果', async () => {
    await assert.rejects(
      () => service.export({ savePath: path.join(userDataDir, 'before-run.xlsx') }),
      (error) => error.code === 'duplicate-inbound-run-missing'
    );
    writeBankFile(bankFile, [bankRow({
      BizId: 'PURE-I', FundType: 'Inbound', 'Credit Amount': '10', Channel: 'CIT',
      Currency: 'USD', 'Payee Name': 'P', 'Payee CardNo': '1', 'Drawee Name': 'D',
      'Drawee CardNo': '2'
    })]);
    await service.importFiles([bankFile, documentFile]);
    const result = await service.run();
    assert.equal(result.summary.pureInboundRowCount, 1);
    assert.equal(result.summary.mailRowCount, 0);
    assert.equal(result.summary.manualRowCount, 0);
    assert.equal(service.status().canExport, false);
    await assert.rejects(
      () => service.export({ savePath: path.join(userDataDir, 'pure-inbound.xlsx') }),
      (error) => error.code === 'duplicate-inbound-export-empty'
    );
    assert.equal(fs.existsSync(path.join(userDataDir, 'pure-inbound.xlsx')), false);
  });
});
