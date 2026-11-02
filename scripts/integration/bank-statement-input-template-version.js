// 设置 · 模板文件「银行对账单（导入识别结构）」集成验证（真实主库迁移与预置场景 + 真实模板服务 + 真实识别、读取与入金表仓储）
//   覆盖（D17–D19 第一批）：在模板文件导入并启用新结构（按位置改名、删列、新增列）后，「导入文件」按 main.js 的装配
//         同时接受新结构与内置 46 列；按新结构导出的入金渠道银行对账单读出后对应回内置 46 列，二次分流入金表时
//         按同一结构的入金表签名流式入库（14 个字段）；「链接表管理」识别为入金表并标明按当前版本读取；
//         预置场景引用的银行字段不阻止启用；平盘银行导入（真实流式 Worker 预检与写入）与重复入账匹配导入按同一装配接受新结构、
//         入库为内置 46 列；恢复默认后新结构文件被拒并附指引，内置结构文件照常。
//
// 导入入口是 IPC + 对话框绑定，本脚本镜像其识别 / 读取 / 落库调用（与 linked-input-template-version.js 同范式）。
// 用法：node scripts/integration/bank-statement-input-template-version.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { AppDatabase } = require('../../src/backend/database');
const linkedRepo = require('../../src/backend/database/linked-table-repository');
const { BANK_STATEMENT_FIELDS } = require('../../src/constants/bank-statement-fields');
const { ALL_TABLE_SIGNATURES, BANK_DEPOSIT_SIGNATURE, LINKED_IMPORT_SIGNATURES } = require('../../src/constants/table-signatures');
const { detectTableType } = require('../../src/main-process/table-type-detector');
const { streamLinkedRowsToInsert } = require('../../src/main-process/linked-table-stream-source');
const { readBankStatement } = require('../../src/main-process/bank-statement-io');
const { projectLinkedRow, versionSignatureOf, withBankStatementStructure } = require('../../src/main-process/linked-structure-signatures');
const { bankStatementSourceHeaders, resolveBankStatementStructure } = require('../../src/main-process/bank-statement-structure');
const { createTemplateResourceService } = require('../../src/main-process/template-resources/service');
const { createPositionReconciliationService } = require('../../src/main-process/position-reconciliation/service');
const { createDuplicateInboundMatchService } = require('../../src/main-process/duplicate-inbound-match/service');
const { BILL_HEADERS } = require('../../src/backend/acquiring-bill-currency-db/columns');

const ROOT = path.resolve(__dirname, '..', '..');
// V2：「合并单号」按位置改名为「合并编号」，删除「分类人」，末尾新增一列；必用列与预置场景引用的列不动。
const BANK_V2 = [...BANK_STATEMENT_FIELDS.filter((header) => header !== '分类人').map((header) => (header === '合并单号' ? '合并编号' : header)), '新增列'];
const DEPOSIT_ROW = { BizId: 'IT-BIZ-1', BillDate: '2026-10-20', Channel: 'ADM', Currency: 'USD', 'Credit Amount': '100',
  ReconciliationId: 'IT-R-1', CustomerRef: 'IT-REF', 'Payment Detail': 'IT-PAY', FundType: 'Inbound', 合并编号: '合并-1', 新增列: '不导入' };

function writeBank(filePath, headers, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))]), '渠道对账单');
  XLSX.writeFile(workbook, filePath, { bookSST: true });
  return filePath;
}

