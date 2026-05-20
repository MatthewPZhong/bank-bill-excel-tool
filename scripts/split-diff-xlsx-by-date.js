// 一次性脚本（fix11 + fix13 前的应急工具）：把 ExcelJS streaming writer 生成的差异 xlsx 拆为多 sheet
// 输入 xlsx 单 sheet 含 2.6M 行 → Excel/WPS 默认只能显示前 1,048,576 行，超出部分用户看不到
// 输出：单文件多 sheet
//   - 前 N 个 sheet：按账单日期切分的差异表（每 sheet ≤ 1,048,575 数据行）；sheet 名 = "YYYY-MM-DD~MM-DD"（按起始日升序）
//   - 末尾 sheet「运行结果汇总」（如带 --report 参数）：复制 report.xlsx 的全部内容
//
// 用法：
//   node scripts/split-diff-xlsx-by-date.js <input.xlsx> <output.xlsx>
//   node scripts/split-diff-xlsx-by-date.js <input.xlsx> <output.xlsx> --report <report.xlsx>
//
// 实现：流式两 pass
//   pass 1 流式 sax 解析 sheet1.xml → 统计每个账单日期（第 1 列）的行数 + 拿表头
//   按账单日期升序贪心切分 → 计算 segments [{startDate, endDate}]
//   pass 2 流式 sax 重读 → 按账单日期路由到对应 sheet 的 ExcelJS streaming writer

const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');
const sax = require('sax');
const ExcelJS = require('exceljs');

const MAX_DATA_ROWS_PER_SHEET = 1048575; // Excel 单 sheet 上限 1,048,576 行（含表头 → 数据 1,048,575）

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = [];
      zip.on('entry', (entry) => { entries.push(entry); zip.readEntry(); });
      zip.on('end', () => resolve({ zip, entries }));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function readEntryToString(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  });
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const items = [];
  const parser = sax.parser(false, { lowercase: true });
  let inSi = false;
  let inT = false;
  let buf = '';
  parser.onopentag = (n) => {
    if (n.name === 'si') { inSi = true; buf = ''; }
    else if (n.name === 't' && inSi) inT = true;
  };
  parser.ontext = (t) => { if (inT) buf += t; };
  parser.oncdata = (t) => { if (inT) buf += t; };
  parser.onclosetag = (name) => {
    if (name === 't') inT = false;
    else if (name === 'si') { items.push(buf); inSi = false; buf = ''; }
  };
  parser.write(xml).close();
  return items;
}

function colRefToIndex(ref) {
  // "A1" -> 0, "B1" -> 1, ..., "AA1" -> 26
  const match = ref.match(/^([A-Z]+)/);
  if (!match) return -1;
  let col = 0;
  for (let i = 0; i < match[1].length; i++) col = col * 26 + (match[1].charCodeAt(i) - 64);
  return col - 1;
}

