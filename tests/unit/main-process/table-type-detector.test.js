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
  GATEWAY_RECON_SIGNATURE,
  FX_OPTION_SIGNATURE,
  // v2.1.16-beta.3 ②：入金表签名 + 链接表导入候选集 + 预加工候选集
  BANK_DEPOSIT_SIGNATURE,
  LINKED_IMPORT_SIGNATURES,
  PREPROCESS_TABLE_SIGNATURES
} = require('../../../src/constants/table-signatures');
const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');

const ASSETS = path.join(__dirname, '..', '..', '..', 'assets');

// 把 AOA 写成临时 xlsx，返回文件路径（调用方负责清理目录）。
function writeTempXlsx(dir, name, aoa, sheetName = 'Sheet1') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  const fp = path.join(dir, name);
  XLSX.writeFile(wb, fp);
  return fp;
}

// 把多张 sheet（[{ name, aoa }]）写成临时 xlsx（保持顺序），返回文件路径。
function writeTempMultiSheetXlsx(dir, name, sheets) {
  const wb = XLSX.utils.book_new();
  for (const { name: sheetName, aoa } of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  }
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

test.describe('detectTableType — Codex#1：返回命中 sheetName（封面 sheet 在前回归）', () => {
  test('单 sheet 命中 → 返回 sheetName 指向该 sheet', () => {
    const header = [...BANK_STATEMENT_FIELDS];
    const fp = writeTempXlsx(tmpDir, 'sheetname-single.xlsx', [header, header.map(() => 'v')], '渠道对账单');
    const result = detectTableType(fp, [BANK_DEPOSIT_SIGNATURE]);
    assert.equal(result.status, 'matched');
    assert.equal(result.tableKey, 'bank-deposit');
    assert.equal(result.sheetName, '渠道对账单', 'L1 命中应返回命中 sheet 名');
  });

  test('🔴 封面 sheet 在前 + 数据 sheet 在后 → 命中数据 sheet 且 sheetName 指向数据 sheet', () => {
    // Codex#1 回归：detector 逐 sheet 扫描命中数据 sheet，返回值须带回该 sheet 名，
    //   否则 linked import 的 readLinkedRowsAsObjects 缺省读首个（封面）sheet → write-error。
    const header = [...BANK_STATEMENT_FIELDS];
    const fp = writeTempMultiSheetXlsx(tmpDir, 'sheetname-cover-first.xlsx', [
      { name: '封面说明', aoa: [['本表为银行对账单说明'], ['制表人：测试']] },
      { name: '渠道对账单', aoa: [header, header.map(() => 'v')] }
    ]);
    const result = detectTableType(fp, [BANK_DEPOSIT_SIGNATURE]);
    assert.equal(result.status, 'matched', '封面 sheet 在前仍应命中后面的数据 sheet');
    assert.equal(result.tableKey, 'bank-deposit');
    assert.equal(result.sheetName, '渠道对账单', '返回数据 sheet 名（非封面 sheet），供 reader 从正确 sheet 读表头落库');
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

test.describe('detectTableType — 多 sheet 扫描（v2.1.16 PR#61 F4 真回归）', () => {
  // 回归点：底层 readWorkbookRows 历史只读 SheetNames[0]；若银行对账单文件把封面/汇总 sheet
  //   排在「渠道对账单」之前，detector 只看第一个 sheet 会误判 unrecognized。现改为扫所有 sheet。
  const BANK_HEADER = [...BANK_STATEMENT_FIELDS];
  const COVER_SHEET = {
    name: '汇总',
    aoa: [['对账汇总'], ['总笔数', 100], ['总金额', 99999]]
  };
  const BANK_SHEET = {
    name: '渠道对账单',
    aoa: [BANK_HEADER, BANK_HEADER.map(() => 'v')]
  };

  test('封面 sheet 在前的银行对账单 → 仍命中 bank-statement（不再误判 unrecognized）', () => {
    const fp = writeTempMultiSheetXlsx(tmpDir, 'bank-cover-first.xlsx', [COVER_SHEET, BANK_SHEET]);
    const result = detectTableType(fp);
    assert.equal(result.status, 'matched', '封面在前时仍应识别出银行对账单（多 sheet 扫描）');
    assert.equal(result.tableKey, 'bank-statement');
    assert.equal(result.score, 1, 'L1 精确命中 score=1');
  });

  test('多张封面/说明 sheet 在前、数据 sheet 在最后 → 仍命中', () => {
    const note = { name: '说明', aoa: [['本表为对账结果'], ['制表人', '张三']] };
    const fp = writeTempMultiSheetXlsx(tmpDir, 'bank-multi-cover.xlsx', [COVER_SHEET, note, BANK_SHEET]);
    const result = detectTableType(fp);
    assert.equal(result.status, 'matched');
    assert.equal(result.tableKey, 'bank-statement');
  });

  test('数据 sheet 在第一个（历史常见摆放）→ 仍命中（短路即返回，行为不退化）', () => {
    const fp = writeTempMultiSheetXlsx(tmpDir, 'bank-data-first.xlsx', [BANK_SHEET, COVER_SHEET]);
    const result = detectTableType(fp);
    assert.equal(result.status, 'matched');
    assert.equal(result.tableKey, 'bank-statement');
  });

  test('多 sheet 但全部都不是任何签名表 → unrecognized', () => {
    const fp = writeTempMultiSheetXlsx(tmpDir, 'no-match-multi.xlsx', [
      COVER_SHEET,
      { name: '其它', aoa: [['列甲', '列乙', '列丙'], ['a', 'b', 'c']] }
    ]);
    const result = detectTableType(fp);
    assert.equal(result.status, 'unrecognized');
    assert.equal(result.tableKey, null);
  });

  test('封面 sheet 在前的网关对账单（大小写敏感仍生效）→ 命中 gateway-recon', () => {
    const gwHeader = [...GATEWAY_RECON_SIGNATURE.expectedHeaders];
    const fp = writeTempMultiSheetXlsx(tmpDir, 'gw-cover-first.xlsx', [
      COVER_SHEET,
      { name: '1409155847565936642', aoa: [gwHeader, gwHeader.map(() => 'v')] }
    ]);
    const result = detectTableType(fp, [BANK_STATEMENT_SIGNATURE, GATEWAY_RECON_SIGNATURE]);
    assert.equal(result.status, 'matched');
    assert.equal(result.tableKey, 'gateway-recon');
  });

  test('两张数据 sheet 各命中不同表（同文件不同 sheet 分别命中银行/网关）→ 取先出现者 bank-statement（短路）', () => {
    const gwHeader = [...GATEWAY_RECON_SIGNATURE.expectedHeaders];
    const fp = writeTempMultiSheetXlsx(tmpDir, 'bank-then-gw.xlsx', [
      BANK_SHEET,
      { name: 'gw', aoa: [gwHeader, gwHeader.map(() => 'v')] }
    ]);
    const result = detectTableType(fp, [BANK_STATEMENT_SIGNATURE, GATEWAY_RECON_SIGNATURE]);
    // 跨 sheet 不判 ambiguous（ambiguous 仅同一 sheet 多签名命中）；按 sheet 顺序短路取第一个命中。
    assert.equal(result.status, 'matched');
    assert.equal(result.tableKey, 'bank-statement', '不同 sheet 各命中一张表时按 sheet 顺序短路（非 ambiguous）');
  });

  test('同一 sheet 内拼接两表表头 → 仍判 ambiguous（多 sheet 改造不破坏 ambiguous 语义）', () => {
    const combined = [
      ...BANK_STATEMENT_SIGNATURE.expectedHeaders,
      ...GATEWAY_RECON_SIGNATURE.expectedHeaders
    ];
    const fp = writeTempMultiSheetXlsx(tmpDir, 'ambiguous-multi.xlsx', [
      { name: '封面', aoa: [['x']] },
      { name: '混合', aoa: [combined, combined.map(() => 'v')] }
    ]);
    const result = detectTableType(fp, [BANK_STATEMENT_SIGNATURE, GATEWAY_RECON_SIGNATURE]);
    assert.equal(result.status, 'ambiguous');
    assert.ok(Array.isArray(result.matchedKeys));
  });
});

test.describe('detectTableType — 外汇期权表 unsupported（v2.1.16 PR#61 F3）', () => {
  // 模板已入库 assets/外汇期权订单.xlsx（sheet「交易数据」，标题第 0 行、表头第 1 行）。
  // 期望：识别得出 fx-option，但 detector 返回 status='unsupported'（区别 unrecognized），不接入落库。
  test('期权表（真实模板）→ status=unsupported + tableKey=fx-option（已入库未接入）', () => {
    const result = detectTableType(path.join(ASSETS, '外汇期权订单.xlsx'));
    assert.equal(result.status, 'unsupported', '期权表已入库 → unsupported（非 unrecognized）');
    assert.equal(result.tableKey, 'fx-option');
    assert.equal(result.score, 1, 'L1 精确命中 score=1');
  });

  test('FX_OPTION_SIGNATURE 已纳入 ALL_TABLE_SIGNATURES 候选', () => {
    const keys = ALL_TABLE_SIGNATURES.map((s) => s.tableKey);
    assert.ok(keys.includes('fx-option'), 'fx-option 必须在候选集（识别更友好）');
    assert.ok(Array.isArray(FX_OPTION_SIGNATURE.expectedHeaders) && FX_OPTION_SIGNATURE.expectedHeaders.length === 24, '期权表实测 24 列');
  });

  test('封面 sheet 在前的期权表（headerRowOffset=1 + 多 sheet）→ 仍 unsupported', () => {
    const optHeader = [...FX_OPTION_SIGNATURE.expectedHeaders];
    const fp = writeTempMultiSheetXlsx(tmpDir, 'opt-cover-first.xlsx', [
      { name: '封面', aoa: [['说明']] },
      // 还原真实模板结构：第 0 行标题、第 1 行表头
      { name: '交易数据', aoa: [['期权交易数据'], optHeader, optHeader.map(() => 'v')] }
    ]);
    const result = detectTableType(fp);
    assert.equal(result.status, 'unsupported');
    assert.equal(result.tableKey, 'fx-option');
  });

  test('期权表不被其它表误判、其它表也不被期权误判（互斥）', () => {
    const opt = detectTableType(path.join(ASSETS, '外汇期权订单.xlsx'));
    const fxDelivery = detectTableType(path.join(ASSETS, '外汇交割表.xls'));
    assert.equal(opt.tableKey, 'fx-option');
    assert.equal(fxDelivery.tableKey, 'fx-delivery');
    assert.notEqual(opt.tableKey, fxDelivery.tableKey, '期权表 / 交割表互不串台');
  });
});

test.describe('detectTableType — 银行对账单入金表 bank-deposit 候选集隔离（v2.1.16-beta.3 ②）', () => {
  // UT-D1：🔴 ALL_TABLE_SIGNATURES 不含入金表（防回归不变量；入金表与主表同构 44 列，进 ALL 会致缺省 ambiguous）
  test('UT-D1：ALL_TABLE_SIGNATURES 不含 bank-deposit（隔离不变量）', () => {
    assert.equal(
      ALL_TABLE_SIGNATURES.some((s) => s.tableKey === 'bank-deposit'),
      false,
      '🔴 ALL_TABLE_SIGNATURES 绝不能含 bank-deposit（与主表同构 → 缺省候选 ambiguous）'
    );
  });

  // UT-D2：LINKED_IMPORT_SIGNATURES 含入金表
  test('UT-D2：LINKED_IMPORT_SIGNATURES 含 bank-deposit', () => {
    assert.equal(
      LINKED_IMPORT_SIGNATURES.some((s) => s.tableKey === 'bank-deposit'),
      true,
      'LINKED_IMPORT_SIGNATURES 必须含 bank-deposit'
    );
    assert.equal(BANK_DEPOSIT_SIGNATURE.tableKey, 'bank-deposit');
    assert.equal(BANK_DEPOSIT_SIGNATURE.scope, 'linked');
    assert.equal(
      BANK_DEPOSIT_SIGNATURE.expectedHeaders.length,
      BANK_STATEMENT_FIELDS.length,
      '入金表 expectedHeaders 与主表同为 44 列'
    );
  });

  // UT-D3：链接候选集内入金表唯一命中（非 ambiguous）。主表签名不在 LINKED_IMPORT_SIGNATURES → 唯一同构匹配。
  test('UT-D3：银行对账单.xlsx 在 LINKED_IMPORT_SIGNATURES 内唯一命中 bank-deposit（非 ambiguous）', () => {
    const result = detectTableType(path.join(ASSETS, '银行对账单.xlsx'), LINKED_IMPORT_SIGNATURES);
    assert.equal(result.status, 'matched', '入金表是该候选集内唯一同构签名 → matched，不 ambiguous');
    assert.equal(result.tableKey, 'bank-deposit');
    assert.equal(result.score, 1, 'L1 精确命中 score=1');
  });

  // UT-D4：预加工候选集仍识别为主表（不串）
  test('UT-D4：银行对账单.xlsx 在 PREPROCESS_TABLE_SIGNATURES 内识别为 bank-statement（不串）', () => {
    const result = detectTableType(path.join(ASSETS, '银行对账单.xlsx'), PREPROCESS_TABLE_SIGNATURES);
    assert.equal(result.status, 'matched');
    assert.equal(result.tableKey, 'bank-statement', '同一文件走预加工候选仍为主表，不被入金表抢走');
  });

  // UT-D5：非入金表链接文件不被入金表干扰
  test('UT-D5：网关对账单.xlsx 在 LINKED_IMPORT_SIGNATURES 内仍命中 gateway-recon', () => {
    const result = detectTableType(path.join(ASSETS, '网关对账单.xlsx'), LINKED_IMPORT_SIGNATURES);
    assert.equal(result.status, 'matched');
    assert.equal(result.tableKey, 'gateway-recon', '入金表签名不干扰网关对账单识别');
  });
});

test.describe('detectTableType — 导出常量自检', () => {
  test('L2_HEADER_SCAN_ROWS 为正整数', () => {
    assert.equal(typeof L2_HEADER_SCAN_ROWS, 'number');
    assert.ok(L2_HEADER_SCAN_ROWS > 0);
  });
});
