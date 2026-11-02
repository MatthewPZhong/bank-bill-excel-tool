// 设置 · 模板文件「银行账单处理链接表导入识别结构」集成验证（真实主库迁移 + 真实模板服务 + 真实识别与链接表仓储）
//   覆盖：网关对账单导入并启用新结构（按位置改名、删列、新增列）后，按新结构导出的文件经流式路径入库，
//         入库键为内置列名（新增列也入库）；内置结构的文件被拒并列出与当前版本的逐列差异；C3 下拉为入库后实际可用的列名；
//         外汇交割表（标题行 + 中间空列）启用新结构后经数组路径入库，空列不入对象、物理行号不变；
//         恢复默认后回到内置识别；版本文件被改动时该表导入中止并指向设置。
//
// 签名解析与读行对应按 main.js 的装配（resolveLinkedSignatures → currentInputStructure、projectLinkedRow）；
//   linked-table:import handler 是 IPC + 对话框绑定无法直接调用，本脚本镜像其流式 feed 与数组 zip
//   （与 v3.0.1-linked-gateway-upsert.js 同范式），识别、流式读取、仓储均调用真实实现。
// 用法：node scripts/integration/linked-input-template-version.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { AppDatabase } = require('../../src/backend/database');
const linkedRepo = require('../../src/backend/database/linked-table-repository');
const { readRowsWithMetadata } = require('../../src/backend/file-service/readers');
const { normalizeCell } = require('../../src/backend/file-service/common');
const { LINKED_IMPORT_SIGNATURES } = require('../../src/constants/table-signatures');
const { detectTableType } = require('../../src/main-process/table-type-detector');
const { streamLinkedRowsToInsert } = require('../../src/main-process/linked-table-stream-source');
const {
  linkedStructureMismatchLines,
  projectLinkedRow,
  resolveLinkedSignatures
} = require('../../src/main-process/linked-structure-signatures');
const { createTemplateResourceService } = require('../../src/main-process/template-resources/service');

const ROOT = path.resolve(__dirname, '..', '..');
const GATEWAY = LINKED_IMPORT_SIGNATURES.find((signature) => signature.tableKey === 'gateway-recon');
const FX = LINKED_IMPORT_SIGNATURES.find((signature) => signature.tableKey === 'fx-delivery');
// 网关 V2：remark1 按位置改名为「备注1」，删除 bookdate，末尾新增「新增列」；必用列不动。
const GATEWAY_V2 = [
  ...GATEWAY.expectedHeaders.filter((header) => header !== 'bookdate').map((header) => (header === 'remark1' ? '备注1' : header)),
  '新增列'
];
// 外汇交割表 V2：「操作员」按位置改名为「经办人」，第 10 列空列保留。
const FX_V2 = FX.expectedHeaders.map((header) => (header === '操作员' ? '经办人' : header));

function writeWorkbook(filePath, sheets) {
  const workbook = XLSX.utils.book_new();
  for (const { name, aoa } of sheets) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), name);
  XLSX.writeFile(workbook, filePath, { bookSST: true });
  return filePath;
}

function rowOf(headers, values) {
  return headers.map((header) => (header && values[header] !== undefined ? values[header] : ''));
}

// 镜像 main.js readLinkedRowsAsObjectsWithMeta（数组路径：定位「连续位置全等 expectedHeaders」的表头行后逐行 zip）。
function readRowsAsObjectsWithMeta(filePath, signature, sheetName) {
  const expected = signature.expectedHeaders;
  const result = readRowsWithMetadata(filePath, [], { sheetName });
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const allRowNumbers = Array.isArray(result.rowNumbers) ? result.rowNumbers : [];
  let headerRowIdx = -1;
  let colOffset = -1;
  for (let ri = 0; ri < rows.length && headerRowIdx < 0; ri += 1) {
    const row = Array.isArray(rows[ri]) ? rows[ri] : [];
    for (let cs = 0; cs <= row.length - expected.length; cs += 1) {
      if (expected.every((header, i) => normalizeCell(header) === normalizeCell(row[cs + i]))) {
        headerRowIdx = ri;
        colOffset = cs;
        break;
      }
    }
  }
  if (headerRowIdx < 0) throw new Error('数组路径未定位到表头');
  const objects = [];
  const rowNumbers = [];
  for (let ri = headerRowIdx + 1; ri < rows.length; ri += 1) {
    const row = Array.isArray(rows[ri]) ? rows[ri] : [];
    const obj = {};
    expected.forEach((header, i) => {
      const name = normalizeCell(header);
      if (name !== '') obj[name] = normalizeCell(row[colOffset + i] === undefined ? '' : row[colOffset + i]);
    });
    objects.push(obj);
    rowNumbers.push(allRowNumbers[ri] ?? ri + 1);
  }
  return { objects, rowNumbers };
}

