// v2.1.16-beta.6 需求 B 单测：预加工导出双 sheet「未命中场景 / 命中场景」
//   覆盖 AC B-1~B-6（PRD §三）+ 决策 D5/D8/D9/B-Q1/B-Q2
//   🔴 资金红线：对账主产物格式。断言精确对应新契约（命中明细第1列 + 原列右移1 + sheet 顺序对调）。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  writeBankStatementOutput,
  buildHitDetail,
  SHEET1_UNMATCHED_NAME,
  SHEET2_HIT_NAME,
  SHEET1_A1_NOTICE,
  HIT_DETAIL_HEADER,
  MANY_TO_MANY_NOTE_HEADER,
  SHEET_MANY_TO_MANY_NAME,
  MARK_WITHOUT_RESULT
} = require('../../../src/main-process/exceljs-writer');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta6-b-'));
  return path.join(dir, name);
}

// ===== buildHitDetail（命中明细拼接，v3.0.7 需求B/C/D 格式 {字段名}:{wrap(旧)}→{wrap(新)}）=====
test('B buildHitDetail 单条字段变更格式精确（字段名前缀 + 半角冒号 + 全角箭头；纯数字→中文双引号）', () => {
  const out = buildHitDetail([
    { scenarioName: '按字段区分发生额', column: 'Credit Amount', oldValue: '100', newValue: '0' }
  ]);
  assert.strictEqual(out, 'Credit Amount:“100”→“0”');
});

test('B buildHitDetail 多字段变更 "; " 单行拼接（无换行，末条无尾分隔）', () => {
  const out = buildHitDetail([
    { scenarioName: 'S', column: 'A', oldValue: '1', newValue: '2' },
    { scenarioName: 'S', column: 'B', oldValue: '3', newValue: '4' }
  ]);
  assert.strictEqual(out, 'A:“1”→“2”; B:“3”→“4”');
  assert.ok(out.includes('; '), '多段用 "; " 分隔');
  assert.ok(!out.includes('\n'), 'C 单行布局：命中明细绝不含换行');
});

test('B buildHitDetail 空 → 空串', () => {
  assert.strictEqual(buildHitDetail([]), '');
  assert.strictEqual(buildHitDetail(null), '');
});

// ===== wrap 含数字/不含数字边界（v3.0.7 需求B/C/D：字段名前缀 + 全角箭头 →）=====
//   wrapHitValue 口径不变：含【任意数字字符】→ 中文双引号（trim 后）；完全不含数字 → 半角尖括号（原始 s）。
//   前缀 = column（裸写），箭头 = 全角 →，D：值不省略。
test('B buildHitDetail wrap 边界：空串/负数小数/千分位/数字英文混合/纯英文（字段名前缀 + 全角箭头）', () => {
  // 空串 → <>（不含数字 → 尖括号空）；column 缺省 → 前缀空串
  assert.strictEqual(buildHitDetail([{ oldValue: '', newValue: '' }]), ':<>→<>');
  // 负数 / 小数（含数字）→ 中文双引号（trim 后判定）
  assert.strictEqual(
    buildHitDetail([{ column: 'Amount', oldValue: '-12.5', newValue: '3.0' }]),
    'Amount:“-12.5”→“3.0”'
  );
  // 千分位含逗号（含数字）→ 中文双引号（按"含数字"归双引号）
  assert.strictEqual(
    buildHitDetail([{ column: 'Amount', oldValue: '1,000', newValue: '2,000' }]),
    'Amount:“1,000”→“2,000”'
  );
  // 字母数字混合（含数字）→ 中文双引号
  assert.strictEqual(
    buildHitDetail([{ column: 'Ref', oldValue: 'abc123', newValue: 'x' }]),
    'Ref:“abc123”→<x>'
  );
  // 数字英文混合（如交易流水号 T54SWIC494447，含数字）→ 中文双引号
  assert.strictEqual(
    buildHitDetail([{ column: 'ReconciliationId', oldValue: 'T54SWIC494447', newValue: '123' }]),
    'ReconciliationId:“T54SWIC494447”→“123”'
  );
  // 纯英文（Fundtransfer-out，不含数字）→ 尖括号（保留原始）
  assert.strictEqual(
    buildHitDetail([{ column: 'FundType', oldValue: 'Fundtransfer-out', newValue: 'Refund' }]),
    'FundType:<Fundtransfer-out>→<Refund>'
  );
  // 前后带空格的纯数字 → trim 后走双引号分支，显示 trim 后值
  assert.strictEqual(
    buildHitDetail([{ column: 'Credit Amount', oldValue: ' 100 ', newValue: '0' }]),
    'Credit Amount:“100”→“0”'
  );
});

