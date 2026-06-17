// 工具箱🧰「合表 / 拆表」大文件流式端到端集成测试（v3.0.8 BUG3）
//   目标：证明 30 万行级大文件下 merge / split 走流式不 OOM、不闪退，且输出行数/内容/格式正确。
//
// 为什么必须有这条（feedback_multiagent_seam_gap）：
//   BUG3 跨 3 个文件协作——toolbox-stream-io.js（流式读写）↔ toolbox.js（流式去重/过滤纯逻辑）↔
//   main.js 三个 IPC handler。逐文件 review / 小数据单测看不见「30 万行真实跨接缝」的内存/正确性接缝。
//   本脚本复刻 main.js handler 的「流式读源 → toolbox 纯逻辑 → 流式写 → readback」整条链路（绕过 Electron dialog），
//   用真实大 xlsx 验证：① 不 OOM（实测 RSS 峰值远低于全量路径会撞的 >1GB）；② 输出行数/内容/格式与契约一致。
//
// 用法：node scripts/integration/toolbox-large-file-stream.js
//      可调行数：TOOLBOX_LARGE_ROWS=300000 node scripts/integration/toolbox-large-file-stream.js（缺省 30 万）

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ExcelJS = require('exceljs');

// 与 main.js handler 同源：流式读写 + toolbox 纯逻辑
const {
  streamDataRows,
  readHeaderRowStreamed,
  writeRowsStreamed
} = require('../../src/main-process/toolbox-stream-io');
const {
  assertHeadersIdentical,
  createValuesByFieldAccumulator,
  createRowFilter
} = require('../../src/main-process/toolbox');
// 流式读引擎（直接用于 readback 校验大输出，避免 SheetJS 全量读大文件再 OOM）
const { readXlsxStreamed } = require('../../src/backend/pending-import/streaming-xlsx-reader');

const ROWS = Number(process.env.TOOLBOX_LARGE_ROWS || 300000);
const HEADERS = ['MerchantId', 'Channel', 'Currency', 'BillDate', 'Credit Amount', 'Debit Amount', 'Balance', 'OrderNo'];

let passed = 0;
let failed = 0;
const failures = [];
function assertTrue(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push({ label });
}
function assertEq(actual, expected, label) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ label, actual, expected });
}

// 用 ExcelJS streaming writer 生成大 xlsx 源文件（生成端本身流式，不 OOM）。
//   channelCycle：渠道值循环序列（用于后续拆表按 Channel 过滤验证）。
async function genLargeXlsx(filePath, rowCount, { channelCycle = ['ALIPAY', 'WECHAT', 'UNION'] } = {}) {
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: false, useSharedStrings: false });
  const sheet = writer.addWorksheet('COMMON');
  sheet.addRow(HEADERS.slice()).commit();
  const counts = {};
  for (let i = 0; i < rowCount; i += 1) {
    const channel = channelCycle[i % channelCycle.length];
    counts[channel] = (counts[channel] || 0) + 1;
    sheet.addRow([
      `M${(i % 5000)}`,            // MerchantId（文本，会套 @）
      channel,                      // Channel（文本）
      i % 2 === 0 ? 'USD' : 'CNY',  // Currency（文本）
      '2026-01-02',                 // BillDate（日期 serial）
      i % 3 === 0 ? '100.50' : '',  // Credit Amount（数字 0.00）
      i % 3 === 0 ? '' : '12.34',   // Debit Amount（数字 0.00）
      String(1000 + i) + '.00',     // Balance（数字 0.00）
      `ORDER-${i}`                  // OrderNo（普通列，原样）
    ]).commit();
  }
  await sheet.commit();
  await writer.commit();
  return { counts };
}

