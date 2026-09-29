'use strict';
// 共用 XLSX 基础设施真实文件链路：账单预读、Toolbox 投影、Position/VCC spill、BizOP 候选输出。
// fixture 与数据库均在本次独占临时目录；取消后 await close，并通过子进程自然退出检查私有 SST 目录。
// 普通取消/正常退出不代表 worker 强制 terminate 回收或 Windows/Excel/WPS 验收。
// 用法：node scripts/integration/shared-xlsx-boundary.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const { Linter } = require('eslint');
const { writeXlsx, flowRow } = require('../../tests/helpers/biz-op-v327-xlsx');
const { readMeaningfulRowsHead } = require('../../src/backend/file-service/readers');
const { streamToolboxXlsxTables } = require('../../src/main-process/toolbox-format-io');
const { streamPositionXlsxRows } = require('../../src/backend/position-reconciliation-import/xlsx-reader');
const { BANK_STATEMENT_FIELDS } = require('../../src/constants/bank-statement-fields');
const { BANK_SHEET_NAME } = require('../../src/main-process/position-reconciliation/constants');
const { openWorkbookSheets, streamDetailRows } = require('../../src/backend/vcc-financial-op/workbook-reader');
const { SOURCE_TYPES, PENDING_HEADERS } = require('../../src/backend/vcc-financial-op/definitions');
const { openRichWorkbook } = require('../../src/backend/xlsx/rich-workbook');
const { createBizOpPayloadStore, readVerifiedManifest } = require('../../src/main-process/biz-op-v327/payload-store');
const { runImportPipeline } = require('../../src/main-process/biz-op-v327/import-pipeline');
const { fsyncDirectory } = require('../../src/main-process/background-execution/durable-file');

let passed = 0;
const failures = [];
const skips = [];
function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  passed += 1;
}
function truth(value, label) {
  assert.ok(value, label);
  passed += 1;
}
async function rejects(action, expected, label) {
  await assert.rejects(action, expected, label);
  passed += 1;
}
async function group(label, action) {
  try { await action(); console.log(`PASS ${label}`); }
  catch (error) { failures.push({ label, error }); console.error(`FAIL ${label}: ${error.stack}`); }
}
function writeSheet(filePath, sheetName, headers, records) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    headers,
    ...records.map((record) => headers.map((header) => record[header] ?? ''))
  ]), sheetName);
  XLSX.writeFile(book, filePath, { bookSST: true });
}