// ===== sheet1「未命中场景」：A1 提示 + 表头 + FundType 排序（B-1/B-2/B-Q1/D8）=====
//   v3.0.8 W2：未命中 sheet 表头/数据整体右移一列（从 B 列起，getCell 第 2 参数 = colIdx+2）；
//            A 列除 A1 提醒外留空。命中场景 sheet 不变（见下方 B sheet2 用例）。
test('B sheet1 未命中场景：A1 加粗提示 + 第1行表头(B列,#9上移) + Mark without result 行排前（W2 右移）', async () => {
  const headers = ['MerchantId', 'FundType', 'Amount'];
  const unmatchedRows = [
    { MerchantId: 'm1', FundType: 'Ach Return', Amount: '50', _rowId: 'u1', _modifiedColumns: new Set() },
    { MerchantId: 'm2', FundType: MARK_WITHOUT_RESULT, Amount: '100', _rowId: 'u2', _modifiedColumns: new Set() }
  ];
  const out = tmpFile('s1.xlsx');
  await writeBankStatementOutput([], headers, out, unmatchedRows, []);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  // sheet 顺序对调：未命中场景(0) → 命中场景(1)
  assert.strictEqual(wb.worksheets[0].name, SHEET1_UNMATCHED_NAME, 'sheet1 = 未命中场景');
  assert.strictEqual(wb.worksheets[1].name, SHEET2_HIT_NAME, 'sheet2 = 命中场景');
  const s1 = wb.worksheets[0];
  // B-1：A1 加粗提示（W2 不变）
  assert.strictEqual(s1.getCell('A1').value, SHEET1_A1_NOTICE);
  assert.ok(s1.getCell('A1').font && s1.getCell('A1').font.bold, 'A1 加粗');
  // W2 + #9：A 列除 A1 外留空（表头已上移到第 1 行 B 列起；第 2 行起数据 A 列为空）
  assert.ok(s1.getCell(2, 1).value === null || s1.getCell(2, 1).value === undefined, '#9 数据行 A 列留空');
  assert.ok(s1.getCell(3, 1).value === null || s1.getCell(3, 1).value === undefined, '#9 数据行 A 列留空');
  // B-Q1 + W2 + #9：表头上移到第 1 行（与 A1 提醒同行）、从 B 列（第 2 列）起
  assert.strictEqual(s1.getCell(1, 2).value, 'MerchantId', '#9 第1行表头 MerchantId 从 B 列起');
  assert.strictEqual(s1.getCell(1, 3).value, 'FundType', '#9 第1行表头 FundType（右移1）');
  assert.strictEqual(s1.getCell(1, 4).value, 'Amount', '#9 第1行表头 Amount（右移1）');
  // B-2/D8 + W2 + #9：第 2 行起数据、从 B 列起，FundType='Mark without result' 行排前
  assert.strictEqual(s1.getCell(2, 2).value, 'm2', '#9 Mark without result 行排第一（第2行 B 列）');
  assert.strictEqual(s1.getCell(2, 3).value, MARK_WITHOUT_RESULT, '#9 FundType 数据右移1');
  assert.strictEqual(s1.getCell(3, 2).value, 'm1', '#9 其他未命中行随后（第3行 B 列）');
});

