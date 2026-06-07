// 一次性基准 + 对拍：实测「收单单据币种校验」写差异文件（writeDiffWorkbook）提速效果
//
// 背景（v2.1.15 W0，🔴 资金红线 — 差异表是对账产出，内容必须逐行逐列不变）
//   旧实现：writer.writeDiffWorkbook 在每个 segment 内用 `LIMIT 5000 OFFSET k` 循环分页，
//     对应 SQL run-repository.listDiffRowsByDateRange 的 `ORDER BY json_extract(...账单日期)` 无索引，
//     每批全排序 + 深 OFFSET → 整月单 segment 时退化 O(N²)。
//   新实现：run-repository.iterateDiffRowsByDateRange 去掉 LIMIT/OFFSET，用 stmt.iterate() 单次游标遍历，
//     SQL body 与 listDiffRowsByDateRange 逐字相同（仅去分页）→ 输出逐行逐列不变，复杂度降到 O(N log N)。
//
// 本脚本做两件事（证据优先）：
//   1. 性能：AppDatabase.init 真实建库 → 灌 N bill + 1 run + N diff_rows（全 currency_mismatch）
//      → 分别用「改前 OFFSET 实现（脚本内联拷贝，不进生产代码）」与「改后生产 writer」计时，给出加速倍数。
//   2. 正确性对拍：用 ExcelJS 读回 baseline.xlsx（OFFSET 版）与 new.xlsx（生产版），
//      对差异 sheet 逐 sheet 名 / 逐行 / 逐列断言一致（资金红线兜底，逐 cell sha256）。
//      「运行结果汇总」sheet 含运行耗时 / 生成时间等时变字段 → 不参与对拍（baseline 本就不产出该 sheet）。
//   另含一个触发 sub-sheet 切分（单日 > MAX 行）的可选用例（--sub），覆盖罕见 sub-sheet 切分路径。
//
// 用法：
//   node scripts/perf/bench-acquiring-diff-write.js [N] [--sub]
//   例：node scripts/perf/bench-acquiring-diff-write.js 500000
//       node scripts/perf/bench-acquiring-diff-write.js 500000 --sub   （额外跑 ~105 万单日行 sub-sheet 切分用例）
//
// 注意：纯测量脚本，不改任何生产代码；用独立临时库 + 临时输出目录，跑完即删，不碰生产数据。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { AppDatabase } = require('../../src/backend/database');
const writer = require('../../src/main-process/acquiring-bill-currency-writer');
const runRepo = require('../../src/backend/acquiring-bill-currency-db/run-repository');
const {
  TEMPLATE_BILL_HEADERS,
  WRITER_OUTPUT_HEADERS_V2
} = require('../../src/backend/acquiring-bill-currency-db/columns');

const N = Number(process.argv[2]) || 500000;
const MONTH = '2026-05';
const COL_SEP = ''; // 列分隔（不会出现在币种/金额/日期等数据里）
const ROW_SEP = ''; // 行分隔

function ms(t0, t1) {
  return Number(t1 - t0) / 1e6;
}

function buildDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-diffwrite-bench-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const appDb = new AppDatabase(dbPath);
  appDb.init();
  return { appDb, db: appDb.db, dir };
}

