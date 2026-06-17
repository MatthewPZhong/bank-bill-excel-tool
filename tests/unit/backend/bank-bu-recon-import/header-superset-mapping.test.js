// v3.0.8 迭代2-B（🔴资金对账红线）— BU回填校验「兼容新版 46 列银行对账单导入」逻辑层单测
//
// 背景：新版银行对账单在 'Transaction Description' 后插入「合并单号」「合并状态」两列（44 → 46），
// 其后所有列整体右移。BU回填模块（src/backend/bank-bu-recon-import）做了两处兼容：
//   ① validator.js  validateBankHeaders 用「宽容超集 + 有序子序列」校验（多余列忽略、不落库）
//   ② reader.js     按"列名 → 文件实际列索引"取值（不再按固定列索引），防止 Extra Information /
//                   Remark-BU 等后移列错位（资金对账错列 = 红线事故）
//
// 本测试只覆盖逻辑层（validator + 按名 mapper），不依赖真实 xlsx 文件 IO：
//   - validateBankHeaders 直接吃表头数组
//   - reader.js 的 buildHeaderIndexMap / buildRowMapper 未导出，这里用公共常量
//     (BANK_HEADERS / BANK_DB_COLUMNS / bankHeaderToDbColumn) + normalizeHeaderCell 原样复刻其映射契约
//     （header→实际列索引 Map + 按 BANK_HEADERS[i]→BANK_DB_COLUMNS[i] 配对 + trim 归一），
//     从而断言"无论列是否位移/有多余列，都按名正确取值、恰好 44 个 DB 字段、不含新增列对应键"。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validatePendingGuanliHeaders,
  validateBankHeaders,
  normalizeHeaderCell
} = require('../../../../src/backend/bank-bu-recon-import/validator');
const {
  BANK_HEADERS,
  BANK_DB_COLUMNS,
  bankHeaderToDbColumn,
  PENDING_GUANLI_HEADERS
} = require('../../../../src/backend/bank-bu-recon-db/columns');

// ------------------------------------------------------------------------
// 复刻 reader.js 的"按列名取值"映射（buildHeaderIndexMap + buildRowMapper）。
// 与 src/backend/bank-bu-recon-import/reader.js 行为严格一致：
//   - 用文件实际表头建 normalizeHeaderCell(列名) → 列索引 Map（首次出现优先）
//   - 按 (BANK_HEADERS[i] → BANK_DB_COLUMNS[i]) 配对，取文件对应列的 cell 并 trim 归一
//   - 多出的列（不在 BANK_HEADERS 中）自然不进结果对象
// trim 归一与 file-service/common.js 的 normalizeCell 等价（null/undefined→''，否则 String().trim()）。
// ------------------------------------------------------------------------
function buildHeaderIndexMap(headerRow) {
  const map = new Map();
  if (Array.isArray(headerRow)) {
    for (let i = 0; i < headerRow.length; i++) {
      const name = normalizeHeaderCell(headerRow[i]);
      if (name !== '' && !map.has(name)) {
        map.set(name, i);
      }
    }
  }
  return map;
}