// ===== sheet2「命中场景」：命中明细列 + 异常说明列 + 原列右移 + 标黄（B-3/B-4/D5/D9）=====
test('B sheet2 命中场景：第1列命中明细 + 第2列异常说明 + 原列右移2 + 标黄右移', async () => {
  const headers = ['MerchantId', 'FundType', 'Amount'];
  const modifiedRows = [
    { MerchantId: 'm1', FundType: 'x', Amount: '0', _rowId: 'r1', _modifiedColumns: new Set(['FundType']) }
  ];
  const modifications = [
    { rowId: 'r1', column: 'FundType', oldValue: 'old', newValue: 'x', scenarioName: '场景1' }
  ];
  const out = tmpFile('s2.xlsx');
  await writeBankStatementOutput(modifiedRows, headers, out, [], modifications);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const s2 = wb.getWorksheet(SHEET2_HIT_NAME);
  // B-3：第1列表头 = 命中明细，第2列表头 = 异常说明
  assert.strictEqual(s2.getCell(1, 1).value, HIT_DETAIL_HEADER, '第1列表头=命中明细');
  assert.strictEqual(s2.getCell(1, 2).value, MANY_TO_MANY_NOTE_HEADER, '第2列表头=异常说明');
  assert.strictEqual(s2.getCell(1, 3).value, 'MerchantId', '原表头右移2');
  // B-4：命中明细内容（v3.0.7 需求B/C/D 格式 {字段名}:{wrap(旧)}→{wrap(新)}；old/x 均非数字→尖括号，全角箭头）
  assert.strictEqual(
    s2.getCell(2, 1).value,
    'FundType:<old>→<x>'
  );
  assert.strictEqual(s2.getCell(2, 2).value, '', '无异常说明时第2列为空');
  // 原数据右移2：MerchantId 在第3列
  assert.strictEqual(s2.getCell(2, 3).value, 'm1', '原数据列右移2');
  // D5：FundType 标黄（headers index 1 → 右移列 = 1+3 = 第4列）
  const fundCell = s2.getCell(2, 4);
  assert.ok(
    fundCell.fill && fundCell.fill.fgColor && fundCell.fill.fgColor.argb === 'FFFFFF00',
    'FundType 标黄保留（右移2）'
  );
  // 未改字段 MerchantId（第3列）不标黄
  const mCell = s2.getCell(2, 3);
  assert.ok(!mCell.fill || !mCell.fill.fgColor, 'MerchantId 未改不标黄');
});

test('B sheet2 异常说明并入命中场景：不再输出独立异常 sheet，note 按 _rowId 写第2列并拼接', async () => {
  const headers = ['MerchantId', 'FundType', 'Amount'];
  const modifiedRows = [
    { MerchantId: 'm1', FundType: 'x', Amount: '0', _rowId: 'r1', _modifiedColumns: new Set(['FundType']) },
    { MerchantId: 'm2', FundType: 'y', Amount: '0', _rowId: 'r2', _modifiedColumns: new Set() },
    { MerchantId: 'm3', FundType: 'z', Amount: '0', _rowId: 'r3', _modifiedColumns: new Set() }
  ];
  const manyToManyRows = [
    { row: { _rowId: 'r2' }, note: '调拨多对多' },
    { row: { _rowId: 'r2' }, note: '网关多对多' },
    { row: { _rowId: 'r3' }, note: '   ' },
    { row: { _rowId: 'missing' }, note: '不在命中行中' }
  ];
  const out = tmpFile('m2m-inline.xlsx');

  await writeBankStatementOutput(modifiedRows, headers, out, [], [], null, null, manyToManyRows);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  assert.ok(!wb.getWorksheet(SHEET_MANY_TO_MANY_NAME), '不再生成独立「异常-人工判断」sheet');
  assert.ok(!wb.getWorksheet('异常-人工处理'), '不生成历史别名「异常-人工处理」sheet');
  const s2 = wb.getWorksheet(SHEET2_HIT_NAME);
  assert.strictEqual(s2.getCell(2, 2).value, '', '无 note 的命中行异常说明为空');
  assert.strictEqual(s2.getCell(3, 1).value, '', '仅有异常说明、无字段修改时命中明细为空');
  assert.strictEqual(s2.getCell(3, 2).value, '调拨多对多; 网关多对多', '同 rowId 多条 note 用 "; " 拼接');
  assert.strictEqual(s2.getCell(4, 2).value, '', '空 note 不写入异常说明');
});

// ===== B-6 行数守恒 + B-5 空边界 =====
test('B 行数守恒：未命中 + 命中 = 原始总行数', async () => {
  const headers = ['A', 'B'];
  const modifiedRows = [
    { A: 'h1', B: 'x', _rowId: 'r1', _modifiedColumns: new Set() },
    { A: 'h2', B: 'y', _rowId: 'r2', _modifiedColumns: new Set() }
  ];
  const unmatchedRows = [
    { A: 'u1', B: 'z', _rowId: 'u1', _modifiedColumns: new Set() }
  ];
  const out = tmpFile('conserve.xlsx');
  await writeBankStatementOutput(modifiedRows, headers, out, unmatchedRows, []);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const s1 = wb.getWorksheet(SHEET1_UNMATCHED_NAME); // 第1行(A1提醒+表头) + 数据（#9 上移）
  const s2 = wb.getWorksheet(SHEET2_HIT_NAME);       // 表头 + 数据
  const unmatchedDataRows = s1.actualRowCount - 1;   // 减第1行(表头，含 A1 提醒)（#9 上移后表头与数据各占行）
  const hitDataRows = s2.actualRowCount - 1;         // 减表头
  assert.strictEqual(unmatchedDataRows, 1, '未命中数据 1 行');
  assert.strictEqual(hitDataRows, 2, '命中数据 2 行');
  assert.strictEqual(unmatchedDataRows + hitDataRows, 3, '行数守恒 = 原始 3 行');
});

