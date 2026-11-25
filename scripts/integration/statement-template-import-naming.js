// 网银账单【导入模板】命名（v3.2.18）集成验证
//   覆盖：真实主库（模板、映射、渠道）+ 真实 xlsx 表头读取 + main.js 中的真实预检、命名核对与导入函数
//   ① 预检识别新模板 → 命名（小写、多空格）→ 新建「渠道名-地区」大写模板，表头与源文件名取自所选文件
//   ② 与已有模板重名（大小写不同）：prepare 阶段拒绝，token 保留可改名重试；原模板的表头与映射不变
//   ③ 与渠道重名：拒绝；名称不合规（含「-」、中文）：拒绝
//   ④ 表头与已有模板完全相同：预检直接报错，不登记待确认文件
//   ⑤ 预检后文件被改：拒绝导入、不建模板，token 作废
//   ⑥ token 不存在、已丢弃或属于别的窗口：拒绝
//   ⑦ prepare 通过后、写入前同名模板出现（并发）：execute 复核拒绝，不覆盖新出现的模板
//   UI（弹框、输入过滤、按钮）由 renderer lifecycle 覆盖；IPC prepare 的 FilePlan 由归档夹具覆盖。
//
// 用法：node scripts/integration/statement-template-import-naming.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const acorn = require('acorn');

const { AppDatabase } = require('../../src/backend/database');
const { extractHeaders, FileValidationError } = require('../../src/backend/file-service');
const {
  createPendingTemplateImportStore,
  findTemplateImportNameConflict,
  normalizeTemplateImportName
} = require('../../src/main-process/template-import-naming');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });

function loadMainFunctions(names, deps = {}) {
  const sources = names.map((name) => {
    const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
    if (!node) throw new Error(`未找到 main.js 函数：${name}`);
    return MAIN_SOURCE.slice(node.start, node.end);
  });
  const depNames = Object.keys(deps);
  return Function(...depNames, `${sources.join('\n')}\nreturn { ${names.join(', ')} };`)(...depNames.map((key) => deps[key]));
}

function writeTemplateFile(filePath, headers) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ['2026-11-01', 1]]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

const WINDOW = { sender: { id: 1 } };
const OTHER_WINDOW = { sender: { id: 2 } };

