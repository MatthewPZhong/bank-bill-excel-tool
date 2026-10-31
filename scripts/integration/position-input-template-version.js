// 设置 · 模板文件「平盘链接原始表导入识别结构」集成验证（真实主库迁移 + 真实平盘流式导入 Worker）
//   覆盖：内置结构下表头改名的系统导出被拒并列出逐列差异；在模板文件导入并启用新结构后同一文件可导入，
//         原始表导出按新结构出列；恢复默认后再次被拒；重建服务（模拟重启）后启用状态保持；
//         版本文件被改动时导入中止并指向设置。
//
// 模板服务与平盘服务按 main.js 的装配方式注入（resolveSourceStructures → currentInputStructure），
// 用真实 AppDatabase（完整启动迁移）保存版本元数据，导入走真实流式 Worker 与侧库。
// 用法：node scripts/integration/position-input-template-version.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { AppDatabase } = require('../../src/backend/database');
const { createTemplateResourceService } = require('../../src/main-process/template-resources/service');
const { INPUT_STRUCTURES } = require('../../src/main-process/template-resources/input-structures');
const { createPositionReconciliationService } = require('../../src/main-process/position-reconciliation/service');
const { dispatchPositionLargeImportSchemaMigration } = require('../../src/main-process/position-reconciliation/import-dispatch');
const { SOURCE_DEFINITIONS, SOURCE_TYPES } = require('../../src/main-process/position-reconciliation/constants');

const ROOT = path.resolve(__dirname, '..', '..');
const BATCH_CONTEXT = Object.freeze({
  batchId: 1,
  batchNumber: '2026-10-30-001',
  taskRunId: 'integration-structures',
  taskKey: 'position-reconciliation:source:prepare-import',
  moduleId: 'position-reconciliation',
  parentRunId: 'integration-structures-parent',
  operationKey: 'integration-structures-operation'
});
const INBOUND = SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers;
const RENAMED = INBOUND.map((header) => (header === 'fieldId' ? 'fileId' : header));

function writeWorkbook(filePath, sheetName, headers, rows = []) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))]),
    sheetName
  );
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