function streamParseSheet(zip, sheetEntry, sharedStrings, onRow) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(sheetEntry, (err, stream) => {
      if (err) return reject(err);
      const parser = sax.createStream(false, { lowercase: true });
      let currentRowIndex = 0;
      let cells = [];
      let cellCol = -1;
      let cellType = '';
      let inIs = false;
      let inT = false;
      let inV = false;
      let buf = '';

      parser.on('opentag', (n) => {
        if (n.name === 'row') {
          currentRowIndex = Number(n.attributes.r || '0');
          cells = [];
        } else if (n.name === 'c') {
          cellCol = colRefToIndex(n.attributes.r || '');
          cellType = n.attributes.t || '';
          buf = '';
        } else if (n.name === 'is') inIs = true;
        else if (n.name === 't' && inIs) inT = true;
        else if (n.name === 't' && !inIs) inT = true;
        else if (n.name === 'v') inV = true;
      });
      parser.on('text', (t) => { if (inT || inV) buf += t; });
      parser.on('cdata', (t) => { if (inT || inV) buf += t; });
      parser.on('closetag', (name) => {
        if (name === 't') inT = false;
        else if (name === 'is') inIs = false;
        else if (name === 'v') inV = false;
        else if (name === 'c') {
          let value = buf;
          if (cellType === 's') value = sharedStrings[Number(buf)] || '';
          else if (cellType === 'inlineStr' || cellType === 'str') value = buf;
          cells[cellCol] = value;
          buf = '';
          cellCol = -1;
          cellType = '';
        } else if (name === 'row') {
          onRow(currentRowIndex, cells);
        }
      });
      parser.on('end', resolve);
      parser.on('error', reject);
      stream.pipe(parser);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args[0];
  const outputPath = args[1];
  const reportIdx = args.indexOf('--report');
  const reportPath = reportIdx >= 0 ? args[reportIdx + 1] : null;
  if (!inputPath || !outputPath) {
    console.error('usage: node split-diff-xlsx-by-date.js <input.xlsx> <output.xlsx> [--report <report.xlsx>]');
    process.exit(1);
  }

  const inputSize = fs.statSync(inputPath).size;
  console.log(`[1/4] 打开输入文件: ${inputPath} (${(inputSize/1024/1024).toFixed(1)} MB)`);
  const { zip, entries } = await openZip(inputPath);
  const sheetEntry = entries.find((e) => e.fileName === 'xl/worksheets/sheet1.xml');
  const sharedStringsEntry = entries.find((e) => e.fileName === 'xl/sharedStrings.xml');
  if (!sheetEntry) throw new Error('sheet1.xml 未找到');

  const sharedStrings = sharedStringsEntry
    ? parseSharedStrings(await readEntryToString(zip, sharedStringsEntry))
    : [];
  console.log(`  sharedStrings: ${sharedStrings.length} 条`);

  console.log('[2/4] Pass 1 流式扫账单日期 + 统计行数...');
  const t1 = Date.now();
  const dateCounts = new Map();
  let header = null;
  let totalDataRows = 0;
  await streamParseSheet(zip, sheetEntry, sharedStrings, (rowIndex, cells) => {
    if (rowIndex === 1) {
      header = cells.slice();
      return;
    }
    const date = String(cells[0] || '').trim();
    dateCounts.set(date, (dateCounts.get(date) || 0) + 1);
    totalDataRows++;
    if (totalDataRows % 200000 === 0) {
      process.stdout.write(`  扫到 ${totalDataRows} 行...\r`);
    }
  });
  zip.close();
  console.log(`  Pass 1 完成: ${totalDataRows} 数据行 / ${dateCounts.size} 个不同账单日期 / ${((Date.now()-t1)/1000).toFixed(1)}s`);

  console.log('[3/4] 计算 sheet 切分点...');
  const sortedDates = [...dateCounts.keys()].sort();
  const segments = [];
  let segStartDate = sortedDates[0];
  let segRowCount = 0;
  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i];
    const rows = dateCounts.get(date);
    if (segRowCount > 0 && segRowCount + rows > MAX_DATA_ROWS_PER_SHEET) {
      segments.push({ startDate: segStartDate, endDate: sortedDates[i - 1], rowCount: segRowCount });
      segStartDate = date;
      segRowCount = rows;
    } else {
      segRowCount += rows;
    }
  }
  segments.push({ startDate: segStartDate, endDate: sortedDates[sortedDates.length - 1], rowCount: segRowCount });

  function fmtSheetName(seg) {
    // "2026-03-01~03-10"（start 含完整年月日 + end 用 "MM-DD"，包括同月场景）
    const [y1, m1, d1] = seg.startDate.split('-');
    const [_y2, m2, d2] = seg.endDate.split('-');
    return `${y1}-${m1}-${d1}~${m2}-${d2}`;
  }

  console.log(`  切分结果: ${segments.length} 个 sheet`);
  segments.forEach((seg, i) => {
    console.log(`    Sheet ${i+1}: "${fmtSheetName(seg)}" (${seg.startDate} ~ ${seg.endDate}, ${seg.rowCount} 行)`);
  });

  // 构造 date -> segment index 映射
  const dateToSegIdx = new Map();
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    for (const d of sortedDates) {
      if (d >= seg.startDate && d <= seg.endDate) dateToSegIdx.set(d, s);
    }
  }

  console.log('[4/4] Pass 2 流式写多 sheet 到输出文件...');
  const t2 = Date.now();
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outputPath,
    useStyles: false,
    useSharedStrings: false
  });
  const sheets = segments.map((seg) => {
    const ws = writer.addWorksheet(fmtSheetName(seg));
    if (header) ws.addRow(header).commit();
    return ws;
  });

  // 重新打开 zip（第一次已 close）
  const { zip: zip2, entries: entries2 } = await openZip(inputPath);
  const sheetEntry2 = entries2.find((e) => e.fileName === 'xl/worksheets/sheet1.xml');

  let writtenRows = 0;
  await streamParseSheet(zip2, sheetEntry2, sharedStrings, (rowIndex, cells) => {
    if (rowIndex === 1) return; // skip header
    const date = String(cells[0] || '').trim();
    const segIdx = dateToSegIdx.get(date);
    if (segIdx === undefined) {
      console.warn(`  WARN: 行 ${rowIndex} 账单日期 "${date}" 无对应 segment，跳过`);
      return;
    }
    sheets[segIdx].addRow(cells).commit();
    writtenRows++;
    if (writtenRows % 200000 === 0) {
      process.stdout.write(`  写入 ${writtenRows} / ${totalDataRows} 行...\r`);
    }
  });
  zip2.close();

  for (const ws of sheets) await ws.commit();
  console.log(`  Pass 2 完成: 写入 ${writtenRows} 行 / ${((Date.now()-t2)/1000).toFixed(1)}s`);

  // fix12 临时补丁：把 UTC 字符串 "YYYY-MM-DD HH:MM:SS" 转本地时区显示
  // 根因 = SQLite CURRENT_TIMESTAMP 返回 UTC，writer 直接写 sheet 没转 → 用户看到差 8h
  // 仅对 report sheet 中的「运行时间」字段做转换
  function utcStrToLocal(utcStr) {
    const m = String(utcStr).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return utcStr;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    if (Number.isNaN(d.getTime())) return utcStr;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  let summaryRowCount = 0;
  if (reportPath) {
    console.log(`[5/5] 追加「运行结果汇总」sheet（来源 ${reportPath}）...`);
    const t3 = Date.now();
    const reportWb = new (require('exceljs').Workbook)();
    await reportWb.xlsx.readFile(reportPath);
    const srcSheet = reportWb.worksheets[0];
    if (!srcSheet) throw new Error('report.xlsx 内没有任何 sheet');
    const summarySheet = writer.addWorksheet('运行结果汇总');
    srcSheet.eachRow({ includeEmpty: true }, (row) => {
      const values = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell && cell.value;
        values.push(v == null ? '' : v);
      });
      // fix12 临时补丁：第一列 = "运行时间" 时把第二列 UTC 字符串转本地
      if (values[0] === '运行时间' && typeof values[1] === 'string') {
        const localStr = utcStrToLocal(values[1]);
        if (localStr !== values[1]) {
          console.log(`    [fix12 临时] 运行时间: "${values[1]}" (UTC) → "${localStr}" (本地)`);
          values[1] = localStr;
        }
      }
      summarySheet.addRow(values).commit();
      summaryRowCount++;
    });
    await summarySheet.commit();
    console.log(`  追加完成: ${summaryRowCount} 行 / ${((Date.now()-t3)/1000).toFixed(1)}s`);
  }

  await writer.commit();

  const outputSize = fs.statSync(outputPath).size;
  console.log('\n✅ 完成');
  console.log(`输入: ${inputPath} (${(inputSize/1024/1024).toFixed(1)} MB / ${totalDataRows} 行 / 1 sheet)`);
  const totalSheets = segments.length + (reportPath ? 1 : 0);
  const sheetSummary = reportPath
    ? `${segments.length} 差异 sheet + 1「运行结果汇总」(${summaryRowCount} 行) = ${totalSheets} sheets`
    : `${segments.length} sheets`;
  console.log(`输出: ${outputPath} (${(outputSize/1024/1024).toFixed(1)} MB / ${writtenRows} 行 / ${sheetSummary})`);
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
