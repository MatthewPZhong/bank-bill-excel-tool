// 原型脚本（非生产代码）：预览 refund-backfill-rules-v2（R1~R6 + O1~O4）在真实样本上的回填输出。
// ⚠️ 仅用于给用户看「这版功能产出长什么样」，不接 DB/不改 src，逻辑按 spec 手写。
// ⚠️ 未提供入金表(depositRows) → 二跳类策略(matchJpmUs / R2 / R3 / R5 / R6)无法执行，本次仅跑：
//     S1(渠道流水号等值) / R1(JPM-HK T54[A-Z]{4}提取等值，已修正正则) / S2-MTX / S3(付款人/卡号) / S4(单向0~21天)。

const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const path = require('node:path');

// ---------- 常量（对齐 spec 定稿） ----------
const HIT_PRECISE = '精准命中';
const HIT_FUZZY = '模糊命中';
const S4_DETAIL_TEXT = '命中唯一值:退款提交日期+大账号+金额+币种'; // O2 定稿文案
const S4_TOLERANCE = 21;                                   // R4 单向 0~21
const T54_RE = /T54[A-Z]{4}\d{6}/g;                        // R1 修正：T54+4字母+6数字
const MTX_RE = /MTX\d{19}/g;
const BLACKLIST = new Set(['NOTPROVIDED', 'NONREF']);      // R2 黑名单（本次未用，二跳缺入金表）

// O3：银行列 9→10（CustomerRef 右侧加 Payment Detail）
const REFUND_BANK_COLUMNS = [
  'BillDate', 'Channel', '地区', 'MerchantId', 'Currency',
  'Debit Amount', 'ReconciliationId', 'ChannelOrderNo', 'CustomerRef', 'Payment Detail'
];
// O4：追加 15 个中台退款订单字段
const REFUND_RO_COLUMNS = [
  '流水号', '加款单号', '渠道名称', '银行大账号', '虚拟卡号', '原加款金额', '退款金额', '币种',
  '付款人名称', '付款卡号', '附言', '客户号', '账户号', '银行打款流水号', 'valueDate'
];
// 模板表头 31 列：A~D + 命中类型 + 匹配命中详情 + 10 银行列 + 15 ro 列
const TEMPLATE_HEADERS = [
  '退款单号', '状态', '渠道流水号', '渠道退款时间', '命中类型', '匹配命中详情',
  ...REFUND_BANK_COLUMNS, ...REFUND_RO_COLUMNS
];
const UNMATCHED_HEADERS = ['结果类型', '退款单号', ...REFUND_BANK_COLUMNS, '报错/提示信息'];
const RESULT_ERROR = '报错-人工介入';
const RESULT_NOTICE = '未匹配-提示';

// ---------- 工具 ----------
const norm = (v) => (v === null || v === undefined) ? '' : (typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v).trim());
const num = (v) => { if (typeof v === 'number') return Number.isFinite(v) ? v : null; const s = String(v == null ? '' : v).replace(/,/g, '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const clean = (s) => norm(s).split('//').join('');
function toDate(v) { const s = norm(v); let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return new Date(+m[1], +m[2] - 1, +m[3]); m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/); if (m) return new Date(+m[1], +m[2] - 1, +m[3]); return null; }
const MS = 86400000;
function signedDayDiff(a, b) { const da = toDate(a), db = toDate(b); if (!da || !db) return null; return Math.round((da.getTime() - db.getTime()) / MS); }
function load(p) { const wb = XLSX.readFile(p, { dense: true }); const ws = wb.Sheets[wb.SheetNames[0]]; const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }); const H = rows[0]; return rows.slice(1).filter(r => r && r.some(c => String(c).trim())).map((r, i) => { const o = {}; H.forEach((h, j) => o[h] = r[j]); o._rowId = `row_${i}`; return o; }); }

function bankAmountAbs(b) { const c = num(b['Credit Amount']) || 0, d = num(b['Debit Amount']) || 0; return Math.abs(c - d); }
function extract(text, re) { const s = norm(text); if (!s) return []; const fresh = new RegExp(re.source, 'g'); return Array.from(new Set(s.match(fresh) || [])); }