// 本分支局部边界检查；正式 G8 配置激活由 G8 集成负责。
function createDeprecatedImportChecker() {
  const repositoryRoot = path.resolve(__dirname, '../..');
  const commonDirectory = path.join(repositoryRoot, 'src/backend/xlsx');
  const leafNames = ['excel-text', 'ooxml-namespaces', 'number-date', 'model', 'style-registry', 'xlsx-sheet-scanner'];
  const deprecatedFiles = new Set([
    ...leafNames.map((name) => `src/backend/toolbox-format/${name}.js`),
    'src/backend/big-table-import/zip-reader.js',
    'src/backend/position-reconciliation-import/shared-strings-provider.js',
    'src/backend/pending-import/streaming-xlsx-reader.js',
    'src/backend/pending-import/xlsx-size-preflight.js',
    'src/backend/xlsx-rich-reader.js'
  ].map((file) => path.join(repositoryRoot, file)));
  const assemblyFile = path.join(repositoryRoot, 'src/backend/toolbox-format/xlsx-pass.js');
  const aggregateFile = path.join(repositoryRoot, 'src/backend/toolbox-format/index.js');
  const assemblySymbols = new Set(['ToolboxXlsxPass', 'openToolboxXlsxPass']);
  const commonSymbols = new Set([...leafNames, 'workbook-parts'].flatMap((name) =>
    Object.keys(require(path.join(commonDirectory, name)))));
  const linter = new Linter();
  const rule = {
    meta: { schema: [], messages: { deprecated: '公共 XLSX API 必须从 src/backend/xlsx 读取：{{target}}' } },
    create(context) {
      return {
        CallExpression(node) {
          const literalRequire = node.callee.type === 'Identifier' && node.callee.name === 'require';
          const resolveRequire = node.callee.type === 'MemberExpression' && node.callee.object.name === 'require'
            && node.callee.property.name === 'resolve';
          const request = node.arguments[0]?.value;
          if ((!literalRequire && !resolveRequire) || typeof request !== 'string' || !request.startsWith('.')) return;
          let target;
          try { target = require.resolve(path.resolve(path.dirname(context.filename), request)); }
          catch (_error) { return; }
          let rejected = deprecatedFiles.has(target);
          if (target === assemblyFile || target === aggregateFile) {
            // 原 index 继续向 xlsx-pass 转发其历史 helper；它不是新增业务消费者。
            if (context.filename === aggregateFile && target === assemblyFile) return;
            const parent = node.parent;
            let names = null;
            if (parent.type === 'VariableDeclarator' && parent.id.type === 'ObjectPattern') {
              if (parent.id.properties.every((item) => item.type === 'Property' && !item.computed)) {
                names = parent.id.properties.map((item) => item.key.name ?? item.key.value);
              }
            } else if (parent.type === 'MemberExpression' && parent.object === node) {
              const property = parent.computed ? parent.property.value : parent.property.name;
              if (typeof property === 'string') names = [property];
            }
            rejected = !names || names.some((name) => target === assemblyFile
              ? !assemblySymbols.has(name) : commonSymbols.has(name));
          }
          if (rejected) context.report({ node, messageId: 'deprecated', data: { target: request } });
        }
      };
    }
  };
  return (source, filename) => linter.verify(source, [{
    files: ['**/*.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { xlsx: { rules: { 'no-deprecated-import': rule } } },
    rules: { 'xlsx/no-deprecated-import': 'error' }
  }], { filename, allowInlineConfig: false, reportUnusedDisableDirectives: false });
}

async function runCloseChild(filePath, tempRoot) {
  const cancelToken = { cancelled: false };
  const workbook = await openRichWorkbook(filePath, { memoryBudgetBytes: 1, sstTempRoot: tempRoot, cancelToken });
  assert.equal(workbook.sharedStrings.mode, 'disk');
  try {
    await assert.rejects(workbook.scan(() => { cancelToken.cancelled = true; }), { code: 'TOOLBOX_XLSX_CANCELLED' });
  } finally { await workbook.close(); }
  assert.equal(fs.existsSync(tempRoot), false);
  console.log('reader cancelled and closed');
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-xlsx-boundary-'));
  const fixture = path.join(root, 'mixed.xlsx');
  const precise = '1234567890123456789.123456789';
  const expectedLegacy = [['标识', '金额', '备注'], ['001', String(Number.parseFloat(precise)), '中文 & <tag>'], ['002', '0', '尾行']];
  await writeXlsx(fixture, { headers: expectedLegacy[0], sharedStrings: ['中文 & <tag>'], rowCount: 2,
    row: (index) => index === 0 ? ['001', { t: 'n', v: precise }, { t: 's', v: '0' }] : ['002', { t: 'n', v: '-0' }, '尾行'] });
  try {
    await group('账单真实 legacy 预读保持行序、数值投影与截断', async () => {
      const complete = await readMeaningfulRowsHead(fixture, 0, { maxColCount: 3 });
      equal(complete.rows, expectedLegacy, '账单值及类型');
      equal(complete.truncated, false, '完整读取');
      const head = await readMeaningfulRowsHead(fixture, 2, { maxColCount: 3 });
      equal(head.rows, expectedLegacy.slice(0, 2), '预读截断');
      equal(head.truncated, true, '截断标记');
    });

    await group('Toolbox 真实装配保持类型/lexical 与业务 legacy 投影', async () => {
      const output = [];
      const cells = [];
      const summary = await streamToolboxXlsxTables(fixture, {
        onHeader(info) { output.push(info.normalizedHeaders); },
        onDataRow(row, context) { output.push(context.matchValues); cells.push(row.cells); }
      });
      equal(output, expectedLegacy, 'Toolbox 业务行和账单 legacy 一致');
      equal(summary.dataRowCount, 2, '数据行数');
      equal(cells[0].map((cell) => cell.cellType), ['text', 'number', 'text'], 'rich 单元格类型');
      equal(cells[0][1].rawLexicalValue, precise, 'rich 保留精确金额词元');
      equal(cells[0][2].decodedSemanticValue, '中文 & <tag>', 'SST XML 解码');
      const token = { cancelled: false };
      await rejects(() => streamToolboxXlsxTables(fixture, {
        cancelToken: token, onDataRow() { token.cancelled = true; }
      }), { code: 'TOOLBOX_XLSX_CANCELLED' }, 'Toolbox 取消不返回部分成功');
    });

    await group('Position 真实银行行映射、低预算 spill 与取消清理', async () => {
      const file = path.join(root, 'position.xlsx');
      writeSheet(file, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [
        { BizId: '000001', BillDate: new Date(2026, 8, 2), Currency: 'USD', 'Credit Amount': 12.5 },
        { BizId: '000002', BillDate: new Date(2026, 8, 3), Currency: 'USD', 'Debit Amount': 2.25 }
      ]);
      const baselineBook = XLSX.readFile(file, { cellDates: true });
      const baseline = XLSX.utils.sheet_to_json(baselineBook.Sheets[BANK_SHEET_NAME], { defval: '' });
      const tempRoot = path.join(root, 'position-sst');
      const observed = [];
      const summary = await streamPositionXlsxRows(file, { kind: 'bank', sstTempRoot: tempRoot,
        sstMemoryBudgetBytes: 1, onRow(value) { observed.push(value); } });
      equal(observed.map((value) => value.row), baseline, 'Position 对照同 fixture SheetJS 业务值和日期类型');
      equal(observed.map((value) => value.excelRowNumber), [2, 3], 'Position 原始行号');
      equal(summary.sharedStringsMode, 'disk', '实际触发 spill');
      equal(fs.existsSync(tempRoot), false, 'Position 完成后的 spill 清理');
      const token = { cancelled: false };
      const cancelledRoot = path.join(root, 'position-cancelled-sst');
      await rejects(() => streamPositionXlsxRows(file, { kind: 'bank', cancelToken: token,
        sstTempRoot: cancelledRoot, sstMemoryBudgetBytes: 1,
        onRow() { token.cancelled = true; }
      }), { code: 'position-import-cancelled' }, 'Position 错误映射');
      equal(fs.existsSync(cancelledRoot), false, 'Position 取消后的 spill 清理');
    });

    await group('VCC 真实 Pending 明细保留 key 类型及 shared workbook 关闭责任', async () => {
      const file = path.join(root, 'vcc.xlsx');
      const records = [
        { PendingBizId: '000001', 金额: 12.5, 币种: 'USD', 平账账期: '2026-09' },
        { PendingBizId: '000002', 金额: -2.25, 币种: 'USD', 平账账期: '2026-09' }
      ];
      writeSheet(file, '明细', PENDING_HEADERS, records);
      const tempRoot = path.join(root, 'vcc-sst');
      const workbook = await openWorkbookSheets(file, { sstTempRoot: tempRoot, sstMemoryBudgetBytes: 1 });
      try {
        equal(workbook.sharedStrings.mode, 'disk', 'VCC 实际触发 spill');
        const observed = [];
        const summary = await streamDetailRows(file, SOURCE_TYPES.PENDING, { workbook,
          onDataRow(value) { observed.push(value); } });
        equal(summary.rowCount, 2, 'VCC 业务行数');
        equal(observed.map((row) => row.values), records.map((record) => PENDING_HEADERS.map((header) => String(record[header] ?? ''))), 'VCC 业务字符串合同');
        equal(observed.map((row) => [row.rowR, row.keyCellType]), [[2, 's'], [3, 's']], 'VCC 身份列 SST 类型及行号');
        truth(fs.existsSync(tempRoot), '共享 workbook 由上层继续持有');
        const failure = new Error('测试调用方拒绝行');
        await rejects(() => streamDetailRows(file, SOURCE_TYPES.PENDING, { workbook,
          onDataRow() { throw failure; } }), (error) => error === failure, '扫描失败保留原始错误');
      } finally { await workbook.close(); }
      equal(fs.existsSync(tempRoot), false, 'VCC 所有者 await close 后清理');
    });

    await group('BizOP 真实 rich reader→adapter→候选 SQLite 输出与资源清理', async () => {
      const capability = fsyncDirectory(root);
      if (capability.capability !== 'supported') {
        skips.push(`BizOP 持久化成功链：宿主目录 fsync ${capability.errorCode}，不模拟屏障成功`);
        return;
      }
      const store = createBizOpPayloadStore({ userDataDir: path.join(root, 'bizop') });
      store.initialize();
      const filePath = path.join(root, 'flow.xlsx');
      await writeXlsx(filePath, { sharedStrings: ['000123'], rowCount: 2,
        row: (index) => flowRow({ account: { t: 's', v: '0' }, amount: { t: 'n', v: precise }, number: `000${index + 1}` }) });
      const taskRunId = `task-${randomUUID()}`;
      const candidateRef = `candidate-${randomUUID()}`;
      const reportRef = `report-${randomUUID()}`;
      const output = await runImportPipeline({ payloadStore: store, taskRunId, candidateRef, reportRef,
        intentDigest: 'f'.repeat(64), options: { sstMemoryBudgetBytes: 1 },
        files: [{ filePath, artifactId: 1, order: 0, sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') }] });
      const result = store.readDocument(`operations/${taskRunId}/${candidateRef}.json`, output.sha256).value;
      equal(result.batchRejected, false, 'BizOP 接收合法输入');
      equal(result.acceptedRows, 2, 'BizOP 接收行数');
      truth(result.metrics.sstSpillBytes > 0, 'BizOP 实际触发 spill');
      const reference = result.references[0];
      const manifest = readVerifiedManifest(await store.verifyManifest(`inputs/${reference.objectId}/manifest.json`, reference.digest));
      const database = new DatabaseSync(store.resolve(`inputs/${reference.objectId}/${manifest.parts[0].name}`), { readOnly: true });
      try {
        const rows = database.prepare('SELECT account_no,recon_amount,flow_no,key_currency,source_row FROM flow_check_rows ORDER BY row_ordinal').all();
        equal(rows.map((row) => ({ ...row })), [2, 3].map((sourceRow, index) => ({ account_no: '000123', recon_amount: precise,
          flow_no: `000${index + 1}`, key_currency: 'USD', source_row: sourceRow })), 'BizOP 候选金额/身份/币种/血缘');
      } finally { database.close(); }
      equal(fs.existsSync(store.resolve(`staging/${taskRunId}`, { mustExist: false })), false, 'BizOP 最后资源关闭后 staging 清理');
    });

    await group('rich 普通取消、await close 与真实子进程自然退出', async () => {
      const tempRoot = path.join(root, 'child-sst');
      const child = spawnSync(process.execPath, [__filename, '--close-child', fixture, tempRoot], {
        cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 15000
      });
      equal(child.error, undefined, '子进程按时退出');
      equal(child.status, 0, `子进程退出状态：${child.stderr}`);
      truth(child.stdout.includes('reader cancelled and closed'), '子进程完成取消和关闭');
      equal(fs.existsSync(tempRoot), false, '真实退出后私有 spill 根不存在');
    });

    await group('生产代码没有新增或遗留的公共 XLSX 旧 API 入边', async () => {
      const check = createDeprecatedImportChecker();
      const sourceRoot = path.resolve(__dirname, '../../src');
      const violations = [];
      function inspect(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) inspect(file);
          else if (entry.name.endsWith('.js')) {
            for (const result of check(fs.readFileSync(file, 'utf8'), file)) {
              violations.push(`${path.relative(sourceRoot, file)}:${result.line} ${result.message}`);
            }
          }
        }
      }
      inspect(sourceRoot);
      equal(violations, [], '生产路径弃用 API 入边');
      const probe = path.join(sourceRoot, 'backend/shared-xlsx-boundary-probe.js');
      for (const source of [
        "const { parseRowXml } = require('./pending-import/streaming-xlsx-reader');",
        "require('./toolbox-format/xlsx-pass').parseWorkbookXml('');",
        "const { parseWorkbookXml } = require('./toolbox-format');"
      ]) equal(check(source, probe).length, 1, '旧 shim/helper/聚合 helper 均被检查拒绝');
      equal(check("const { openToolboxXlsxPass } = require('./toolbox-format/xlsx-pass');", probe), [], 'Toolbox 业务装配保持合法');
      equal(check("const { parseWorkbookXml } = require('./xlsx/workbook-parts');", probe), [], '公共解析入口保持合法');
    });

    await group('公共 XLSX 全部模块的源码依赖闭包不反向载入业务', async () => {
      const commonRoot = path.resolve(__dirname, '../../src/backend/xlsx');
      const sourcePrefix = path.resolve(__dirname, '../../src') + path.sep;
      const allowedCommon = path.resolve(__dirname, '../../src/backend/file-service/common.js');
      const pending = [];
      function loadDirectory(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) loadDirectory(file);
          else if (entry.name.endsWith('.js')) { require(file); pending.push(require.cache[require.resolve(file)]); }
        }
      }
      loadDirectory(commonRoot);
      const seen = new Set();
      while (pending.length) {
        const current = pending.pop();
        if (seen.has(current.id)) continue;
        seen.add(current.id);
        if (current.filename.startsWith(sourcePrefix)) {
          truth(current.filename.startsWith(commonRoot + path.sep) || current.filename === allowedCommon, current.filename);
        }
        pending.push(...current.children);
      }
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  for (const skipped of skips) console.log(`SKIP ${skipped}`);
  console.log(`==== ${passed}/${passed + failures.length} PASS ====`);
  if (failures.length) process.exitCode = 1;
}

if (process.argv[2] === '--close-child') {
  runCloseChild(process.argv[3], process.argv[4]).catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  run().catch((error) => { console.error('FATAL', error); process.exitCode = 1; });
}