async function run() {
  console.log('==== 网银账单【导入模板】命名 集成验证 ====');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-template-import-naming-'));
  const database = new AppDatabase(path.join(temporary, 'tool-data.sqlite'));
  database.init();
  const activityLog = [];
  let librarySyncCount = 0;
  let tokenCounter = 0;
  const pendingTemplateImports = createPendingTemplateImportStore({ createToken: () => `token-${++tokenCounter}` });
  // 生产 createErrorResult 在 prepare 阶段返回带 errorCode 的预检结果；这里统一保留 errorCode 便于断言。
  const createErrorResult = ({ message, errorCode = 'BUSINESS_ERROR' }) => ({ status: 'error', message, errorCode });
  const fns = loadMainFunctions([
    'findConflictingTemplateByHeaders',
    'templateImportOwnerId',
    'createTemplateImportFileErrorResult',
    'createTemplateHeadersDuplicateResult',
    'extractStatementTemplateHeaders',
    'prepareOrdinaryTemplateImport',
    'checkOrdinaryTemplateImportName',
    'createTemplateImportExpiredResult',
    'resolveOrdinaryTemplateImport',
    'importOrdinaryTemplate'
  ], {
    database,
    path,
    extractHeaders,
    FileValidationError,
    createErrorResult,
    pendingTemplateImports,
    normalizeTemplateImportName,
    findTemplateImportNameConflict,
    syncTemplateLibraryFile: () => { librarySyncCount += 1; },
    clearLastErrorReport: () => {},
    appendActivityLogEntry: (entry) => activityLog.push(entry),
    buildTemplateSummary: (template) => ({ id: template.id, name: template.name })
  });

  let fileCounter = 0;
  function templateFile(headers, name = `sample-${++fileCounter}.xlsx`) {
    const filePath = path.join(temporary, name);
    writeTemplateFile(filePath, headers);
    return filePath;
  }

  // 模拟渲染层：预检 → 命名确认（prepare 核对 → execute 写入），与 template:import 的调用顺序一致。
  function confirm(event, options) {
    const resolved = fns.resolveOrdinaryTemplateImport(event, options);
    if (!resolved.ok) return resolved.result;
    return fns.importOrdinaryTemplate(event, options, resolved.filePath);
  }

  const existing = database.upsertTemplate({ name: 'dbs-hk', sourceFileName: 'dbs-hk.xlsx', headers: ['交易日期', '金额', '账号'] });
  const existingMappings = [{ templateField: 'BillDate', mappedField: '交易日期' }, { templateField: 'MerchantId', mappedField: '账号' }];
  database.saveMappings(existing.id, existingMappings, [{ merchantId: 'HK001', currency: 'HKD' }]);
  const existingSnapshot = JSON.stringify(database.getTemplateMappings(existing.id));

  const results = [];
  const cases = [
    ['① 预检识别新模板 → 小写、多空格命名 → 新建大写「渠道名-地区」模板，表头与源文件名取自所选文件', () => {
      const filePath = templateFile(['Value Date', 'Amount', 'Account No'], 'metacomp 原始账单.xlsx');
      const prepared = fns.prepareOrdinaryTemplateImport(1, filePath);
      assert.deepEqual(prepared, { status: 'ready', importToken: prepared.importToken, sourceFileName: 'metacomp 原始账单.xlsx' });
      const result = confirm(WINDOW, { importToken: prepared.importToken, bankName: ' meta  comp ', region: 'sg' });
      assert.equal(result.status, 'success', result.message);
      assert.equal(result.message, '已导入模板「META COMP-SG」，请在模板管理中维护映射关系');
      const created = database.getTemplateByName('META COMP-SG');
      assert.deepEqual([created.headers, created.sourceFileName], [['Value Date', 'Amount', 'Account No'], 'metacomp 原始账单.xlsx']);
      assert.equal(pendingTemplateImports.peek(prepared.importToken, 1), null);
      assert.equal(librarySyncCount, 1);
      assert.deepEqual(activityLog.at(-1).details.slice(0, 3), ['模板名：META COMP-SG', '银行渠道名：META COMP', '地区：SG']);
    }],
    ['② 与已有模板重名（大小写不同）：拒绝且 token 保留，改名后导入成功；原模板表头与映射不变', () => {
      const filePath = templateFile(['Txn Date', 'Credit', 'Debit']);
      const prepared = fns.prepareOrdinaryTemplateImport(1, filePath);
      const duplicated = confirm(WINDOW, { importToken: prepared.importToken, bankName: 'DBS', region: 'HK' });
      assert.equal(duplicated.errorCode, 'TEMPLATE_NAME_DUPLICATED');
      assert.match(duplicated.message, /已有同名模板「dbs-hk」/);
      assert.ok(pendingTemplateImports.peek(prepared.importToken, 1));
      assert.deepEqual(database.getTemplate(existing.id).headers, ['交易日期', '金额', '账号']);
      assert.equal(JSON.stringify(database.getTemplateMappings(existing.id)), existingSnapshot);
      const renamed = confirm(WINDOW, { importToken: prepared.importToken, bankName: 'dbs', region: 'sg' });
      assert.equal(renamed.status, 'success', renamed.message);
      assert.equal(database.getTemplateByName('DBS-SG').sourceFileName, path.basename(filePath));
      assert.equal(JSON.stringify(database.getTemplateMappings(existing.id)), existingSnapshot);
    }],
    ['③ 与渠道重名拒绝；名称含「-」或中文拒绝，均不建模板', () => {
      const owner = database.upsertTemplate({ name: '泰国银行-曼谷', sourceFileName: 'kbank.xlsx', headers: ['K1', 'K2'] });
      const channelId = database.saveMappings(owner.id, [{ templateField: 'BillDate', mappedField: 'K1' }], [], [], undefined, null,
        { channelAssignment: { mode: 'create' } }).channelAssignment.channelId;
      database.renameStatementChannel(channelId, 'Kbank-VN');
      const prepared = fns.prepareOrdinaryTemplateImport(1, templateFile(['C1', 'C2']));
      const before = database.listTemplates().length;
      const channelConflict = confirm(WINDOW, { importToken: prepared.importToken, bankName: 'kbank', region: 'vn' });
      assert.equal(channelConflict.errorCode, 'TEMPLATE_NAME_CHANNEL_CONFLICT');
      assert.match(channelConflict.message, /已有同名渠道「Kbank-VN」/);
      const dashed = confirm(WINDOW, { importToken: prepared.importToken, bankName: 'KBANK-TH', region: 'BKK' });
      assert.deepEqual([dashed.errorCode, dashed.message], ['TEMPLATE_IMPORT_NAME_INVALID', '银行渠道名只能输入英文字母、数字和空格']);
      const chinese = confirm(WINDOW, { importToken: prepared.importToken, bankName: 'KBANK', region: '曼谷' });
      assert.equal(chinese.errorCode, 'TEMPLATE_IMPORT_NAME_INVALID');
      assert.equal(database.listTemplates().length, before);
    }],
    ['④ 表头与已有模板完全相同：预检直接报错，不登记待确认文件', () => {
      const size = pendingTemplateImports.size();
      const prepared = fns.prepareOrdinaryTemplateImport(3, templateFile(['交易日期', '金额', '账号']));
      assert.deepEqual([prepared.status, prepared.errorCode], ['error', 'TEMPLATE_HEADERS_DUPLICATE']);
      assert.match(prepared.message, /与已有模板「dbs-hk」完全相同/);
      assert.equal(pendingTemplateImports.size(), size);
    }],
    ['⑤ 预检后文件被改：拒绝导入、不建模板，token 作废', () => {
      const filePath = templateFile(['F1', 'F2']);
      const prepared = fns.prepareOrdinaryTemplateImport(1, filePath);
      writeTemplateFile(filePath, ['F1', 'F2', 'F3']);
      const result = confirm(WINDOW, { importToken: prepared.importToken, bankName: 'CHANGED', region: 'SG' });
      assert.equal(result.errorCode, 'TEMPLATE_IMPORT_FILE_CHANGED');
      assert.equal(database.getTemplateByName('CHANGED-SG'), null);
      assert.equal(pendingTemplateImports.peek(prepared.importToken, 1), null);
    }],
    ['⑥ token 不存在、已丢弃或属于别的窗口：拒绝', () => {
      const prepared = fns.prepareOrdinaryTemplateImport(1, templateFile(['G1', 'G2']));
      assert.equal(confirm(OTHER_WINDOW, { importToken: prepared.importToken, bankName: 'G', region: 'SG' }).errorCode, 'TEMPLATE_IMPORT_EXPIRED');
      assert.equal(confirm(WINDOW, { importToken: 'missing', bankName: 'G', region: 'SG' }).errorCode, 'TEMPLATE_IMPORT_EXPIRED');
      assert.equal(confirm({}, { importToken: prepared.importToken, bankName: 'G', region: 'SG' }).errorCode, 'TEMPLATE_IMPORT_EXPIRED');
      pendingTemplateImports.discard(prepared.importToken, 1);
      assert.equal(confirm(WINDOW, { importToken: prepared.importToken, bankName: 'G', region: 'SG' }).errorCode, 'TEMPLATE_IMPORT_EXPIRED');
      assert.equal(database.getTemplateByName('G-SG'), null);
    }],
    ['⑦ prepare 通过后、写入前出现同名模板：execute 复核拒绝，不覆盖新出现的模板', () => {
      const filePath = templateFile(['H1', 'H2']);
      const prepared = fns.prepareOrdinaryTemplateImport(1, filePath);
      const options = { importToken: prepared.importToken, bankName: 'race', region: 'sg' };
      const resolved = fns.resolveOrdinaryTemplateImport(WINDOW, options);
      assert.equal(resolved.ok, true);
      const racer = database.upsertTemplate({ name: 'RACE-SG', sourceFileName: 'racer.xlsx', headers: ['R1'] });
      const result = fns.importOrdinaryTemplate(WINDOW, options, resolved.filePath);
      assert.equal(result.errorCode, 'TEMPLATE_NAME_DUPLICATED');
      assert.deepEqual(database.getTemplate(racer.id).headers, ['R1']);
      assert.equal(fns.importOrdinaryTemplate(WINDOW, options, path.join(temporary, 'other.xlsx')).errorCode, 'TEMPLATE_IMPORT_EXPIRED');
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
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