// 两句式命中详情（O2：无「匹配成功:」前缀）
const detailRo = (bf, bv, rf, rv) => `"银行对账单${bf}里的${norm(bv)}"匹配上了"refund order ${rf} 的${norm(rv)}"`;

// ---------- 策略（仅非二跳，二跳缺入金表跳过） ----------
// S1：ro 银行打款流水号 == bank ChannelOrderNo / CustomerRef
function matchS1(b, cands) { const hits = []; for (const ro of cands) { const pay = norm(ro['银行打款流水号']); if (!pay) continue; for (const f of ['ChannelOrderNo', 'CustomerRef']) { const bv = norm(b[f]); if (bv && bv === pay) { hits.push({ ro, detail: detailRo(f, bv, '银行打款流水号', pay), hitType: HIT_PRECISE }); break; } } } return hits; }
// R1：JPM-HK 清洗// → 提 T54[A-Z]{4} → == ro 银行打款流水号
function matchHkT54(b, cands) { const toks = []; for (const f of ['Extra Information', 'Payment Detail']) for (const t of extract(clean(b[f]), T54_RE)) if (!toks.includes(t)) toks.push(t); if (!toks.length) return []; const hits = []; for (const ro of cands) { const pay = norm(ro['银行打款流水号']); if (!pay) continue; const hit = toks.find(t => t === pay); if (hit) hits.push({ ro, detail: detailRo('Extra Information/Payment Detail(提T54)', hit, '银行打款流水号', pay), hitType: HIT_PRECISE }); } return hits; }
// S2-MTX：bank Extra Info 提 MTX → ro 附言 includes
function matchMtx(b, cands) { const mtx = extract(b['Extra Information'], MTX_RE); if (!mtx.length) return []; const hits = []; for (const ro of cands) { const memo = norm(ro['附言']); if (!memo) continue; const hit = mtx.find(m => memo.includes(m)); if (hit) hits.push({ ro, detail: detailRo('Extra Information(提MTX)', hit, '附言', memo.slice(0, 40)), hitType: HIT_PRECISE }); } return hits; }
// S3：ro 付款人名称/付款卡号/虚拟卡号 == bank Drawee Name/Drawee CardNo/Payee CardNo（按位）
function matchS3(b, cands) { const pairs = [['付款人名称', 'Drawee Name'], ['付款卡号', 'Drawee CardNo'], ['虚拟卡号', 'Payee CardNo']]; const hits = []; for (const ro of cands) { for (const [rk, bf] of pairs) { const rv = norm(ro[rk]); if (!rv) continue; const bv = norm(b[bf]); if (bv && bv === rv) { hits.push({ ro, detail: detailRo(bf, bv, rk, rv), hitType: HIT_PRECISE }); break; } } } return hits; }
// S4：单向 0 ≤ bank.BillDate − ro.valueDate ≤ 21
function matchS4(b, cands) { const hits = []; for (const ro of cands) { const diff = signedDayDiff(b['BillDate'], ro['valueDate']); if (diff !== null && diff >= 0 && diff <= S4_TOLERANCE) hits.push({ ro, diff, detail: S4_DETAIL_TEXT, hitType: HIT_FUZZY }); } hits.sort((a, b) => a.diff - b.diff); return hits; }

