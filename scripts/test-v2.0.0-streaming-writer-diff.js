#!/usr/bin/env node
/* eslint-disable no-console */
// 流式 xlsx writer 产物一致性测试
// 写入的 xlsx 必须能被 XLSX 库正常读回，且数据 byte-level 与原输入一致
// （资金敏感：archive 产物被业务人工核查，结构错就作废）
//
// 运行：node scripts/test-v2.0.0-streaming-writer-diff.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { writeStreamedXlsx, __internal } = require('../src/backend/pending-import/streaming-xlsx-writer');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-writer-test-'));

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('  ✓', name); pass += 1; }
  else { console.log('  ✗', name, detail ? `— ${detail}` : ''); fail += 1; }
}

async function main() {
  // --- T1 基础：3 列 × 5 行，含空值、特殊字符 ---
  console.log('[T1] 基础写入 + XLSX 读回一致性');
  {
    const headers = ['订单号', '金额', '备注'];
    const rows = [
      ['A001', '100.50', 'normal'],
      ['A002', '200', ''],              // 空备注
      ['B<01>', '300', '特殊 & 字符'],  // XML 转义
      ['', '0.01', '空订单号'],         // 空订单号
      ['C001', '-123.45', '负数金额']
    ];
    const out = path.join(TMP, 't1.xlsx');
    await writeStreamedXlsx(out, headers, rows);
    check('文件存在', fs.existsSync(out));

    // XLSX 库读回
    const wb = XLSX.readFile(out);
    check('sheet 名 Sheet1', wb.SheetNames[0] === 'Sheet1');
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    check('行数 = 6（header + 5 data）', aoa.length === 6);
    check('表头一致', JSON.stringify(aoa[0]) === JSON.stringify(headers));

    for (let i = 0; i < rows.length; i++) {
      const actualRow = aoa[i + 1];
      const expectedRow = rows[i];
      check(
        `row ${i + 2} 内容一致`,
        JSON.stringify(actualRow) === JSON.stringify(expectedRow),
        `expected ${JSON.stringify(expectedRow)} got ${JSON.stringify(actualRow)}`
      );
    }
  }

  // --- T2 中文 + UTF-8 多字节 ---
  console.log('[T2] 中文字符串 UTF-8');
  {
    const headers = ['pending类型', 'pending资金类型', 'order_no'];
    const rows = [
      ['资金已发生_业务未发生_订单单边', '入金', 'TX20260224'],
      ['对方业务已发生_资金未发生', '退票', 'MTX1912 测试'],
    ];
    const out = path.join(TMP, 't2.xlsx');
    await writeStreamedXlsx(out, headers, rows);
    const wb = XLSX.readFile(out);
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    check('中文表头一致', JSON.stringify(aoa[0]) === JSON.stringify(headers));
    check('中文数据行 1 一致', JSON.stringify(aoa[1]) === JSON.stringify(rows[0]));
    check('中文数据行 2 一致', JSON.stringify(aoa[2]) === JSON.stringify(rows[1]));
  }

  // --- T3 单元函数：column letter ---
  console.log('[T3] columnLetter 1-based → A/Z/AA/AE');
  check('1 → A', __internal.columnLetter(1) === 'A');
  check('26 → Z', __internal.columnLetter(26) === 'Z');
  check('27 → AA', __internal.columnLetter(27) === 'AA');
  check('31 → AE', __internal.columnLetter(31) === 'AE');
  check('52 → AZ', __internal.columnLetter(52) === 'AZ');

  // --- T4 async iterator 输入 ---
  console.log('[T4] async iterator 输入');
  {
    async function* gen() {
      for (let i = 1; i <= 100; i++) {
        yield [`k${i}`, String(i * 1.5)];
      }
    }
    const out = path.join(TMP, 't4.xlsx');
    await writeStreamedXlsx(out, ['key', 'value'], gen());
    const wb = XLSX.readFile(out);
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    check('async iter 行数 101', aoa.length === 101);
    check('async iter row 50 = [k49, "73.5"]', aoa[49][0] === 'k49' && aoa[49][1] === '73.5');
    check('async iter row 100 = [k100, "150"]', aoa[100][0] === 'k100' && aoa[100][1] === '150');
  }

  // --- T5 空数据集 ---
  console.log('[T5] 空行数据集');
  {
    const out = path.join(TMP, 't5.xlsx');
    await writeStreamedXlsx(out, ['a', 'b', 'c'], []);
    const wb = XLSX.readFile(out);
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    check('只有表头', aoa.length === 1);
    check('表头内容对', JSON.stringify(aoa[0]) === JSON.stringify(['a', 'b', 'c']));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('');
  console.log(`Total: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  process.exit(2);
});
