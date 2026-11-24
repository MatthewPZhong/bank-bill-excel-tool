// v3.0.0 块 B 集成测试：链接表大文件流式导入链路端到端契约（detector → 落库 → ADM 候选）
//   用真实 .xlsx fixture 串起 PR-1/PR-2/PR-3 的真实代码：
//     1. detector 对「物理单 sheet .xlsx」返回 matched/bank-deposit + streamingEligible=true（PR-1/PR-2 路由输入）
//     2. detector 对「多 sheet .xlsx」返回 streamingEligible=false（维持数组路径，不退化）
//     3. replaceLinkedTableStreaming + readXlsxStreamed 流式落库 → DB row_count 正确、值口径正确（PR-2）
//     4. readBankDepositAdmCandidates 只返回 Channel=ADM 子集（PR-3）
//   注：流式行源 feed 循环镜像 main.js streamLinkedRowsToInsert（闭包未导出）；其余均调真实实现。
//
// 用法：node scripts/integration/v3.0.0-linked-streaming-import.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { detectTableType } = require('../../src/main-process/table-type-detector');
const { LINKED_IMPORT_SIGNATURES } = require('../../src/constants/table-signatures');
const { AppDatabase } = require('../../src/backend/database');
const linkedRepo = require('../../src/backend/database/linked-table-repository');
const { streamLinkedRowsToInsert } = require('../../src/main-process/linked-table-stream-source');
const { writeWorkbookRows } = require('../../src/backend/file-service');
const { CHANNEL_VALUE, ADM_FUND_TYPES } = require('../../src/constants/adm-bank-deposit-fields');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

let passed = 0;
let failed = 0;
const failures = [];
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; return; }
  failed += 1; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1; failures.push({ label, actual: cond, expected: true });
}

const SIG = LINKED_IMPORT_SIGNATURES.find((s) => s.tableKey === 'bank-deposit');
const HEADERS = SIG.expectedHeaders; // 44 列

// 按表头名建一行（未列出的列留空字符串）→ 转 44 列数组（aoa 一行）。
//   数字保留为数值（写成 t="n"，模拟真实文件金额列）→ 流式 String(parseFloat) 口径；其余 String 化。
function rowAoa(fields) {
  return HEADERS.map((h) => {
    const v = fields[h];
    if (v === undefined) return '';
    return typeof v === 'number' ? v : String(v);
  });
}

// 5 行：2 行 Channel=ADM（Fundtransfer-out）+ 3 行 JPM。Credit Amount 为数字（测数字口径）。
const DATA = [
  { ReconciliationId: 'R-ADM-1', BillDate: '2026-05-06', Channel: CHANNEL_VALUE, FundType: ADM_FUND_TYPES[0], CustomerRef: 'REF1', ChannelOrderNo: 'CO1', 'Credit Amount': 1.2 },
  { ReconciliationId: 'R-JPM-1', BillDate: '2026-05-07', Channel: 'JPM', FundType: 'X', 'Credit Amount': 2.5 },
  { ReconciliationId: 'R-ADM-2', BillDate: '2026-05-08', Channel: CHANNEL_VALUE, FundType: ADM_FUND_TYPES[1], CustomerRef: 'REF2', ChannelOrderNo: 'CO2', 'Credit Amount': 3 },
  { ReconciliationId: 'R-JPM-2', BillDate: '2026-05-09', Channel: 'JPM', FundType: 'Y', 'Credit Amount': 4 },
  { ReconciliationId: 'R-JPM-3', BillDate: '2026-05-10', Channel: 'PingPong', FundType: 'Z', 'Credit Amount': 5 }
];

function writeSingleSheet(filePath) {
  const aoa = [HEADERS, ...DATA.map(rowAoa)];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '渠道对账单');
  // bookSST:true → 字符串走 sharedStrings（流式 reader 的 s 分支可读；默认 inline t="str" 流式读不出）。
  XLSX.writeFile(wb, filePath, { bookSST: true });
}

function writeMultiSheet(filePath) {
  const aoa = [HEADERS, ...DATA.map(rowAoa)];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['封面'], ['说明']]), '封面');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '渠道对账单');
  XLSX.writeFile(wb, filePath, { bookSST: true });
}

// 单 sheet + 中间一行全空（测 streamLinkedRowsToInsert 的 isRowMeaningful 空行过滤 = 对齐数组路径）
function writeSingleSheetWithBlankRow(filePath) {
  const rows = DATA.map(rowAoa);
  rows.splice(2, 0, HEADERS.map(() => '')); // 第 3 行插一整行空（44 列全空字符串）
  const aoa = [HEADERS, ...rows];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '渠道对账单');
  XLSX.writeFile(wb, filePath, { bookSST: true });
}