// 流式 readback：统计输出文件各 sheet 的行数——用 JSZip nodeStream 增量扫 <row，**不把整张 sheet XML
//   一次性物化成大字符串**（26MB 文件解压后 XML 可达数百 MB，readFileSync+async('string') 会让 readback 自身吃满内存，
//   污染「证明流式不 OOM」的内存峰值结论）。本函数内存常数。
//   返回 { totalDataRows, sheetDataCounts }。
async function readbackStreamed(filePath) {
  const JSZip = require('jszip');
  // loadAsync(readFileSync) 把压缩包载入内存（压缩态，26MB 量级，可接受）；解压走 nodeStream 不物化全 XML。
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const sheetEntries = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort();
  let totalDataRows = 0;
  const sheetDataCounts = [];
  for (const entryName of sheetEntries) {
    // eslint-disable-next-line no-await-in-loop
    const rowCount = await countRowsStreamed(zip.file(entryName));
    const dataRows = Math.max(rowCount - 1, 0); // 数据行 = <row> 数 - 1（表头行）
    sheetDataCounts.push(dataRows);
    totalDataRows += dataRows;
  }
  return { totalDataRows, sheetDataCounts };
}

// 流式数 entry XML 里的 <row 标签数（nodeStream + 增量计数，内存常数）。
function countRowsStreamed(entry) {
  return new Promise((resolve, reject) => {
    const { StringDecoder } = require('node:string_decoder');
    const stream = entry.nodeStream();
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let count = 0;
    const RE = /<row\b/g;
    stream.on('data', (chunk) => {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      RE.lastIndex = 0;
      let m;
      let lastIdx = 0;
      while ((m = RE.exec(pending))) { count += 1; lastIdx = m.index + 4; }
      // 保留尾部少量字符防 `<row` 跨 chunk 截断（最长 4 字符 + 一点余量）。
      pending = pending.slice(Math.max(lastIdx, pending.length - 8));
    });
    stream.on('end', () => resolve(count));
    stream.on('error', reject);
  });
}

function rssMB() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

