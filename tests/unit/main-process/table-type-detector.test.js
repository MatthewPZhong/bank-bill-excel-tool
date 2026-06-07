// v2.1.16 阶段一 A2：表头自动识别 detectTableType 正式单测
//
// 由开发期临时脚本 scripts/tmp-a2-detector-check.js 转正（node:test，纳入 release-check）。
//
// 覆盖维度：
//   1) L1 精确命中：6 张 assets 真实模板各自命中正确 tableKey（score=1）
//   2) L2 模糊打分：构造仅命中部分指纹列的文件，按命中率 ≥ minScore 判 matched
//   3) 短表防子集误判：4 列回填模板 vs 25 列退款订单（双向不互相误命中）
//   4) 大小写敏感：网关全小写 reconciliationid / merchantid 命中 gateway，不串到银行驼峰
//   5) ambiguous：表头同时精确命中两张表 → status=ambiguous + matchedKeys
//   6) unrecognized：候选签名都不命中（4 列回填模板 / 垃圾文件）
//   7) read-error：文件不存在 / 空 xlsx → status=read-error
//
// 数据来源：assets/ 现有真实模板（识别按表头，不依赖数据行——交割表为空模板亦能命中）+ 必要时临时构造 fixture。
//   外汇交割表.xls 现为空模板（仅标题行 + 表头行，0 数据行），detectTableType 仍按表头命中（与 A4 落库读数据行解耦）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  detectTableType,
  SHORT_TABLE_COLUMN_THRESHOLD,
  L2_HEADER_SCAN_ROWS
} = require('../../../src/main-process/table-type-detector');
const {
  ALL_TABLE_SIGNATURES,
  BANK_STATEMENT_SIGNATURE,
  GATEWAY_RECON_SIGNATURE
} = require('../../../src/constants/table-signatures');

const ASSETS = path.join(__dirname, '..', '..', '..', 'assets');

// 把 AOA 写成临时 xlsx，返回文件路径（调用方负责清理目录）。
function writeTempXlsx(dir, name, aoa, sheetName = 'Sheet1') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  const fp = path.join(dir, name);
  XLSX.writeFile(wb, fp);
  return fp;
}

let tmpDir;
test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-test-'));
});
test.afterEach(() => {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    tmpDir = null;
  }
});

test.describe('detectTableType — L1 精确命中 assets 真实模板', () => {
  // [文件名, 期望 tableKey]（来源：tmp-a2 已验证用例 + A4 链接表）
  const L1_CASES = [
    ['银行对账单.xlsx', 'bank-statement'],
    ['中台退款订单.xls', 'zhongtai-refund-order'],
    ['入账原始订单.xlsx', 'intake-original-order'],
    ['中台调拨订单.xlsx', 'zhongtai-dispatch-order'],
    ['网关对账单.xlsx', 'gateway-recon'],
    ['外汇交割表.xls', 'fx-delivery'] // 空模板（0 数据行），按表头命中
  ];

  for (const [file, expectKey] of L1_CASES) {
    test(`${file} → ${expectKey}（status=matched, score=1）`, () => {
      const result = detectTableType(path.join(ASSETS, file));
      assert.equal(result.status, 'matched', `${file} 应识别为 matched`);
      assert.equal(result.tableKey, expectKey);
      assert.equal(result.score, 1, 'L1 精确命中 score=1');
    });
  }

  test('外汇交割表（含中间空列，L1 用 l1MatchHeaders 锚点）命中 fx-delivery', () => {
    // 交割表真实表头第 10 列为空列；签名以 l1MatchHeaders（空列前连续 9 列）作 L1 锚点。
    const result = detectTableType(path.join(ASSETS, '外汇交割表.xls'));
    assert.equal(result.status, 'matched');
    assert.equal(result.tableKey, 'fx-delivery');
  });
});

