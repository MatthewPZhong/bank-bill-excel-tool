// v2.1.15 W1（spec §3 / 决策 xlsx 为准、旧硬编码作废、存量不迁移）：网关账单表头枚举读取单测
//
// 覆盖（与 fund-type-enum.test.js 对称，但体现本 loader 的差异）：
//   - 读真实 assets/网关对账单.xlsx → 31 列表头（有序，整行）、不含 __CUSTOM__
//   - GATEWAY_RECON_HEADERS_FILE_NAME 常量
//   - 临时 fixture：取「表头行整行」（非 fund-type 的「第一列跳表头」）+ 去空列 + 去重
//   - 🔴 资金红线：表头含 __CUSTOM__ sentinel → 必须剔除
//   - 文件缺失 / 空表头 → 降级 fallback 到旧硬编码 GATEWAY_RECON_FIELDS（非空，不抛错；区别于 fund-type 降级空数组）
//   - 模块级缓存命中（同路径不重复读盘；reset 后重读）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  loadGatewayReconHeaders,
  getDefaultGatewayReconHeadersPath,
  resetGatewayReconHeadersCache,
  GATEWAY_RECON_HEADERS_FILE_NAME,
  CUSTOM_VALUE_SENTINEL
} = require('../../../src/constants/gateway-recon-headers-loader');
const { GATEWAY_RECON_FIELDS } = require('../../../src/constants/gateway-recon-fields');

// 用 XLSX 在临时目录生成 fixture：第一行 = 表头行（多列），其余为数据行（loader 只读表头行）
function writeFixtureXlsx(headerRow, dataRows = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwheaders-fixture-'));
  const filePath = path.join(dir, 'fixture.xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  XLSX.utils.book_append_sheet(wb, ws, '1409155847565936642'); // 数字 sheet 名（与真实模板一致）
  XLSX.writeFile(wb, filePath);
  return { dir, filePath };
}

test.describe('loadGatewayReconHeaders', () => {
  test.beforeEach(() => {
    resetGatewayReconHeadersCache();
  });

  test('读真实 assets/网关对账单.xlsx → 31 列表头（有序）、不含 __CUSTOM__', () => {
    const realPath = getDefaultGatewayReconHeadersPath();
    // 仿 C2：asset 缺失 = 硬失败（不 skip 假绿）。缺失会导致 C3 网关字段下拉静默 fallback 旧硬编码。
    if (!fs.existsSync(realPath)) {
      assert.fail(`真实网关对账单 asset 缺失：${realPath}（必须 git add，缺失会导致 C3 网关字段下拉降级旧硬编码）`);
    }
    const values = loadGatewayReconHeaders(realPath);
    assert.equal(values.length, 31, '当前 assets/网关对账单.xlsx 表头应为 31 列');
    assert.ok(!values.includes(CUSTOM_VALUE_SENTINEL), '表头不得含 __CUSTOM__ sentinel');
    // 代表列抽样（首/末/中文列）——验证「整行表头」读取正确，不 deepEqual 全量（xlsx 为准、可演进）
    assert.equal(values[0], 'Billdate');
    assert.equal(values[values.length - 1], '账单状态');
    assert.ok(values.includes('关联单号'));
    assert.ok(values.includes('AccountRef'));
  });

  test('GATEWAY_RECON_HEADERS_FILE_NAME 常量正确', () => {
    assert.equal(GATEWAY_RECON_HEADERS_FILE_NAME, '网关对账单.xlsx');
  });

  test('临时 fixture：取表头行整行（有序）', () => {
    const { dir, filePath } = writeFixtureXlsx(['列A', '列B', '列C'], [['x', 'y', 'z']]);
    try {
      const values = loadGatewayReconHeaders(filePath);
      assert.deepEqual(values, ['列A', '列B', '列C']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('临时 fixture：去空列 + 去重（保持首次出现顺序）', () => {
    const { dir, filePath } = writeFixtureXlsx(['A', '', 'B', 'A', 'C', 'B']);
    try {
      const values = loadGatewayReconHeaders(filePath);
      assert.deepEqual(values, ['A', 'B', 'C']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('🔴 资金红线：表头含 __CUSTOM__ → 必须剔除', () => {
    const { dir, filePath } = writeFixtureXlsx(['A', '__CUSTOM__', 'B']);
    try {
      const values = loadGatewayReconHeaders(filePath);
      assert.deepEqual(values, ['A', 'B'], '__CUSTOM__ 是自取值保留 value，必须剔除防 mode 误判');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('文件缺失 → 降级 fallback 到旧硬编码 GATEWAY_RECON_FIELDS（非空，不抛错）', () => {
    const missing = path.join(os.tmpdir(), 'definitely-not-exist-gwheaders-xyz.xlsx');
    const values = loadGatewayReconHeaders(missing);
    assert.deepEqual(values, [...GATEWAY_RECON_FIELDS]);
  });

  test('空表头 fixture → 降级 fallback 到旧硬编码', () => {
    const { dir, filePath } = writeFixtureXlsx(['', '', '']);
    try {
      const values = loadGatewayReconHeaders(filePath);
      assert.deepEqual(values, [...GATEWAY_RECON_FIELDS]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('缓存命中：删文件后再读同路径仍返缓存值；reset 后重读降级 fallback', () => {
    const { dir, filePath } = writeFixtureXlsx(['P', 'Q']);
    try {
      const first = loadGatewayReconHeaders(filePath);
      assert.deepEqual(first, ['P', 'Q']);
      // 删文件但不 reset → 仍返缓存（证明命中缓存，未重新读盘）
      fs.rmSync(filePath, { force: true });
      const second = loadGatewayReconHeaders(filePath);
      assert.deepEqual(second, ['P', 'Q']);
      // reset 后再读（文件已删）→ 降级 fallback 到旧硬编码
      resetGatewayReconHeadersCache();
      const third = loadGatewayReconHeaders(filePath);
      assert.deepEqual(third, [...GATEWAY_RECON_FIELDS]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('缺省路径（不传 filePath）→ 走默认 assets 路径', () => {
    const values = loadGatewayReconHeaders();
    assert.ok(Array.isArray(values));
    assert.ok(values.length > 0);
    assert.ok(!values.includes(CUSTOM_VALUE_SENTINEL));
  });
});