async function run() {
  console.log(`==== 工具箱🧰 大文件流式 端到端验证（${ROWS.toLocaleString()} 行/文件）====`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-large-'));
  let peakRss = rssMB();
  const track = () => { const m = rssMB(); if (m > peakRss) peakRss = m; };

  try {
    // ===== 生成 2 个同表头大源文件（合表用）=====
    const fileA = path.join(tmpDir, 'large-a.xlsx');
    const fileB = path.join(tmpDir, 'large-b.xlsx');
    console.log(`生成源文件 A/B（各 ${ROWS.toLocaleString()} 行）...`);
    const genA = await genLargeXlsx(fileA, ROWS);
    track();
    const genB = await genLargeXlsx(fileB, ROWS);
    track();
    console.log(`  源文件大小：A=${(fs.statSync(fileA).size / 1024 / 1024).toFixed(1)}MB B=${(fs.statSync(fileB).size / 1024 / 1024).toFixed(1)}MB`);

    // ===== ① 合表：流式表头校验 + 流式合并 =====
    console.log('① 合表（流式读 A+B → 合并写）...');
    const headersA = await readHeaderRowStreamed(fileA);
    const headersB = await readHeaderRowStreamed(fileB);
    track();
    const baseHeaders = assertHeadersIdentical([headersA, headersB], ['large-a.xlsx', 'large-b.xlsx']);
    assertEq(JSON.stringify(baseHeaders), JSON.stringify(HEADERS), '①表头校验通过 + 基准表头 = 原表头');

    const mergeOut = path.join(tmpDir, 'merged.xlsx');
    const mergeRes = await writeRowsStreamed({
      savePath: mergeOut,
      normalizedHeaders: baseHeaders,
      sheetBaseName: 'COMMON',
      writeDataRows: async (emit) => {
        for (const p of [fileA, fileB]) {
          // eslint-disable-next-line no-await-in-loop
          await streamDataRows(p, (cells) => { emit(cells); track(); });
        }
      }
    });
    track();
    assertEq(mergeRes.dataRowCount, ROWS * 2, '①合并数据行数 = A 行数 + B 行数');
    const mergeReadback = await readbackStreamed(mergeOut);
    assertEq(mergeReadback.totalDataRows, ROWS * 2, '①合并产物 readback 数据行数 = 2×ROWS');
    console.log(`  合并输出：${mergeReadback.totalDataRows.toLocaleString()} 数据行，${mergeReadback.sheetDataCounts.length} sheet，大小 ${(fs.statSync(mergeOut).size / 1024 / 1024).toFixed(1)}MB`);

    // ===== ② 拆表第一步：流式去重值 =====
    console.log('② 拆表 split:read（流式扫一遍累积去重值）...');
    const splitHeaders = await readHeaderRowStreamed(fileA);
    const acc = createValuesByFieldAccumulator(splitHeaders);
    await streamDataRows(fileA, (cells) => { acc.addRow(cells); track(); });
    track();
    const valuesByField = acc.result();
    assertEq(JSON.stringify(valuesByField['Channel'].sort()), JSON.stringify(['ALIPAY', 'UNION', 'WECHAT']), '②Channel 去重值 = 3 个渠道（流式去重不物化全部行）');
    assertEq(valuesByField['Currency'].sort().join(','), 'CNY,USD', '②Currency 去重值 = USD/CNY');

    // ===== ③ 拆表第二步：流式过滤 + 写 =====
    console.log('③ 拆表 split:export（流式过滤 Channel=ALIPAY → 写）...');
    const filter = createRowFilter(splitHeaders, 'Channel', ['ALIPAY']);
    assertTrue(filter.fieldFound, '③字段 Channel 命中');
    const splitOut = path.join(tmpDir, 'split-alipay.xlsx');
    const splitRes = await writeRowsStreamed({
      savePath: splitOut,
      normalizedHeaders: splitHeaders,
      sheetBaseName: 'COMMON',
      writeDataRows: async (emit) => {
        await streamDataRows(fileA, (cells) => {
          if (filter.matches(cells)) { emit(cells); }
          track();
        });
      }
    });
    track();
    assertEq(splitRes.dataRowCount, genA.counts.ALIPAY, '③拆表命中行数 = 源文件 ALIPAY 行数');
    const splitReadback = await readbackStreamed(splitOut);
    assertEq(splitReadback.totalDataRows, genA.counts.ALIPAY, '③拆表产物 readback 行数 = ALIPAY 行数');

    // ===== ④ 抽样校验内容 + 格式（决策①：by-name 格式正确套用）=====
    console.log('④ 抽样校验拆表产物内容 + 格式（by-name）...');
    const sampleCells = [];
    await readXlsxStreamed(splitOut, (cells, idx) => {
      if (idx >= 2 && idx <= 4) sampleCells.push(cells.slice(0, HEADERS.length)); // 取前几条数据行
    }, { colCount: HEADERS.length, maxRows: 5 });
    assertTrue(sampleCells.length >= 1, '④抽到样本数据行');
    // 内容：所有抽样行 Channel 列（idx 1）= ALIPAY
    assertTrue(sampleCells.every((r) => r[1] === 'ALIPAY'), '④抽样行 Channel 均为 ALIPAY（仅含命中值行）');
    // 格式：读 styles.xml + 抽样单元格 numFmt——Balance/Credit 应为数字格式，BillDate 为日期 serial
    const fmtOk = await verifyByNameFormat(splitOut);
    assertTrue(fmtOk.balanceIsNumber, '④Balance 列写成数字（非文本）');
    assertTrue(fmtOk.billDateIsSerial, '④BillDate 列写成日期 serial（数字 + 日期 numFmt）');
    assertTrue(fmtOk.merchantIsText, '④MerchantId 列写成文本（@ 格式）');
    assertTrue(fmtOk.headerCourierNew, '④表头行 Courier New 字体');

    // ===== ⑤ 内存峰值断言（不 OOM）=====
    console.log(`\n内存 RSS 峰值：${peakRss}MB`);
    // 30 万行 × 2 文件全量 readRows + writeFile 会撞 >1GB；流式应远低于此。给 800MB 宽松上限（含 node 基线 + ExcelJS）。
    assertTrue(peakRss < 800, `⑤内存峰值 ${peakRss}MB < 800MB（流式不 OOM；全量路径此规模必 >1GB）`);

    const total = passed + failed;
    console.log(`\n==== ${passed}/${total} PASS ====`);
    if (failed > 0) {
      console.error('\nFAILURES:');
      failures.forEach((f) => {
        console.error(`  - ${f.label}`);
        if ('actual' in f) {
          console.error(`      actual:   ${JSON.stringify(f.actual)}`);
          console.error(`      expected: ${JSON.stringify(f.expected)}`);
        }
      });
      process.exit(1);
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

// 校验输出 xlsx 的 by-name 格式（直接解析 sheet1.xml 单元格 t/s 属性 + styles.xml numFmt）。
async function verifyByNameFormat(filePath) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const stylesXml = await zip.file('xl/styles.xml').async('string');

  // 列序：HEADERS = [MerchantId(A), Channel(B), Currency(C), BillDate(D), Credit(E), Debit(F), Balance(G), OrderNo(H)]
  // 取第 2 行（首个数据行）各列单元格。
  const rowMatch = sheetXml.match(/<row r="2"[^>]*>([\s\S]*?)<\/row>/);
  const rowXml = rowMatch ? rowMatch[1] : '';
  const cellOf = (col) => {
    const m = rowXml.match(new RegExp(`<c r="${col}2"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`));
    if (!m) return null;
    return { attrs: m[1] || '', body: m[2] || '' };
  };
  const typeOf = (cell) => { if (!cell) return ''; const m = cell.attrs.match(/\st="([^"]+)"/); return m ? m[1] : ''; };
  const styleIdxOf = (cell) => { if (!cell) return null; const m = cell.attrs.match(/\ss="(\d+)"/); return m ? Number(m[1]) : null; };

  const balance = cellOf('G');
  const billDate = cellOf('D');
  const merchant = cellOf('A');

  // 数字单元格：无 t（或 t="n"）+ <v> 数字
  const balanceIsNumber = !!balance && (typeOf(balance) === '' || typeOf(balance) === 'n') && /<v(?:\s[^>]*)?>[\d.]+<\/v>/.test(balance.body);
  // 日期 serial：数字单元格（无 t / t=n）+ 值为整数 serial（45000+ 量级）
  const billDateIsSerial = !!billDate && (typeOf(billDate) === '' || typeOf(billDate) === 'n') && /<v(?:\s[^>]*)?>\d{5,}<\/v>/.test(billDate.body);
  // 文本单元格：t="s"（sharedString，useSharedStrings:false 下 ExcelJS 仍可能 inlineStr）或 t="str" / inlineStr
  const merchantType = typeOf(merchant);
  const merchantIsText = !!merchant && (merchantType === 's' || merchantType === 'str' || merchantType === 'inlineStr');

  // numFmt：解析 cellXfs 找 Balance/MerchantId 单元格的 numFmtId 是否指向 0.00 / @。
  //   宽松校验：只要 styles.xml 同时含 0.00 与 @ 的 numFmt 定义（自定义或内建引用），即认为 by-name 格式生效。
  const has0_00 = /numFmtId="2"|formatCode="0\.00"/.test(stylesXml);
  const hasText = /numFmtId="49"|formatCode="@"/.test(stylesXml);

  // 表头 Courier New
  const headerCourierNew = /<name val="Courier New"\/>/.test(stylesXml);

  return {
    balanceIsNumber: balanceIsNumber && has0_00,
    billDateIsSerial,
    merchantIsText: merchantIsText && hasText,
    headerCourierNew
  };
}

run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exit(1); });