async function run() {
  console.log('==== 银行账单处理链接表导入识别结构 集成验证 ====');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-input-template-version-'));
  const userData = path.join(temporary, 'userData');
  const files = path.join(temporary, 'files');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(files, { recursive: true });
  const database = new AppDatabase(path.join(userData, 'tool-data.sqlite'));
  database.init();
  const createTemplates = () => createTemplateResourceService({
    appRoot: ROOT, appVersion: 'integration', userDataRoot: userData, store: database
  });
  let templates = createTemplates();
  // 与 main.js resolveImportSignatures 相同的装配。
  const resolveSignatures = () => resolveLinkedSignatures(LINKED_IMPORT_SIGNATURES, (resourceId) => templates.currentInputStructure(resourceId));
  const importVersion = async (resourceId, filePath) => {
    templates.rememberPickedFile(filePath);
    const prepared = await templates.prepareImport({ resourceId, filePath });
    assert.equal(prepared.status, 'success', prepared.message);
    assert.notEqual(prepared.verdict, 'fail', JSON.stringify(prepared.checks));
    const committed = await templates.commitImport({ importToken: prepared.importToken, enable: true });
    assert.equal(committed.status, 'success', committed.message);
    return prepared;
  };
  // 镜像 handler 网关流式分支：transform = 按当前版本读出的行对应回内置列名。
  const streamGateway = (signature, filePath) => database.upsertLinkedGatewayBillStreaming(async (writeOne) => {
    const { matched } = await streamLinkedRowsToInsert(filePath, signature, writeOne, (row) => projectLinkedRow(signature, row));
    assert.ok(matched, '流内定位到网关表头');
  }, { sourceFileName: path.basename(filePath), legacySource: true });

  const gatewayData = writeWorkbook(path.join(files, '网关对账单-V2导出.xlsx'), [{ name: '1409155847565936642', aoa: [
    GATEWAY_V2,
    rowOf(GATEWAY_V2, { Billdate: '2026-10-20', Channel: 'PAY', merchantid: 'M001', ReconBillBizId: 'IT-B-1', reconciliationid: 'IT-R-1', amount: '100', 备注1: '改名列的值', 新增列: '新增列的值' }),
    rowOf(GATEWAY_V2, { Billdate: '2026-10-21', Channel: 'PAY', merchantid: 'M001', ReconBillBizId: 'IT-B-2', reconciliationid: 'IT-R-2', amount: '200' })
  ] }]);
  const gatewayBuiltinData = writeWorkbook(path.join(files, '网关对账单-内置结构.xlsx'), [{ name: 'Sheet1', aoa: [
    GATEWAY.expectedHeaders,
    rowOf(GATEWAY.expectedHeaders, { Billdate: '2026-10-22', ReconBillBizId: 'IT-B-3', amount: '300' })
  ] }]);
  const results = [];

  const cases = [
    ['网关对账单导入并启用新结构：预检展示按位置改名、导入后为空与新增列入库', async () => {
      const templateFile = writeWorkbook(path.join(files, '网关对账单-新结构.xlsx'), [{ name: 'Sheet1', aoa: [GATEWAY_V2] }]);
      const prepared = await importVersion('gateway-recon', templateFile);
      assert.equal(prepared.verdict, 'warn');
      const mapping = prepared.checks.find((check) => check.label === '列对应').detail;
      assert.match(mapping, /按位置视为改名：第 26 列「备注1」→「remark1」/);
      assert.match(mapping, /导入后为空：bookdate/);
      assert.match(mapping, /不导入：新增列/);
      assert.deepEqual(prepared.diff, { added: ['新增列'], removed: ['bookdate'] }, '取值为入库后的列名：改名列仍是 remark1');
    }],
    ['按新结构导出的文件经流式路径入库：入库键为内置列名，改名列取新列值，删除列为空，新增列也入库', async () => {
      const signatures = await resolveSignatures();
      const signature = signatures.find((item) => item.tableKey === 'gateway-recon');
      assert.equal(signature.versionLabel, 'V2');
      const detected = await detectTableType(gatewayData, signatures);
      assert.deepEqual([detected.status, detected.tableKey, detected.streamingEligible], ['matched', 'gateway-recon', true]);
      const written = await streamGateway(signature, gatewayData);
      assert.equal(written.rowCount, 2);
      const row = linkedRepo.readLinkedTableRows(database.db, 'gateway-bill').find((item) => item.ReconBillBizId === 'IT-B-1');
      assert.deepEqual(Object.keys(row), [...GATEWAY.expectedHeaders, '新增列']);
      assert.equal(row.remark1, '改名列的值');
      assert.equal(row.bookdate, '');
      assert.equal(row['新增列'], '新增列的值');
      assert.equal(Object.hasOwn(row, '备注1'), false);
    }],
    ['内置结构的文件在新结构下不识别：给出与当前版本 V2 的逐列差异与模板文件指引，不写入', async () => {
      const signatures = await resolveSignatures();
      const detected = await detectTableType(gatewayBuiltinData, signatures);
      assert.deepEqual([detected.status, detected.tableKey], ['structure-mismatch', 'gateway-recon']);
      const lines = linkedStructureMismatchLines(detected, signatures);
      assert.equal(lines[0], '最接近：网关对账单（当前版本 V2，31 列；文件 31 列）');
      assert.ok(lines.includes('第 26 列（Z）：应为「备注1」，实际为「remark1」'), lines.join('\n'));
      assert.ok(lines.includes('缺少列：备注1、新增列'), lines.join('\n'));
      assert.ok(lines.includes('多出列：remark1、bookdate'), lines.join('\n'));
      assert.equal(lines.at(-1), '如系统导出结构已变更，请在「设置 → 模板文件」导入新版本');
      assert.equal(linkedRepo.readLinkedTableRows(database.db, 'gateway-bill').length, 2);
    }],
    ['C3 网关字段下拉为入库后实际可用的列名（含新增列，改名列仍为内置名，不含导入后为空的列）', async () => {
      const current = await templates.currentRuntimeValues('gateway-recon');
      assert.equal(current.status, 'user');
      assert.ok(current.values.includes('新增列'));
      assert.ok(current.values.includes('remark1'));
      assert.equal(current.values.includes('备注1'), false);
      assert.equal(current.values.includes('bookdate'), false);
    }],
    ['外汇交割表（标题行 + 中间空列）启用新结构后经数组路径入库：空列不入对象，物理行号不变', async () => {
      const titled = (headers, rows) => [['外汇交割查询结果'], headers, ...rows];
      const templateFile = writeWorkbook(path.join(files, '外汇交割表-新结构.xlsx'), [{ name: 'Sheet1', aoa: titled(FX_V2, []) }]);
      const prepared = await importVersion('fx-delivery', templateFile);
      assert.equal(prepared.checks.find((check) => check.label === '表头').status, 'pass', '中间空列允许');
      const dataFile = writeWorkbook(path.join(files, '外汇交割表-V2导出.xlsx'), [{ name: 'Sheet1', aoa: titled(FX_V2, [
        rowOf(FX_V2, { 交易编号: '926100001', 交易日期: '2026-10-20', 到期日: '2026-10-22', 货币1金额: '100', 货币2金额: '720', 经办人: '张三' }),
        [],
        rowOf(FX_V2, { 交易编号: '926100002', 交易日期: '2026-10-21', 到期日: '2026-10-23', 货币1金额: '50', 货币2金额: '360' })
      ]) }]);
      const signatures = await resolveSignatures();
      const signature = signatures.find((item) => item.tableKey === 'fx-delivery');
      const detected = await detectTableType(dataFile, signatures);
      assert.deepEqual([detected.status, detected.tableKey], ['matched', 'fx-delivery']);
      const meta = readRowsAsObjectsWithMeta(dataFile, signature, detected.sheetName);
      const rows = meta.objects.map((row) => projectLinkedRow(signature, row));
      assert.deepEqual(meta.rowNumbers, [3, 5], '空行造成的物理行号断档保留（BOC 分组依赖）');
      assert.deepEqual(Object.keys(rows[0]), FX.expectedHeaders.filter(Boolean));
      assert.equal(rows[0]['操作员'], '张三');
      database.upsertLinkedFx(rows, { sourceFileName: path.basename(dataFile) });
      const stored = linkedRepo.readLinkedTableRows(database.db, 'fx-settlement');
      assert.deepEqual(stored.map((row) => [row['交易编号'], row['操作员']]), [['926100001', '张三'], ['926100002', '']]);
    }],
    ['重建服务（模拟重启）后启用状态保持；恢复默认后回到内置识别', async () => {
      templates = createTemplates();
      assert.equal((await resolveSignatures()).find((item) => item.tableKey === 'gateway-recon').versionLabel, 'V2');
      const restored = await templates.setCurrentVersion({ resourceId: 'gateway-recon', versionId: 'v1' });
      assert.equal(restored.status, 'success', restored.message);
      const signatures = await resolveSignatures();
      assert.equal(signatures.find((item) => item.tableKey === 'gateway-recon'), GATEWAY, '内置版本签名原样');
      const detected = await detectTableType(gatewayBuiltinData, signatures);
      assert.deepEqual([detected.status, detected.tableKey], ['matched', 'gateway-recon']);
    }],
    ['版本文件被改动时该表签名标记不可用并指向设置（调用方中止该表导入），其余表不受影响', async () => {
      const enabled = await templates.setCurrentVersion({ resourceId: 'gateway-recon', versionId: 'v2' });
      assert.equal(enabled.status, 'success', enabled.message);
      const versionFile = path.join(userData, 'template-resources', 'gateway-recon', 'v2.xlsx');
      const bytes = fs.readFileSync(versionFile);
      bytes[bytes.length - 1] ^= 0xff;
      fs.writeFileSync(versionFile, bytes);
      templates = createTemplates();
      const signatures = await resolveSignatures();
      const gateway = signatures.find((item) => item.tableKey === 'gateway-recon');
      assert.match(gateway.structureUnavailable, /当前版本 V2 不可用：版本文件已被修改（SHA-256 不一致）。请在 设置 → 模板文件 恢复默认或重新导入/);
      assert.equal(signatures.find((item) => item.tableKey === 'fx-delivery').versionLabel, 'V2');
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