test('B 空边界：空 modifiedRows + 空 unmatchedRows 不报错', async () => {
  const headers = ['A', 'B'];
  const out = tmpFile('empty.xlsx');
  await writeBankStatementOutput([], headers, out, [], []);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  assert.strictEqual(wb.worksheets.length, 2, '空数据仍输出 2 sheet');
  assert.strictEqual(wb.getWorksheet(SHEET1_UNMATCHED_NAME).getCell('A1').value, SHEET1_A1_NOTICE);
  assert.strictEqual(wb.getWorksheet(SHEET2_HIT_NAME).getCell(1, 1).value, HIT_DETAIL_HEADER);
});

test('v3.2.22 writeBankStatementOutput：按来源编码——银行账单原值读回原值，场景改写的列按 OOXML 原文写出', async () => {
  const XLSX = require('xlsx');
  const { writeBankStatementOutput: write } = require('../../../src/main-process/exceljs-writer');
  const out = tmpFile('nul.xlsx');
  const headers = ['MerchantId', 'ReconciliationId', 'Payment Detail'];
  // 银行账单原值（经 SheetJS 读取，已解码）读回原值；场景改写的列（_modifiedColumns，回填值可能是流式导入的转义原文）按
  //   OOXML 原文写出：同一格的控制字符不说明其余部分已解码，流式导入的混合单元格 `RID\rX_x005F_x0041_` 读回源对账ID。
  const hit = [{
    _rowId: 'r1', _modifiedColumns: new Set(['ReconciliationId']),
    MerchantId: 'A\u0000B', ReconciliationId: 'RID\rX_x005F_x0041_', 'Payment Detail': 'x\u007fy_x0041_z'
  }];
  const unmatched = [
    { _rowId: 'r2', MerchantId: 'AB', ReconciliationId: '', 'Payment Detail': 'line1\nline2\ttab' },
    { _rowId: 'r3', MerchantId: 'A', ReconciliationId: '', 'Payment Detail': '_x0041_x0042_' },
    // 边界：`_x0041` 紧接 NUL 与 `Ax0000_` 是两个不同账号，不能写成同一段可解码文本。
    { _rowId: 'r4', MerchantId: '_x0041\u0000', ReconciliationId: '', 'Payment Detail': '' },
    { _rowId: 'r5', MerchantId: 'Ax0000_', ReconciliationId: '', 'Payment Detail': '' },
    // 🔴 含真实 NUL 的账号与字面 `A_x0000_B` 是两个账号，导出后仍可区分。
    { _rowId: 'r6', MerchantId: 'A_x0000_B', ReconciliationId: '', 'Payment Detail': '' }
  ];
  await write(hit, headers, out, unmatched, []);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const hitSheet = wb.getWorksheet('命中场景');
  assert.strictEqual(hitSheet.getCell(2, 3).value, 'A\u0000B', 'ExcelJS 读回含 NUL 的账号');
  assert.strictEqual(hitSheet.getCell(2, 4).value, 'RID\rX_x0041_', '🔴 混合单元格读回源对账ID');
  assert.strictEqual(hitSheet.getCell(2, 5).value, 'x\u007fy_x0041_z', '银行账单原值读回原值');
  const unmatchedSheet = wb.worksheets.find((sheet) => sheet.name !== '命中场景');
  assert.strictEqual(unmatchedSheet.getCell(2, 2).value, 'AB', '另一个账号不变');
  assert.strictEqual(unmatchedSheet.getCell(2, 4).value, 'line1\nline2\ttab', '换行、制表符原样');
  assert.strictEqual(unmatchedSheet.getCell(3, 4).value, '_x0041_x0042_', '银行账单原值中的字面写法读回原值');
  assert.strictEqual(unmatchedSheet.getCell(4, 2).value, '_x0041\u0000', 'ExcelJS 读回边界账号 1');
  assert.strictEqual(unmatchedSheet.getCell(5, 2).value, 'Ax0000_', 'ExcelJS 读回边界账号 2');
  assert.strictEqual(unmatchedSheet.getCell(6, 2).value, 'A_x0000_B', '🔴 ExcelJS 读回字面账号，不与 A\\0B 混同');

  const sheetJs = XLSX.readFile(out);
  const hitRows = XLSX.utils.sheet_to_json(sheetJs.Sheets['命中场景'], { header: 1, raw: true });
  assert.strictEqual(hitRows[1][2], 'A\u0000B', 'SheetJS 读回含 NUL 的账号');
  assert.strictEqual(hitRows[1][3], 'RID\rX_x0041_', '🔴 SheetJS 读回源对账ID');
  assert.strictEqual(hitRows[1][4], 'x\u007fy_x0041_z');
  const unmatchedName = sheetJs.SheetNames.find((name) => name !== '命中场景');
  const unmatchedRows = XLSX.utils.sheet_to_json(sheetJs.Sheets[unmatchedName], { header: 1, raw: true });
  assert.strictEqual(unmatchedRows[3][1], '_x0041\u0000', 'SheetJS 读回边界账号 1');
  assert.strictEqual(unmatchedRows[4][1], 'Ax0000_', 'SheetJS 读回边界账号 2');
  assert.strictEqual(unmatchedRows[5][1], 'A_x0000_B', '🔴 SheetJS 读回字面账号，不与 A\\0B 混同');
  assert.strictEqual(unmatchedRows[2][3], '_x0041_x0042_');
});

