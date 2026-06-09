#!/usr/bin/env node
/* eslint-disable no-console */
// =============================================================================
// v3.0.0 块 B / O-2 自测 fixture 生成器
//
// 造两个中等链接表（sheet「渠道对账单」，44 列 = BANK_STATEMENT_FIELDS），用于自验证
// test-v3.0.0-linked-streaming-parity.js 这套 diff harness 是否「该一致的一致、该报的报得出」：
//
//   safe.xlsx  —— 全用「安全存储」：日期=ISO 文本字符串、金额=General 数字、ID=文本字符串
//                 → 现状 SheetJS(raw:false) 与流式逐格应完全一致（diff=0）
//   risky.xlsx —— 故意制造「危险存储」：
//                 · 日期列存 Excel serial + 日期 numFmt（SheetJS 格式化成日期串 / 流式得序列号数字）
//                 · 金额列存 number + 千分位/两位小数 numFmt（SheetJS "1,234.50" / 流式 "1234.5"）
//                 · ReconciliationId 存长数字（格式化 vs String(parseFloat) 分叉）
//                 → diff 必须 >0 且命中这些列，否则说明 harness 漏判
//
// ⚠️ 注意：本 fixture 由 SheetJS 写出，只能验证 harness 的「抓分叉能力」，
//   不能替代「真实链接表怎么存」的代表性 —— 真实文件的存储口径只能由 PROBE 真实样本得到。
//
// 用法：node scripts/test-v3.0.0-make-linked-fixture.js
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { BANK_STATEMENT_FIELDS } = require('../src/constants/bank-statement-fields');

const OUT_DIR = path.join(__dirname, 'fixtures', 'v3.0.0');
const SHEET_NAME = '渠道对账单';

const DATE_COLS = ['BillDate', 'ValueDate', '最近修改时间'];
const AMOUNT_COLS = ['Credit Amount', 'Debit Amount', 'Extra Fee', 'Recon Amount', 'buyAmount', 'sellAmount'];
function colIndex(name) {
  return BANK_STATEMENT_FIELDS.indexOf(name);
}

// 构造 worksheet：每行先填满 44 列普通文本（防尾部空列被 trim 影响行对齐），再覆盖关键列。
function buildSheet({ risky }) {
  const ws = {};
  let maxRow = 0;
  const set = (r, c, cell) => {
    ws[XLSX.utils.encode_cell({ r, c })] = cell;
    if (r > maxRow) maxRow = r;
  };

  // 表头行
  BANK_STATEMENT_FIELDS.forEach((h, c) => set(0, c, { t: 's', v: h }));

  const DATA_ROWS = 5;
  for (let i = 0; i < DATA_ROWS; i += 1) {
    const r = i + 1;
    // 1) 全列默认普通文本（含中文 + 故意前后空格 —— normalizeCell 双边 trim，不应产生 diff）
    for (let c = 0; c < BANK_STATEMENT_FIELDS.length; c += 1) {
      set(r, c, { t: 's', v: `  值_${r}_${c}_中文  ` });
    }
    // 2) 日期列
    DATE_COLS.forEach((name) => {
      const c = colIndex(name);
      if (c < 0) return;
      // risky：Date 对象 → SheetJS 写成 Excel serial + builtin 日期 numFmt（raw:false 格式化成日期串 / 流式得序列号）
      if (risky) set(r, c, { t: 'd', v: new Date(2025, 5, 15 + i), z: 'm/d/yyyy' });
      else set(r, c, { t: 's', v: `2025-06-${15 + i}` }); // ISO 文本
    });
    // 3) 金额列
    AMOUNT_COLS.forEach((name, k) => {
      const c = colIndex(name);
      if (c < 0) return;
      if (risky) {
        const fmt = k % 2 === 0 ? '#,##0.00' : '0.00';
        set(r, c, { t: 'n', v: 1234.5 + i * 1000 + k, z: fmt }); // 带千分位/两位小数
      } else {
        set(r, c, { t: 'n', v: 0.01 + i }); // General 数字
      }
    });
    // 4) ReconciliationId / MerchantId
    const reconC = colIndex('ReconciliationId');
    const midC = colIndex('MerchantId');
    if (risky) {
      if (reconC >= 0) set(r, reconC, { t: 'n', v: 1374968354575550000 + i }); // 长数字
      if (midC >= 0) set(r, midC, { t: 'n', v: 100200300 + i });
    } else {
      if (reconC >= 0) set(r, reconC, { t: 's', v: `137496835457555046${i}` }); // 文本长 ID
      if (midC >= 0) set(r, midC, { t: 's', v: `00${i}` });                       // 前导零文本
    }
  }

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: BANK_STATEMENT_FIELDS.length - 1 } });
  return ws;
}

function writeFixture(name, risky) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildSheet({ risky }), SHEET_NAME);
  const out = path.join(OUT_DIR, name);
  // bookSST:true → 字符串走 shared-string 表（真实链接表的文本存储形态；流式 reader 的 s 分支可读）。
  //   默认 bookSST:false 会把字符串写成 t="str"+<v>（公式串形态），非真实文件形态、且带 xml:space 的 <v> 流式读不出。
  XLSX.writeFile(wb, out, { bookSST: true });
  console.log(`  ✓ 生成 ${path.relative(process.cwd(), out)} （${risky ? 'risky 危险存储' : 'safe 安全存储'}）`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log('生成 O-2 自测 fixture：');
writeFixture('linked-parity-safe.xlsx', false);
writeFixture('linked-parity-risky.xlsx', true);
console.log('\n下一步：node scripts/test-v3.0.0-linked-streaming-parity.js');