test.describe('detectTableType — L2 模糊打分', () => {
  test('仅命中部分指纹列、命中率 ≥ minScore → matched（走 L2）', () => {
    // 构造一张「非完整银行表头」的文件：故意打乱列顺序 + 删掉一些列，使 L1（连续子序列全等）必失败，
    // 但保留 ≥ minScore(0.6) 比例的 signatureHeaders 指纹 → L2 命中 bank-statement。
    // 银行指纹 5 个：ReconciliationId / Credit Amount / Debit Amount / 拆分信息 / 关联大账号。
    // 这里放 4 个（4/5=0.8 ≥ 0.6），并打散夹杂无关列使其无法构成 L1 连续锚点。
    const header = [
      '无关列X', 'ReconciliationId', '无关列Y', 'Credit Amount', '无关列Z',
      'Debit Amount', '无关列W', '拆分信息'
    ];
    const fp = writeTempXlsx(tmpDir, 'fuzzy-bank.xlsx', [header, header.map(() => 'v')]);
    // 仅以银行签名为候选，排除其它表干扰，专测 L2 打分。
    const result = detectTableType(fp, [BANK_STATEMENT_SIGNATURE]);
    assert.equal(result.status, 'matched', 'L2 命中率 ≥ minScore → matched');
    assert.equal(result.tableKey, 'bank-statement');
    assert.ok(result.score >= BANK_STATEMENT_SIGNATURE.minScore, `score(${result.score}) ≥ minScore(${BANK_STATEMENT_SIGNATURE.minScore})`);
    assert.ok(result.score < 1, 'L2 命中 score < 1（区别于 L1 精确）');
  });

  test('命中率 < minScore → unrecognized', () => {
    // 仅命中 1 个银行指纹（1/5=0.2 < 0.6）→ 不达标。
    const header = ['无关列A', 'ReconciliationId', '无关列B', '无关列C'];
    const fp = writeTempXlsx(tmpDir, 'fuzzy-low.xlsx', [header, header.map(() => 'v')]);
    const result = detectTableType(fp, [BANK_STATEMENT_SIGNATURE]);
    assert.equal(result.status, 'unrecognized', '命中率不足 minScore → unrecognized');
    assert.ok(result.score < BANK_STATEMENT_SIGNATURE.minScore);
  });
});

test.describe('detectTableType — 短表防子集误判（4 列回填模板 vs 25 列退款订单）', () => {
  // 4 列回填模板签名（preprocess scope，与退款订单同域，刻意避开共有列「状态」）。
  const REFUND_TEMPLATE_SIG = Object.freeze({
    tableKey: 'zhongtai-refund-template',
    label: '中台退款订单回填模板',
    scope: 'preprocess',
    expectedHeaders: ['退款单号', '状态', '渠道流水号', '渠道退款时间'],
    signatureHeaders: ['退款单号', '渠道流水号', '渠道退款时间'],
    dateColumn: '渠道退款时间',
    minScore: 0.6,
    headerRowOffset: 0
  });

  test('短表阈值常量 = 8（回填模板 4 列 ≤ 8，触发列数守卫）', () => {
    assert.equal(SHORT_TABLE_COLUMN_THRESHOLD, 8);
    assert.ok(REFUND_TEMPLATE_SIG.expectedHeaders.length <= SHORT_TABLE_COLUMN_THRESHOLD);
  });

  test('回填模板文件 vs ALL_TABLE_SIGNATURES → unrecognized（不被 25 列退款订单误判）', () => {
    const result = detectTableType(path.join(ASSETS, '中台退款订单回填模板.xlsx'));
    assert.equal(result.status, 'unrecognized', '4 列回填模板不应被长退款订单表误命中');
    assert.equal(result.tableKey, null);
  });

  test('把回填模板签名加入候选：回填模板文件命中自己', () => {
    const withTemplate = [...ALL_TABLE_SIGNATURES, REFUND_TEMPLATE_SIG];
    const result = detectTableType(path.join(ASSETS, '中台退款订单回填模板.xlsx'), withTemplate);
    assert.equal(result.status, 'matched');
    assert.equal(result.tableKey, 'zhongtai-refund-template');
  });

  test('把回填模板签名加入候选：退款订单文件仍命中退款订单（不被 4 列模板抢走）', () => {
    const withTemplate = [...ALL_TABLE_SIGNATURES, REFUND_TEMPLATE_SIG];
    const result = detectTableType(path.join(ASSETS, '中台退款订单.xls'), withTemplate);
    assert.equal(result.status, 'matched');
    assert.equal(result.tableKey, 'zhongtai-refund-order', '25 列退款订单不被 4 列回填模板（子集）抢占');
  });
});