test('v3.2.22 encodeDecodedExcelJsCellText：随机已解码文本经两种读取端解码规则读回原值', () => {
  const { encodeDecodedExcelJsCellText } = require('../../../src/main-process/exceljs-writer');
  const decodeWith = (pattern) => (text) => text.replace(pattern, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  const decoders = [decodeWith(/_x([\da-fA-F]{4})_/ig), decodeWith(/_x([0-9A-F]{4})_/g)];
  const alphabet = ['_', '_', 'x', 'X', '0', '4', '1', 'a', 'F', '\u0000', '\u001f', '\u007f', '\t', '\r', '\n', 'B',
    '_x0041_', '_x005F_', '_x00af_', '_X0041_', 'x0041', '_x00'];
  let seed = 11;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 30000; i += 1) {
    const length = Math.floor(random() * 10);
    let text = '';
    for (let j = 0; j < length; j += 1) text += alphabet[Math.floor(random() * alphabet.length)];
    const encoded = encodeDecodedExcelJsCellText(text);
    assert.doesNotMatch(encoded, /[\u0000-\u0008\u000B-\u001F\u007F]/, JSON.stringify(text));
    for (const decode of decoders) assert.strictEqual(decode(encoded), text, JSON.stringify({ text, encoded }));
  }
  assert.strictEqual(encodeDecodedExcelJsCellText('PLAIN_x00'), 'PLAIN_x00', '不含转义写法与控制字符的文本不变');
  assert.strictEqual(encodeDecodedExcelJsCellText(12), 12);
});

