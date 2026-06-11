// v2.1.9 N5 Phase 6 T24：scenario-hit-rows-writer 单元测试
//
// 覆盖范围（spec §5.1-5.3 + §2.2 4 种行结果矩阵）：
//   1. 命中专属场景（_matchStatus='命中' + _hitScenarioId≠null + _matchedChannelId 非通用）
//   2. 命中通用兜底（_matchStatus='命中' + _hitScenarioId≠null + 行匹配专属但 hit 在通用 → _fallbackChannelId 非空）
//   3. 兜底命中（_matchStatus='兜底' + _hitScenarioId≠null + 通用渠道场景命中）
//   4. 列结构精确（headers + 末尾 3 列「匹配渠道 / 匹配状态 / 命中场景」，D17=b 序）
//   5. 文件名规范（命中场景行-{basename}-{timestamp}.xlsx，D15=a）
//   6. 空 modifiedRows graceful（输出含表头空 sheet）
//   7. atomic write（tmp 不留半文件 + rename 后 .tmp 消失）
//   8. 缺失 metadata 字段 graceful（_hitChannelKey / _matchStatus 缺 → '' 兜底）
//   9. 内部 _ 前缀字段不泄漏（INTERNAL_FIELDS 投影过滤）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  writeScenarioHitRows,
  buildHitScenarioLabel,
  buildOriginalBaseName,
  buildDateDir,
  // v2.1.9 D16=b：新增辅助函数 export
  buildHitChannelLabel,
  normalizeChannelsToLabelMap,
  SUFFIX_HEADERS,
  REPORT_SHEET_NAME,
  DEFAULT_REPORT_SUBDIR
} = require('../../../src/main-process/scenario-hit-rows-writer');

const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');

// ---------- Fixtures ----------

// 用 3 列的小 headers 让 sheet 紧凑（避开 44 列冗余；末尾 3 列「匹配渠道 / 匹配状态 / 命中场景」保持业务约束）
const TEST_HEADERS = ['Date', 'Amount', 'CustomerRef'];

let tmpDir;

function makeRow({
  rowId,
  date = '2026-04-01',
  amount = 100,
  customerRef = 'X',
  hitChannelKey = '工商-上海',
  matchStatus = '命中',
  matchedChannelId = 2,
  fallbackChannelId = null,
  // v2.1.9 D16=b：默认命中专属渠道 id=2（工商-上海）
  hitChannelId = 2,
  hitScenarioId = 101,
  hitScenarioDisplayIndex = 1,
  hitScenarioName = '工行上海对账场景'
} = {}) {
  return {
    _rowId: rowId,
    Date: date,
    Amount: amount,
    CustomerRef: customerRef,
    _modifiedColumns: new Set(['Amount']),
    _hitChannelKey: hitChannelKey,
    _matchStatus: matchStatus,
    _matchedChannelId: matchedChannelId,
    _fallbackChannelId: fallbackChannelId,
    // v2.1.9 D16=b：命中场景所属渠道 id（writer 反查 channels.label）
    _hitChannelId: hitChannelId,
    _hitScenarioId: hitScenarioId,
    _hitScenarioDisplayIndex: hitScenarioDisplayIndex,
    _hitScenarioName: hitScenarioName
  };
}

// v2.1.9 D16=b：典型 channels 列表 fixture（与 channelsRepository.listChannels 输出形态一致）
const TEST_CHANNELS = [
  { id: 1, name: '通用', ownerLocation: '通用', isBuiltin: true, label: '通用' },
  { id: 2, name: '工商', ownerLocation: '上海', isBuiltin: false, label: '工商-上海' },
  { id: 3, name: '招商', ownerLocation: '北京', isBuiltin: false, label: '招商-北京' }
];

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-hit-rows-writer-'));
});

test.afterEach(() => {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    tmpDir = null;
  }
});

// ========================================================================
// 1) 辅助函数 unit
// ========================================================================

