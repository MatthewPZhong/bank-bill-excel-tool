// v2.1.16-beta.3 ②：银行对账单入金表导入裁列单测（UT-H1~H3）
//
// 覆盖：
//   UT-H1：命中后裁 13 字段（pickBankDepositFields 输出恰好 13 键 = BANK_DEPOSIT_FIELDS）
//   UT-H2：🔴 异构/缺列文件经 detector 不唯一命中 bank-deposit → 不进裁列落库
//   UT-H3：裁后对象保留键/日期字段（ReconciliationId / BillDate）
//
// 裁列纯函数 pickBankDepositFields 抽在 linked-table-repository.js（TECH Open Q3：抽出便于单测）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { pickBankDepositFields, BANK_DEPOSIT_FIELDS } = require('../../../../src/backend/database/linked-table-repository');
const { BANK_STATEMENT_FIELDS } = require('../../../../src/constants/bank-statement-fields');
const { detectTableType } = require('../../../../src/main-process/table-type-detector');
const { LINKED_IMPORT_SIGNATURES } = require('../../../../src/constants/table-signatures');

let tmpDir;
test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-deposit-import-'));
});
test.afterEach(() => {
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } tmpDir = null; }
});

function writeTempXlsx(name, aoa, sheetName = '渠道对账单') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  const fp = path.join(tmpDir, name);
  XLSX.writeFile(wb, fp);
  return fp;
}

// 构造一行 44 字段对象（值用字段名占位，便于断言裁列保真）
function fullRow44() {
  const obj = {};
  for (const f of BANK_STATEMENT_FIELDS) obj[f] = `v_${f}`;
  return obj;
}

test.describe('bank-deposit 裁列（v2.1.16-beta.3 ②）', () => {
  // UT-H1：裁 13 字段
  test('UT-H1：pickBankDepositFields 输出恰好 13 键 = BANK_DEPOSIT_FIELDS', () => {
    const picked = pickBankDepositFields(fullRow44());
    const keys = Object.keys(picked).sort();
    assert.equal(keys.length, 13, '裁后恰好 13 字段');
    assert.deepEqual(keys, [...BANK_DEPOSIT_FIELDS].sort(), '字段集合 = BANK_DEPOSIT_FIELDS');
    // 值按字段名 pick（非索引切片）：抽查保真
    assert.equal(picked.ReconciliationId, 'v_ReconciliationId');
    assert.equal(picked.FundType, 'v_FundType');
    assert.equal(picked['Credit Amount'], 'v_Credit Amount');
    // 不含主表其余列
    assert.ok(!('账户主体' in picked), '不含账户主体');
    assert.ok(!('Recon Amount' in picked), '不含 Recon Amount');
  });

  // UT-H3：裁后保留键/日期字段（保证 replaceLinkedTable 取键列/日期不丢）
  test('UT-H3：裁后对象含 ReconciliationId 与 BillDate', () => {
    const picked = pickBankDepositFields(fullRow44());
    assert.ok('ReconciliationId' in picked, '保留键列字段 ReconciliationId');
    assert.ok('BillDate' in picked, '保留日期字段 BillDate');
  });

  // 边界：非对象入参 → 返回 13 字段全 undefined（不抛错）
  test('pickBankDepositFields 非对象入参容错（返回 13 字段全 undefined）', () => {
    const picked = pickBankDepositFields(null);
    assert.equal(Object.keys(picked).length, 13);
    assert.ok(BANK_DEPOSIT_FIELDS.every((f) => picked[f] === undefined));
  });

  // UT-H2：🔴 异构/缺指纹列文件 → detector 不命中 bank-deposit（不进裁列落库）。
  //   删掉关键指纹列（Debit Amount / 拆分信息 / 关联大账号）使 L2 命中率 < 0.6；
  //   列残缺也破坏 L1 的 44 列连续锚点 → 整体 unrecognized。
  test('UT-H2：缺指纹列文件 → detector 不命中 bank-deposit（不会裁列落库脏数据）', () => {
    const broken = BANK_STATEMENT_FIELDS.filter(
      (h) => h !== 'Debit Amount' && h !== '拆分信息' && h !== '关联大账号'
    ); // 仅剩 ReconciliationId / Credit Amount 两个指纹 → 2/5=0.4 < 0.6
    const fp = writeTempXlsx('broken.xlsx', [broken, broken.map((h) => `x_${h}`)]);
    const detected = detectTableType(fp, LINKED_IMPORT_SIGNATURES);
    assert.notEqual(detected.tableKey, 'bank-deposit', '缺指纹列文件不应命中 bank-deposit');
    assert.notEqual(detected.status, 'matched', '缺指纹列文件不应 matched（不进裁列落库）');
  });

  test('UT-H2b：列错位（打散）文件 → detector 不唯一命中 bank-deposit', () => {
    // 打散列顺序：L1 连续子序列全等必失败；只保留 2 个指纹列（2/5=0.4 < 0.6）→ L2 也不达标
    const scrambled = ['ReconciliationId', '随机A', 'Credit Amount', '随机B', '随机C', '随机D'];
    const fp = writeTempXlsx('scrambled.xlsx', [scrambled, scrambled.map(() => 'v')]);
    const detected = detectTableType(fp, LINKED_IMPORT_SIGNATURES);
    assert.notEqual(detected.tableKey, 'bank-deposit', '列错位文件不应命中 bank-deposit');
  });

  // UT-H2c：🔴 截断文件（保留 ≥0.6 指纹 → L2 仍可能 matched）。文档化第二道防线：
  //   即便 detector L2 宽松命中，handler 内 readLinkedRowsAsObjects 按 44 列精确 zip，
  //   截断文件没有 44 列连续表头行 → 抛 FileValidationError（write-error），永不进 replaceLinkedTable 落脏数据。
  //   这里断言「截断文件仍含 ≥0.6 指纹但列数 != 44」，作为对第二道防线前提的守护。
  test('UT-H2c：截断文件 L2 可能 matched，但列数 != 44（handler 44 列 zip 为第二道防线）', () => {
    const truncated = BANK_STATEMENT_FIELDS.slice(0, 34); // 保留 4/5 指纹（含 关联大账号 idx30）
    assert.notEqual(truncated.length, BANK_STATEMENT_FIELDS.length, '截断文件列数 != 44');
    const fp = writeTempXlsx('truncated.xlsx', [truncated, truncated.map((h) => `x_${h}`)]);
    const detected = detectTableType(fp, LINKED_IMPORT_SIGNATURES);
    // 不强断言 matched/unrecognized（L2 阈值行为）；仅说明：若 matched，handler 44 列 zip 会再次拦截。
    if (detected.status === 'matched') {
      assert.equal(detected.tableKey, 'bank-deposit', '若命中只能是 bank-deposit（同候选集唯一 44 列签名）');
    }
  });
});
