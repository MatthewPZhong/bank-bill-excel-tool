// 一次性诊断脚本（PR #50 NewF1 配套调研）：扫源单据 xlsx 统计「对账金额」x「对账币种」空值组合分布
//
// 用法：node scripts/scan-bill-empty-distribution.js /path/to/bill/dir
//      （或多个文件路径作为参数）
//
// 输出 4 种组合的行数：都不空 / 仅金额空 / 仅币种空 / 都空

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
        if (n.name === 'row') row = { rowIndex: Number(n.attributes.r || '0'), values: [] };
        else if (n.name === 'c') { cellCol = colRefToIndex(n.attributes.r || ''); cellType = n.attributes.t || ''; buf = ''; }
        else if (n.name === 'is') inIs = true;
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
            // 单据 BILL_HEADERS：values[18] = 对账金额，values[19] = 对账币种
            const amount = String(row.values[18] || '').trim();
            const currency = String(row.values[19] || '').trim();
            const aE = amount === '';
            const cE = currency === '';
            if (!aE && !cE) stats.bothFilled++;
            else if (aE && !cE) stats.amountEmptyOnly++;
            else if (!aE && cE) stats.currencyEmptyOnly++;
            else stats.bothEmpty++;
            stats.total++;
            // 记录单边空 sample（最多 3 个供分析）
            if (aE !== cE) {
              if (aE && stats.amountEmptySamples.length < 3) {
                stats.amountEmptySamples.push({ file: path.basename(filePath), rowIndex: row.rowIndex, values: row.values.slice(0, 26) });
              }
              if (cE && stats.currencyEmptySamples.length < 3) {
                stats.currencyEmptySamples.push({ file: path.basename(filePath), rowIndex: row.rowIndex, values: row.values.slice(0, 26) });
              }
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
  const args = process.argv.slice(2);
  if (args.length === 0) { console.error('usage: node scan-bill-empty-distribution.js <dir or file...>'); process.exit(1); }
  let files = [];
  for (const a of args) {
    const stat = fs.statSync(a);
    if (stat.isDirectory()) {
      files.push(...fs.readdirSync(a).filter((f) => f.endsWith('.xlsx') && !f.startsWith('.~') && !f.startsWith('~$')).map((f) => path.join(a, f)));
    } else {
      files.push(a);
    }
  }
  files.sort();

  const stats = {
    total: 0, bothFilled: 0, amountEmptyOnly: 0, currencyEmptyOnly: 0, bothEmpty: 0,
    amountEmptySamples: [], currencyEmptySamples: []
  };
  console.log(`扫描 ${files.length} 个文件...`);
  for (let i = 0; i < files.length; i++) {
    const t0 = Date.now();
    await scanFile(files[i], stats);
    process.stdout.write(`  [${i + 1}/${files.length}] ${path.basename(files[i])} (${((Date.now() - t0) / 1000).toFixed(1)}s, 累计 ${stats.total} 行)\n`);
  }

  console.log('\n=== 空值分布统计（单据：对账金额第 19 列 / 对账币种第 20 列）===');
  const fmt = (n) => stats.total === 0 ? '0' : `${n.toLocaleString()} (${((n / stats.total) * 100).toFixed(3)}%)`;
  console.log(`总单据行数：${stats.total.toLocaleString()}`);
  console.log(`① 对账金额 + 对账币种 都不空：${fmt(stats.bothFilled)}`);
  console.log(`② 仅金额空（币种有值）：     ${fmt(stats.amountEmptyOnly)}`);
  console.log(`③ 仅币种空（金额有值）：     ${fmt(stats.currencyEmptyOnly)}  ← 进 diff_rows diff_type='bill_currency_missing'`);
  console.log(`④ 都空：                     ${fmt(stats.bothEmpty)}`);

  if (stats.currencyEmptySamples.length > 0) {
    console.log('\n=== 仅币种空 sample（最多 3 条）===');
    for (const s of stats.currencyEmptySamples) {
      console.log(`  ${s.file}:row${s.rowIndex} →`, JSON.stringify(s.values.slice(0, 22)));
    }
  }
  if (stats.amountEmptySamples.length > 0) {
    console.log('\n=== 仅金额空 sample（最多 3 条）===');
    for (const s of stats.amountEmptySamples) {
      console.log(`  ${s.file}:row${s.rowIndex} →`, JSON.stringify(s.values.slice(0, 22)));
    }
  }
}

main().catch((e) => { console.error('FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
