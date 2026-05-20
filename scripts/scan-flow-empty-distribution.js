// 一次性诊断脚本（PR #50 NewF1 之前调研）：扫源流水 xlsx 统计「通道清算金额」x「通道清算币种」空值组合分布
//
// 用法：node scripts/scan-flow-empty-distribution.js /path/to/flow/dir
//
// 输出 4 种组合的行数：
//   - 都不空
//   - 金额空 + 币种不空（NewF1 修复后差异表会跳过这些行）
//   - 金额不空 + 币种空
//   - 都空

const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');
const sax = require('sax');

function colRefToIndex(ref) {
  const m = ref.match(/^([A-Z]+)/);
  if (!m) return -1;
  let col = 0;
  for (let i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64);
  return col - 1;
}

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = [];
      zip.on('entry', (e) => { entries.push(e); zip.readEntry(); });
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
  let inSi = false, inT = false, buf = '';
  parser.onopentag = (n) => { if (n.name === 'si') { inSi = true; buf = ''; } else if (n.name === 't' && inSi) inT = true; };
  parser.ontext = (t) => { if (inT) buf += t; };
  parser.oncdata = (t) => { if (inT) buf += t; };
  parser.onclosetag = (name) => { if (name === 't') inT = false; else if (name === 'si') { items.push(buf); inSi = false; } };
  parser.write(xml).close();
  return items;
}

async function scanFile(filePath, stats) {
  const { zip, entries } = await openZip(filePath);
  const sheetEntry = entries.find((e) => e.fileName === 'xl/worksheets/sheet1.xml');
  const ssEntry = entries.find((e) => e.fileName === 'xl/sharedStrings.xml');
  const sharedStrings = ssEntry ? parseSharedStrings(await readEntryToString(zip, ssEntry)) : [];

  await new Promise((resolve, reject) => {
    zip.openReadStream(sheetEntry, (err, stream) => {
      if (err) return reject(err);
      const parser = sax.createStream(false, { lowercase: true });
      let row = null;
      let cellCol = -1, cellType = '', buf = '', inT = false, inV = false, inIs = false;
      parser.on('opentag', (n) => {
        if (n.name === 'row') {
          row = { rowIndex: Number(n.attributes.r || '0'), values: [] };
        } else if (n.name === 'c') {
          cellCol = colRefToIndex(n.attributes.r || '');
          cellType = n.attributes.t || '';
          buf = '';
        } else if (n.name === 'is') inIs = true;
        else if (n.name === 't') inT = true;
        else if (n.name === 'v') inV = true;
      });
      parser.on('text', (t) => { if (inT || inV) buf += t; });
      parser.on('cdata', (t) => { if (inT || inV) buf += t; });
      parser.on('closetag', (name) => {
        if (name === 't') inT = false;
        else if (name === 'is') inIs = false;
        else if (name === 'v') inV = false;
        else if (name === 'c') {
          let v = buf;
          if (cellType === 's') v = sharedStrings[Number(buf)] || '';
          else if (cellType === 'inlineStr' || cellType === 'str') v = buf;
          if (row) row.values[cellCol] = v;
          buf = ''; cellCol = -1; cellType = '';
        } else if (name === 'row') {
          if (row && row.rowIndex >= 2) {
            const amount = String(row.values[28] || '').trim();
            const currency = String(row.values[29] || '').trim();
            const amountEmpty = amount === '';
            const currencyEmpty = currency === '';
            if (!amountEmpty && !currencyEmpty) stats.bothFilled++;
            else if (amountEmpty && !currencyEmpty) stats.amountEmptyOnly++;
            else if (!amountEmpty && currencyEmpty) stats.currencyEmptyOnly++;
            else stats.bothEmpty++;
            stats.total++;
            // 收集子类型 sample（如果空，看第几列是 sub_type）
            if (amountEmpty || currencyEmpty) {
              const subType = String(row.values[5] || '').trim(); // 流水第 6 列「子类型」(spec)
              if (!stats.subTypeSamples.has(subType)) {
                stats.subTypeSamples.set(subType, { amountEmpty: 0, currencyEmpty: 0, bothEmpty: 0, sample: row.values.slice(0, 35) });
              }
              const s = stats.subTypeSamples.get(subType);
              if (amountEmpty && currencyEmpty) s.bothEmpty++;
              else if (amountEmpty) s.amountEmpty++;
              else s.currencyEmpty++;
            }
          }
          row = null;
        }
      });
      parser.on('end', resolve);
      parser.on('error', reject);
      stream.pipe(parser);
    });
  });

  zip.close();
}

async function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scan-flow-empty-distribution.js <flow-dir>'); process.exit(1); }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.xlsx') && !f.startsWith('.~') && !f.startsWith('~$')).sort();
  const stats = {
    total: 0, bothFilled: 0, amountEmptyOnly: 0, currencyEmptyOnly: 0, bothEmpty: 0,
    subTypeSamples: new Map()
  };
  console.log(`扫描 ${files.length} 个文件...`);
  for (let i = 0; i < files.length; i++) {
    process.stdout.write(`  [${i + 1}/${files.length}] ${files[i]}\r`);
    const t0 = Date.now();
    await scanFile(path.join(dir, files[i]), stats);
    process.stdout.write(`  [${i + 1}/${files.length}] ${files[i]} (${((Date.now() - t0) / 1000).toFixed(1)}s, 累计 ${stats.total} 行)\n`);
  }
  console.log('\n=== 空值分布统计 ===');
  const fmt = (n) => `${n.toLocaleString()} (${((n / stats.total) * 100).toFixed(3)}%)`;
  console.log(`总流水行数：${stats.total.toLocaleString()}`);
  console.log(`① 通道清算金额 + 币种 都不空：${fmt(stats.bothFilled)}`);
  console.log(`② 仅金额空（币种有值）：     ${fmt(stats.amountEmptyOnly)}  ← NewF1 修复后会被 JOIN 跳过`);
  console.log(`③ 仅币种空（金额有值）：     ${fmt(stats.currencyEmptyOnly)}`);
  console.log(`④ 都空：                     ${fmt(stats.bothEmpty)}`);

  console.log('\n=== 空值行按「子类型」（流水第 6 列）分组 ===');
  const subList = [...stats.subTypeSamples.entries()].sort((a, b) => (b[1].amountEmpty + b[1].currencyEmpty + b[1].bothEmpty) - (a[1].amountEmpty + a[1].currencyEmpty + a[1].bothEmpty));
  for (const [subType, info] of subList) {
    console.log(`  子类型 "${subType}": 仅金额空=${info.amountEmpty} / 仅币种空=${info.currencyEmpty} / 都空=${info.bothEmpty}`);
  }
}

main().catch((e) => { console.error('FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