test.describe('detectTableType — 大小写敏感（网关全小写 vs 银行驼峰）', () => {
  test('网关对账单（全小写 reconciliationid / merchantid）命中 gateway-recon', () => {
    const result = detectTableType(path.join(ASSETS, '网关对账单.xlsx'));
    assert.equal(result.status, 'matched');
    assert.equal(result.tableKey, 'gateway-recon');
  });

  test('银行对账单（驼峰 ReconciliationId）命中 bank-statement，二者互不串台', () => {
    const bank = detectTableType(path.join(ASSETS, '银行对账单.xlsx'));
    const gateway = detectTableType(path.join(ASSETS, '网关对账单.xlsx'));
    assert.equal(bank.tableKey, 'bank-statement');
    assert.equal(gateway.tableKey, 'gateway-recon');
    assert.notEqual(bank.tableKey, gateway.tableKey, '银行（驼峰）/ 网关（全小写）靠大小写区分，不互相误判');
  });

  test('把网关指纹列改成驼峰（ReconciliationId/MerchantId）→ 不再精确命中 gateway（L1 落空）', () => {
    // 验证大小写敏感：L1 锚点（全 31 列表头）含全小写指纹列；改成驼峰后 L1 连续子序列全等失败。
    // L2 仍可能凭其余 3 个未改的指纹（originBillBizId/Merchant_status/账单状态）命中——
    // 故这里只断言「不再是 L1 精确命中（score<1）」，证明大小写参与了 L1 锚点匹配。
    const gwHeaders = GATEWAY_RECON_SIGNATURE.expectedHeaders.map((h) => {
      if (h === 'merchantid') return 'MerchantId';
      if (h === 'reconciliationid') return 'ReconciliationId';
      return h;
    });
    const fp = writeTempXlsx(tmpDir, 'gw-camel.xlsx', [gwHeaders, gwHeaders.map(() => 'v')]);
    const result = detectTableType(fp, [GATEWAY_RECON_SIGNATURE]);
    assert.notEqual(result.score, 1, '改驼峰后 L1 精确锚点失配 → 不再 score=1（证明大小写敏感）');
  });
});

test.describe('detectTableType — ambiguous / unrecognized / read-error', () => {
  test('表头同时精确命中两张表 → status=ambiguous + matchedKeys', () => {
    // 同一行拼接银行 44 列 + 网关 31 列：两个 L1 锚点都能在该行找到连续子序列 → 双命中。
    const combined = [
      ...BANK_STATEMENT_SIGNATURE.expectedHeaders,
      ...GATEWAY_RECON_SIGNATURE.expectedHeaders
    ];
    const fp = writeTempXlsx(tmpDir, 'ambiguous.xlsx', [combined, combined.map(() => 'v')]);
    const result = detectTableType(fp, [BANK_STATEMENT_SIGNATURE, GATEWAY_RECON_SIGNATURE]);
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.tableKey, null);
    assert.ok(Array.isArray(result.matchedKeys), 'ambiguous 返回 matchedKeys');
    assert.deepEqual(
      [...result.matchedKeys].sort(),
      ['bank-statement', 'gateway-recon'],
      'matchedKeys 含两个精确命中的 tableKey'
    );
  });

  test('垃圾文件（非 Excel 内容，可被 SheetJS 勉强解析）→ unrecognized', () => {
    const fp = path.join(tmpDir, 'garbage.xlsx');
    fs.writeFileSync(fp, 'this is not a valid excel file at all');
    const result = detectTableType(fp);
    assert.equal(result.status, 'unrecognized', '无任何签名命中 → unrecognized');
  });

  test('文件不存在 → read-error', () => {
    const result = detectTableType(path.join(tmpDir, 'does-not-exist.xlsx'));
    assert.equal(result.status, 'read-error');
    assert.equal(result.tableKey, null);
  });

  test('空 xlsx（无任何有意义行）→ read-error', () => {
    const fp = writeTempXlsx(tmpDir, 'empty.xlsx', []);
    const result = detectTableType(fp);
    assert.equal(result.status, 'read-error', '空文件 readRowsWithMetadata 抛 FILE_READ → read-error');
  });

  test('空候选签名集 → 任何文件都 unrecognized（无候选可命中）', () => {
    const result = detectTableType(path.join(ASSETS, '银行对账单.xlsx'), []);
    assert.equal(result.status, 'unrecognized');
  });
});

test.describe('detectTableType — 导出常量自检', () => {
  test('L2_HEADER_SCAN_ROWS 为正整数', () => {
    assert.equal(typeof L2_HEADER_SCAN_ROWS, 'number');
    assert.ok(L2_HEADER_SCAN_ROWS > 0);
  });
});