test.describe('buildHitScenarioLabel', () => {
  test('完整 metadata → "[N] name"', () => {
    const row = { _hitScenarioId: 101, _hitScenarioDisplayIndex: 1, _hitScenarioName: '专属场景' };
    assert.strictEqual(buildHitScenarioLabel(row), '[1] 专属场景');
  });

  test('_hitScenarioId 为 null → ""', () => {
    const row = { _hitScenarioId: null, _hitScenarioDisplayIndex: 1, _hitScenarioName: '专属场景' };
    assert.strictEqual(buildHitScenarioLabel(row), '');
  });

  test('_hitScenarioName 为空 → ""', () => {
    const row = { _hitScenarioId: 1, _hitScenarioDisplayIndex: 1, _hitScenarioName: '' };
    assert.strictEqual(buildHitScenarioLabel(row), '');
  });

  test('_hitScenarioDisplayIndex 缺失 → ""', () => {
    const row = { _hitScenarioId: 1, _hitScenarioName: '专属场景' };
    assert.strictEqual(buildHitScenarioLabel(row), '');
  });

  test('null row → ""', () => {
    assert.strictEqual(buildHitScenarioLabel(null), '');
  });

  test('displayIndex=0 仍输出（0 是合法序号 fallback）', () => {
    const row = { _hitScenarioId: 1, _hitScenarioDisplayIndex: 0, _hitScenarioName: '场景' };
    assert.strictEqual(buildHitScenarioLabel(row), '[0] 场景');
  });
});

test.describe('buildOriginalBaseName', () => {
  test('正常路径 + xlsx → basename 无扩展', () => {
    assert.strictEqual(buildOriginalBaseName('/Users/x/工商-上海-2026-04.xlsx'), '工商-上海-2026-04');
  });

  test('null / undefined / 空 → "unknown"', () => {
    assert.strictEqual(buildOriginalBaseName(null), 'unknown');
    assert.strictEqual(buildOriginalBaseName(undefined), 'unknown');
    assert.strictEqual(buildOriginalBaseName(''), 'unknown');
  });

  test('无扩展名 → 全 basename', () => {
    assert.strictEqual(buildOriginalBaseName('/tmp/abc'), 'abc');
  });

  test('csv 扩展也兼容（去扩展）', () => {
    assert.strictEqual(buildOriginalBaseName('/tmp/工商.csv'), '工商');
  });
});

test.describe('buildDateDir', () => {
  test('格式 YYYY-MM-DD', () => {
    const dir = buildDateDir(new Date('2026-04-15T10:00:00'));
    assert.strictEqual(dir, '2026-04-15');
  });

  test('补零', () => {
    const dir = buildDateDir(new Date('2026-01-05T10:00:00'));
    assert.strictEqual(dir, '2026-01-05');
  });
});

test.describe('SUFFIX_HEADERS 常量（spec §5.2 D17=b 列序）', () => {
  test('精确 3 列：[匹配渠道, 匹配状态, 命中场景]', () => {
    assert.deepStrictEqual(SUFFIX_HEADERS, ['匹配渠道', '匹配状态', '命中场景']);
  });
});

// v3.0.4 F2：命中场景行报表落位子目录由 error-reports 互换为 bank-statement-process。
//   常量保护断言——防互换被无意回退（落位断言以本 symbol 引用，不会自动暴露回退）。
test.describe('DEFAULT_REPORT_SUBDIR 常量（v3.0.4 F2 目录互换）', () => {
  test('落位子目录 = bank-statement-process（与错误报告目录互换后）', () => {
    assert.strictEqual(DEFAULT_REPORT_SUBDIR, 'bank-statement-process');
  });
});