test('v3.2.22 encodeExcelJsCellText：随机文本按两种读取端解码规则，编码结果与原文解码一致', () => {
  const { encodeExcelJsCellText } = require('../../../src/main-process/exceljs-writer');
  // SheetJS（与 Excel）：`_x`/`_X` + 大小写十六进制；ExcelJS 文本：`_x` + 大写十六进制。均为自左向右、不重叠替换。
  const decodeWith = (pattern) => (text) => text.replace(pattern, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  const decodeSheetJs = decodeWith(/_x([\da-fA-F]{4})_/ig);
  const decodeExcelJs = decodeWith(/_x([0-9A-F]{4})_/g);
  const alphabet = ['_', '_', 'x', 'X', '0', '4', '1', 'a', 'F', '\u0000', '\u001f', '\u007f', '\t', '\r', '\n', 'B',
    '_x0041_', '_x005F_', '_x00af_', '_X0041_', '_x000D_', '_xD83D_', 'x0041', '_x00', '41_'];
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 30000; i += 1) {
    const length = Math.floor(random() * 10);
    let text = '';
    for (let j = 0; j < length; j += 1) text += alphabet[Math.floor(random() * alphabet.length)];
    const encoded = encodeExcelJsCellText(text);
    assert.doesNotMatch(encoded, /[\u0000-\u0008\u000B-\u001F\u007F]/, JSON.stringify(text));
    if (!/[\u0000-\u0008\u000B-\u001F\u007F]/.test(text)) {
      assert.strictEqual(encoded, text, `不含控制字符的文本逐字节不变：${JSON.stringify(text)}`);
      continue;
    }
    assert.strictEqual(decodeSheetJs(encoded), decodeSheetJs(text), JSON.stringify({ text, encoded }));
    // 原文含 ExcelJS 不认的写法（小写十六进制或 `_X`）时，两种读取端对原文本身的切分就不同，只按 SheetJS 口径断言。
    if (!/[a-fX]/.test(text)) {
      assert.strictEqual(decodeExcelJs(encoded), decodeExcelJs(text), JSON.stringify({ text, encoded }));
    }
  }
  assert.strictEqual(encodeExcelJsCellText('RID\rX_x005F_x0041_'), 'RID_x000D_X_x005F_x0041_', '已成对的写法原样保留');
  assert.strictEqual(encodeExcelJsCellText('_x0041\u0000'), '_x005F_x0041_x0000_', '会与编码后的控制字符拼出新写法的下划线才转义');
  assert.strictEqual(encodeExcelJsCellText('\rx0041_'), '_x000D_x0041_', '读取端自左向右：编码出的写法吃掉末尾下划线');
});

test('v3.2.22 writeBankStatementOutput：回车写成 _x000D_，`X\\rY`、`X\\nY`、`X\\r\\nY` 三个账号两种读取端都能区分', async () => {
  const XLSX = require('xlsx');
  const { writeBankStatementOutput: write, encodeExcelJsCellText } = require('../../../src/main-process/exceljs-writer');
  assert.strictEqual(encodeExcelJsCellText('X\rY'), 'X_x000D_Y');
  assert.strictEqual(encodeExcelJsCellText('X\nY'), 'X\nY', '换行原样');
  assert.strictEqual(encodeExcelJsCellText('X\r\nY'), 'X_x000D_\nY');
  const out = tmpFile('cr.xlsx');
  const headers = ['MerchantId', 'ReconciliationId'];
  const unmatched = [
    { _rowId: 'r1', MerchantId: 'X\rY', ReconciliationId: '' },
    { _rowId: 'r2', MerchantId: 'X\nY', ReconciliationId: '' },
    { _rowId: 'r3', MerchantId: 'X\r\nY', ReconciliationId: '' }
  ];
  await write([], headers, out, unmatched, []);
  const expected = ['X\rY', 'X\nY', 'X\r\nY'];

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sheet = wb.worksheets.find((ws) => ws.name !== '命中场景');
  assert.deepStrictEqual([2, 3, 4].map((row) => sheet.getCell(row, 2).value), expected, 'ExcelJS 读回');

  const sheetJs = XLSX.readFile(out);
  const name = sheetJs.SheetNames.find((n) => n !== '命中场景');
  const rows = XLSX.utils.sheet_to_json(sheetJs.Sheets[name], { header: 1, raw: true });
  assert.deepStrictEqual([1, 2, 3].map((row) => rows[row][1]), expected, 'SheetJS 读回');
});

test('v3.2.22 writeBankStatementOutput：流式导入落库的转义原文（如对账ID `RID_x005F_x0041_`）原样写出，读回源表字面值', async () => {
  const XLSX = require('xlsx');
  const { writeBankStatementOutput: write, encodeExcelJsCellText } = require('../../../src/main-process/exceljs-writer');
  // 单工作表 .xlsx 流式导入不解 `_xHHHH_`：源表字面 `RID_x0041_` 落库为 `RID_x005F_x0041_`，回填到银行行后导出。
  assert.strictEqual(encodeExcelJsCellText('RID_x005F_x0041_'), 'RID_x005F_x0041_', '不含控制字符：不再转义');
  const out = tmpFile('escaped-id.xlsx');
  const headers = ['MerchantId', 'ReconciliationId'];
  await write([{ _rowId: 'r1', _modifiedColumns: new Set(['ReconciliationId']), MerchantId: 'M1', ReconciliationId: 'RID_x005F_x0041_' }],
    headers, out, [], []);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  assert.strictEqual(wb.getWorksheet('命中场景').getCell(2, 4).value, 'RID_x0041_', 'ExcelJS 读回源表字面值');
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets['命中场景'], { header: 1, raw: true });
  assert.strictEqual(rows[1][3], 'RID_x0041_', 'SheetJS 读回源表字面值');
});