async function run() {
  console.log('==== 平盘链接原始表导入识别结构 集成验证 ====');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'position-input-template-version-'));
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
  // 与 main.js resolvePositionSourceStructures 相同的装配。
  const resolveSourceStructures = async () => {
    const structures = {};
    for (const [resourceId, spec] of Object.entries(INPUT_STRUCTURES)) {
      if (spec.group === 'position-sources') structures[spec.moduleKey] = await templates.currentInputStructure(resourceId);
    }
    return structures;
  };
  let sequence = 0;
  let position = null;
  position = createPositionReconciliationService({
    userDataDir: userData,
    templatePath: path.join(ROOT, 'assets', '平盘银行对账单.xlsx'),
    positionImportEngine: 'streaming',
    operationTokenProvider: () => `integration-${++sequence}`,
    resolveSourceStructures,
    authorizeStreamingSourceApply: async (ready) => {
      const baseCheckpoint = position.persistenceCheckpoint();
      const schema = await dispatchPositionLargeImportSchemaMigration({
        engine: 'streaming',
        userDataDir: userData,
        sideDbPath: position.store.dbPath,
        expectedCheckpoint: baseCheckpoint,
        batchContext: BATCH_CONTEXT
      }).promise;
      return {
        operationToken: `integration-apply-${++sequence}`,
        archiveManifestHash: ready.archiveManifestHash,
        schemaFingerprint: schema.fingerprint,
        baseCheckpoint
      };
    }
  });

  const exportFile = writeWorkbook(path.join(files, '网关原始入账单.xlsx'), '账单明细', RENAMED, [{
    bizId: 'IT-IN-1', billDate: '2026-07-20', tradeType: 'Inbound-VA', reconId: 'IT-RID-1', channel: 'DBS',
    merchantId: 'M001', currency: 'USD', amount: '100', originOutboundCurrency: 'EUR', fileId: 'IT-FILE-1'
  }]);
  const templateFile = writeWorkbook(path.join(files, '中台网关原始入账订单-新结构.xlsx'), '账单明细', RENAMED);
  const importSource = async () => {
    const prepared = await position.prepareSourceImportForLifecycle([exportFile]);
    if (!prepared.requiresExecution) return prepared.result;
    return position.executePreparedSourceImport(prepared.plan, BATCH_CONTEXT, {
      executionInputPaths: prepared.inputPaths,
      outputs: []
    });
  };
  const assertRejectedWithDiff = (result) => {
    assert.equal(result.status, 'failed');
    const item = result.results[0];
    assert.equal(item.code, 'position-source-unrecognized');
    assert.ok(item.detailLines.includes('第 20 列（T）：应为「fieldId」，实际为「fileId」'), item.detailLines.join('\n'));
    assert.ok(item.detailLines.includes('如系统导出结构已变更，请在「设置 → 模板文件」导入新版本'));
  };
  const results = [];

  const cases = [
    ['内置结构下表头改名的系统导出被拒，逐列列出差异与导入新版本的指引', async () => {
      assertRejectedWithDiff(await importSource());
      assert.equal(position.store.countSourceRows(SOURCE_TYPES.GATEWAY_INBOUND), 0);
    }],
    ['导入并启用新结构后同一文件导入成功，原始表导出按新结构出列', async () => {
      templates.rememberPickedFile(templateFile);
      const prepared = await templates.prepareImport({ resourceId: 'position-gateway-raw-in', filePath: templateFile });
      assert.equal(prepared.status, 'success', prepared.message);
      assert.equal(prepared.verdict, 'warn', JSON.stringify(prepared.checks));
      assert.deepEqual(prepared.diff, { added: ['fileId'], removed: ['fieldId'] });
      const committed = await templates.commitImport({ importToken: prepared.importToken, enable: true });
      assert.equal(committed.status, 'success', committed.message);
      assert.equal(committed.version.label, 'V2');

      const imported = await importSource();
      assert.equal(imported.status, 'ok', JSON.stringify(imported.results));
      assert.equal(position.store.countSourceRows(SOURCE_TYPES.GATEWAY_INBOUND), 1);
      const rawPath = path.join(files, 'raw.xlsx');
      await position.exportRaw(SOURCE_TYPES.GATEWAY_INBOUND, rawPath);
      const rows = XLSX.utils.sheet_to_json(XLSX.readFile(rawPath).Sheets['中台网关原始入账订单'], { header: 1, defval: '' });
      assert.deepEqual(rows[0], RENAMED);
      assert.equal(rows[1][RENAMED.indexOf('fileId')], 'IT-FILE-1');
    }],
    ['重建服务（模拟重启）后启用状态保持；恢复默认后同一文件再次被拒', async () => {
      templates = createTemplates();
      const current = await templates.currentInputStructure('position-gateway-raw-in');
      assert.deepEqual([current.status, current.label], ['user', 'V2']);
      const restored = await templates.setCurrentVersion({ resourceId: 'position-gateway-raw-in', versionId: 'v1' });
      assert.equal(restored.status, 'success');
      assertRejectedWithDiff(await importSource());
    }],
    ['版本文件被改动时导入中止并指向设置，只落 {userData}/template-resources/', async () => {
      const enabled = await templates.setCurrentVersion({ resourceId: 'position-gateway-raw-in', versionId: 'v2' });
      assert.equal(enabled.status, 'success', enabled.message);
      const versionFile = path.join(userData, 'template-resources', 'position-gateway-raw-in', 'v2.xlsx');
      assert.ok(fs.existsSync(versionFile));
      const bytes = fs.readFileSync(versionFile);
      bytes[bytes.length - 1] ^= 0xff;
      fs.writeFileSync(versionFile, bytes);
      templates = createTemplates();
      await assert.rejects(importSource(), (error) => {
        assert.equal(error.code, 'position-source-structure-unavailable');
        assert.match(error.message, /当前版本 V2 不可用：版本文件已被修改（SHA-256 不一致）。请在 设置 → 模板文件 恢复默认或重新导入/);
        return true;
      });
    }]
  ];

  try {
    for (const [label, body] of cases) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await body();
        results.push({ label, ok: true });
        console.log(`PASS ${label}`);
      } catch (error) {
        results.push({ label, ok: false, error });
        console.log(`FAIL ${label}\n  ${error && error.stack ? error.stack : error}`);
      }
    }
  } finally {
    try { position.close(); } catch (_error) { /* 已关闭 */ }
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
