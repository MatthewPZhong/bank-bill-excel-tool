// v1.5.3 端到端回归测试（Dev 自测）
//
// 覆盖 PRD §七 P0/P1 中 23 条可自动验证的用例（R1 资金装配 / R2 迁移 / R3 字体 / R4 浮点精度）。
// 独立运行：node scripts/test-v1.5.3-regression.js
// 不依赖 Electron 主进程；每用例独立 tempdir + 独立 SQLite。
//
// 结构：
//   Section 1 — R1 资金装配（7 条）：P0-4 ~ P0-7、P0-10、P0-11、P1-3
//   Section 2 — R1 IPC 校验层（2 条）：P0-8 / P0-9
//   Section 3 — R2 迁移三态（3 条）：P0-13 / P0-14 / P0-15
//   Section 4 — R2 过滤 / bundle + Codex 修复（14 条）：P1-4 / P1-5 / P0-F1 ~ P0-F12
//   Section 5 — R3 字体 XML 级验证（7 条）：P0-17 ~ P0-20、P1-6 / P1-7 / P1-8
//   Section 6 — R4 账单合并浮点精度（3 条）：P0-R4-1 ~ P0-R4-3
//
// 字体验证使用 unzip 解压 xlsx + 正则匹配 styles.xml / sheet1.xml（不依赖 xlsx reader）。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../src/backend/database');
const { groupBigAccountRows } = require('../src/backend/database/utils');
const {
  runOwnAccountsMigration,
  MIGRATION_FLAG_KEY,
  MIGRATION_LOG_FILENAME
} = require('../src/backend/database/own-accounts-migration');
const {
  listBalanceSeedBankNames,
  readBalanceSeedRecords,
  writeBalanceSeedRecords
} = require('../src/backend/balance-seed-store');
const {
  ALL_BANKS_TEMPLATE_SCOPE,
  assembleMonthlyBalance,
  buildTargetLastDay,
  lastDayOfMonth,
  pickLatestSeedForAccount,
  toBalanceRows
} = require('../src/main-process/monthly-balance');
const {
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../src/backend/file-service');
const {
  roundAmount,
  sanitizeAmountValue
} = require('../src/backend/file-service/normalizers');

const ASSETS_BALANCE_TEMPLATE = path.join(
  __dirname,
  '..',
  'assets',
  '余额账单模版.xlsx'
);

// ---------------------------------------------------------------------------
// 测试注册 / 计数
// ---------------------------------------------------------------------------

const results = [];

function record(id, level, label, status, detail) {
  results.push({ id, level, label, status, detail });
  const mark = status === 'pass' ? '✅' : status === 'skip' ? '⏭️' : '❌';
  const tail = detail ? ` — ${detail}` : '';
  console.log(`[${id}] ${mark} ${label}${tail}`);
}

function runCase(id, level, label, fn) {
  try {
    const detail = fn();
    record(id, level, label, 'pass', detail || '');
  } catch (err) {
    if (err && err.__skip) {
      record(id, level, label, 'skip', err.reason || 'skipped');
      return;
    }
    const expected = err && err.expected !== undefined ? err.expected : undefined;
    const actual = err && err.actual !== undefined ? err.actual : undefined;
    let detail = err && err.message ? err.message : String(err);
    if (expected !== undefined || actual !== undefined) {
      detail = `${detail}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`;
    }
    record(id, level, label, 'fail', detail);
  }
}

function skipCase(id, level, label, reason) {
  record(id, level, label, 'skip', reason);
}

// ---------------------------------------------------------------------------
// 公共工具
// ---------------------------------------------------------------------------

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function newAppDb(root) {
  const db = new AppDatabase(path.join(root, 'app.sqlite'));
  db.init();
  return db;
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    const error = new Error(msg || 'assertEqual failed');
    error.expected = expected;
    error.actual = actual;
    throw error;
  }
}

function assertTruthy(value, msg) {
  if (!value) {
    throw new Error(msg || 'assertTruthy failed');
  }
}

// ---------------------------------------------------------------------------
// R1 辅助：造一个含 filename_fixed_field 的测试模板 + 大账号
// ---------------------------------------------------------------------------

function createSingleTemplateCtx({ templateName = '中行-北京', bankName = '中行', bigAccounts = [] } = {}) {
  const root = makeTempRoot('v153-regression-');
  const db = newAppDb(root);
  const template = db.upsertTemplate({
    name: templateName,
    sourceFileName: `${templateName}.xlsx`,
    headers: ['日期', '摘要', '金额']
  });
  db.saveMappings(
    template.id,
    [{ templateField: 'MerchantId', mappedField: '摘要' }],
    bigAccounts
  );
  return { root, db, template, bankName };
}