// v2.1.9 D16=b 新增：normalizeChannelsToLabelMap unit
test.describe('normalizeChannelsToLabelMap (D16=b)', () => {
  test('null / undefined → null（writer 触发回退）', () => {
    assert.strictEqual(normalizeChannelsToLabelMap(null), null);
    assert.strictEqual(normalizeChannelsToLabelMap(undefined), null);
  });

  test('Array<channel> → Map<id, label>', () => {
    const m = normalizeChannelsToLabelMap([
      { id: 1, label: '通用' },
      { id: 2, label: '工商-上海' }
    ]);
    assert.ok(m instanceof Map);
    assert.strictEqual(m.get(1), '通用');
    assert.strictEqual(m.get(2), '工商-上海');
  });

  test('Map<id, channel> 入参 → Map<id, label>', () => {
    const input = new Map([
      [1, { id: 1, label: '通用' }],
      [2, { id: 2, label: '工商-上海' }]
    ]);
    const m = normalizeChannelsToLabelMap(input);
    assert.strictEqual(m.get(1), '通用');
    assert.strictEqual(m.get(2), '工商-上海');
  });

  test('Map<id, string> 入参 → 透传 string', () => {
    const input = new Map([[1, '通用'], [2, '工商-上海']]);
    const m = normalizeChannelsToLabelMap(input);
    assert.strictEqual(m.get(1), '通用');
    assert.strictEqual(m.get(2), '工商-上海');
  });

  test('缺 label 字段 → fallback `${name}-${ownerLocation}`', () => {
    const m = normalizeChannelsToLabelMap([
      { id: 5, name: '招商', ownerLocation: '北京' }
    ]);
    assert.strictEqual(m.get(5), '招商-北京');
  });

  test('其他非法 input（object 等）→ null', () => {
    assert.strictEqual(normalizeChannelsToLabelMap({}), null);
    assert.strictEqual(normalizeChannelsToLabelMap('foo'), null);
    assert.strictEqual(normalizeChannelsToLabelMap(123), null);
  });
});

// v2.1.9 D16=b 新增：buildHitChannelLabel unit
test.describe('buildHitChannelLabel (D16=b)', () => {
  const map = new Map([[1, '通用'], [2, '工商-上海']]);

  test('null row → ""', () => {
    assert.strictEqual(buildHitChannelLabel(null, map), '');
  });

  test('channelsLabelMap=null + row 有 _hitChannelKey → 回退 _hitChannelKey', () => {
    const row = { _hitChannelKey: 'BOSH-CN', _hitChannelId: 1 };
    assert.strictEqual(buildHitChannelLabel(row, null), 'BOSH-CN');
  });

  test('channelsLabelMap=null + row 无 _hitChannelKey → ""', () => {
    const row = { _hitChannelId: 1 };
    assert.strictEqual(buildHitChannelLabel(row, null), '');
  });

  test('channelsLabelMap 非空 + _hitChannelId 命中通用 → "通用"', () => {
    const row = { _hitChannelKey: 'BOSH-CN', _hitChannelId: 1 };
    assert.strictEqual(buildHitChannelLabel(row, map), '通用');
  });

  test('channelsLabelMap 非空 + _hitChannelId 命中专属 → "工商-上海"', () => {
    const row = { _hitChannelKey: 'BOSH-CN', _hitChannelId: 2 };
    assert.strictEqual(buildHitChannelLabel(row, map), '工商-上海');
  });

  test('channelsLabelMap 非空 + _hitChannelId=null（未命中行）→ ""', () => {
    const row = { _hitChannelKey: 'BOSH-CN', _hitChannelId: null };
    assert.strictEqual(buildHitChannelLabel(row, map), '');
  });

  test('channelsLabelMap 非空 + _hitChannelId 查不到 → ""', () => {
    const row = { _hitChannelKey: 'BOSH-CN', _hitChannelId: 999 };
    assert.strictEqual(buildHitChannelLabel(row, map), '');
  });
});

// ========================================================================
// 2) writeScenarioHitRows 主流程
// ========================================================================