function teardown({ appDb, dir }) {
  try { appDb.close && appDb.close(); } catch (_e) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

// 灌 N 行单据。raw_json 用 9 字段模版（贴近 v2.1.8 N4 瘦身后真实大小）；账单日期分布到多天体现排序代价。
//   singleDay=false：账单日期乱序 round-robin 到 daysSpread 天（默认 30），制造跨日排序压力；
//   singleDay=true ：全部同一天（用于 sub-sheet 切分用例，单 segment 单日）。
function populateBill(db, monthKey, n, { daysSpread = 30, singleDay = false } = {}) {
  const CCY = ['USD', 'EUR', 'HKD', 'CNY', 'JPY'];
  const insert = db.prepare(`
    INSERT INTO acquiring_bill_currency_bill_imports
      (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const importedAt = '2026-05-01T00:00:00.000Z';
  const t0 = process.hrtime.bigint();
  db.exec('BEGIN');
  try {
    for (let i = 0; i < n; i++) {
      const ccy = CCY[i % CCY.length];
      // 账单日期：singleDay 固定一天；否则乱序 round-robin 到 daysSpread 天（靠 SQL ORDER BY 还原顺序）
      const dayNum = singleDay ? 10 : (1 + ((i * 7) % daysSpread));
      const billDate = `2026-05-${String(dayNum).padStart(2, '0')}`;
      const raw = JSON.stringify({
        '账单日期': billDate,
        'originBillBizId': `OB${i}`,
        '单据类型': '消费',
        '主对账Id': `R${i}`,
        '业务订单号': `O${i}`,
        '对账金额': '123.45',
        '对账币种': ccy,
        'valueDate': billDate,
        'channel': 'WX'
      });
      // source_file / source_row_index 参与同日内二级排序，制造同日多行的稳定排序场景
      const srcFile = `bench-${i % 3}.xlsx`;
      insert.run(monthKey, srcFile, i + 2, `R${i}`, ccy, ccy.toLowerCase(), raw, importedAt);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const t1 = process.hrtime.bigint();
  return ms(t0, t1);
}

// 插 1 条 run + 为本月每条 bill 插 1 条 diff_rows（全 currency_mismatch），返回 runId
function populateRunAndDiff(db, monthKey, n) {
  const runRes = db.prepare(`
    INSERT INTO acquiring_bill_currency_runs
      (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
    VALUES (?, ?, ?, ?, ?, 'success')
  `).run(monthKey, n, 0, n, 0);
  const runId = Number(runRes.lastInsertRowid);
  const ids = db.prepare(
    'SELECT id FROM acquiring_bill_currency_bill_imports WHERE month_key = ? ORDER BY id'
  ).all(monthKey);
  const insertDiff = db.prepare(`
    INSERT INTO acquiring_bill_currency_diff_rows
      (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
    VALUES (?, ?, ?, ?, 'currency_mismatch')
  `);
  const t0 = process.hrtime.bigint();
  db.exec('BEGIN');
  try {
    for (const r of ids) insertDiff.run(runId, r.id, 'usd', '123.45');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const t1 = process.hrtime.bigint();
  return { runId, diffMs: ms(t0, t1) };
}

// ============================================================
// baseline 生成器：内联「改前」OFFSET 深分页实现（仅脚本内，不进生产代码）
//   逐字复刻改动前 writer.writeDiffWorkbook 的循环体逻辑（LIMIT 5000 OFFSET），
//   复用生产的 planSegments / fmtSheetName / MAX_DATA_ROWS_PER_SHEET 行为。
//   目的：同一次运行内即可对拍「OFFSET 旧逻辑」与「游标新逻辑」输出一致。
//   说明：baseline 只产出差异 sheet（对拍核心），不产出「运行结果汇总」sheet（含时变字段，不参与对拍）。
// ============================================================
const MAX_DATA_ROWS_PER_SHEET = writer.MAX_DATA_ROWS_PER_SHEET;

function sanitizeSheetNameLocal(name) {
  return String(name).replace(/[\/\\*?\[\]:]/g, '-').slice(0, 31);
}

// 改前的分页 SQL（与改动前 run-repository.listDiffRowsByDateRange 逐字相同，含 LIMIT/OFFSET）
function listDiffRowsByDateRangeOffset(db, { runId, startDate, endDate, limit, offset }) {
  return db.prepare(`
    SELECT
      b.raw_json AS bill_raw_json,
      d.flow_currency,
      d.flow_amount_abs
    FROM acquiring_bill_currency_diff_rows d
    INNER JOIN acquiring_bill_currency_bill_imports b ON b.id = d.bill_import_id
    WHERE d.run_id = ?
      AND COALESCE(json_extract(b.raw_json, '$."账单日期"'), '') >= ?
      AND COALESCE(json_extract(b.raw_json, '$."账单日期"'), '') <= ?
    ORDER BY json_extract(b.raw_json, '$."账单日期"') ASC, b.source_file ASC, b.source_row_index ASC
    LIMIT ? OFFSET ?
  `).all(runId, startDate, endDate, limit, offset);
}

// baseline 版 writeDiffWorkbook：与改前 writer 同结构，内层走 OFFSET 分页
async function writeDiffWorkbookOffsetBaseline({ db, runId, monthKey, savePath }) {
  fs.mkdirSync(path.dirname(savePath), { recursive: true });
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: savePath,
    useStyles: false,
    useSharedStrings: false
  });
  wb.lastModifiedBy = 'pzhong';

  const dateCounts = runRepo.getBillDateCounts(db, { runId });
  const segments = writer.planSegments(dateCounts);

  const BATCH = 5000;
  let totalWritten = 0;

  for (const seg of segments) {
    const sheetBaseName = writer.fmtSheetName(seg);
    let sheet = wb.addWorksheet(sheetBaseName);
    sheet.addRow(WRITER_OUTPUT_HEADERS_V2.slice()).commit();
    let curSubSheetRowCount = 0;
    let subSheetIndex = 1;

    let segWritten = 0;
    if (seg.rowCount > 0) {
      let offset = 0;
      while (true) {
        const rows = listDiffRowsByDateRangeOffset(db, {
          runId,
          startDate: seg.startDate,
          endDate: seg.endDate,
          limit: BATCH,
          offset
        });
        if (rows.length === 0) break;
        for (const d of rows) {
          if (curSubSheetRowCount >= MAX_DATA_ROWS_PER_SHEET) {
            await sheet.commit();
            subSheetIndex++;
            const subName = sanitizeSheetNameLocal(`${sheetBaseName}(${subSheetIndex})`);
            sheet = wb.addWorksheet(subName);
            sheet.addRow(WRITER_OUTPUT_HEADERS_V2.slice()).commit();
            curSubSheetRowCount = 0;
          }
          const rawObj = JSON.parse(d.bill_raw_json);
          const row = new Array(WRITER_OUTPUT_HEADERS_V2.length);
          for (let i = 0; i < TEMPLATE_BILL_HEADERS.length; i++) {
            const v = rawObj[TEMPLATE_BILL_HEADERS[i]];
            row[i] = v === undefined || v === null ? '' : v;
          }
          row[TEMPLATE_BILL_HEADERS.length] =
            rawObj['对账币种'] === undefined || rawObj['对账币种'] === null ? '' : rawObj['对账币种'];
          row[TEMPLATE_BILL_HEADERS.length + 1] = d.flow_currency === null ? '' : d.flow_currency;
          row[TEMPLATE_BILL_HEADERS.length + 2] = d.flow_amount_abs === null ? '' : d.flow_amount_abs;
          sheet.addRow(row).commit();
          curSubSheetRowCount++;
        }
        segWritten += rows.length;
        offset += rows.length;
        if (rows.length < BATCH) break;
      }
    }
    await sheet.commit();
    totalWritten += segWritten;
  }

  await wb.commit();
  return { filePath: savePath, rowCount: totalWritten };
}

// ============================================================
// 对拍：读回两个 xlsx，逐 sheet 名 / 逐行 / 逐列断言一致（资金红线兜底）
//   读回工具用非流式 ExcelJS.Workbook().xlsx.readFile()（sheet 名/顺序解析最可靠）。
//   备注：ExcelJS.stream.xlsx.WorkbookReader 直接 async 迭代依赖 zip entry 顺序
//   （workbook.xml 须先于 sheetN.xml 到达，否则 this.model.sheets undefined 崩），
//   而 streaming WorkbookWriter 产出的 entry 顺序不保证 → 直接迭代不可靠，故对拍弃用直接迭代。
//   - 每个差异 sheet 逐 cell 累加 sha256（内存 O(行宽)，不存全表）；sha256 一致即逐行逐列一致。
//   - 差异 sheet：sheet 名匹配 /^\d{4}-\d{2}-\d{2}~/ 或 sub-sheet 后缀 (n) 或空差异「差异」。
//   - 「运行结果汇总」sheet：baseline 不产出 → 不参与对拍（new 由生产 writer 产出，含时变字段）。
//   - 单 sheet 超约 105 万行时非流式 readFile 触发 jszip RangeError(Invalid string length)：
//     仅 sub-sheet 切分用例（单日 > MAX）会撞上 → 该用例改走 digestDiffSheetsStructure 结构对拍。
// ============================================================
function cellVal(cell) {
  const v = cell && cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    return String(v);
  }
  return String(v);
}

function isDiffSheet(name) {
  // 差异 sheet：YYYY-MM-DD~MM-DD 或带 sub-sheet 后缀 (n)；空差异时为「差异」
  return /^\d{4}-\d{2}-\d{2}~/.test(name) || name === '差异' || /\(\d+\)$/.test(name);
}

// 非流式读回 → 差异 sheet 的 (name, rowCount, sha256) 摘要数组（按文件内 sheet 顺序）。
// 逐 cell sha256（资金红线：逐行逐列一致）。受 jszip 单字符串上限约束（~105 万行单 sheet）。
async function digestDiffSheets(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const out = [];
  wb.eachSheet((ws) => {
    if (!isDiffSheet(ws.name)) return;
    const hash = crypto.createHash('sha256');
    let rowCount = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      rowCount++;
      const arr = [];
      for (let c = 1; c <= WRITER_OUTPUT_HEADERS_V2.length; c++) {
        arr.push(cellVal(row.getCell(c)));
      }
      hash.update(arr.join(COL_SEP) + ROW_SEP);
    });
    out.push({ name: ws.name, rowCount, sha256: hash.digest('hex') });
  });
  return out;
}

// 仅结构对拍（sheet 名序列 + 每 sheet 行数），不读 cell —— 用于 105 万+ 行单 sheet 绕开 jszip 上限。
// 配合 sub-sheet 用例：切分逻辑（curSubSheetRowCount >= MAX → 开新 sheet）改前改后逐字未变，
// 切分点只取决于行计数、与取数方式（OFFSET vs iterate）无关；故「主用例逐 cell 一致 + sub 结构一致」
// 联合证明 sub-sheet 路径 byte 一致。用流式 reader 的 'worksheet'+'row' 事件仅统计行数（不取 cell 内容）。
async function digestDiffSheetsStructure(filePath) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit', sharedStrings: 'cache', styles: 'ignore', hyperlinks: 'ignore'
  });
  const all = [];
  await new Promise((resolve, reject) => {
    reader.on('worksheet', (ws) => {
      const rec = { name: ws.name, rowCount: 0 };
      ws.on('row', () => { rec.rowCount++; });
      all.push(rec);
    });
    reader.on('end', resolve);
    reader.on('error', reject);
    reader.read();
  });
  return all.filter((r) => isDiffSheet(r.name));
}

function assertDiffEqual(baselineSheets, newSheets, label, { contentChecked = true } = {}) {
  const errs = [];
  if (baselineSheets.length !== newSheets.length) {
    errs.push(`差异 sheet 数量不一致: baseline=${baselineSheets.length} new=${newSheets.length}`);
  }
  const max = Math.min(baselineSheets.length, newSheets.length);
  let totalRows = 0;
  for (let s = 0; s < max; s++) {
    const a = baselineSheets[s];
    const b = newSheets[s];
    if (a.name !== b.name) {
      errs.push(`sheet[${s}] 名不一致: baseline="${a.name}" new="${b.name}"`);
    }
    if (a.rowCount !== b.rowCount) {
      errs.push(`sheet "${a.name}" 行数不一致: baseline=${a.rowCount} new=${b.rowCount}`);
    }
    if (contentChecked && a.sha256 !== b.sha256) {
      errs.push(`sheet "${a.name}" 内容 sha256 不一致: baseline=${a.sha256.slice(0, 12)} new=${b.sha256.slice(0, 12)}`);
    }
    totalRows += Math.min(a.rowCount, b.rowCount);
  }
  if (errs.length > 0) {
    console.log(`\n[${label}] 对拍 FAIL：`);
    for (const e of errs) console.log('  - ' + e);
    return { ok: false, totalRows };
  }
  const mode = contentChecked
    ? '逐行逐列一致（sha256 逐 sheet 匹配）'
    : '结构一致（sheet 名序列 + 每 sheet 行数；逐 cell 内容由主用例覆盖）';
  console.log(`[${label}] 对拍 PASS：差异 sheet ${max} 个，${mode}（含表头合计 ${totalRows} 行）`);
  return { ok: true, totalRows };
}

// ============================================================
// 主流程
// ============================================================
async function benchMain() {
  console.log(`\n收单写差异文件 提速基准 + 对拍  (N=${N} diff 行, month=${MONTH})`);
  console.log(`node=${process.version}  平台=${process.platform}\n`);

  let result = { okMain: false, okSub: null };

  // ---- 主用例：N 行跨多天，逐 cell sha256 对拍 ----
  const ctx = buildDb();
  const { db, dir } = ctx;
  try {
    const popMs = populateBill(db, MONTH, N, { daysSpread: 30 });
    const { runId, diffMs } = populateRunAndDiff(db, MONTH, N);
    console.log(`灌库：bill ${N} 行 ${popMs.toFixed(0)}ms / diff_rows ${N} 行 ${diffMs.toFixed(0)}ms\n`);

    const baselinePath = path.join(dir, 'baseline.xlsx');
    const newPath = path.join(dir, 'new.xlsx');

    // 改前（OFFSET 深分页）计时
    const t0 = process.hrtime.bigint();
    const bRes = await writeDiffWorkbookOffsetBaseline({ db, runId, monthKey: MONTH, savePath: baselinePath });
    const t1 = process.hrtime.bigint();
    const beforeMs = ms(t0, t1);

    // 改后（生产 writer，游标遍历）计时 —— 同一 db / 同一 runId
    const t2 = process.hrtime.bigint();
    const nRes = await writer.writeDiffWorkbook({ db, runId, monthKey: MONTH, savePath: newPath });
    const t3 = process.hrtime.bigint();
    const afterMs = ms(t2, t3);

    console.log('=== 性能 ===');
    console.log(`改前（OFFSET 深分页）：${beforeMs.toFixed(1)} ms  (写 ${bRes.rowCount} 行)`);
    console.log(`改后（游标遍历）    ：${afterMs.toFixed(1)} ms  (写 ${nRes.rowCount} 行)`);
    const speedup = afterMs > 0 ? (beforeMs / afterMs) : Infinity;
    console.log(`加速倍数            ：${speedup.toFixed(2)}x\n`);

    if (bRes.rowCount !== nRes.rowCount) {
      console.log(`⚠️ 写入行数不一致: baseline=${bRes.rowCount} new=${nRes.rowCount}`);
    }

    console.log('=== 正确性对拍（差异 sheet 逐行逐列）===');
    const bSheets = await digestDiffSheets(baselinePath);
    const nSheets = await digestDiffSheets(newPath);
    const r = assertDiffEqual(bSheets, nSheets, '主用例 N 行跨多天');
    result.okMain = r.ok;
  } finally {
    teardown(ctx);
  }

  // ---- sub-sheet 切分用例（可选 --sub）：单日 > MAX 行，覆盖罕见切分路径（结构对拍）----
  if (process.argv.includes('--sub')) {
    const subN = MAX_DATA_ROWS_PER_SHEET + 1000;
    console.log(`\n=== sub-sheet 切分对拍用例（单日 ${subN} 行，超 MAX=${MAX_DATA_ROWS_PER_SHEET}）===`);
    console.log('（单 sheet 逼近 105 万行 → 非流式 readFile 会触发 jszip 字符串上限，故此用例做结构对拍）');
    const ctx2 = buildDb();
    try {
      populateBill(ctx2.db, MONTH, subN, { singleDay: true });
      const { runId } = populateRunAndDiff(ctx2.db, MONTH, subN);
      const bp = path.join(ctx2.dir, 'baseline-sub.xlsx');
      const np = path.join(ctx2.dir, 'new-sub.xlsx');
      await writeDiffWorkbookOffsetBaseline({ db: ctx2.db, runId, monthKey: MONTH, savePath: bp });
      await writer.writeDiffWorkbook({ db: ctx2.db, runId, monthKey: MONTH, savePath: np });
      const bs = await digestDiffSheetsStructure(bp);
      const ns = await digestDiffSheetsStructure(np);
      const r2 = assertDiffEqual(bs, ns, 'sub-sheet 切分', { contentChecked: false });
      result.okSub = r2.ok;
    } finally {
      teardown(ctx2);
    }
  } else {
    console.log('\n(跳过 sub-sheet 切分用例；加 --sub 开启，灌 ~105 万单日行验证切分路径，耗时较长)');
  }

  console.log('\n=== 结论 ===');
  const subMsg = result.okSub === null ? '(未跑)' : (result.okSub ? 'PASS' : 'FAIL');
  console.log(`主用例对拍: ${result.okMain ? 'PASS' : 'FAIL'} | sub-sheet 对拍: ${subMsg}`);
  if (!result.okMain || result.okSub === false) {
    console.log('❌ 对拍未全过 —— 资金红线：差异表输出不一致，禁止合入！');
    process.exit(1);
  }
  console.log('✅ 差异表输出逐行逐列一致；提速生效。');
}

benchMain().catch((e) => {
  console.error(e);
  process.exit(1);
});