test('v3.2.22 命中明细按来源逐值编码：旧值（银行原值）读回原值、新值（流式导入的转义原文）读回与结果列一致', async () => {
  const XLSX = require('xlsx');
  const { writeBankStatementOutput: write } = require('../../../src/main-process/exceljs-writer');
  assert.strictEqual(
    buildHitDetail([{ column: 'ReconciliationId', oldValue: 'OLD\rID', newValue: 'RID_x005F_x0041_' }]),
    'ReconciliationId:<OLD_x000D_ID>→“RID_x005F_x0041_”',
    '旧值单独编码，新值原样（不随旧值的回车整格再转义一次）'
  );
  assert.strictEqual(
    buildHitDetail([
      { column: 'ReconciliationId', oldValue: 'OLD_x0041_', newValue: 'MID_x005F_x0041_' },
      { column: 'ReconciliationId', oldValue: 'MID_x005F_x0041_', newValue: 'NEW' }
    ]),
    'ReconciliationId:“OLD_x005F_x0041_”→“MID_x005F_x0041_”; ReconciliationId:“MID_x005F_x0041_”→<NEW>',
    '首次改写的旧值是银行原值（按已解码文本）；同列再次改写时旧值即前一次的新值（按原文）'
  );
  // 🔴 值为已解码文本的改写（_valueDecoded：C1 提取、C2 标记、C3 自定义值）按已解码文本；其后再改写时旧值按同一口径。
  assert.strictEqual(
    buildHitDetail([
      { column: 'ReconciliationId', oldValue: 'OLD', newValue: 'C1_x0041_', _valueDecoded: true },
      { column: 'ReconciliationId', oldValue: 'C1_x0041_', newValue: 'GW_x005F_x0041_' },
      { column: 'ReconciliationId', oldValue: 'GW_x005F_x0041_', newValue: 'C3_x0041_', _valueDecoded: true }
    ]),
    'ReconciliationId:<OLD>→“C1_x005F_x0041_”; ReconciliationId:“C1_x005F_x0041_”→“GW_x005F_x0041_”; ' +
      'ReconciliationId:“GW_x005F_x0041_”→“C3_x005F_x0041_”',
    '已解码值读回字面值；链接表原文仍按原文'
  );
  const out = tmpFile('hit-detail-mixed.xlsx');
  const headers = ['MerchantId', 'ReconciliationId'];
  const modifications = [{ rowId: 'r1', column: 'ReconciliationId', oldValue: 'OLD\rID', newValue: 'RID_x005F_x0041_' }];
  await write([{ _rowId: 'r1', _modifiedColumns: new Set(['ReconciliationId']), MerchantId: 'M1', ReconciliationId: 'RID_x005F_x0041_' }],
    headers, out, [], modifications);
  const expectedDetail = 'ReconciliationId:<OLD\rID>→“RID_x0041_”';
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const hit = wb.getWorksheet('命中场景');
  assert.deepStrictEqual([hit.getCell(2, 1).value, hit.getCell(2, 4).value], [expectedDetail, 'RID_x0041_'], 'ExcelJS 读回');
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets['命中场景'], { header: 1, raw: true });
  assert.deepStrictEqual([rows[1][0], rows[1][3]], [expectedDetail, 'RID_x0041_'], 'SheetJS 读回');
});