test.describe('writeScenarioHitRows — 正常路径', () => {
  test('命中专属场景：写入完整列 + 路径返回正确', async () => {
    const rows = [
      makeRow({
        rowId: 'R1',
        hitChannelKey: '工商-上海',
        matchStatus: '命中',
        matchedChannelId: 2,
        fallbackChannelId: null,
        hitChannelId: 2,  // v2.1.9 D16=b：命中专属渠道
        hitScenarioDisplayIndex: 1,
        hitScenarioName: '工行上海对账场景'
      })
    ];

    const result = await writeScenarioHitRows(rows, '/tmp/工商-上海-2026-04.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS,
      channels: TEST_CHANNELS
    });

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.rowCount, 1);
    // 文件名规范（D15=a）
    assert.match(result.fileName, /^命中场景行-工商-上海-2026-04-20260427T143022\.xlsx$/);
    // 落位（D14=a）
    assert.strictEqual(
      result.filePath,
      path.join(tmpDir, DEFAULT_REPORT_SUBDIR, buildDateDir(), result.fileName)
    );
    assert.ok(fs.existsSync(result.filePath), '文件应存在');
    // tmp 不留
    assert.ok(!fs.existsSync(`${result.filePath}.tmp`), 'tmp 应已 rename');
  });

  test('命中通用兜底（行匹配专属 + hit 在通用）：D16=b 匹配渠道列 = "通用"', async () => {
    const rows = [
      makeRow({
        rowId: 'R1',
        hitChannelKey: '工商-上海',  // 行原始渠道 key（仍为审计列保留）
        matchStatus: '命中',  // 行匹配到专属（spec §2.2 命中渠道）
        matchedChannelId: 2,
        fallbackChannelId: 1,  // 但命中通用 → fallback 标记
        hitChannelId: 1,  // v2.1.9 D16=b：实际命中通用 → 渠道列 = "通用"
        hitScenarioDisplayIndex: 2,
        hitScenarioName: '通用兜底场景'
      })
    ];
    const result = await writeScenarioHitRows(rows, '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS,
      channels: TEST_CHANNELS
    });

    // readback 验证列值
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    const dataRow = sheet.getRow(2);
    // D16=b：命中通用 → '通用'（不是 '工商-上海'）
    assert.strictEqual(dataRow.getCell(TEST_HEADERS.length + 1).value, '通用');
    assert.strictEqual(dataRow.getCell(TEST_HEADERS.length + 2).value, '命中');
    assert.strictEqual(dataRow.getCell(TEST_HEADERS.length + 3).value, '[2] 通用兜底场景');
  });

  test('兜底命中（未匹配渠道 + 通用命中）：D16=b 匹配渠道列 = "通用"', async () => {
    const rows = [
      makeRow({
        rowId: 'R1',
        hitChannelKey: '招行-未知',  // 行原始 key（库内无的渠道）
        matchStatus: '兜底',  // 未匹配（spec §2.2）
        matchedChannelId: null,
        fallbackChannelId: null,
        hitChannelId: 1,  // v2.1.9 D16=b：兜底直接走通用，hitChannelId=1
        hitScenarioDisplayIndex: 5,
        hitScenarioName: '通用对账场景'
      })
    ];
    const result = await writeScenarioHitRows(rows, '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS,
      channels: TEST_CHANNELS
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    const dataRow = sheet.getRow(2);
    // D16=b：实际命中通用 → '通用'（不是原始 '招行-未知'）
    assert.strictEqual(dataRow.getCell(TEST_HEADERS.length + 1).value, '通用');
    assert.strictEqual(dataRow.getCell(TEST_HEADERS.length + 2).value, '兜底');
    assert.strictEqual(dataRow.getCell(TEST_HEADERS.length + 3).value, '[5] 通用对账场景');
  });

  // v2.1.9 D16=b 新增 case：命中专属（非通用）→ 匹配渠道 = name-ownerLocation
  test('命中专属（非通用）：D16=b 匹配渠道列 = "工商-上海"', async () => {
    const rows = [
      makeRow({
        rowId: 'R1',
        hitChannelKey: '工商-上海',
        matchStatus: '命中',
        matchedChannelId: 2,
        fallbackChannelId: null,
        hitChannelId: 2,  // 命中专属
        hitScenarioDisplayIndex: 1,
        hitScenarioName: '专属场景'
      })
    ];
    const result = await writeScenarioHitRows(rows, '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS,
      channels: TEST_CHANNELS
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    const dataRow = sheet.getRow(2);
    assert.strictEqual(dataRow.getCell(TEST_HEADERS.length + 1).value, '工商-上海');
  });

  // v2.1.9 D16=b 新增 case：未传 channels opts → 回退 _hitChannelKey（向后兼容）
  test('未传 opts.channels → 回退 _hitChannelKey（向后兼容老 caller / 单维路径）', async () => {
    const rows = [
      makeRow({
        rowId: 'R1',
        hitChannelKey: 'BOSH-CN',  // 原始 Channel-地区（行原值）
        matchStatus: '命中',
        matchedChannelId: 2,
        hitChannelId: 1,  // 即使有 hitChannelId，缺 opts.channels 也回退 _hitChannelKey
        hitScenarioDisplayIndex: 1,
        hitScenarioName: '通用场景'
      })
    ];
    const result = await writeScenarioHitRows(rows, '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
      // 不传 channels
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    const dataRow = sheet.getRow(2);
    // 回退到 _hitChannelKey 原始值
    assert.strictEqual(dataRow.getCell(TEST_HEADERS.length + 1).value, 'BOSH-CN');
  });

  // v2.1.9 D16=b 新增 case：传 channels 但 _hitChannelId 未在 channels 中 → '' 兜底
  test('传 channels + _hitChannelId 不在 map 中 → "" 兜底', async () => {
    const rows = [
      makeRow({
        rowId: 'R1',
        hitChannelKey: '工商-上海',
        hitChannelId: 999,  // 库中无的 id
        hitScenarioDisplayIndex: 1,
        hitScenarioName: '场景'
      })
    ];
    const result = await writeScenarioHitRows(rows, '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS,
      channels: TEST_CHANNELS
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    const dataRow = sheet.getRow(2);
    const v = dataRow.getCell(TEST_HEADERS.length + 1).value;
    // 查不到 → '' 或 null（exceljs readback）
    assert.ok(v === '' || v === null, `应为空，实际 ${JSON.stringify(v)}`);
  });

  // v2.1.9 D16=b 新增 case：channels 以 Map 形态传入
  test('opts.channels 接受 Map 形态（id → channel-obj）', async () => {
    const channelsMap = new Map([
      [1, { id: 1, name: '通用', ownerLocation: '通用', isBuiltin: true, label: '通用' }],
      [2, { id: 2, name: '工商', ownerLocation: '上海', isBuiltin: false, label: '工商-上海' }]
    ]);
    const rows = [
      makeRow({ rowId: 'R1', hitChannelId: 2, hitScenarioDisplayIndex: 1, hitScenarioName: '专属' })
    ];
    const result = await writeScenarioHitRows(rows, '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS,
      channels: channelsMap
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    assert.strictEqual(sheet.getRow(2).getCell(TEST_HEADERS.length + 1).value, '工商-上海');
  });
});

test.describe('writeScenarioHitRows — 列结构精确（spec §5.2 + D17=b）', () => {
  test('表头列序：headers + [匹配渠道, 匹配状态, 命中场景]', async () => {
    const rows = [makeRow({ rowId: 'R1' })];
    const result = await writeScenarioHitRows(rows, '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    const headerRow = sheet.getRow(1);
    const headerVals = [];
    for (let i = 1; i <= TEST_HEADERS.length + 3; i++) {
      headerVals.push(headerRow.getCell(i).value);
    }
    assert.deepStrictEqual(headerVals, [...TEST_HEADERS, '匹配渠道', '匹配状态', '命中场景']);
    // 列数 = headers + 3
    assert.strictEqual(sheet.columnCount, TEST_HEADERS.length + 3);
  });

  test('使用默认 BANK_STATEMENT_FIELDS（不传 opts.headers）→ 44 + 3 = 47 列', async () => {
    // 构造一个带 44 列 + metadata 的 row（仅填几个字段，其余空字符串兜底）
    const row = {
      _rowId: 'R1',
      Channel: '工商',
      地区: '上海',
      Currency: 'CNY',
      'Credit Amount': 100,
      _modifiedColumns: new Set(),
      _hitChannelKey: '工商-上海',
      _matchStatus: '命中',
      _matchedChannelId: 2,
      _fallbackChannelId: null,
      // v2.1.9 D16=b：hitChannelId=2 → 经 channels 反查 → '工商-上海'
      _hitChannelId: 2,
      _hitScenarioId: 1,
      _hitScenarioDisplayIndex: 1,
      _hitScenarioName: '场景'
    };
    const result = await writeScenarioHitRows([row], '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      channels: TEST_CHANNELS
      // headers 不传 → 默认 BANK_STATEMENT_FIELDS
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    assert.strictEqual(sheet.columnCount, BANK_STATEMENT_FIELDS.length + 3);
    // 末尾 3 列固定
    const lastIdx = BANK_STATEMENT_FIELDS.length + 1;
    assert.strictEqual(sheet.getRow(1).getCell(lastIdx).value, '匹配渠道');
    assert.strictEqual(sheet.getRow(1).getCell(lastIdx + 1).value, '匹配状态');
    assert.strictEqual(sheet.getRow(1).getCell(lastIdx + 2).value, '命中场景');
    // 数据行末尾值（D16=b：从 channels 表反查 label）
    assert.strictEqual(sheet.getRow(2).getCell(lastIdx).value, '工商-上海');
    assert.strictEqual(sheet.getRow(2).getCell(lastIdx + 1).value, '命中');
    assert.strictEqual(sheet.getRow(2).getCell(lastIdx + 2).value, '[1] 场景');
  });
});

test.describe('writeScenarioHitRows — 文件名规范（D15=a）', () => {
  test('命名格式 命中场景行-{basename}-{timestamp}.xlsx', async () => {
    const result = await writeScenarioHitRows([], '/tmp/招商银行-北京.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
    });
    assert.strictEqual(result.fileName, '命中场景行-招商银行-北京-20260427T143022.xlsx');
  });

  test('originalFilePath 无扩展名也兼容', async () => {
    const result = await writeScenarioHitRows([], '/tmp/abc', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
    });
    assert.strictEqual(result.fileName, '命中场景行-abc-20260427T143022.xlsx');
  });

  test('originalFilePath 缺失 → "unknown" 兜底', async () => {
    const result = await writeScenarioHitRows([], null, {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
    });
    assert.strictEqual(result.fileName, '命中场景行-unknown-20260427T143022.xlsx');
  });
});

test.describe('writeScenarioHitRows — 空 modifiedRows graceful', () => {
  test('空数组 → 仍输出含表头空 sheet', async () => {
    const result = await writeScenarioHitRows([], '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
    });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.rowCount, 0);
    assert.ok(fs.existsSync(result.filePath), '空文件应存在');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    // 仅表头行
    assert.strictEqual(sheet.rowCount, 1);
    // 表头列数仍正确
    assert.strictEqual(sheet.columnCount, TEST_HEADERS.length + 3);
  });
});

test.describe('writeScenarioHitRows — graceful 兜底', () => {
  test('row 缺 _hitChannelKey / _matchStatus → "" 兜底（不抛错）', async () => {
    const rows = [
      {
        _rowId: 'R1',
        Date: '2026-04-01',
        Amount: 100,
        CustomerRef: 'X',
        // 没有 _hitChannelKey / _matchStatus
        _hitScenarioId: 1,
        _hitScenarioDisplayIndex: 1,
        _hitScenarioName: '场景'
      }
    ];
    const result = await writeScenarioHitRows(rows, '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    const dataRow = sheet.getRow(2);
    // 缺失字段 → '' 兜底，不抛错（ExcelJS 把空字符串读回可能为 null，allow 两种）
    const channelKeyVal = dataRow.getCell(TEST_HEADERS.length + 1).value;
    assert.ok(channelKeyVal === '' || channelKeyVal === null, `匹配渠道空值 ('') 或 null，实际 ${JSON.stringify(channelKeyVal)}`);
    const matchStatusVal = dataRow.getCell(TEST_HEADERS.length + 2).value;
    assert.ok(matchStatusVal === '' || matchStatusVal === null, `匹配状态空值 ('') 或 null，实际 ${JSON.stringify(matchStatusVal)}`);
    // 命中场景仍正确
    assert.strictEqual(dataRow.getCell(TEST_HEADERS.length + 3).value, '[1] 场景');
  });

  test('未命中行（无 _hitScenarioId）混入 modifiedRows → 命中场景列空', async () => {
    const rows = [
      makeRow({ rowId: 'R1' }),  // 正常命中
      {
        _rowId: 'R2',
        Date: '2026-04-02',
        Amount: 200,
        CustomerRef: 'Y',
        _hitChannelKey: '招商-未知',
        _matchStatus: '兜底',
        // 没有 _hitScenarioId（未命中）— 严格 spec 不该混入，但兜底处理
        _hitScenarioId: null,
        _hitScenarioDisplayIndex: null,
        _hitScenarioName: null
      }
    ];
    const result = await writeScenarioHitRows(rows, '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    // R2 命中场景列为空（buildHitScenarioLabel 兜底 ''）
    const r2Hit = sheet.getRow(3).getCell(TEST_HEADERS.length + 3).value;
    assert.ok(r2Hit === '' || r2Hit === null, `R2 命中场景列应空，实际 ${JSON.stringify(r2Hit)}`);
  });
});

test.describe('writeScenarioHitRows — 入参校验', () => {
  test('modifiedRows 非数组 → 抛错', async () => {
    await assert.rejects(
      writeScenarioHitRows(null, '/tmp/x.xlsx', { exportRoot: tmpDir }),
      /modifiedRows 必须是数组/
    );
  });

  test('opts.exportRoot 缺失 + opts.reportDir 缺失 → 抛错', async () => {
    await assert.rejects(
      writeScenarioHitRows([], '/tmp/x.xlsx', {}),
      /opts\.exportRoot 必填/
    );
  });

  test('opts.reportDir 显式提供 → 绕过 exportRoot 拼接', async () => {
    const reportDir = path.join(tmpDir, 'custom-dir');
    const result = await writeScenarioHitRows([], '/tmp/x.xlsx', {
      reportDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
    });
    assert.strictEqual(path.dirname(result.filePath), reportDir);
    assert.ok(fs.existsSync(result.filePath));
  });
});

test.describe('writeScenarioHitRows — 内部 _ 字段不泄漏（spec §5.3）', () => {
  test('表头不含 _ 前缀字段（投影自动过滤）', async () => {
    const rows = [makeRow({ rowId: 'R1' })];
    const result = await writeScenarioHitRows(rows, '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    // 取所有表头单元格值（exceljs values 第 0 索引是 undefined）
    const headerVals = sheet.getRow(1).values.slice(1).filter((v) => v != null);
    const leaks = headerVals.filter((v) => typeof v === 'string' && v.startsWith('_'));
    assert.strictEqual(leaks.length, 0, `应无 _ 前缀字段泄漏，实际 leaks=${JSON.stringify(leaks)}`);
  });
});

test.describe('writeScenarioHitRows — atomic write（spec §5.3）', () => {
  test('成功后 .tmp 文件不存在', async () => {
    const result = await writeScenarioHitRows([makeRow({ rowId: 'R1' })], '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
    });
    assert.ok(fs.existsSync(result.filePath));
    assert.ok(!fs.existsSync(`${result.filePath}.tmp`));
  });
});

test.describe('writeScenarioHitRows — 多行 + 行序保持', () => {
  test('3 行按入参顺序写入', async () => {
    const rows = [
      makeRow({ rowId: 'R1', date: '2026-04-01', amount: 100 }),
      makeRow({ rowId: 'R2', date: '2026-04-02', amount: 200 }),
      makeRow({ rowId: 'R3', date: '2026-04-03', amount: 300 })
    ];
    const result = await writeScenarioHitRows(rows, '/tmp/test.xlsx', {
      exportRoot: tmpDir,
      timestamp: '20260427T143022',
      headers: TEST_HEADERS
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
    assert.strictEqual(sheet.rowCount, 4); // 1 表头 + 3 数据
    assert.strictEqual(sheet.getRow(2).getCell(1).value, '2026-04-01');
    assert.strictEqual(sheet.getRow(3).getCell(1).value, '2026-04-02');
    assert.strictEqual(sheet.getRow(4).getCell(1).value, '2026-04-03');
  });
});