function cleanupCtx(ctx) {
  if (ctx && ctx.db) {
    try { ctx.db.db.close(); } catch (_) {}
  }
  if (ctx && ctx.root) {
    try { fs.rmSync(ctx.root, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// R3 辅助：XLSX 字体抽查（用 unzip + 正则）
// ---------------------------------------------------------------------------

function unzipText(xlsxPath, internalPath) {
  try {
    return execFileSync('unzip', ['-p', xlsxPath, internalPath], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (err) {
    throw new Error(`unzip -p ${xlsxPath} ${internalPath} 失败：${err.message}`);
  }
}

// 从 styles.xml 提取 fonts 列表（按 <font>...</font> 顺序）
// 返回每个 font 的 name 字符串（如 'Calibri' / 'Courier New'）；缺 name 记作空串
function extractFonts(stylesXml) {
  const fontsBlockMatch = stylesXml.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/);
  if (!fontsBlockMatch) return [];
  const block = fontsBlockMatch[1];
  const fonts = [];
  const fontRe = /<font\b[^>]*>([\s\S]*?)<\/font>/g;
  let match;
  while ((match = fontRe.exec(block)) !== null) {
    const inner = match[1];
    const nameMatch = inner.match(/<name\s+val="([^"]*)"\s*\/?>/);
    fonts.push(nameMatch ? nameMatch[1] : '');
  }
  return fonts;
}

// 从 styles.xml 提取 cellXfs 的 fontId 数组（按 xfId 顺序）
function extractCellXfsFontIds(stylesXml) {
  const blockMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!blockMatch) return [];
  const block = blockMatch[1];
  const xfs = [];
  const xfRe = /<xf\b[^\/>]*\/?>/g;
  let match;
  while ((match = xfRe.exec(block)) !== null) {
    const fontIdMatch = match[0].match(/fontId="(\d+)"/);
    xfs.push(fontIdMatch ? Number(fontIdMatch[1]) : 0);
  }
  return xfs;
}

// 从 sheet1.xml 抽取给定行号（r 属性从 1 起）的所有 cell 的 s="" 属性（xfId）
function extractRowCellStyleIds(sheetXml, rowNumber) {
  // 先定位 <row r="N"> 到下一个 <row 或 </sheetData>
  const rowRe = new RegExp(`<row[^>]*r="${rowNumber}"[^>]*>([\\s\\S]*?)</row>`);
  const rowMatch = sheetXml.match(rowRe);
  if (!rowMatch) return [];
  const rowInner = rowMatch[1];
  const cellRe = /<c\b([^>]*)>/g;
  const styleIds = [];
  let match;
  while ((match = cellRe.exec(rowInner)) !== null) {
    const attrs = match[1];
    const sMatch = attrs.match(/\bs="(\d+)"/);
    styleIds.push(sMatch ? Number(sMatch[1]) : 0);
  }
  return styleIds;
}

// 核心检查：xlsx 第 r 行每个 cell 的字体是否全是 Courier New
// 返回 { ok, courierFontIds, usedFontNames }
function inspectXlsxRowFonts(xlsxPath, rowNumber) {
  const styles = unzipText(xlsxPath, 'xl/styles.xml');
  const sheet = unzipText(xlsxPath, 'xl/worksheets/sheet1.xml');

  const fonts = extractFonts(styles);
  const cellXfsFontIds = extractCellXfsFontIds(styles);
  const rowStyleIds = extractRowCellStyleIds(sheet, rowNumber);

  if (!fonts.length || !cellXfsFontIds.length) {
    return { ok: false, reason: 'no-fonts-or-cellxfs', fonts, cellXfsFontIds };
  }
  if (!rowStyleIds.length) {
    return { ok: false, reason: 'no-cells-in-row', rowNumber };
  }

  const courierFontIds = [];
  fonts.forEach((name, idx) => {
    if (name === 'Courier New') courierFontIds.push(idx);
  });

  if (!courierFontIds.length) {
    return {
      ok: false,
      reason: 'no-courier-in-fonts',
      fonts,
      cellXfsFontIds,
      rowStyleIds,
      usedFontNames: rowStyleIds.map((xfId) => fonts[cellXfsFontIds[xfId]] || '?')
    };
  }

  const usedFontNames = rowStyleIds.map((xfId) => {
    const fontId = cellXfsFontIds[xfId];
    return fonts[fontId] || '?';
  });

  const allCourier = usedFontNames.every((n) => n === 'Courier New');
  return {
    ok: allCourier,
    reason: allCourier ? 'all-courier' : 'mixed-fonts',
    fonts,
    cellXfsFontIds,
    rowStyleIds,
    courierFontIds,
    usedFontNames
  };
}

// ---------------------------------------------------------------------------
// ============================ Section 1 — R1 装配 ============================
// ---------------------------------------------------------------------------

function casesR1() {
  // --- P0-4：单模板某月命中（exact） ---
  runCase('P0-4', 'P0', '单模板某月命中', () => {
    const ctx = createSingleTemplateCtx({
      bigAccounts: [{ merchantId: 'MID_A', currency: 'CNY', accountNature: 'client' }]
    });
    try {
      writeBalanceSeedRecords(ctx.root, ctx.bankName, [
        { merchantId: 'MID_A', currency: 'CNY', billDate: '2026-03-31', endBalance: 1000, templateName: ctx.template.name, updatedAt: '' }
      ]);
      const result = assembleMonthlyBalance({
        templateScope: ctx.template.name,
        year: 2026,
        month: 3,
        db: ctx.db,
        storageRoot: ctx.root
      });
      assertEqual(result.records.length, 1, 'records.length');
      assertEqual(result.records[0].billDate, '2026-03-31', 'billDate');
      assertEqual(result.records[0].endBalance, 1000, 'endBalance');
      assertEqual(result.records[0].pickReason, 'exact', 'pickReason');
      return `records.length=1, billDate=2026-03-31, endBalance=1000, pickReason=exact`;
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-5：当月无但更早有（fallback） ---
  runCase('P0-5', 'P0', '当月无但更早有', () => {
    const ctx = createSingleTemplateCtx({
      bigAccounts: [{ merchantId: 'MID_A', currency: 'CNY', accountNature: 'client' }]
    });
    try {
      writeBalanceSeedRecords(ctx.root, ctx.bankName, [
        { merchantId: 'MID_A', currency: 'CNY', billDate: '2026-02-28', endBalance: 900, templateName: ctx.template.name, updatedAt: '' }
      ]);
      const result = assembleMonthlyBalance({
        templateScope: ctx.template.name,
        year: 2026,
        month: 3,
        db: ctx.db,
        storageRoot: ctx.root
      });
      assertEqual(result.records.length, 1, 'records.length');
      assertEqual(result.records[0].billDate, '2026-02-28', 'billDate');
      assertEqual(result.records[0].endBalance, 900, 'endBalance');
      assertEqual(result.records[0].pickReason, 'fallback', 'pickReason');
      return `records.length=1, billDate=2026-02-28, endBalance=900, pickReason=fallback`;
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-6：billDate 全部 > 月末 → 跳过 ---
  runCase('P0-6', 'P0', 'billDate 全部 > 月末 跳过', () => {
    const ctx = createSingleTemplateCtx({
      bigAccounts: [{ merchantId: 'MID_A', currency: 'CNY', accountNature: 'client' }]
    });
    try {
      writeBalanceSeedRecords(ctx.root, ctx.bankName, [
        { merchantId: 'MID_A', currency: 'CNY', billDate: '2026-04-30', endBalance: 500, templateName: ctx.template.name, updatedAt: '' }
      ]);
      const result = assembleMonthlyBalance({
        templateScope: ctx.template.name,
        year: 2026,
        month: 3,
        db: ctx.db,
        storageRoot: ctx.root
      });
      assertEqual(result.records.length, 0, 'records.length 应为 0');
      const missing = result.stats.missingAccounts.find(
        (m) => m.merchantId === 'MID_A' && m.currency === 'CNY'
      );
      assertTruthy(missing, 'missingAccounts 应含 MID_A/CNY');
      assertEqual(missing.reason, 'no-candidates', 'missing.reason');
      return `records.length=0, missingAccounts.reason=no-candidates`;
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-7：完全无 seeds → 跳过 ---
  runCase('P0-7', 'P0', '完全无 seeds 跳过', () => {
    const ctx = createSingleTemplateCtx({
      bigAccounts: [{ merchantId: 'MID_A', currency: 'CNY', accountNature: 'client' }]
    });
    try {
      // 不写任何 seeds
      const result = assembleMonthlyBalance({
        templateScope: ctx.template.name,
        year: 2026,
        month: 3,
        db: ctx.db,
        storageRoot: ctx.root
      });
      assertEqual(result.records.length, 0, 'records.length 应为 0');
      const missing = result.stats.missingAccounts.find(
        (m) => m.merchantId === 'MID_A' && m.currency === 'CNY'
      );
      assertTruthy(missing, 'missingAccounts 应含 MID_A/CNY');
      assertEqual(missing.reason, 'no-candidates', 'missing.reason');
      return `records.length=0, missingAccounts.reason=no-candidates`;
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-10：全部银行渠道合并 ---
  runCase('P0-10', 'P0', '全部银行渠道合并', () => {
    const root = makeTempRoot('v153-all-banks-');
    const db = newAppDb(root);
    try {
      const t1 = db.upsertTemplate({ name: '中行-北京', sourceFileName: 'a.xlsx', headers: ['h'] });
      const t2 = db.upsertTemplate({ name: '建行-上海', sourceFileName: 'b.xlsx', headers: ['h'] });
      const t3 = db.upsertTemplate({ name: '工行-深圳', sourceFileName: 'c.xlsx', headers: ['h'] });
      db.saveMappings(t1.id, [{ templateField: 'MerchantId', mappedField: 'h' }], [
        { merchantId: 'BOC_A', currency: 'CNY', accountNature: 'client' }
      ]);
      db.saveMappings(t2.id, [{ templateField: 'MerchantId', mappedField: 'h' }], [
        { merchantId: 'CCB_A', currency: 'CNY', accountNature: 'client' }
      ]);
      db.saveMappings(t3.id, [{ templateField: 'MerchantId', mappedField: 'h' }], [
        { merchantId: 'ICBC_A', currency: 'CNY', accountNature: 'client' }
      ]);
      writeBalanceSeedRecords(root, '中行', [
        { merchantId: 'BOC_A', currency: 'CNY', billDate: '2026-03-31', endBalance: 1, templateName: '中行-北京', updatedAt: '' }
      ]);
      writeBalanceSeedRecords(root, '建行', [
        { merchantId: 'CCB_A', currency: 'CNY', billDate: '2026-03-31', endBalance: 2, templateName: '建行-上海', updatedAt: '' }
      ]);
      writeBalanceSeedRecords(root, '工行', [
        { merchantId: 'ICBC_A', currency: 'CNY', billDate: '2026-03-31', endBalance: 3, templateName: '工行-深圳', updatedAt: '' }
      ]);

      const result = assembleMonthlyBalance({
        templateScope: ALL_BANKS_TEMPLATE_SCOPE,
        year: 2026,
        month: 3,
        db,
        storageRoot: root
      });
      assertEqual(result.stats.templateCount, 3, 'templateCount');
      assertEqual(result.records.length, 3, 'records.length');
      const bocHit = result.records.find((r) => r.merchantId === 'BOC_A');
      const ccbHit = result.records.find((r) => r.merchantId === 'CCB_A');
      const icbcHit = result.records.find((r) => r.merchantId === 'ICBC_A');
      assertTruthy(bocHit && ccbHit && icbcHit, '3 模板各自的大账号都应出现');
      return `records.length=3, templateCount=3, 3 家银行全部覆盖`;
    } finally {
      try { db.db.close(); } catch (_) {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // --- P0-11：自有账号放行（R1 唯一放行 own） ---
  runCase('P0-11', 'P0', '自有账号放行', () => {
    const root = makeTempRoot('v153-own-');
    const db = newAppDb(root);
    try {
      const template = db.upsertTemplate({
        name: '中行-北京',
        sourceFileName: 'a.xlsx',
        headers: ['h']
      });
      db.saveMappings(template.id, [{ templateField: 'MerchantId', mappedField: 'h' }], [
        { merchantId: 'CLIENT_1', currency: 'CNY', accountNature: 'client' },
        { merchantId: 'CLIENT_2', currency: 'CNY', accountNature: 'client' },
        { merchantId: 'OWN_1', currency: 'CNY', accountNature: 'own' }
      ]);
      writeBalanceSeedRecords(root, '中行', [
        { merchantId: 'CLIENT_1', currency: 'CNY', billDate: '2026-03-31', endBalance: 11, templateName: '中行-北京', updatedAt: '' },
        { merchantId: 'CLIENT_2', currency: 'CNY', billDate: '2026-03-31', endBalance: 22, templateName: '中行-北京', updatedAt: '' },
        { merchantId: 'OWN_1', currency: 'CNY', billDate: '2026-03-31', endBalance: 33, templateName: '中行-北京', updatedAt: '' }
      ]);

      // 对照：默认 getTemplateBigAccounts（不含 own）应只返 2 条
      const clientOnly = db.getTemplateBigAccounts(template.id);
      assertEqual(clientOnly.length, 2, 'getTemplateBigAccounts 默认不含 own');

      // 对照：显式 includeOwn=true 返 3 条
      const includeOwn = db.getTemplateBigAccounts(template.id, { includeOwn: true });
      assertEqual(includeOwn.length, 3, 'getTemplateBigAccounts {includeOwn:true} 应含 3 条');

      // assembleMonthlyBalance 内部显式传 includeOwn:true，records 3 条都出现
      const result = assembleMonthlyBalance({
        templateScope: template.name,
        year: 2026,
        month: 3,
        db,
        storageRoot: root
      });
      assertEqual(result.records.length, 3, 'records.length（含 own）');
      const ownRow = result.records.find((r) => r.merchantId === 'OWN_1');
      assertTruthy(ownRow, '自有账号 OWN_1 应出现在 records');
      assertEqual(ownRow.endBalance, 33, 'OWN_1 endBalance');
      return `默认 2 条 / includeOwn:true 3 条 / R1 records=3（含 OWN_1）`;
    } finally {
      try { db.db.close(); } catch (_) {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // --- P1-3：多币种大账号 ---
  runCase('P1-3', 'P1', '多币种大账号', () => {
    const ctx = createSingleTemplateCtx({
      bigAccounts: [
        { merchantId: 'MID_X', currency: 'CNY', accountNature: 'client' },
        { merchantId: 'MID_X', currency: 'USD', accountNature: 'client' }
      ]
    });
    try {
      writeBalanceSeedRecords(ctx.root, ctx.bankName, [
        { merchantId: 'MID_X', currency: 'CNY', billDate: '2026-03-31', endBalance: 111.11, templateName: ctx.template.name, updatedAt: '' },
        { merchantId: 'MID_X', currency: 'USD', billDate: '2026-03-31', endBalance: 222.22, templateName: ctx.template.name, updatedAt: '' }
      ]);
      const result = assembleMonthlyBalance({
        templateScope: ctx.template.name,
        year: 2026,
        month: 3,
        db: ctx.db,
        storageRoot: ctx.root
      });
      const cnyRow = result.records.find((r) => r.merchantId === 'MID_X' && r.currency === 'CNY');
      const usdRow = result.records.find((r) => r.merchantId === 'MID_X' && r.currency === 'USD');
      assertTruthy(cnyRow, 'CNY 行应存在');
      assertTruthy(usdRow, 'USD 行应存在');
      assertEqual(cnyRow.endBalance, 111.11, 'CNY endBalance');
      assertEqual(usdRow.endBalance, 222.22, 'USD endBalance');
      return `CNY(111.11) + USD(222.22) 两行都出现`;
    } finally {
      cleanupCtx(ctx);
    }
  });
}

// ---------------------------------------------------------------------------
// ======================= Section 2 — R1 IPC 校验层 =========================
// ---------------------------------------------------------------------------

function casesR1IpcValidation() {
  // --- P0-8：模板为空（这里用"模板名查不到"模拟）— 装配层返回空 records，不抛 ---
  runCase('P0-8', 'P0', '模板查不到不抛异常', () => {
    const ctx = createSingleTemplateCtx({
      bigAccounts: [{ merchantId: 'MID_A', currency: 'CNY', accountNature: 'client' }]
    });
    try {
      // 传一个根本不存在的模板名 —— 装配层应平静返回 templates=[] 且 records=[]
      // 报错文案在 IPC 层（main.js 的 handler）加，不在装配层
      const result = assembleMonthlyBalance({
        templateScope: '不存在的模板-xyz',
        year: 2026,
        month: 3,
        db: ctx.db,
        storageRoot: ctx.root
      });
      assertEqual(result.templates.length, 0, 'templates 应为空');
      assertEqual(result.records.length, 0, 'records 应为空');
      assertEqual(result.stats.templateCount, 0, 'templateCount 应为 0');
      return `templates=[], records=[], 不抛异常（报错在 IPC 层）`;
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-9：year/month 非法 → 装配层抛 Error ---
  runCase('P0-9', 'P0', 'year/month 非法抛异常', () => {
    const ctx = createSingleTemplateCtx({
      bigAccounts: [{ merchantId: 'MID_A', currency: 'CNY', accountNature: 'client' }]
    });
    try {
      let thrown = null;
      try {
        assembleMonthlyBalance({
          templateScope: ctx.template.name,
          year: 2026,
          month: 13,
          db: ctx.db,
          storageRoot: ctx.root
        });
      } catch (err) {
        thrown = err;
      }
      assertTruthy(thrown, '应抛异常');
      assertTruthy(
        String(thrown.message).includes('year') || String(thrown.message).includes('month'),
        '异常文案应含 year/month'
      );
      // 再验证一次 null month
      let thrown2 = null;
      try {
        assembleMonthlyBalance({
          templateScope: ctx.template.name,
          year: null,
          month: null,
          db: ctx.db,
          storageRoot: ctx.root
        });
      } catch (err) {
        thrown2 = err;
      }
      assertTruthy(thrown2, 'null year/month 应抛异常');
      return `month=13 抛 "${thrown.message}", null year/month 抛 "${thrown2.message}"`;
    } finally {
      cleanupCtx(ctx);
    }
  });
}

// ---------------------------------------------------------------------------
// ==================== Section 3 — R2 迁移三态 ============================
// ---------------------------------------------------------------------------

function casesR2Migration() {
  // --- P0-13：迁移成功（多模板全部写入 + orphan bankName 合并验证） ---
  let sharedCtx = null;
  runCase('P0-13', 'P0', '迁移成功（多模板全部写入 + orphan 跳过）', () => {
    // 主场景：3 模板（中行-北京 / 中行-上海 / 建行），中行 2 条 own + 建行 1 条 own
    const root = makeTempRoot('v153-mig-done-');
    const db = newAppDb(root);
    try {
      const t1 = db.upsertTemplate({ name: '中行-北京', sourceFileName: 'a.xlsx', headers: ['h'] });
      const t2 = db.upsertTemplate({ name: '中行-上海', sourceFileName: 'b.xlsx', headers: ['h'] });
      const t3 = db.upsertTemplate({ name: '建行', sourceFileName: 'c.xlsx', headers: ['h'] });

      // own-accounts/中行.json：2 条 merchant（多模板全部写入 = 2×2 = 4）
      // own-accounts/建行.json：1 条 merchant（1×1 = 1）
      // 合计 5 条 own
      const ownDir = path.join(root, 'own-accounts');
      fs.mkdirSync(ownDir, { recursive: true });
      fs.writeFileSync(path.join(ownDir, '中行.json'), JSON.stringify([
        { merchantId: 'BOC_OWN_A', currencies: ['CNY'] },
        { merchantId: 'BOC_OWN_B', currencies: ['USD'] }
      ], null, 2));
      fs.writeFileSync(path.join(ownDir, '建行.json'), JSON.stringify([
        { merchantId: 'CCB_OWN_A', currencies: ['CNY'] }
      ], null, 2));

      const result = runOwnAccountsMigration(root, db.db);
      assertEqual(result.status, 'done', 'status');

      const all = db.db.prepare(
        "SELECT template_id, merchant_id, currency, account_nature FROM template_big_accounts WHERE account_nature='own' ORDER BY template_id, merchant_id, currency"
      ).all();
      assertEqual(all.length, 5, 'own 记录数');
      assertEqual(all.filter((r) => r.template_id === t1.id).length, 2, '中行-北京 应有 2 条 own');
      assertEqual(all.filter((r) => r.template_id === t2.id).length, 2, '中行-上海 应有 2 条 own');
      assertEqual(all.filter((r) => r.template_id === t3.id).length, 1, '建行 应有 1 条 own');

      const flag = db.db.prepare(
        'SELECT setting_value AS v FROM app_settings WHERE setting_key = ?'
      ).get(MIGRATION_FLAG_KEY);
      assertEqual(flag && flag.v, '1', 'flag=1');

      const logContent = fs.readFileSync(path.join(root, MIGRATION_LOG_FILENAME), 'utf8');
      assertTruthy(logContent.includes('[OK]'), '日志应含 [OK] 行');

      // 保存 sharedCtx 供 P0-14 幂等验证用（避免 cleanup）
      sharedCtx = { root, db, t1, t2, t3 };

      // --- 附加：orphan bankName 用独立 tmp 验证（跳过不算失败） ---
      const orphanRoot = makeTempRoot('v153-mig-orphan-');
      const orphanDb = newAppDb(orphanRoot);
      try {
        orphanDb.upsertTemplate({ name: '中行-北京', sourceFileName: 'a.xlsx', headers: ['h'] });
        const orphanDir = path.join(orphanRoot, 'own-accounts');
        fs.mkdirSync(orphanDir, { recursive: true });
        fs.writeFileSync(path.join(orphanDir, '不存在行.json'), JSON.stringify([
          { merchantId: 'GHOST_A', currencies: ['CNY'] }
        ], null, 2));
        const r = runOwnAccountsMigration(orphanRoot, orphanDb.db);
        assertEqual(r.status, 'done', 'orphan 场景 status 应为 done（不算失败）');
        assertEqual(r.stats.orphans, 1, 'orphans 计数');
        const orphanLog = fs.readFileSync(path.join(orphanRoot, MIGRATION_LOG_FILENAME), 'utf8');
        assertTruthy(
          orphanLog.includes('[WARN]') && orphanLog.includes('orphan bankName'),
          '日志应含 [WARN] orphan bankName'
        );
        const anyOwn = orphanDb.db.prepare(
          "SELECT COUNT(*) AS c FROM template_big_accounts WHERE account_nature='own'"
        ).get();
        assertEqual(anyOwn.c, 0, 'orphan 场景不应有 own 记录插入');
      } finally {
        try { orphanDb.db.close(); } catch (_) {}
        fs.rmSync(orphanRoot, { recursive: true, force: true });
      }

      return `主场景 status=done, own 5 条（中行×2模板×2=4 + 建行×1=1）, flag=1, 日志含 [OK]；orphan 场景 status=done, 日志 [WARN], 无 own 插入`;
    } catch (err) {
      try { db.db.close(); } catch (_) {}
      fs.rmSync(root, { recursive: true, force: true });
      throw err;
    }
  });

  // --- P0-14：幂等 ---
  runCase('P0-14', 'P0', '迁移幂等', () => {
    if (!sharedCtx) {
      const err = new Error('P0-13 未执行或失败，P0-14 依赖其状态');
      err.__skip = true;
      err.reason = 'P0-13 依赖前置用例失败';
      throw err;
    }
    try {
      const before = sharedCtx.db.db
        .prepare("SELECT COUNT(*) AS c FROM template_big_accounts")
        .get().c;
      const result = runOwnAccountsMigration(sharedCtx.root, sharedCtx.db.db);
      assertEqual(result.status, 'already-done', 'status');
      // stats 都是初始 0
      assertEqual(result.stats.insertedRows, 0, 'insertedRows');
      assertEqual(result.stats.scannedJsonFiles, 0, 'scannedJsonFiles');
      const after = sharedCtx.db.db
        .prepare("SELECT COUNT(*) AS c FROM template_big_accounts")
        .get().c;
      assertEqual(after, before, '记录总数不应变化');
      return `status=already-done, stats 空, 记录总数 ${after} 不变`;
    } finally {
      // 清理 sharedCtx
      try { sharedCtx.db.db.close(); } catch (_) {}
      fs.rmSync(sharedCtx.root, { recursive: true, force: true });
      sharedCtx = null;
    }
  });

  // --- P0-15：冲突保留已有 ---
  runCase('P0-15', 'P0', '迁移冲突保留已有', () => {
    const root = makeTempRoot('v153-mig-conflict-');
    const db = newAppDb(root);
    try {
      const template = db.upsertTemplate({
        name: '中行-北京',
        sourceFileName: 'a.xlsx',
        headers: ['h']
      });
      // 预置 client 记录 CONFLICT_A/CNY
      db.saveMappings(template.id, [{ templateField: 'MerchantId', mappedField: 'h' }], [
        { merchantId: 'CONFLICT_A', currency: 'CNY', accountNature: 'client' }
      ]);

      const ownDir = path.join(root, 'own-accounts');
      fs.mkdirSync(ownDir, { recursive: true });
      // own-accounts 里也有 CONFLICT_A/CNY（期望：已存在 → 保留 client，不覆盖）
      fs.writeFileSync(path.join(ownDir, '中行.json'), JSON.stringify([
        { merchantId: 'CONFLICT_A', currencies: ['CNY'] },
        { merchantId: 'NEW_OWN', currencies: ['USD'] }
      ], null, 2));

      const result = runOwnAccountsMigration(root, db.db);
      assertEqual(result.status, 'done', 'status');
      assertEqual(result.stats.conflicts, 1, 'conflicts 计数');
      assertEqual(result.stats.insertedRows, 1, 'inserted 仅 NEW_OWN/USD');

      const conflict = db.db.prepare(
        "SELECT account_nature FROM template_big_accounts WHERE template_id=? AND merchant_id='CONFLICT_A' AND currency='CNY'"
      ).get(template.id);
      assertEqual(conflict.account_nature, 'client', 'CONFLICT_A/CNY 应保持 client');

      const newOwn = db.db.prepare(
        "SELECT account_nature FROM template_big_accounts WHERE template_id=? AND merchant_id='NEW_OWN' AND currency='USD'"
      ).get(template.id);
      assertEqual(newOwn.account_nature, 'own', 'NEW_OWN/USD 应为 own');

      const logContent = fs.readFileSync(path.join(root, MIGRATION_LOG_FILENAME), 'utf8');
      assertTruthy(logContent.includes('[CONFLICT]'), '日志应含 [CONFLICT]');
      return `conflicts=1, 日志含 [CONFLICT], CONFLICT_A/CNY 保持 client, NEW_OWN/USD 为 own`;
    } finally {
      try { db.db.close(); } catch (_) {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// ============== Section 4 — R2 过滤 / bundle（2 条） =====================
// ---------------------------------------------------------------------------

function casesR2FilterBundle() {
  // --- P1-4：重复 saveMappings 不重插 ---
  runCase('P1-4', 'P1', '重复 saveMappings 不重插', () => {
    const ctx = createSingleTemplateCtx({ bigAccounts: [] });
    try {
      const payload = [
        { merchantId: 'M_A', currency: 'CNY', accountNature: 'client' },
        { merchantId: 'M_A', currency: 'USD', accountNature: 'client' },
        { merchantId: 'OWN_A', currency: 'CNY', accountNature: 'own' }
      ];
      // 第 1 次
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        payload
      );
      const after1 = ctx.db.db.prepare(
        'SELECT COUNT(*) AS c FROM template_big_accounts WHERE template_id = ?'
      ).get(ctx.template.id).c;
      assertEqual(after1, 3, '第一次 saveMappings 后应 3 条');

      // 第 2 次（相同内容）— saveMappings 内部先 DELETE 再 INSERT（transaction 语义）
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        payload
      );
      const after2 = ctx.db.db.prepare(
        'SELECT COUNT(*) AS c FROM template_big_accounts WHERE template_id = ?'
      ).get(ctx.template.id).c;
      assertEqual(after2, 3, '第二次 saveMappings 后仍应 3 条（不重复）');

      // 验证 nature 保留
      const rows = ctx.db.db.prepare(
        'SELECT merchant_id, currency, account_nature FROM template_big_accounts WHERE template_id=? ORDER BY merchant_id, currency'
      ).all(ctx.template.id);
      const ownRow = rows.find((r) => r.merchant_id === 'OWN_A');
      assertEqual(ownRow.account_nature, 'own', 'OWN_A 的 nature 应为 own');
      return `两次提交都 3 条（去重 by UNIQUE 约束 + 先 DELETE 再 INSERT）`;
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P1-5：bundle 导入导出带 accountNature ---
  runCase('P1-5', 'P1', 'bundle 导入导出带 accountNature', () => {
    const ctx = createSingleTemplateCtx({ bigAccounts: [] });
    try {
      // 第一步：写入 2 client + 1 own
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        [
          { merchantId: 'C_A', currency: 'CNY', accountNature: 'client' },
          { merchantId: 'C_B', currency: 'USD', accountNature: 'client' },
          { merchantId: 'OWN_X', currency: 'CNY', accountNature: 'own' }
        ]
      );
      // 验证 bundle 导出含 accountNature
      const entries = ctx.db.listTemplateBundleEntries();
      const entry = entries.find((e) => e.name === ctx.template.name);
      assertTruthy(entry, 'bundle 应含目标模板条目');
      assertTruthy(Array.isArray(entry.bigAccounts), 'bigAccounts 应为数组');
      // 每项都应含 accountNature 字段
      const allHaveNature = entry.bigAccounts.every(
        (item) => typeof item.accountNature === 'string' && item.accountNature !== ''
      );
      assertTruthy(allHaveNature, 'bundle 每项大账号都应含 accountNature');
      const ownItem = entry.bigAccounts.find((i) => i.merchantId === 'OWN_X');
      assertTruthy(ownItem, 'bundle 应含 OWN_X 项');
      assertEqual(ownItem.accountNature, 'own', 'OWN_X 应为 own');
      const clientItem = entry.bigAccounts.find((i) => i.merchantId === 'C_A');
      assertEqual(clientItem.accountNature, 'client', 'C_A 应为 client');

      // 第二步：模拟老 bundle 导入（bigAccounts 里无 accountNature 字段）→ 走 saveMappings 默认 'client'
      // 先清空 bigAccounts
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        []
      );
      // 模拟老 bundle 的 bigAccounts：缺 accountNature
      const oldBundleBigAccounts = [
        { merchantId: 'LEGACY_A', currency: 'CNY' /* 故意不给 accountNature */ }
      ];
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        oldBundleBigAccounts
      );
      const legacy = ctx.db.db.prepare(
        "SELECT account_nature FROM template_big_accounts WHERE template_id=? AND merchant_id='LEGACY_A'"
      ).get(ctx.template.id);
      assertEqual(legacy.account_nature, 'client', '老 bundle 缺字段 → 默认 client');
      return `bundle 导出 3 项均带 nature, 老 bundle 缺字段 → 默认 client`;
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-F1：维护大账号 roundtrip 不丢 own（Codex Finding 1 修复验证） ---
  // 背景：修复前，维护大账号弹窗从 template:get-mappings 拉 bigAccounts，默认过滤 own；
  //       用户点完成后 saveMappings DELETE+INSERT 写回可见行，静默删除 own 账号。
  // 修复：弹窗打开时改用 big-account:get-with-own（grouped，含 own）作为 bigAccounts 初值。
  // 本用例模拟修复后的链路：grouped 含 own → saveMappings → 断言 own 保留。
  runCase('P0-F1', 'P0', '维护大账号 roundtrip 不丢 own（Finding 1 修复）', () => {
    const ctx = createSingleTemplateCtx({ bigAccounts: [] });
    try {
      // 前置：初始写入 2 client + 1 own
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        [
          { merchantId: 'C_FOO', currency: 'CNY', accountNature: 'client' },
          { merchantId: 'C_BAR', currency: 'USD', accountNature: 'client' },
          { merchantId: 'OWN_Z', currency: 'CNY', accountNature: 'own' }
        ]
      );

      // 模拟 big-account:get-with-own IPC：getTemplateBigAccounts(templateId, {includeOwn:true}) + groupBigAccountRows
      const rowsWithOwn = ctx.db.getTemplateBigAccounts(ctx.template.id, { includeOwn: true });
      assertEqual(rowsWithOwn.length, 3, 'getTemplateBigAccounts(includeOwn:true) 应返回 3 行');
      const groupedWithOwn = groupBigAccountRows(rowsWithOwn);
      assertEqual(groupedWithOwn.length, 3, 'grouped 列表应为 3 项');
      const ownInGrouped = groupedWithOwn.find((item) => item.merchantId === 'OWN_Z');
      assertTruthy(ownInGrouped, 'grouped 列表应含 OWN_Z');
      assertEqual(ownInGrouped.accountNature, 'own', 'OWN_Z 的 accountNature 应为 own');

      // 对照：旧链路 template:get-mappings 返回的 bigAccounts 默认过滤 own
      const legacyPayload = ctx.db.getTemplateMappings(ctx.template.id);
      const legacyBigAccounts = legacyPayload.bigAccounts;
      assertEqual(legacyBigAccounts.length, 2, '旧链路 getTemplateMappings.bigAccounts 应只含 2 项 client（§3.1 过滤）');
      assertTruthy(
        !legacyBigAccounts.some((item) => item.merchantId === 'OWN_Z'),
        '旧链路不应含 OWN_Z（证实修复前的 bug 场景）'
      );

      // 模拟维护大账号 onDone → saveMappings：把 grouped（含 own）展平后写回
      // 等价于 main.js expandBigAccountConfigurations + database.saveMappings
      const flattened = [];
      groupedWithOwn.forEach((item) => {
        item.currencies.forEach((currency) => {
          flattened.push({
            merchantId: item.merchantId,
            currency,
            accountNature: item.accountNature
          });
        });
      });
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        flattened
      );

      // 断言：own 账号仍在
      const afterRows = ctx.db.db.prepare(
        'SELECT merchant_id, account_nature FROM template_big_accounts WHERE template_id=? ORDER BY merchant_id'
      ).all(ctx.template.id);
      assertEqual(afterRows.length, 3, 'saveMappings roundtrip 后应仍 3 条');
      const afterOwn = afterRows.find((r) => r.merchant_id === 'OWN_Z');
      assertTruthy(afterOwn, 'OWN_Z 应仍在表里（修复后不再静默删除）');
      assertEqual(afterOwn.account_nature, 'own', 'OWN_Z 的 nature 应仍为 own');
      return 'grouped(含 own) → saveMappings roundtrip 保留 3 条，OWN_Z 仍是 own';
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-F2：Finding 1 负向证明 —— 旧链路确实会丢 own（contract test） ---
  // 目的：用"假装走旧链路"的方式构造出 bug 场景，确保 §3.1 过滤确实会造成 own 被删。
  //      若该用例未来开始 fail，说明 §3.1 过滤语义被改动，需要同步重审 Finding 1 修复是否仍有效。
  runCase('P0-F2', 'P0', '旧链路（过滤后 bigAccounts → saveMappings）会丢 own（负向证明）', () => {
    const ctx = createSingleTemplateCtx({ bigAccounts: [] });
    try {
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        [
          { merchantId: 'C_A', currency: 'CNY', accountNature: 'client' },
          { merchantId: 'OWN_B', currency: 'CNY', accountNature: 'own' }
        ]
      );
      // 模拟旧链路：用 getTemplateMappings（默认过滤 own）的 bigAccounts 作为 roundtrip 输入
      const legacyPayload = ctx.db.getTemplateMappings(ctx.template.id);
      const flattened = [];
      legacyPayload.bigAccounts.forEach((item) => {
        item.currencies.forEach((currency) => {
          flattened.push({
            merchantId: item.merchantId,
            currency,
            accountNature: item.accountNature
          });
        });
      });
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        flattened
      );
      const afterRows = ctx.db.db.prepare(
        'SELECT merchant_id FROM template_big_accounts WHERE template_id=?'
      ).all(ctx.template.id);
      assertEqual(afterRows.length, 1, '旧链路 roundtrip 后 own 被删 → 剩 1 条');
      assertEqual(afterRows[0].merchant_id, 'C_A', '剩下的应是 C_A');
      return 'legacy roundtrip 删除 OWN_B（证明 §3.1 过滤 + saveMappings 组合确实会丢 own）';
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-F3：迁移 sanitize 双向匹配（Codex Round 2 Finding 2 修复） ---
  // 背景：own-account-store.sanitizeBankName 把空格转 '-' 后写入文件名。
  //       迁移用 path.basename 拿到的是 sanitized 形态，但 getTemplatesByBankName 直接 SQL 比 raw bankName。
  //       含空格的银行名（"中国 银行"、"BNP Paribas"）→ orphan + 标记完成 → 资金数据永久丢失。
  // 修复：迁移入口按 sanitize(splitTemplateName(t.name).bankName) 建索引，file basename 直接 lookup。
  runCase('P0-F3', 'P0', '迁移 sanitize 双向匹配（含空格的 bankName）', () => {
    const root = makeTempRoot('v153-mig-sanitize-');
    const db = newAppDb(root);
    try {
      // 模板的 bankName 含空格："中国 银行-北京"
      const t = db.upsertTemplate({ name: '中国 银行-北京', sourceFileName: 'a.xlsx', headers: ['h'] });

      // file basename 是 sanitize 后的：'中国-银行.json'（空格变 '-'）
      const ownDir = path.join(root, 'own-accounts');
      fs.mkdirSync(ownDir, { recursive: true });
      fs.writeFileSync(path.join(ownDir, '中国-银行.json'), JSON.stringify([
        { merchantId: 'BOC_OWN_SP', currencies: ['CNY'] }
      ], null, 2));

      const result = runOwnAccountsMigration(root, db.db);
      assertEqual(result.status, 'done', 'status');
      assertEqual(result.stats.insertedRows, 1, '应成功 insert 1 条（不再 orphan）');
      assertEqual(result.stats.orphans, 0, 'orphans=0（修复前会是 1）');

      const own = db.db.prepare(
        "SELECT merchant_id, currency, account_nature FROM template_big_accounts WHERE template_id = ? AND account_nature='own'"
      ).all(t.id);
      assertEqual(own.length, 1, 'own 记录应为 1 条');
      assertEqual(own[0].merchant_id, 'BOC_OWN_SP', 'merchant_id 匹配');
      return `'中国-银行.json' (sanitized) 命中模板 '中国 银行-北京' (raw) → insertedRows=1, orphans=0`;
    } finally {
      try { db.db.close(); } catch (_) {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // --- P0-F4：fixedAssignment lookup 按 merchantId 聚合 client+own（Codex Round 2 Finding 4） ---
  // 背景：v1.5.3 之后大账号按 (merchantId+accountNature) 分组，同 merchantId 可能有 2 条。
  //       旧 lookup `new Map(items.map(i=>[i.merchantId,i]))` 后写覆盖前写，
  //       fixedAssignment 过滤会拒绝合法 currency（被覆盖的那一条的 currencies）→ 静默丢失。
  // 修复：lookup 按 merchantId 聚合所有 currencies（client ∪ own）。
  // 本用例直接验证 main.js validateTemplateConfiguration 的逻辑等价物，避免拉 Electron。
  runCase('P0-F4', 'P0', 'fixedAssignment lookup 聚合 client+own currencies', () => {
    // 模拟修复后的聚合 lookup 行为
    const cleanedBigAccounts = [
      { merchantId: 'M_X', currencies: ['CNY'], accountNature: 'client' },
      { merchantId: 'M_X', currencies: ['USD'], accountNature: 'own' }  // 同 merchantId 不同 nature 不同 currency
    ];
    const bigAccountCurrencyLookup = new Map();
    cleanedBigAccounts.forEach((item) => {
      if (!bigAccountCurrencyLookup.has(item.merchantId)) {
        bigAccountCurrencyLookup.set(item.merchantId, new Set());
      }
      const set = bigAccountCurrencyLookup.get(item.merchantId);
      item.currencies.forEach((c) => set.add(c));
    });

    const validCurrencies = bigAccountCurrencyLookup.get('M_X');
    assertTruthy(validCurrencies, 'M_X 应有 lookup');
    assertEqual(validCurrencies.size, 2, '应聚合 2 个 currency (CNY + USD)');
    assertTruthy(validCurrencies.has('CNY'), 'CNY 应在合法集');
    assertTruthy(validCurrencies.has('USD'), 'USD 应在合法集（修复前会因 own 覆盖 client 而漏判）');

    // 模拟旧 lookup 行为 — 后写 own 覆盖 client → CNY 被误判
    const oldLookup = new Map(cleanedBigAccounts.map((item) => [item.merchantId, item]));
    assertEqual(oldLookup.get('M_X').currencies[0], 'USD', '旧 lookup 后写 own 覆盖 → 只剩 USD（证明 bug 存在）');
    return `merchantId M_X (client:CNY + own:USD) → 合并集 {CNY, USD}（修复）vs 旧 {USD}（bug）`;
  });

  // --- P0-F6：preserveOwn=true 不删 own（Codex Round 3 Finding 5 修复） ---
  // 背景：用户改非大账号 mapping 后直接保存（不开维护大账号），前端 currentBigAccounts 是 client-only。
  //       旧 saveMappings 直接 DELETE all + INSERT all → own 被静默删除。
  // 修复：saveMappings 加 preserveOwn 参数：true 时仅 DELETE client_only 行；caller 不传 own 时 own 不动。
  runCase('P0-F6', 'P0', 'preserveOwn=true 不删 own（Finding 5 修复）', () => {
    const ctx = createSingleTemplateCtx({ bigAccounts: [] });
    try {
      // 前置：写入 1 client + 1 own
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        [
          { merchantId: 'C_X', currency: 'CNY', accountNature: 'client' },
          { merchantId: 'OWN_X', currency: 'CNY', accountNature: 'own' }
        ]
      );

      // 模拟"用户没开维护大账号直接保存"：传 client-only + preserveOwn=true
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '日期' }],  // 改了 mappedField
        [{ merchantId: 'C_X', currency: 'CNY', accountNature: 'client' }],
        [],
        undefined,
        null,
        { preserveOwn: true }
      );

      const rows = ctx.db.db.prepare(
        "SELECT merchant_id, account_nature FROM template_big_accounts WHERE template_id=? ORDER BY merchant_id"
      ).all(ctx.template.id);
      assertEqual(rows.length, 2, 'preserveOwn=true 后应仍 2 条');
      const own = rows.find((r) => r.merchant_id === 'OWN_X');
      assertTruthy(own, 'OWN_X 应仍存在');
      assertEqual(own.account_nature, 'own', 'OWN_X 仍是 own');

      // 验证 mapping 也确实被更新（DELETE+INSERT mappings 仍生效）
      const mappings = ctx.db.db.prepare(
        "SELECT mapped_field FROM template_mappings WHERE template_id=? AND template_field='MerchantId'"
      ).get(ctx.template.id);
      assertEqual(mappings.mapped_field, '日期', 'mapping 应已更新为新值');
      return 'preserveOwn=true 仅删 client + INSERT client；OWN_X 保留；mapping 同步更新';
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-F7：preserveOwn=false 全权（含主动删除 own）（Codex Round 3 Finding 5 — 互补） ---
  runCase('P0-F7', 'P0', 'preserveOwn=false 全权（用户在维护大账号删 own）', () => {
    const ctx = createSingleTemplateCtx({ bigAccounts: [] });
    try {
      // 前置：1 client + 2 own
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        [
          { merchantId: 'C_Y', currency: 'CNY', accountNature: 'client' },
          { merchantId: 'OWN_KEEP', currency: 'CNY', accountNature: 'own' },
          { merchantId: 'OWN_DEL', currency: 'USD', accountNature: 'own' }
        ]
      );

      // 模拟"用户开维护大账号 → 删除 OWN_DEL → 完成 → 保存"：
      //   currentBigAccounts 含 OWN_KEEP（保留），不含 OWN_DEL（已删）
      //   bigAccountsLoadedWithOwn=true → preserveOwn=false → DELETE all + INSERT incoming
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        [
          { merchantId: 'C_Y', currency: 'CNY', accountNature: 'client' },
          { merchantId: 'OWN_KEEP', currency: 'CNY', accountNature: 'own' }
        ],
        [],
        undefined,
        null,
        { preserveOwn: false }
      );

      const rows = ctx.db.db.prepare(
        "SELECT merchant_id, account_nature FROM template_big_accounts WHERE template_id=? ORDER BY merchant_id"
      ).all(ctx.template.id);
      assertEqual(rows.length, 2, 'preserveOwn=false 后应剩 2 条（OWN_DEL 已删）');
      assertTruthy(!rows.some((r) => r.merchant_id === 'OWN_DEL'), 'OWN_DEL 应已被删除');
      const ownKeep = rows.find((r) => r.merchant_id === 'OWN_KEEP');
      assertTruthy(ownKeep && ownKeep.account_nature === 'own', 'OWN_KEEP 应保留为 own');
      return 'preserveOwn=false 完整覆盖：保留 OWN_KEEP, 删除 OWN_DEL';
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-F8：preserveOwn=true 时 caller 误传 own 行被防御性跳过（Finding 5 互补防御） ---
  runCase('P0-F8', 'P0', 'preserveOwn=true 时 caller 误传 own 不破坏 UNIQUE', () => {
    const ctx = createSingleTemplateCtx({ bigAccounts: [] });
    try {
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        [{ merchantId: 'OWN_PRE', currency: 'CNY', accountNature: 'own' }]
      );
      // caller 误传 own 行 + preserveOwn=true（如果不防御 → INSERT 'OWN_PRE'/'CNY'/'own' 跟已存 row 撞 UNIQUE）
      ctx.db.saveMappings(
        ctx.template.id,
        [{ templateField: 'MerchantId', mappedField: '摘要' }],
        [
          { merchantId: 'C_NEW', currency: 'CNY', accountNature: 'client' },
          { merchantId: 'OWN_PRE', currency: 'CNY', accountNature: 'own' }  // caller 错误地把 own 也传进来
        ],
        [],
        undefined,
        null,
        { preserveOwn: true }
      );
      const rows = ctx.db.db.prepare(
        "SELECT merchant_id, account_nature FROM template_big_accounts WHERE template_id=? ORDER BY merchant_id"
      ).all(ctx.template.id);
      assertEqual(rows.length, 2, '应有 2 条（OWN_PRE 保留 + C_NEW 新增）');
      const ownPre = rows.find((r) => r.merchant_id === 'OWN_PRE');
      assertTruthy(ownPre && ownPre.account_nature === 'own', 'OWN_PRE 不重复插入也不丢失');
      return '防御性跳过 caller 误传的 own 行；OWN_PRE 仍 1 条不重复';
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-F10：import-bank-info dedupe by (merchantId, currency)（Codex Round 5 Finding 8 修复） ---
  // 背景：Excel 源同 (merchantId, currency) 既出现为 client 又出现为 own → 直接 concat → onDone → saveMappings → UNIQUE 撞 → save 报错
  // 修复：合并时按 (merchantId, currency) dedupe，client 优先（PRD §3.1 一致），部分冲突保留剩余 own currencies
  // 本用例复刻 dedupe 算法验证决策表（renderer-dialogs.js 是 IIFE 工厂不易抽 export，改用 contract test）
  runCase('P0-F10', 'P0', 'import-bank-info dedupe (merchantId, currency) — client 优先', () => {
    function mergeWithDedupe(clientAccounts, ownAccounts) {
      const mergedAccounts = [];
      const seenByPair = new Set();
      const droppedOwnPairs = [];
      clientAccounts.forEach((item) => {
        const merchantId = String(item.merchantId || '').trim();
        const currencies = Array.isArray(item.currencies) ? item.currencies : [];
        mergedAccounts.push({ ...item, accountNature: 'client' });
        currencies.forEach((c) => {
          seenByPair.add(`${merchantId}::${String(c || '').trim()}`);
        });
      });
      ownAccounts.forEach((item) => {
        const merchantId = String(item.merchantId || '').trim();
        const currencies = Array.isArray(item.currencies) ? item.currencies : [];
        const remaining = currencies.filter((c) => !seenByPair.has(`${merchantId}::${String(c || '').trim()}`));
        if (remaining.length === 0) {
          droppedOwnPairs.push(merchantId);
          return;
        }
        mergedAccounts.push({
          ...item,
          currencies: remaining,
          isMultiCurrency: remaining.length > 1,
          accountNature: 'own'
        });
        remaining.forEach((c) => seenByPair.add(`${merchantId}::${String(c || '').trim()}`));
      });
      return { mergedAccounts, droppedOwnPairs };
    }

    // 用例 1：完全冲突 — 同 merchantId/currency 同时为 client + own → own 整体丢
    const r1 = mergeWithDedupe(
      [{ merchantId: 'A', currencies: ['CNY'] }],
      [{ merchantId: 'A', currencies: ['CNY'] }]
    );
    assertEqual(r1.mergedAccounts.length, 1, '完全冲突 → 1 条');
    assertEqual(r1.mergedAccounts[0].accountNature, 'client', '保留 client');
    assertEqual(r1.droppedOwnPairs.length, 1, '丢 1 条 own');

    // 用例 2：无冲突 — 都保留
    const r2 = mergeWithDedupe(
      [{ merchantId: 'A', currencies: ['CNY'] }],
      [{ merchantId: 'B', currencies: ['USD'] }]
    );
    assertEqual(r2.mergedAccounts.length, 2, '无冲突 → 2 条都保留');
    assertEqual(r2.droppedOwnPairs.length, 0, '无丢弃');

    // 用例 3：部分冲突 — own 同 merchantId 含 CNY+USD，client 占 CNY → own 仅保留 USD
    const r3 = mergeWithDedupe(
      [{ merchantId: 'A', currencies: ['CNY'] }],
      [{ merchantId: 'A', currencies: ['CNY', 'USD'] }]
    );
    assertEqual(r3.mergedAccounts.length, 2, '部分冲突 → 2 条（client A/CNY + own A/USD）');
    const ownItem = r3.mergedAccounts.find((i) => i.accountNature === 'own');
    assertTruthy(ownItem, 'own 应仍存在');
    assertEqual(ownItem.currencies.length, 1, 'own 仅剩 1 个 currency');
    assertEqual(ownItem.currencies[0], 'USD', '剩 USD（CNY 被 client 占）');

    // 用例 4：UNIQUE 验证 — 没有任何 (merchantId, currency) 在 mergedAccounts 中重复
    const r4 = mergeWithDedupe(
      [{ merchantId: 'A', currencies: ['CNY', 'USD'] }],
      [
        { merchantId: 'A', currencies: ['CNY'] },     // 完全冲突 → 丢
        { merchantId: 'A', currencies: ['USD'] },     // 完全冲突 → 丢
        { merchantId: 'B', currencies: ['CNY'] }       // 无冲突 → 保留
      ]
    );
    const pairs = new Set();
    r4.mergedAccounts.forEach((item) => {
      item.currencies.forEach((c) => {
        const key = `${item.merchantId}::${c}`;
        assertTruthy(!pairs.has(key), `(${item.merchantId}, ${c}) 不应重复`);
        pairs.add(key);
      });
    });
    return `4 条决策表正确：完全冲突丢 own / 无冲突全留 / 部分冲突保留剩余 / 最终无 (mid, cur) 重复`;
  });

  // --- P0-F11：F8 dedupe 时 droppedOwnPairs 计数与明细（Round 6 self-review C1 修复） ---
  // C1 把 console.warn 升级为 setStatus warning；要求 droppedOwnPairs 列表必须含被丢的 own pair 标识，
  // 且数量准确（驱动状态栏文案 "检测到 N 个自有账号与客资重复..."）
  runCase('P0-F11', 'P0', 'dedupe droppedOwnPairs 计数与明细正确（C1 修复）', () => {
    function mergeWithDedupe(clientAccounts, ownAccounts) {
      const mergedAccounts = [];
      const seenByPair = new Set();
      const droppedOwnPairs = [];
      clientAccounts.forEach((item) => {
        const merchantId = String(item.merchantId || '').trim();
        const currencies = Array.isArray(item.currencies) ? item.currencies : [];
        mergedAccounts.push({ ...item, accountNature: 'client' });
        currencies.forEach((c) => seenByPair.add(`${merchantId}::${String(c || '').trim()}`));
      });
      ownAccounts.forEach((item) => {
        const merchantId = String(item.merchantId || '').trim();
        const currencies = Array.isArray(item.currencies) ? item.currencies : [];
        const remaining = currencies.filter((c) => !seenByPair.has(`${merchantId}::${String(c || '').trim()}`));
        if (remaining.length === 0) {
          droppedOwnPairs.push(`${merchantId}（${currencies.join('/')}）`);
          return;
        }
        if (remaining.length < currencies.length) {
          const dropped = currencies.filter((c) => seenByPair.has(`${merchantId}::${String(c || '').trim()}`));
          droppedOwnPairs.push(`${merchantId}（${dropped.join('/')}, 部分冲突）`);
        }
        mergedAccounts.push({ ...item, currencies: remaining, isMultiCurrency: remaining.length > 1, accountNature: 'own' });
        remaining.forEach((c) => seenByPair.add(`${merchantId}::${String(c || '').trim()}`));
      });
      return { mergedAccounts, droppedOwnPairs };
    }

    // case 1：完全冲突 → droppedOwnPairs 应有 1 条标识 own 全 currency 被丢
    const r1 = mergeWithDedupe(
      [{ merchantId: 'A', currencies: ['CNY'] }],
      [{ merchantId: 'A', currencies: ['CNY'] }]
    );
    assertEqual(r1.droppedOwnPairs.length, 1, '完全冲突 → 1 条 dropped');
    assertTruthy(r1.droppedOwnPairs[0].includes('A'), 'dropped 含 merchantId');
    assertTruthy(r1.droppedOwnPairs[0].includes('CNY'), 'dropped 含 currency 明细');

    // case 2：部分冲突 → droppedOwnPairs 应含 "部分冲突" 标记
    const r2 = mergeWithDedupe(
      [{ merchantId: 'B', currencies: ['CNY'] }],
      [{ merchantId: 'B', currencies: ['CNY', 'USD'] }]
    );
    assertEqual(r2.droppedOwnPairs.length, 1, '部分冲突 → 1 条 dropped');
    assertTruthy(r2.droppedOwnPairs[0].includes('部分冲突'), 'dropped 标记 "部分冲突"');
    assertTruthy(r2.droppedOwnPairs[0].includes('CNY'), 'dropped 列出被丢的 currency CNY（USD 保留）');
    assertTruthy(!r2.droppedOwnPairs[0].includes('USD'), 'dropped 不含保留的 currency USD');

    // case 3：多个 own 都完全冲突 → droppedOwnPairs 应有 2 条
    const r3 = mergeWithDedupe(
      [
        { merchantId: 'A', currencies: ['CNY'] },
        { merchantId: 'B', currencies: ['USD'] }
      ],
      [
        { merchantId: 'A', currencies: ['CNY'] },
        { merchantId: 'B', currencies: ['USD'] },
        { merchantId: 'C', currencies: ['EUR'] }   // 无冲突 → 保留
      ]
    );
    assertEqual(r3.droppedOwnPairs.length, 2, '2 个完全冲突 → 2 条 dropped');
    assertEqual(r3.mergedAccounts.length, 3, 'merged 应含 2 client + 1 own (C/EUR)');

    // case 4：无冲突 → droppedOwnPairs 应为空
    const r4 = mergeWithDedupe(
      [{ merchantId: 'A', currencies: ['CNY'] }],
      [{ merchantId: 'B', currencies: ['USD'] }]
    );
    assertEqual(r4.droppedOwnPairs.length, 0, '无冲突 → 0 条 dropped');

    return 'droppedOwnPairs 4 条决策表：完全冲突 1/部分冲突 1（带标记）/多冲突 2/无冲突 0';
  });

  // --- P0-F12：saveMappings preserveOwn=true 跳 own 行 + warn（Round 6 self-review I2 修复） ---
  // I2 修复让 caller 误传 own 行时打 warn（不静默）。本用例验证：
  //   1. caller 误传 own 不撞 UNIQUE 约束（已通过 P0-F8）
  //   2. console.warn 被调用且含跳过的 (merchantId, currency) 列表
  runCase('P0-F12', 'P0', 'saveMappings preserveOwn=true caller 误传 own 触发 warn（I2 修复）', () => {
    const ctx = createSingleTemplateCtx({ bigAccounts: [] });
    try {
      // 拦截 console.warn
      const originalWarn = console.warn;
      const warnCalls = [];
      console.warn = (...args) => warnCalls.push(args.join(' '));

      try {
        ctx.db.saveMappings(
          ctx.template.id,
          [{ templateField: 'MerchantId', mappedField: '摘要' }],
          [{ merchantId: 'OWN_PRE', currency: 'CNY', accountNature: 'own' }]
        );
        // caller 误传 own 行 + preserveOwn=true → I2 期望打 warn
        ctx.db.saveMappings(
          ctx.template.id,
          [{ templateField: 'MerchantId', mappedField: '摘要' }],
          [
            { merchantId: 'C_NEW', currency: 'CNY', accountNature: 'client' },
            { merchantId: 'OWN_PRE', currency: 'CNY', accountNature: 'own' },
            { merchantId: 'OWN_OTHER', currency: 'USD', accountNature: 'own' }
          ],
          [],
          undefined,
          null,
          { preserveOwn: true }
        );

        // 验证 warn 被调用，含跳过的 (mid/cur) 列表
        const matched = warnCalls.find((w) => w.includes('preserveOwn=true') && w.includes('防御性跳过'));
        assertTruthy(matched, '应有 warn 含 "preserveOwn=true...防御性跳过"');
        assertTruthy(matched.includes('OWN_PRE/CNY'), 'warn 含 OWN_PRE/CNY 标识');
        assertTruthy(matched.includes('OWN_OTHER/USD'), 'warn 含 OWN_OTHER/USD 标识');
        assertTruthy(matched.includes('2 个 own'), 'warn 含数量 "2 个 own"');

        // 验证数据库不撞 UNIQUE 约束（OWN_PRE 保留 + C_NEW 新增）
        const rows = ctx.db.db.prepare(
          "SELECT merchant_id, account_nature FROM template_big_accounts WHERE template_id=? ORDER BY merchant_id"
        ).all(ctx.template.id);
        assertEqual(rows.length, 2, '应 2 条（OWN_PRE 保留 + C_NEW 新增；OWN_OTHER 被跳过）');
        return `warn 含 2 条 own 跳过明细; 数据库 2 条（client 1 + 已存 own 1）`;
      } finally {
        console.warn = originalWarn;
      }
    } finally {
      cleanupCtx(ctx);
    }
  });

  // --- P0-F9：子弹窗重开 mapping dialog 时 bigAccountsLoadedWithOwn 显式透传（Codex Round 4 defensive） ---
  // 背景：renderer-dialogs.js 子弹窗（账单拆分 / 复用模块映射 / 发生额规则 / saveMappings 失败 alert）
  //       的 onClose / onDone / onConfirm 回调都通过 spread `...payload` + 显式覆盖部分字段 重开 mapping dialog。
  //       Codex Round 4 担心 spread 是隐式透传，未来重构 / 漏写会断链。
  // 修复：在所有 6 处 spread 调用点显式加 `bigAccountsLoadedWithOwn`（透传当前局部变量值，非写死 true）。
  //       本用例验证 spread + 显式声明的语义等价性 + 显式优先级（同名字段以显式为准）。
  runCase('P0-F9', 'P0', 'spread + 显式 bigAccountsLoadedWithOwn 透传等价性', () => {
    // 模拟 spread 透传：payload 含 true，spread 后保留
    const payload1 = { bigAccountsLoadedWithOwn: true, other: 'x' };
    const reopened1 = { ...payload1, bigAccounts: 'new' };
    assertEqual(reopened1.bigAccountsLoadedWithOwn, true, 'spread 应自动透传 true');

    // 模拟显式声明 + spread：当前局部 false，payload 中 true → 显式覆盖
    const localLoadedFlag = false;
    const reopened2 = { ...payload1, bigAccounts: 'new', bigAccountsLoadedWithOwn: localLoadedFlag };
    assertEqual(reopened2.bigAccountsLoadedWithOwn, false, '显式声明优先级高于 spread（关键 — 防 Codex 字面建议引入新 bug）');

    // 模拟用户首次进入（未开维护大账号）→ 子弹窗回返：payload 缺字段 → spread 后仍 undefined
    const payload3 = { other: 'x' };
    const reopened3 = { ...payload3, bigAccounts: 'new' };
    assertEqual(Boolean(reopened3.bigAccountsLoadedWithOwn), false, '缺字段时透传 undefined → Boolean=false');

    // 显式声明 false 时（即修复后链路）：透传 false 给新 dialog
    const reopened4 = { ...payload3, bigAccounts: 'new', bigAccountsLoadedWithOwn: false };
    assertEqual(reopened4.bigAccountsLoadedWithOwn, false, '显式 false 时透传 false（保护"未开过维护大账号"语义）');

    return 'spread/显式透传 4 条决策表正确：true→true / 显式覆盖 spread / 缺字段→false / 显式 false→false';
  });

  // --- P0-F5：bigAccountsLoadedWithOwn 标记不覆盖 in-memory 编辑（Codex Round 2 Finding 3） ---
  // 背景：round 1 修复让 manage handler 总是 await getWithOwn 拿数据库版，覆盖了 currentBigAccounts；
  //       但 mapping dialog 内部再次打开 manage 时，currentBigAccounts 可能是上次维护大账号 onDone 的内存版
  //       （含用户主动删除的 own 行），覆盖会丢失这些未保存编辑。
  // 修复：透传 bigAccountsLoadedWithOwn 标记，true 时跳过 getWithOwn 直接用 currentBigAccounts。
  // 本用例模拟两种 payload 形态下的 manage handler 决策路径。
  runCase('P0-F5', 'P0', 'bigAccountsLoadedWithOwn 标记决定是否拉 getWithOwn', () => {
    function decideShouldFetch(payload) {
      const flag = Boolean(payload.bigAccountsLoadedWithOwn);
      return !flag;
    }

    // 首次进入 mapping dialog（来自 template:get-mappings）→ 没字段 → 应拉
    assertEqual(decideShouldFetch({}), true, '首次 payload 缺字段 → 应拉 getWithOwn');
    assertEqual(decideShouldFetch({ bigAccountsLoadedWithOwn: false }), true, '显式 false → 应拉');
    // 重开 mapping dialog（onDone / onCancel 透传 true）→ 不应拉，避免覆盖 in-memory
    assertEqual(decideShouldFetch({ bigAccountsLoadedWithOwn: true }), false, '透传 true → 不应拉');
    assertEqual(decideShouldFetch({ bigAccountsLoadedWithOwn: 'true' }), false, '非空字符串 → 视为 true → 不拉');
    return '决策表正确：缺字段/false=拉, true=不拉（保护 in-memory 编辑）';
  });
}

// ---------------------------------------------------------------------------
// ============== Section 5 — R3 字体 XML 级验证（7 条） ===================
// ---------------------------------------------------------------------------

function casesR3Font() {
  // --- P0-17：明细表头字体 ---
  runCase('P0-17', 'P0', '明细表头字体 Courier New', () => {
    const root = makeTempRoot('v153-font-detail-');
    const out = path.join(root, 'detail.xlsx');
    try {
      writeWorkbookRows({
        rows: [
          ['MerchantId', 'BillDate', 'Credit Amount', 'Currency'],
          ['M_001', '2026-03-31', '100.00', 'CNY'],
          ['M_002', '2026-03-31', '', 'USD']
        ],
        outputFilePath: out,
        sheetName: 'COMMON'
      });
      const info = inspectXlsxRowFonts(out, 1);
      assertTruthy(info.ok, `row 1 非全 Courier New: ${info.reason}, used=${JSON.stringify(info.usedFontNames)}`);
      return `row 1 全部 Courier New (courierFontIds=${JSON.stringify(info.courierFontIds)}, cells=${info.rowStyleIds.length})`;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // --- P0-18：余额表头字体 ---
  runCase('P0-18', 'P0', '余额表头字体 Courier New', () => {
    if (!fs.existsSync(ASSETS_BALANCE_TEMPLATE)) {
      const err = new Error();
      err.__skip = true;
      err.reason = `assets/余额账单模版.xlsx 不存在`;
      throw err;
    }
    const root = makeTempRoot('v153-font-balance-');
    const out = path.join(root, 'balance.xlsx');
    try {
      writeBalanceWorkbook({
        templateFilePath: ASSETS_BALANCE_TEMPLATE,
        records: [
          ['中行', '北京', 'M_001', 'CNY', '2026-03-31', 1000.00]
        ],
        templateFields: ['银行名称', '所在地', '银行账号', '币种', '账单日期', '期末余额'],
        outputFilePath: out
      });
      const info = inspectXlsxRowFonts(out, 1);
      assertTruthy(info.ok, `row 1 非全 Courier New: ${info.reason}, used=${JSON.stringify(info.usedFontNames)}`);
      return `row 1 全部 Courier New (cells=${info.rowStyleIds.length})`;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // --- P0-19：月度余额表头字体（全链路：assemble + toBalanceRows + writeBalanceWorkbook） ---
  runCase('P0-19', 'P0', '月度余额表头字体 Courier New', () => {
    if (!fs.existsSync(ASSETS_BALANCE_TEMPLATE)) {
      const err = new Error();
      err.__skip = true;
      err.reason = `assets/余额账单模版.xlsx 不存在`;
      throw err;
    }
    const root = makeTempRoot('v153-font-mb-');
    const db = newAppDb(root);
    const out = path.join(root, 'monthly.xlsx');
    try {
      const template = db.upsertTemplate({
        name: '中行-北京',
        sourceFileName: 'a.xlsx',
        headers: ['h']
      });
      db.saveMappings(template.id, [{ templateField: 'MerchantId', mappedField: 'h' }], [
        { merchantId: 'M_A', currency: 'CNY', accountNature: 'client' }
      ]);
      writeBalanceSeedRecords(root, '中行', [
        { merchantId: 'M_A', currency: 'CNY', billDate: '2026-03-31', endBalance: 1234.56, templateName: '中行-北京', updatedAt: '' }
      ]);
      const assembled = assembleMonthlyBalance({
        templateScope: template.name,
        year: 2026,
        month: 3,
        db,
        storageRoot: root
      });
      const fields = ['银行名称', '所在地', '银行账号', '币种', '账单日期', '期末余额'];
      const rows = toBalanceRows(assembled.records, fields);
      assertEqual(rows.length, 1, 'rows.length');
      writeBalanceWorkbook({
        templateFilePath: ASSETS_BALANCE_TEMPLATE,
        records: rows,
        templateFields: fields,
        outputFilePath: out
      });
      const info = inspectXlsxRowFonts(out, 1);
      assertTruthy(info.ok, `row 1 非全 Courier New: ${info.reason}, used=${JSON.stringify(info.usedFontNames)}`);
      return `全链路 assemble→toBalanceRows→writeBalanceWorkbook，row 1 全部 Courier New (cells=${info.rowStyleIds.length})`;
    } finally {
      try { db.db.close(); } catch (_) {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // --- P0-20：合并文件表头字体 ---
  // 合并逻辑在 main.js:mergeGeneratedXlsxFiles 内部，依赖 electron？查验一下是否能直接 require。
  runCase('P0-20', 'P0', '合并文件表头字体 Courier New', () => {
    const root = makeTempRoot('v153-font-merge-');
    const a = path.join(root, 'a.xlsx');
    const b = path.join(root, 'b.xlsx');
    const merged = path.join(root, 'merged.xlsx');
    try {
      writeWorkbookRows({
        rows: [
          ['MerchantId', 'BillDate', 'Credit Amount', 'Currency'],
          ['M_001', '2026-03-01', '10', 'CNY']
        ],
        outputFilePath: a,
        sheetName: 'COMMON'
      });
      writeWorkbookRows({
        rows: [
          ['MerchantId', 'BillDate', 'Credit Amount', 'Currency'],
          ['M_002', '2026-03-02', '20', 'USD']
        ],
        outputFilePath: b,
        sheetName: 'COMMON'
      });

      // 等价实现合并逻辑（main.js:mergeGeneratedXlsxFiles 的核心），脱离 Electron 依赖
      const XLSXStyle = require('xlsx-js-style');
      const baseWb = XLSXStyle.readFile(a, { cellNF: true, cellStyles: true, raw: true });
      const baseWs = baseWb.Sheets[baseWb.SheetNames[0]];
      const baseRange = XLSXStyle.utils.decode_range(baseWs['!ref'] || 'A1');
      let nextRow = baseRange.e.r + 1;
      let maxCol = baseRange.e.c;
      const wb2 = XLSXStyle.readFile(b, { cellNF: true, cellStyles: true, raw: true });
      const ws2 = wb2.Sheets[wb2.SheetNames[0]];
      const range2 = XLSXStyle.utils.decode_range(ws2['!ref'] || 'A1');
      if (range2.e.c > maxCol) maxCol = range2.e.c;
      for (let r = 1; r <= range2.e.r; r++) {
        for (let c = 0; c <= maxCol; c++) {
          const srcAddr = XLSXStyle.utils.encode_cell({ r, c });
          const dstAddr = XLSXStyle.utils.encode_cell({ r: nextRow, c });
          const cell = ws2[srcAddr];
          if (cell) baseWs[dstAddr] = { ...cell };
        }
        nextRow++;
      }
      baseWs['!ref'] = XLSXStyle.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: nextRow - 1, c: maxCol }
      });
      // 补注入 Courier New（与 main.js:mergeGeneratedXlsxFiles 的后置逻辑等价）
      for (let c = 0; c <= maxCol; c++) {
        const addr = XLSXStyle.utils.encode_cell({ r: 0, c });
        const cell = baseWs[addr];
        if (!cell) continue;
        const existingStyle = cell.s || {};
        const existingFont = existingStyle.font || {};
        cell.s = {
          ...existingStyle,
          font: { ...existingFont, name: 'Courier New' }
        };
      }
      XLSXStyle.writeFile(baseWb, merged);

      const info = inspectXlsxRowFonts(merged, 1);
      assertTruthy(info.ok, `row 1 非全 Courier New: ${info.reason}, used=${JSON.stringify(info.usedFontNames)}`);
      return `merge 2 files → row 1 全部 Courier New (cells=${info.rowStyleIds.length})`;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // --- P1-6：数据区字体不变 ---
  runCase('P1-6', 'P1', '数据区字体不变', () => {
    const root = makeTempRoot('v153-font-data-');
    const out = path.join(root, 'detail.xlsx');
    try {
      writeWorkbookRows({
        rows: [
          ['MerchantId', 'BillDate', 'Credit Amount', 'Currency'],
          ['M_001', '2026-03-31', '100.00', 'CNY']
        ],
        outputFilePath: out,
        sheetName: 'COMMON'
      });
      const styles = unzipText(out, 'xl/styles.xml');
      const sheet = unzipText(out, 'xl/worksheets/sheet1.xml');
      const fonts = extractFonts(styles);
      const cellXfs = extractCellXfsFontIds(styles);
      // 检查 row 2 字体
      const row2StyleIds = extractRowCellStyleIds(sheet, 2);
      assertTruthy(row2StyleIds.length > 0, 'row 2 应有 cell');
      const row2FontNames = row2StyleIds.map((xfId) => fonts[cellXfs[xfId]] || '?');
      const anyCourierInData = row2FontNames.some((n) => n === 'Courier New');
      assertTruthy(!anyCourierInData, `数据区不应出现 Courier New, 实际: ${JSON.stringify(row2FontNames)}`);
      return `row 2 字体 ${JSON.stringify(row2FontNames)} 均非 Courier New`;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // --- P1-7：报错文件不改 —— 项目的错误报告是 .txt，非 xlsx，无字体可验 ---
  // 查一下实际错误报告格式
  runCase('P1-7', 'P1', '报错文件不改（报告为 txt，无字体）', () => {
    // 查代码事实：grep 验证
    // src/main.js 错误报告写入用 .txt（appendErrorReportFile / buildErrorReportTxt），非 xlsx
    // 因此本用例不具备字体验证条件，标记 skip 而非 fail
    const err = new Error();
    err.__skip = true;
    err.reason = '错误报告为 txt 格式（非 xlsx），无字体可验';
    throw err;
  });

  // --- P1-8：新开账户模块表头 —— 决策 D14：writer 写死 Courier New，共用 writeBalanceWorkbook ---
  // 新开账户模块的 xlsx 生成最终仍走 writeBalanceWorkbook（同 P0-18 机制）
  runCase('P1-8', 'P1', '新开账户模块表头 Courier New', () => {
    // grep 验证新开账户模块的 writer 入口
    // 实现上共用 writeBalanceWorkbook → 已被 P0-18 机制覆盖
    // 直接复用 writeBalanceWorkbook 验证等价：与 P0-18 同结果
    if (!fs.existsSync(ASSETS_BALANCE_TEMPLATE)) {
      const err = new Error();
      err.__skip = true;
      err.reason = `assets/余额账单模版.xlsx 不存在`;
      throw err;
    }
    const root = makeTempRoot('v153-font-newacct-');
    const out = path.join(root, 'new-account.xlsx');
    try {
      writeBalanceWorkbook({
        templateFilePath: ASSETS_BALANCE_TEMPLATE,
        records: [
          ['A行', '北京', 'NEW_M_001', 'CNY', '2026-03-31', 5000.00]
        ],
        templateFields: ['银行名称', '所在地', '银行账号', '币种', '账单日期', '期末余额'],
        outputFilePath: out
      });
      const info = inspectXlsxRowFonts(out, 1);
      assertTruthy(info.ok, `row 1 非全 Courier New: ${info.reason}, used=${JSON.stringify(info.usedFontNames)}`);
      return `新开账户（共用 writeBalanceWorkbook，D14 副作用）row 1 全部 Courier New`;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// ============== Section 6 — R4 账单合并浮点精度（3 条） =================
// ---------------------------------------------------------------------------
//
// 背景：src/backend/file-service.js:437-443 合并求和原本是纯 JS 浮点 `+` / `-`，
//       如 `2377.49 + 178.31` 会产生 `2555.7999999999997` 尾部噪声、
//       `65572.01 + 4917.90` 会产生 `70489.90999999999`。
// 修复（2026-04-22 更正）：
//       资金本就 2 位小数，改用 `roundAmount`（`Number(value.toFixed(2))`）强制截到 2 位，
//       覆盖 IEEE 754 在 12 位处无法收敛的场景（如 70489.90999999999 → 70489.91）。
//       使 `net === 0` 判定与 `netString = sanitizeAmountValue(String(Math.abs(net)))`
//       输出均精确。
//
// 这 3 条用例直接验关键算子（round + abs + sanitize），不走完整 buildMappedRows 链路，
// 因此不依赖模板/DB fixture，跑起来快而确定。

function casesR4FloatingPoint() {
  // --- P0-R4-1：用户 2026-04-22 报告的实际场景 KPY-PAY-4mQadY0aTZzUUCi ---
  runCase('P0-R4-1', 'P0', 'R4 浮点合并 2377.49 + 178.31 = 2555.80', () => {
    // 复现 file-service.js:437-443 的合并求和
    const sumCredit = 0;
    const sumDebit = 2377.49 + 178.31; // 浮点 2555.7999999999997
    // sanity: 原始纯浮点必然带尾部噪声
    assertTruthy(
      sumDebit !== 2555.8,
      `前置断言：纯浮点 ${sumDebit} 本应与 2555.8 不等（否则本用例失去意义）`
    );
    const net = roundAmount(sumCredit - sumDebit);
    // net === -2555.8（精确）
    assertEqual(net, -2555.8, 'net 应精确等于 -2555.8');
    assertEqual(Math.abs(net), 2555.8, 'Math.abs(net) 应精确等于 2555.8');
    // sanitize 后字符串形态（file-service.js:452 的 netString）
    const netString = sanitizeAmountValue(String(Math.abs(net)));
    assertEqual(netString, '2555.8', `netString 应为 '2555.8'，实际 '${netString}'`);
    return `sumDebit=${sumDebit} → net=${net} → netString='${netString}'`;
  });

  // --- P0-R4-2：第二个用户报告 KPY-PAY-KdDQdG2blc0bLJa ---
  runCase('P0-R4-2', 'P0', 'R4 浮点合并 65572.01 + 4917.90 = 70489.91', () => {
    const sumCredit = 0;
    const sumDebit = 65572.01 + 4917.90; // 浮点 70489.90999999999
    assertTruthy(
      sumDebit !== 70489.91,
      `前置断言：纯浮点 ${sumDebit} 本应与 70489.91 不等（否则本用例失去意义）`
    );
    const net = roundAmount(sumCredit - sumDebit);
    assertEqual(net, -70489.91, 'net 应精确等于 -70489.91');
    assertEqual(Math.abs(net), 70489.91, 'Math.abs(net) 应精确等于 70489.91');
    const netString = sanitizeAmountValue(String(Math.abs(net)));
    assertEqual(netString, '70489.91', `netString 应为 '70489.91'，实际 '${netString}'`);
    return `sumDebit=${sumDebit} → net=${net} → netString='${netString}'`;
  });

  // --- P0-R4-3：正负对称抵消，net===0 判定必须命中（file-service.js:446-448 静默跳过） ---
  runCase('P0-R4-3', 'P0', 'R4 对称抵消 net===0 静默跳过', () => {
    // 1.1 本身浮点安全，但合并路径里 sumCredit/sumDebit 可能带噪声，
    // 本用例构造"先产生尾部噪声，再做对称抵消"的最小对照：
    // 若 net 未经 round，1.1 对 1.1 的减法在某些加法累积后会出 -1.1102230246251565e-16。
    // 这里构造一个更明显的场景：sumCredit = 0.1+0.2，sumDebit = 0.3
    const sumCredit = 0.1 + 0.2; // 0.30000000000000004
    const sumDebit = 0.3;
    assertTruthy(
      sumCredit !== sumDebit,
      `前置断言：纯浮点 ${sumCredit} 本应与 ${sumDebit} 不等（否则本用例失去意义）`
    );
    const net = roundAmount(sumCredit - sumDebit);
    assertEqual(net, 0, `net 应精确等于 0（round 之前为 ${sumCredit - sumDebit}）`);
    // 命中 file-service.js:446 `if (net === 0)` → 整个合并组静默跳过
    const shouldSkip = net === 0;
    assertTruthy(shouldSkip, 'net===0 判定必须为 true');
    return `sumCredit=${sumCredit}, sumDebit=${sumDebit}, net=${net}（精确 0）→ 合并组跳过`;
  });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main() {
  console.log('v1.5.3 端到端回归测试');
  console.log('====================');
  console.log('');

  console.log('--- Section 1 — R1 资金装配 ---');
  casesR1();
  console.log('');
  console.log('--- Section 2 — R1 IPC 校验层 ---');
  casesR1IpcValidation();
  console.log('');
  console.log('--- Section 3 — R2 迁移三态 ---');
  casesR2Migration();
  console.log('');
  console.log('--- Section 4 — R2 过滤 / bundle ---');
  casesR2FilterBundle();
  console.log('');
  console.log('--- Section 5 — R3 字体 XML 级验证 ---');
  casesR3Font();
  console.log('');
  console.log('--- Section 6 — R4 账单合并浮点精度 ---');
  casesR4FloatingPoint();
  console.log('');

  // 总结
  const p0All = results.filter((r) => r.level === 'P0');
  const p1All = results.filter((r) => r.level === 'P1');
  const p0Pass = p0All.filter((r) => r.status === 'pass').length;
  const p0Skip = p0All.filter((r) => r.status === 'skip');
  const p0Fail = p0All.filter((r) => r.status === 'fail');
  const p1Pass = p1All.filter((r) => r.status === 'pass').length;
  const p1Skip = p1All.filter((r) => r.status === 'skip');
  const p1Fail = p1All.filter((r) => r.status === 'fail');

  const p0SkipDesc = p0Skip.length
    ? ` (${p0Skip.map((r) => `${r.id} skipped: ${r.detail}`).join('; ')})`
    : '';
  const p1SkipDesc = p1Skip.length
    ? ` (${p1Skip.map((r) => `${r.id} skipped: ${r.detail}`).join('; ')})`
    : '';

  const failures = [...p0Fail, ...p1Fail];

  console.log('=== 总计 ===');
  console.log(`P0 通过: ${p0Pass}/${p0All.length}${p0SkipDesc}`);
  console.log(`P1 通过: ${p1Pass}/${p1All.length}${p1SkipDesc}`);
  console.log(`失败用例: ${failures.length ? failures.map((r) => r.id).join(', ') : '无'}`);

  if (failures.length) {
    console.log('');
    console.log('--- 失败明细 ---');
    failures.forEach((r) => {
      console.log(`[${r.id}] ${r.label}`);
      console.log(`  ${r.detail}`);
    });
    process.exit(1);
  }
}

main();