async function run() {
  console.log('==== 银行对账单导入识别结构 集成验证 ====');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-statement-input-template-version-'));
  const userData = path.join(temporary, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const database = new AppDatabase(path.join(userData, 'tool-data.sqlite'));
  database.init();
  const templates = createTemplateResourceService({ appRoot: ROOT, appVersion: 'integration', userDataRoot: userData, store: database });
  const v2File = writeBank(path.join(temporary, '银行对账单-新结构导出.xlsx'), BANK_V2, [DEPOSIT_ROW]);
  const builtinFile = writeBank(path.join(temporary, '银行对账单-内置结构.xlsx'), BANK_STATEMENT_FIELDS,
    [{ ...DEPOSIT_ROW, BizId: 'IT-BIZ-2', ReconciliationId: 'IT-R-2', 合并单号: '合并-2' }]);
  const results = [];
  // 与 main.js 注入平盘 / 重复入账匹配服务的 resolveBankSourceHeaders 相同。
  const resolveBankSourceHeaders = async () => bankStatementSourceHeaders(await resolveBankStatementStructure(templates));
  const positionBatch = Object.freeze({ batchId: 1, batchNumber: '2026-11-01-001', taskRunId: 'integration-bank-structure',
    taskKey: 'position-reconciliation:bank:import', moduleId: 'position-reconciliation', parentRunId: 'integration-bank-parent',
    operationKey: 'integration-bank-operation' });

  const cases = [
    ['导入并启用新结构：预置场景引用的银行字段不阻止启用，列对应展示改名与置空', async () => {
      const templateFile = writeBank(path.join(temporary, '银行对账单-模板.xlsx'), BANK_V2, []);
      templates.rememberPickedFile(templateFile);
      const prepared = await templates.prepareImport({ resourceId: 'bank-statement-input', filePath: templateFile });
      assert.equal(prepared.status, 'success', prepared.message);
      assert.equal(prepared.verdict, 'warn', JSON.stringify(prepared.checks));
      assert.equal(prepared.checks.find((check) => check.label === '场景引用').status, 'pass');
      assert.match(prepared.checks.find((check) => check.label === '列对应').detail, /按位置视为改名：第 17 列「合并编号」→「合并单号」/);
      assert.equal((await templates.commitImport({ importToken: prepared.importToken, enable: true })).status, 'success');
    }],
    ['「导入文件」同时接受新结构与内置 46 列；新结构入金行按同一结构的入金表签名流式入库 14 个字段', async () => {
      const bankStructure = await resolveBankStatementStructure(templates);
      assert.deepEqual([bankStructure.status, bankStructure.label], ['user', 'V2']);
      const signatures = withBankStatementStructure(ALL_TABLE_SIGNATURES, bankStructure);
      for (const [file, version] of [[v2File, true], [builtinFile, undefined]]) {
        const detected = await detectTableType(file, signatures);
        assert.deepEqual([detected.status, detected.tableKey, detected.matchedVersion], ['matched', 'bank-statement', version]);
      }
      const result = readBankStatement(v2File, { sourceHeaders: bankStatementSourceHeaders(bankStructure) });
      assert.equal(result.structure, 'current');
      assert.equal(result.rows[0]['合并单号'], '合并-1');
      assert.equal(database.isBankDepositChannelFile(result.rows), true);
      const depositSignature = versionSignatureOf(withBankStatementStructure([BANK_DEPOSIT_SIGNATURE], bankStructure), 'bank-deposit');
      const written = await database.upsertLinkedBankDepositStreaming(async (writeOne) => {
        const { matched } = await streamLinkedRowsToInsert(v2File, depositSignature, writeOne,
          (row) => linkedRepo.pickBankDepositFields(projectLinkedRow(depositSignature, row)));
        assert.ok(matched, '流内按新结构定位到表头');
      }, { sourceFileName: path.basename(v2File) });
      assert.equal(written.rowCount, 1);
      const stored = linkedRepo.readLinkedTableRows(database.db, 'bank-deposit')[0];
      assert.deepEqual(Object.keys(stored), [...linkedRepo.BANK_DEPOSIT_FIELDS]);
      assert.deepEqual([stored.BizId, stored.ReconciliationId, stored['Payment Detail'], stored.Channel], ['IT-BIZ-1', 'IT-R-1', 'IT-PAY', 'ADM']);
    }],
    ['「链接表管理」把新结构文件识别为入金表并标明按当前版本读取', async () => {
      const signatures = withBankStatementStructure(LINKED_IMPORT_SIGNATURES, await resolveBankStatementStructure(templates));
      const detected = await detectTableType(v2File, signatures);
      assert.deepEqual([detected.status, detected.tableKey, detected.matchedVersion], ['matched', 'bank-deposit', true]);
    }],
    ['平盘银行导入按同一装配接受新结构：真实 Worker 预检与写入，入库为内置 46 列', async () => {
      let sequence = 0;
      const position = createPositionReconciliationService({ userDataDir: path.join(temporary, 'position'),
        templatePath: path.join(ROOT, 'assets', '平盘银行对账单.xlsx'), positionImportEngine: 'streaming',
        operationTokenProvider: () => `integration-bank-${++sequence}`, resolveBankSourceHeaders });
      try {
        const file = writeBank(path.join(temporary, '平盘银行对账单-新结构.xlsx'), BANK_V2,
          [{ ...DEPOSIT_ROW, Channel: 'DBS', 地区: 'HK', BizId: 'IT-POS-1' }]);
        const prepared = await position.prepareBankImport([file]);
        assert.equal(prepared.status, 'needs-confirmation', JSON.stringify(prepared));
        const applied = await position.applyBankImport(prepared.token, positionBatch,
          position.bankImportArchiveIntent(prepared.token).map((item) => item.filePath));
        assert.equal(applied.status, 'ok', JSON.stringify(applied));
        const [{ originalRow }] = position.store.getBankRows({ channels: ['DBS'], months: ['2026-10'] });
        assert.deepEqual([originalRow.BizId, originalRow['合并单号'], originalRow['分类人']], ['IT-POS-1', '合并-1', '']);
      } finally {
        position.close();
      }
    }],
    ['重复入账匹配导入按同一装配接受新结构，分组与内置结构一致', async () => {
      const documentFile = path.join(temporary, '单据对账单.xlsx');
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([BILL_HEADERS.slice(), ...['ORDER-1', 'ORDER-2'].map((orderId, index) => (
        BILL_HEADERS.map((header) => ({ 业务订单号: orderId, 用户编号: 'U', 账户号: '000-A', 业务部门: 'OPP', originBillBizId: `DOC-${index + 1}` })[header] ?? '')
      ))]), '单据对账单');
      XLSX.writeFile(workbook, documentFile);
      const common = { Channel: 'CIT', MerchantId: 'M-1', Currency: 'USD', 'Payee Name': 'P', 'Payee CardNo': 'PC', 'Drawee Name': 'D', 'Drawee CardNo': 'DC' };
      const rows = [{ ...common, BizId: 'DUP-R', BillDate: '2026-07-14', FundType: 'Reversal', 'Debit Amount': '100' },
        ...[1, 2].map((index) => ({ ...common, BizId: `DUP-I${index}`, FundType: 'Inbound', 'Credit Amount': '100', ReconciliationId: `DUP-RECON-${index}` }))];
      const counts = async (bankFile) => {
        const service = createDuplicateInboundMatchService({ userDataDir: path.join(temporary, `duplicate-${path.basename(bankFile)}`), database,
          mailTemplatePath: path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx'), bankTemplatePath: path.join(ROOT, 'assets', '银行对账单.xlsx'),
          resolveBankSourceHeaders });
        const imported = await service.importFiles([bankFile, documentFile]);
        return [imported.bank.rowCount, imported.bank.reversalCount, imported.bank.inboundCount];
      };
      const v2Counts = await counts(writeBank(path.join(temporary, 'dup-v2.xlsx'), BANK_V2, rows));
      assert.deepEqual(v2Counts, await counts(writeBank(path.join(temporary, 'dup-builtin.xlsx'), BANK_STATEMENT_FIELDS, rows)));
      assert.deepEqual(v2Counts, [3, 1, 2]);
    }],
    ['恢复默认后只认内置 46 列：新结构文件被拒并附指引，内置结构文件照常', async () => {
      const restored = await templates.setCurrentVersion({ resourceId: 'bank-statement-input', versionId: 'v1' });
      assert.equal(restored.status, 'success', restored.message);
      const bankStructure = await resolveBankStatementStructure(templates);
      assert.equal(bankStatementSourceHeaders(bankStructure), null);
      assert.throws(() => readBankStatement(v2File, { sourceHeaders: bankStatementSourceHeaders(bankStructure) }), (error) => {
        assert.equal(error.detailLines.at(-1), '如系统导出结构已变更，请在「设置 → 模板文件」导入新版本');
        return true;
      });
      assert.equal(readBankStatement(builtinFile).rows[0]['合并单号'], '合并-2');
    }]
  ];

  try {
    for (const [label, body] of cases) {
      try {
        await body();
        results.push({ label, ok: true });
        console.log(`PASS ${label}`);
      } catch (error) {
        results.push({ label, ok: false, error });
        console.log(`FAIL ${label}\n  ${error && error.stack ? error.stack : error}`);
      }
    }
  } finally {
    try { database.close(); } catch (_error) { /* 已关闭 */ }
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n==== ${passed}/${results.length} PASS ====`);
  if (passed !== results.length) {
    console.error('FAILURES:');
    results.filter((item) => !item.ok).forEach((item) => console.error(`  - ${item.label}: ${item.error && item.error.message}`));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