// ---------- 引擎主流程（简化版 1↔1 + 多笔报错） ----------
function runEngine(bankRows, refundRows, region) {
  const ach = bankRows.filter(b => norm(b['FundType']) === 'Ach Return');
  const sub = refundRows.filter(r => norm(r['状态']) === 'SUBMITTED');
  const cents = (v) => { const n = num(v); return n === null ? null : Math.round(n * 100); };
  const keyB = (b) => `${norm(b['MerchantId'])}|${norm(b['Currency'])}|${Math.round(bankAmountAbs(b) * 100)}`;
  const keyR = (r) => { const c = cents(r['退款金额']); return c === null ? null : `${norm(r['银行大账号'])}|${norm(r['币种'])}|${c}`; };
  const groups = new Map();
  for (const b of ach) { const k = keyB(b); if (!groups.has(k)) groups.set(k, { bank: [], ref: [] }); groups.get(k).bank.push(b); }
  for (const r of sub) { const k = keyR(r); if (!k) continue; if (!groups.has(k)) groups.set(k, { bank: [], ref: [] }); groups.get(k).ref.push(r); }

  const backfill = [], unmatched = [];
  const stats = { S1: 0, R1_T54: 0, MTX: 0, S3: 0, S4: 0, error: 0, notice_bankOnly: 0, notice_refOnly: 0 };
  const usedRef = new Set();

  for (const [, g] of groups) {
    if (g.bank.length && !g.ref.length) { g.bank.forEach(b => { unmatched.push(mkUnmatched(b, RESULT_NOTICE, '未能关联到任何退款订单（同唯一值组无 SUBMITTED 退款）')); stats.notice_bankOnly++; }); continue; }
    if (!g.bank.length && g.ref.length) { g.ref.forEach(r => { unmatched.push({ '结果类型': RESULT_NOTICE, '退款单号': norm(r['流水号']), '报错/提示信息': '该退款订单未关联到银行对账单数据' }); stats.notice_refOnly++; }); continue; }

    const settledBank = new Set();
    const strategies = [
      ['S1', (b, c) => matchS1(b, c)],
      ['R1_T54', (b, c) => region === 'HK' ? matchHkT54(b, c) : []],
      ['MTX', (b, c) => matchMtx(b, c)],
      ['S3', (b, c) => matchS3(b, c)],
    ];
    for (const [name, fn] of strategies) {
      const banks = g.bank.filter(b => !settledBank.has(b._rowId));
      const avail = g.ref.filter(r => !usedRef.has(r._rowId));
      if (!banks.length || !avail.length) continue;
      const hitsByBank = new Map(), winnersByRef = new Map();
      for (const b of banks) { const hs = fn(b, avail); hitsByBank.set(b._rowId, hs); hs.forEach(h => { const id = h.ro._rowId; if (!winnersByRef.has(id)) winnersByRef.set(id, new Set()); winnersByRef.get(id).add(b._rowId); }); }
      for (const b of banks) {
        const hs = hitsByBank.get(b._rowId) || [];
        if (!hs.length) continue;
        if (hs.length > 1) { unmatched.push(mkUnmatched(b, RESULT_ERROR, `${name} 关联到 ${hs.length} 条退款订单，无法消歧，请人工介入`)); settledBank.add(b._rowId); stats.error++; continue; }
        const ro = hs[0].ro, w = winnersByRef.get(ro._rowId);
        if (w && w.size > 1) { unmatched.push(mkUnmatched(b, RESULT_ERROR, `${name} 与其他银行行同时命中同一退款订单（反向多笔），请人工介入`)); settledBank.add(b._rowId); stats.error++; continue; }
        backfill.push(mkBackfill(ro, b, hs[0].detail, hs[0].hitType)); usedRef.add(ro._rowId); settledBank.add(b._rowId); stats[name]++;
      }
    }
    // S4 兜底（模糊）
    const banksS4 = g.bank.filter(b => !settledBank.has(b._rowId));
    for (const b of banksS4) {
      const avail = g.ref.filter(r => !usedRef.has(r._rowId));
      const hits = matchS4(b, avail);
      if (hits.length) { backfill.push(mkBackfill(hits[0].ro, b, hits[0].detail, hits[0].hitType)); usedRef.add(hits[0].ro._rowId); stats.S4++; }
      else unmatched.push(mkUnmatched(b, RESULT_NOTICE, '未能关联到任何退款订单（S1/R1/MTX/S3/S4 均未命中；二跳类策略需入金表）'));
    }
    // 未消费 refund
    for (const r of g.ref) if (!usedRef.has(r._rowId)) { unmatched.push({ '结果类型': RESULT_NOTICE, '退款单号': norm(r['流水号']), '报错/提示信息': '该退款订单未关联到银行对账单数据' }); stats.notice_refOnly++; }
  }
  return { backfill, unmatched, stats, achN: ach.length, subN: sub.length };
}

