// v2.1.11 T3（spec §4.5 / PRD §2.3 T3.2 / 决策 D-T3-2-src=xlsx）：FundType 枚举读取单测
//
// 覆盖：
//   - 读真实 assets/FundType枚举值.xlsx → 顺序应得契约约定的 12 个值
//   - 读临时 fixture xlsx → 有序 + 跳表头 + 去空 + 去重
//   - 文件缺失 → 降级空数组（不抛错）
//   - 模块级缓存命中（同路径不重复读盘；reset 后重读）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  loadFundTypeEnum,
  getDefaultFundTypeEnumPath,
  resetFundTypeEnumCache,
  FUND_TYPE_ENUM_FILE_NAME
} = require('../../../src/constants/fund-type-enum');

// 契约约定的 12 个 FundType 值（spec / 任务卡）
// v2.1.16-beta.2 §FundType：错拼 'Ach Ruturn' → 'Ach Return'；末尾新增 'HX-in' / 'HX-out'（Internel* 不动）
const EXPECTED_FUND_TYPES = [
  'Inbound', 'outbound', 'outbound Fail', 'Ach Return', 'Wire Return',
  'Reversal', 'FundTransfer-in', 'FundTransfer-out',
  'InternelFundTransfer-in', 'InternelFundTransfer-out', 'HX-in', 'HX-out'
];

// 用 XLSX 在临时目录生成单列 fixture（第一行表头 + 数据行）
function writeFixtureXlsx(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fundtype-fixture-'));
  const filePath = path.join(dir, 'fixture.xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['FundType'], ...rows.map((v) => [v])]);
  XLSX.utils.book_append_sheet(wb, ws, '1405800876820465666'); // 数字 sheet 名（与真实模板一致）
  XLSX.writeFile(wb, filePath);
  return { dir, filePath };
}

test.describe('loadFundTypeEnum', () => {
  test.beforeEach(() => {
    resetFundTypeEnumCache();
  });

  test('读真实 assets/FundType枚举值.xlsx → 契约 12 个值（有序）', () => {
    const realPath = getDefaultFundTypeEnumPath();
    // C2（v2.1.11 SR-FIX Round 1）：asset 缺失 = 硬失败（不再 skip 假绿）。
    //   旧守卫 skip 会让「asset 未 git add → 打包后 FundType 下拉静默降级文本输入」给 CI 假绿信号。
    //   改 assert.fail 后，asset 缺失（如 checkout 后未 add）即测试失败，强制 asset 进产物。
    if (!fs.existsSync(realPath)) {
      assert.fail(`真实 FundType 枚举 asset 缺失：${realPath}（必须 git add，缺失会导致 FundType 下拉静默降级文本输入）`);
    }
    const values = loadFundTypeEnum(realPath);
    assert.deepEqual(values, EXPECTED_FUND_TYPES);
  });

  test('FUND_TYPE_ENUM_FILE_NAME 常量正确', () => {
    assert.equal(FUND_TYPE_ENUM_FILE_NAME, 'FundType枚举值.xlsx');
  });

  test('临时 fixture：有序 + 跳表头', () => {
    const { dir, filePath } = writeFixtureXlsx(['A', 'B', 'C']);
    try {
      const values = loadFundTypeEnum(filePath);
      assert.deepEqual(values, ['A', 'B', 'C']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('临时 fixture：去空行 + 去重（保持首次出现顺序）', () => {
    const { dir, filePath } = writeFixtureXlsx(['A', '', 'B', 'A', 'C', 'B']);
    try {
      const values = loadFundTypeEnum(filePath);
      assert.deepEqual(values, ['A', 'B', 'C']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('文件缺失 → 降级空数组（不抛错）', () => {
    const missing = path.join(os.tmpdir(), 'definitely-not-exist-fundtype-xyz.xlsx');
    const values = loadFundTypeEnum(missing);
    assert.deepEqual(values, []);
  });

  test('缓存命中：删文件后再读同路径仍返缓存值（未 reset）', () => {
    const { dir, filePath } = writeFixtureXlsx(['X', 'Y']);
    try {
      const first = loadFundTypeEnum(filePath);
      assert.deepEqual(first, ['X', 'Y']);
      // 删文件但不 reset 缓存 → 仍返缓存（证明命中缓存，未重新读盘）
      fs.rmSync(filePath, { force: true });
      const second = loadFundTypeEnum(filePath);
      assert.deepEqual(second, ['X', 'Y']);
      // reset 后再读（文件已删）→ 降级空数组
      resetFundTypeEnumCache();
      const third = loadFundTypeEnum(filePath);
      assert.deepEqual(third, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('缺省路径（不传 filePath）→ 走默认 assets 路径', () => {
    // 不传参 = getDefaultFundTypeEnumPath()；真实文件在则得 12 值，否则降级空数组（不抛）
    const values = loadFundTypeEnum();
    assert.ok(Array.isArray(values));
    if (fs.existsSync(getDefaultFundTypeEnumPath())) {
      assert.deepEqual(values, EXPECTED_FUND_TYPES);
    }
  });
});