async function run() {
  console.log('==== v3.0.0 块B 链接表流式导入 集成验证 ====');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-stream-import-'));
  const singleFile = path.join(tmpDir, 'single.xlsx');
  const multiFile = path.join(tmpDir, 'multi.xlsx');
  const blankRowFile = path.join(tmpDir, 'single-blank.xlsx');
  const dbPath = path.join(tmpDir, 'test.sqlite');
  let appDb = null;
  try {
    writeSingleSheet(singleFile);
    writeMultiSheet(multiFile);

    // Step1：detector 物理单 sheet .xlsx → matched/bank-deposit + streamingEligible=true
    const dSingle = await detectTableType(singleFile, LINKED_IMPORT_SIGNATURES);
    assertEq(dSingle.status, 'matched', 'Step1.单sheet status=matched');
    assertEq(dSingle.tableKey, 'bank-deposit', 'Step1.单sheet tableKey=bank-deposit');
    assertEq(dSingle.streamingEligible, true, 'Step1.单sheet streamingEligible=true');

    // Step2：detector 多 sheet .xlsx → 仍 matched 但 streamingEligible=false（维持数组路径）
    const dMulti = await detectTableType(multiFile, LINKED_IMPORT_SIGNATURES);
    assertEq(dMulti.status, 'matched', 'Step2.多sheet status=matched');
    assertEq(dMulti.tableKey, 'bank-deposit', 'Step2.多sheet tableKey=bank-deposit');
    assertEq(dMulti.streamingEligible, false, 'Step2.多sheet streamingEligible=false');

    // Step3：流式落库（PR-2 真实 replaceLinkedTableStreaming + 真实 readXlsxStreamed）
    appDb = new AppDatabase(dbPath);
    appDb.init();
    const { pickBankDepositFields } = linkedRepo;
    const ret = await appDb.replaceLinkedTableStreaming('bank-deposit', async (insertOne) => {
      const { matched } = await streamLinkedRowsToInsert(singleFile, SIG, insertOne, pickBankDepositFields);
      assertTrue(matched, 'Step3.流内定位到表头');
    }, { sourceFileName: 'single.xlsx' });
    assertEq(ret.rowCount, 5, 'Step3.流式落库 rowCount=5');
    assertEq(linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit').length, 5, 'Step3.DB 实际 5 行');

    // Step4：值口径 —— 读回首行校验关键字段（裁列到 14 字段 + 值正确）
    //   v3.0.4 块 E（需求2）：bank-deposit 白名单 13→14（新增 Payment Detail）。
    const back = linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit');
    const r1 = back.find((r) => r.ReconciliationId === 'R-ADM-1');
    assertTrue(!!r1, 'Step4.读回 R-ADM-1');
    assertEq(r1 && r1.Channel, CHANNEL_VALUE, 'Step4.R-ADM-1 Channel=ADM');
    assertEq(r1 && r1['Credit Amount'], '1.2', 'Step4.R-ADM-1 Credit Amount=1.2（数字 String(parseFloat) 口径）');
    // 裁后字段集合恒 = BANK_DEPOSIT_FIELDS（pickBankDepositFields 按字段名 pick；空值列也保留键）。
    assertEq(
      JSON.stringify(Object.keys(r1).sort()),
      JSON.stringify([...linkedRepo.BANK_DEPOSIT_FIELDS].sort()),
      'Step4.bank-deposit 裁列后字段集合 = BANK_DEPOSIT_FIELDS（14 字段）'
    );

    // Step5：ADM 候选下推过滤（PR-3）→ 只 Channel=ADM 的 2 行
    const cands = linkedRepo.readBankDepositAdmCandidates(appDb.db);
    assertEq(cands.length, 2, 'Step5.readBankDepositAdmCandidates=2（仅 Channel=ADM）');
    assertEq(cands.map((r) => r.ReconciliationId).sort(), ['R-ADM-1', 'R-ADM-2'], 'Step5.候选=R-ADM-1/2');
    assertEq(linkedRepo.hasLinkedTableRows(appDb.db, 'bank-deposit'), true, 'Step5.hasLinkedTableRows=true');

    // Step6：🔴 全空行过滤（Finding-1 回归）——含 1 行全空的单 sheet 流式落库，空行被 isRowMeaningful 跳过（对齐数组路径，防空 key 垃圾行 + row_count 虚高）
    writeSingleSheetWithBlankRow(blankRowFile);
    const retBlank = await appDb.replaceLinkedTableStreaming('bank-deposit', async (insertOne) => {
      const { matched } = await streamLinkedRowsToInsert(blankRowFile, SIG, insertOne, pickBankDepositFields);
      assertTrue(matched, 'Step6.流内定位到表头');
    }, { sourceFileName: 'single-blank.xlsx' });
    assertEq(retBlank.rowCount, 5, 'Step6.含1空行文件流式落库 rowCount=5（空行被跳过，非 6）');
    assertEq(linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit').length, 5, 'Step6.DB 实际 5 行（无空 key 垃圾行）');

    // Step7（v3.2.22 B113，Codex 第十一至十三轮）：本应用写出的明细中含空字符（写成 _x0000_）的值经真实入库路径
    //   （按 BizId 幂等更新的入金表流式导入）：
    //   7a 先按 BizId 建一条记录；7b 首行以同一 BizId 更新金额、次行落库列 ReconciliationId 含空字符 → 整批拒绝，
    //   报物理行与列，该 BizId 仍是旧金额、全部记录不变；7c 只有不落库的列（Transaction Description）含空字符时照常入库
    const importDepositFile = (filePath) => appDb.upsertLinkedBankDepositStreaming(async (writeOne) => {
      await streamLinkedRowsToInsert(filePath, SIG, writeOne, linkedRepo.pickBankDepositFields);
    }, { sourceFileName: path.basename(filePath) });
    const upsertDepositFile = (fileName, rows) => {
      const filePath = path.join(tmpDir, fileName);
      writeWorkbookRows({ rows: [HEADERS, ...rows.map(rowAoa)], outputFilePath: filePath });
      return importDepositFile(filePath);
    };
    const depositAmount = (bizId) => {
      const row = linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit').find((item) => item.BizId === bizId);
      return row ? row['Credit Amount'] : null;
    };
    await upsertDepositFile('nul-base.xlsx', [{ ...DATA[0], BizId: 'BZ-NUL-1', 'Credit Amount': '1.2' }]);
    assertEq(depositAmount('BZ-NUL-1'), '1.2', 'Step7a.按 BizId 建立旧记录');
    const rowsBeforeNul = linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit');
    let nulError = null;
    try {
      await upsertDepositFile('single-nul.xlsx', [
        { ...DATA[0], BizId: 'BZ-NUL-1', 'Credit Amount': '9.9' },
        { ...DATA[1], BizId: 'BZ-NUL-2', ReconciliationId: 'R-NUL\u0000X' }
      ]);
    } catch (error) {
      nulError = error;
    }
    assertEq(nulError && nulError.message.startsWith('源文件第 3 行「ReconciliationId」列的文本含空字符（U+0000）'), true,
      `Step7b.落库列含空字符拒绝并报物理行与列：${nulError && nulError.message}`);
    assertEq(depositAmount('BZ-NUL-1'), '1.2', 'Step7b.首行对同一 BizId 的更新随整批回滚（仍是旧金额）');
    assertEq(linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit'), rowsBeforeNul, 'Step7b.全部记录与行数不变');
    await upsertDepositFile('nul-unstored.xlsx', [{ ...DATA[1], BizId: 'BZ-NUL-3', 'Transaction Description': 'memo\u0000x' }]);
    assertEq(depositAmount('BZ-NUL-3'), '2.5', 'Step7c.只有不落库的列含空字符：照常入库');

    // Step8（v3.2.22 B113，Codex 第十四轮 P1 ⚠️ 资金口径）：XlsxWriter 等按字面保存的大写「_X0041_」：
    //   SheetJS 口径会读成「A」，与另一笔 BizId「TXA」合并、覆盖其金额。流式导入按无法确认原值整批拒绝，报物理行与列
    await upsertDepositFile('upper-base.xlsx', [{ ...DATA[0], BizId: 'TXA', 'Credit Amount': '9.9' }]);
    const upperFile = path.join(tmpDir, 'upper-escape.xlsx');
    writeWorkbookRows({
      rows: [HEADERS, rowAoa({ ...DATA[0], BizId: 'TXA', 'Credit Amount': '9.9' }), rowAoa({ ...DATA[1], BizId: 'TXUPPERPLACEHOLDER', 'Credit Amount': '1.2' })],
      outputFilePath: upperFile
    });
    const zip = await JSZip.loadAsync(fs.readFileSync(upperFile));
    let replaced = 0;
    for (const name of Object.keys(zip.files).filter((item) => item.endsWith('.xml'))) {
      const xml = await zip.file(name).async('string');
      if (!xml.includes('TXUPPERPLACEHOLDER')) continue;
      replaced += 1;
      zip.file(name, xml.replace('TXUPPERPLACEHOLDER', 'TX_X0041_'));
    }
    assertEq(replaced, 1, 'Step8.构造文件：字面大写转义按其他写出端的写法保存');
    fs.writeFileSync(upperFile, await zip.generateAsync({ type: 'nodebuffer' }));
    const rowsBeforeUpper = linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit');
    let upperError = null;
    try {
      await importDepositFile(upperFile);
    } catch (error) {
      upperError = error;
    }
    assertEq(Boolean(upperError) && upperError.message.startsWith('源文件第 3 行「BizId」列的文本含无法确认原值的 Excel 文本转义'), true,
      `Step8.大写转义拒绝并报物理行与列：${upperError && upperError.message}`);
    assertEq(depositAmount('TXA'), '9.9', 'Step8.TXA 金额未被覆盖');
    assertEq(linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit'), rowsBeforeUpper, 'Step8.全部记录与行数不变');

    // Step9（v3.2.22 B113，Codex 第十五轮 P1 ⚠️ 资金口径）：ExcelJS（不转义的真实写出端）原样写出字面「TX_x004a_」，
    //   Excel 与 SheetJS 口径读成「TXJ」，与另一笔「TXJ」合并、覆盖其金额。流式导入按无法确认原值整批拒绝，数据库不变
    await upsertDepositFile('lower-base.xlsx', [{ ...DATA[0], BizId: 'TXJ', 'Credit Amount': '9.9' }]);
    const lowerFile = path.join(tmpDir, 'exceljs-lower-escape.xlsx');
    const lowerBook = new ExcelJS.Workbook();
    const lowerSheet = lowerBook.addWorksheet('Sheet1');
    lowerSheet.addRow(HEADERS);
    lowerSheet.addRow(rowAoa({ ...DATA[0], BizId: 'TXJ', 'Credit Amount': '9.9' }));
    lowerSheet.addRow(rowAoa({ ...DATA[1], BizId: 'TX_x004a_', 'Credit Amount': '1.2' }));
    await lowerBook.xlsx.writeFile(lowerFile);
    const rowsBeforeLower = linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit');
    let lowerError = null;
    try {
      await importDepositFile(lowerFile);
    } catch (error) {
      lowerError = error;
    }
    assertEq(Boolean(lowerError) && lowerError.message.startsWith('源文件第 3 行「BizId」列的文本含无法确认原值的 Excel 文本转义'), true,
      `Step9.可打印字符的转义拒绝并报物理行与列：${lowerError && lowerError.message}`);
    assertEq(depositAmount('TXJ'), '9.9', 'Step9.TXJ 金额未被覆盖');
    assertEq(linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit'), rowsBeforeLower, 'Step9.全部记录与行数不变');

    // Step10（v3.2.22 B113，Codex 第十六轮 P1 ⚠️ 资金口径）：ExcelJS 写出富文本「TX_x005f_」+「x0041_」（ExcelJS 读回
    //   「TX_x005f_x0041_」），保护目标跨段时 SheetJS 口径读成「TX_x0041_」，与另一笔「TX_x0041_」合并、覆盖其金额。
    //   流式导入按无法确认原值整批拒绝，数据库不变
    await upsertDepositFile('rich-base.xlsx', [{ ...DATA[0], BizId: 'TX_x0041_', 'Credit Amount': '9.9' }]);
    assertEq(depositAmount('TX_x0041_'), '9.9', 'Step10.前置：本应用写出的字面「TX_x0041_」按原文入库');
    const richFile = path.join(tmpDir, 'exceljs-rich-escape.xlsx');
    const richBook = new ExcelJS.Workbook();
    const richSheet = richBook.addWorksheet('Sheet1');
    richSheet.addRow(HEADERS);
    richSheet.addRow(rowAoa({ ...DATA[1], 'Credit Amount': '1.2' }));
    richSheet.getCell(2, HEADERS.indexOf('BizId') + 1).value = { richText: [{ text: 'TX_x005f_' }, { text: 'x0041_' }] };
    await richBook.xlsx.writeFile(richFile);
    const rowsBeforeRich = linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit');
    let richError = null;
    try {
      await importDepositFile(richFile);
    } catch (error) {
      richError = error;
    }
    assertEq(Boolean(richError) && richError.message.startsWith('源文件第 2 行「BizId」列的文本含无法确认原值的 Excel 文本转义'), true,
      `Step10.跨段的保护目标拒绝并报物理行与列：${richError && richError.message}`);
    assertEq(depositAmount('TX_x0041_'), '9.9', 'Step10.TX_x0041_ 金额未被覆盖');
    assertEq(linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit'), rowsBeforeRich, 'Step10.全部记录与行数不变');
  } finally {
    try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`));
    process.exit(1);
  }
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