function mkBackfill(ro, b, detail, hitType) {
  const row = { '退款单号': norm(ro['流水号']), '状态': 'SUCCESS', '渠道流水号': norm(b['ReconciliationId']), '渠道退款时间': b['BillDate'], '命中类型': hitType, '匹配命中详情': detail };
  for (const c of REFUND_BANK_COLUMNS) row[c] = b[c];
  for (const c of REFUND_RO_COLUMNS) row[c] = ro[c];
  return row;
}
function mkUnmatched(b, resultType, info) { const row = { '结果类型': resultType }; for (const c of REFUND_BANK_COLUMNS) row[c] = b[c]; row['报错/提示信息'] = info; return row; }

// ---------- 写盘 ----------
async function writeOut(savePath, results) {
  const wb = new ExcelJS.Workbook();
  const proj = (headers, row) => headers.map(h => (row && row[h] !== undefined && row[h] !== null) ? row[h] : '');
  for (const { region, backfill, unmatched } of results) {
    const s1 = wb.addWorksheet(`${region}-回填模板`);
    s1.addRow(TEMPLATE_HEADERS.slice()); s1.getRow(1).font = { bold: true, size: 10 };
    backfill.forEach(r => s1.addRow(proj(TEMPLATE_HEADERS, r)));
    const s2 = wb.addWorksheet(`${region}-未匹配报错`);
    s2.addRow(UNMATCHED_HEADERS.slice()); s2.getRow(1).font = { bold: true, size: 10 };
    unmatched.forEach(r => s2.addRow(proj(UNMATCHED_HEADERS, r)));
  }
  // 说明 sheet
  const note = wb.addWorksheet('⚠️说明');
  [
    ['本文件 = refund-backfill-rules-v2（R1~R6 + O1~O4）原型预览，非生产产出'],
    [''],
    ['【已执行策略】S1 渠道流水号等值 / R1 JPM-HK T54提取等值(正则修正为 T54[A-Z]{4}) / S2-MTX / S3 付款人卡号 / S4 单向0~21天'],
    ['【未执行策略】matchJpmUs(US主流) / R2 附言包含入金CustomerRef / R3 HK CustomerRef二跳 / R5 Drawee+DESC DATE / R6 附言原单日期金额'],
    ['【原因】以上 5 类均为「二跳」策略，需入金表(inbound 银行对账单 depositRows)，本次未提供 → 无法执行'],
    [''],
    ['【新输出格式 O1~O4 已体现】'],
    ['  O1：新增「命中类型」列（精准命中/模糊命中）'],
    ['  O2：命中详情删「匹配成功:」前缀；S4 改固定串「命中唯一值:退款提交日期+大账号+金额+币种」'],
    ['  O3：银行列加「Payment Detail」'],
    ['  O4：追加 15 个中台退款订单字段；模板 14→31 列'],
    [''],
    ['【要看 US 二跳 / R5 / R6 真实命中】请提供对应入金表(inbound 银行对账单)，我重跑。'],
  ].forEach(r => note.addRow(r));
  note.getColumn(1).width = 120;
  await wb.xlsx.writeFile(savePath);
}

// ---------- main ----------
(async () => {
  const base = '/Users/pzhong/Desktop/小助手-Debug/3.0.0/3.0.0-测试用文件/JPM调拨测试';
  const usBank = load(`${base}/渠道账单_2026-06-08_226235-JPMUS.xlsx`);
  const usRef = load(`${base}/Refund_order_1780892881449-jpmus-用例.xls`);
  const hkBank = load(`${base}/渠道账单_2026-06-08_121163-JPMHK.xlsx`);
  const hkRef = load(`${base}/Refund_order_1780892915784-jpmhk-用例.xls`);

  const us = runEngine(usBank, usRef, 'US');
  const hk = runEngine(hkBank, hkRef, 'HK');

  console.log('=== US ===', JSON.stringify({ ach: us.achN, sub: us.subN, backfill: us.backfill.length, unmatched: us.unmatched.length, stats: us.stats }));
  console.log('=== HK ===', JSON.stringify({ ach: hk.achN, sub: hk.subN, backfill: hk.backfill.length, unmatched: hk.unmatched.length, stats: hk.stats }));

  const out = path.join(process.env.HOME, 'Desktop', '退款回填预览-v3.0.5新功能-JPMUS+HK.xlsx');
  await writeOut(out, [{ region: 'HK', ...hk }, { region: 'US', ...us }]);
  console.log('已输出:', out);
})();