function normalizeCellLike(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function mapRowByName(headerRow, cells) {
  const headerIndexMap = buildHeaderIndexMap(headerRow);
  const obj = {};
  for (let i = 0; i < BANK_DB_COLUMNS.length; i++) {
    const colIndex = headerIndexMap.get(BANK_HEADERS[i]);
    obj[BANK_DB_COLUMNS[i]] = normalizeCellLike(colIndex === undefined ? undefined : cells[colIndex]);
  }
  return obj;
}

// 构造一行"按给定表头顺序"的数据：每个 cell 取值 = `<列名>#值`，便于断言取值是否错位。
function makeRowForHeaders(headerRow) {
  return headerRow.map((h) => `${h}#值`);
}

// 新版 46 列表头 = 旧版 44 列在 'Transaction Description' 后插入「合并单号」「合并状态」
function buildBankHeaders46() {
  const headers = [...BANK_HEADERS];
  const at = headers.indexOf('Transaction Description');
  headers.splice(at + 1, 0, '合并单号', '合并状态');
  return headers;
}

// ========================================================================
// 1. 新版 46 列：校验通过 + 按名映射不错位 + 恰好 44 个 DB 字段 + 不含新增列键
// ========================================================================

test.describe('新版 46 列银行对账单：validateBankHeaders 通过', () => {
  test('Transaction Description 后含 合并单号/合并状态 → ok（忽略多余列）', () => {
    const headers = buildBankHeaders46();
    assert.equal(headers.length, 46, '构造表头应为 46 列');
    // 新增两列确实紧跟在 Transaction Description 后
    const at = headers.indexOf('Transaction Description');
    assert.equal(headers[at + 1], '合并单号');
    assert.equal(headers[at + 2], '合并状态');

    const r = validateBankHeaders(headers);
    assert.equal(r.ok, true);
  });
});

test.describe('新版 46 列银行对账单：按列名 mapper 行为', () => {
  test('结果对象恰好 44 个 DB 字段（与 BANK_DB_COLUMNS 完全一致）', () => {
    const headers = buildBankHeaders46();
    const cells = makeRowForHeaders(headers);
    const obj = mapRowByName(headers, cells);

    const keys = Object.keys(obj);
    assert.equal(keys.length, 44, 'DB 字段必须恰好 44 个（合并单号/合并状态 不落库）');
    assert.deepEqual(keys, [...BANK_DB_COLUMNS], 'DB 字段集合与顺序须 = BANK_DB_COLUMNS');
  });

  test('结果对象不含「合并单号」「合并状态」对应的任何键', () => {
    const headers = buildBankHeaders46();
    const cells = makeRowForHeaders(headers);
    const obj = mapRowByName(headers, cells);

    // 这两列没有 DB 列名映射（bankHeaderToDbColumn → null），自然不应出现
    assert.equal(bankHeaderToDbColumn('合并单号'), null);
    assert.equal(bankHeaderToDbColumn('合并状态'), null);
    // 兜底：obj 里不存在任何取自这两列的值（值带 `#值` 标记，按列名取）
    const values = Object.values(obj);
    assert.ok(!values.includes('合并单号#值'), 'obj 不应取到「合并单号」列的值');
    assert.ok(!values.includes('合并状态#值'), 'obj 不应取到「合并状态」列的值');
  });

  test('Extra Information / Remark-BU 取值正确不错位（核心红线断言）', () => {
    const headers = buildBankHeaders46();
    const cells = makeRowForHeaders(headers);
    const obj = mapRowByName(headers, cells);

    // 按名取值：每个 DB 字段的值应 = 其对应模板列名 + '#值'
    assert.equal(obj.extra_information, 'Extra Information#值');
    assert.equal(obj.remark_bu, 'Remark-BU#值');
    // 锚点前后再抽样几列，确保整行不整体右移错位
    assert.equal(obj.transaction_description, 'Transaction Description#值');
    assert.equal(obj.payment_detail, 'Payment Detail#值');
    assert.equal(obj.split_info, '拆分信息#值');
    assert.equal(obj.account_entity, '账户主体#值');
  });

  test('新增两列右移其后所有列：按名取仍逐列对齐 BANK_DB_COLUMNS', () => {
    const headers = buildBankHeaders46();
    const cells = makeRowForHeaders(headers);
    const obj = mapRowByName(headers, cells);
    // 逐列断言：每个 db 字段的值 = 对应模板列名 + '#值'
    for (let i = 0; i < BANK_DB_COLUMNS.length; i++) {
      assert.equal(
        obj[BANK_DB_COLUMNS[i]],
        `${BANK_HEADERS[i]}#值`,
        `第 ${i + 1} 个 DB 字段 ${BANK_DB_COLUMNS[i]} 取值错位`
      );
    }
  });
});

// ========================================================================
// 2. 旧版 44 列：校验仍通过 + 按名映射行为不变（零回归）
// ========================================================================

test.describe('旧版 44 列银行对账单：行为不变（零回归）', () => {
  test('validateBankHeaders 通过', () => {
    const headers = [...BANK_HEADERS];
    assert.equal(headers.length, 44);
    const r = validateBankHeaders(headers);
    assert.equal(r.ok, true);
  });

  test('按名 mapper 仍输出 44 个字段且逐列对齐（等价于原按索引取）', () => {
    const headers = [...BANK_HEADERS];
    const cells = makeRowForHeaders(headers);
    const obj = mapRowByName(headers, cells);

    assert.equal(Object.keys(obj).length, 44);
    assert.deepEqual(Object.keys(obj), [...BANK_DB_COLUMNS]);
    assert.equal(obj.extra_information, 'Extra Information#值');
    assert.equal(obj.remark_bu, 'Remark-BU#值');
    for (let i = 0; i < BANK_DB_COLUMNS.length; i++) {
      assert.equal(obj[BANK_DB_COLUMNS[i]], `${BANK_HEADERS[i]}#值`);
    }
  });
});

// ========================================================================
// 3. Pending 严格校验未被波及：20 列模板，多 1 列（21）应被拒
// ========================================================================

test.describe('Pending 严格校验未受兼容改动波及', () => {
  test('恰好 20 列 → 通过', () => {
    const r = validatePendingGuanliHeaders([...PENDING_GUANLI_HEADERS]);
    assert.equal(r.ok, true);
  });

  test('多出 1 列（21 列）→ 被拒（严格列数校验，不走宽容超集）', () => {
    const headers = [...PENDING_GUANLI_HEADERS, '多余列'];
    assert.equal(headers.length, 21);
    const r = validatePendingGuanliHeaders(headers);
    assert.equal(r.ok, false);
    assert.match(r.error, /列数不匹配/);
  });

  test('模仿"在中间插列"也被拒（Pending 不享受超集宽容）', () => {
    const headers = [...PENDING_GUANLI_HEADERS];
    headers.splice(2, 0, '合并单号');
    const r = validatePendingGuanliHeaders(headers);
    assert.equal(r.ok, false);
  });
});