test('v3.2.22（🔴）异常说明的账号、币种段各按本行该列的来源编码：读回与结果列一致', async () => {
  const XLSX = require('xlsx');
  const { writeBankStatementOutput: write } = require('../../../src/main-process/exceljs-writer');
  const out = tmpFile('many-to-many-note-encoding.xlsx');
  const headers = ['MerchantId', 'Currency', 'ReconciliationId'];
  // 与 many-to-many-detector noteHit 同形：账号、币种段标明取自哪一列，其余为文字。
  const partsOf = (account, currency) => [
    '银行↔网关（账户映射后）多对多：账号 ', { column: 'MerchantId', value: account },
    ' / 币种 ', { column: 'Currency', value: currency },
    ' / 金额 100.00，', '本组银行 2 行 × 网关（账户映射后） 2 行，自动回填仅取其一，请人工复核'
  ];
  const noteOf = (account, currency) => partsOf(account, currency).map((part) => (typeof part === 'string' ? part : part.value)).join('');
  const rows = [
    // r1：MerchantId 是银行账单原值（字面 `A_x0041_B`）→ 按已解码文本，读回字面值。
    { _rowId: 'r1', _modifiedColumns: new Set(['ReconciliationId']), MerchantId: 'A_x0041_B', Currency: 'USD', ReconciliationId: 'RID-1' },
    // r2：MerchantId 被前序场景按链接表原文改写 → 按原文，与结果列同样读回 `B_x0041_`。
    { _rowId: 'r2', _modifiedColumns: new Set(['MerchantId']), MerchantId: 'B_x005F_x0041_', Currency: 'USD', ReconciliationId: '' },
    // r3：只有 Currency 按原文改写 → 币种段按原文，账号段仍按银行原值（两段各自判断）。
    { _rowId: 'r3', _modifiedColumns: new Set(['Currency']), MerchantId: 'C_x0041_', Currency: 'U_x0053_D', ReconciliationId: '' },
    // r4：MerchantId 被改写但值是已解码文本（C1 提取 / C3 自定义值等，_decodedModifiedColumns）→ 按已解码文本。
    { _rowId: 'r4', _modifiedColumns: new Set(['MerchantId']), _decodedModifiedColumns: new Set(['MerchantId']), MerchantId: 'D_x0041_', Currency: 'USD', ReconciliationId: '' }
  ];
  const manyToManyRows = [
    { row: rows[0], note: noteOf('A_x0041_B', 'USD'), noteParts: partsOf('A_x0041_B', 'USD') },
    { row: rows[1], note: noteOf('B_x005F_x0041_', 'USD'), noteParts: partsOf('B_x005F_x0041_', 'USD') },
    { row: rows[2], note: noteOf('C_x0041_', 'U_x0053_D'), noteParts: partsOf('C_x0041_', 'U_x0053_D') },
    { row: rows[3], note: noteOf('D_x0041_', 'USD'), noteParts: partsOf('D_x0041_', 'USD') },
    // 同一行多条说明按 '; ' 拼接，各段仍按来源编码。
    { row: rows[1], note: noteOf('B_x005F_x0041_', 'USD').replaceAll('网关', '调拨'), noteParts: partsOf('B_x005F_x0041_', 'USD').map((part) => (typeof part === 'string' ? part.replaceAll('网关', '调拨') : part)) }
  ];
  await write(rows, headers, out, [], [], null, null, manyToManyRows);
  const hitRows = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets['命中场景'], { header: 1, raw: true });
  assert.strictEqual(hitRows[1][2], 'A_x0041_B');
  assert.strictEqual(hitRows[1][1], noteOf('A_x0041_B', 'USD'), '🔴 银行原值账号在说明里读回字面值，与 MerchantId 列一致');
  assert.strictEqual(hitRows[2][2], 'B_x0041_');
  assert.strictEqual(hitRows[2][1], `${noteOf('B_x0041_', 'USD')}; ${noteOf('B_x0041_', 'USD').replaceAll('网关', '调拨')}`,
    '被场景按原文改写的账号在说明里与结果列同样按原文读回（多条说明各段同口径）');
  assert.deepEqual([hitRows[3][2], hitRows[3][3]], ['C_x0041_', 'USD']);
  assert.strictEqual(hitRows[3][1], noteOf('C_x0041_', 'USD'), '🔴 只改写了币种：账号段仍读回银行原值');
  assert.strictEqual(hitRows[4][2], 'D_x0041_');
  assert.strictEqual(hitRows[4][1], noteOf('D_x0041_', 'USD'), '已解码文本的改写值按已解码文本读回');
});

test('v3.2.22：没有 noteParts 的说明（旧调用方）按整段已解码文本写出', async () => {
  const XLSX = require('xlsx');
  const { writeBankStatementOutput: write } = require('../../../src/main-process/exceljs-writer');
  const out = tmpFile('many-to-many-note-legacy.xlsx');
  const rows = [{ _rowId: 'r1', _modifiedColumns: new Set(['MerchantId']), MerchantId: 'A_x0041_', Currency: 'USD', ReconciliationId: '' }];
  await write(rows, ['MerchantId', 'Currency', 'ReconciliationId'], out, [], [], null, null,
    [{ row: rows[0], note: ' 说明 A_x0041_ ' }, { row: rows[0], note: '   ' }]);
  const hitRows = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets['命中场景'], { header: 1, raw: true });
  assert.strictEqual(hitRows[1][1], '说明 A_x0041_');
});
