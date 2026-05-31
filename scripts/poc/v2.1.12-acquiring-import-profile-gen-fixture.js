// v2.1.12-beta POC（收单导入 profile）—— 大 flow xlsx fixture 生成器
//
// 目的：生成与真实收单流水表结构一致的大体量 xlsx（48 列），供 profile 脚本实测三段耗时。
// 不依赖 prod 代码路径；用 yazl 流式写 zip（内存友好，可生百万行）。
//
// 格式选型：所有 cell 用 t="inlineStr"（与 src/backend/pending-import/streaming-xlsx-writer.js 一致）
//   reader 的 sax 解析支持 inlineStr 分支（reader.js:208），解析路径与 sharedStrings 在
//   「每行组 cells」这步成本相当（POC 关注的是行数×列数的固有成本，不是压缩格式细节）。
//
// 列内容尽量真实：
//   - 账单日期(0)：2026-03-DD（同月，让 monthKey 一致 / 通过 extractMonthKey）
//   - 对账主Id(6)：唯一（满足 DDL 的 UNIQUE(month_key, recon_main_id)）
//   - 通道清算金额(28)：带小数的数字串
//   - 通道清算币种(29)：USD/EUR/CNY/JPY/GBP 轮转（混币种全量）
//   - 其余列：代表性字符串，让 raw_json 体积接近真实
//
// 用法：
//   node scripts/poc/v2.1.12-acquiring-import-profile-gen-fixture.js <rows> [outPath]
//   默认 500000 行 → tmp/poc-acquiring-flow-<rows>.xlsx

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yazl = require('yazl');

// 复制自 src/backend/acquiring-bill-currency-db/columns.js FLOW_HEADERS（POC 不 import prod，原样 replicate）
const FLOW_HEADERS = [
  '账单日期', 'originBizId', '主体大账号', '公司主体', '流水类型', '业务部门',
  '对账主Id', '出入方向', '流水单号', '用户编号', '账户编号', '拆分类型',
  '对账金额', '币种', '账户类型', '流水开始时间', '流水完成时间', '渠道',
  'MerchantId', 'valueDate', 'BankRef', 'Pending标识', '流水BizId', '穿透ID',
  '操作人', '系统创建时间', '系统修改时间', 'MID', '通道清算金额', '通道清算币种',
  '交易订单号', '关联渠道', '关联MID', '关联通道清算币种', '关联通道清算金额', '抵扣资金方向',
  '抵扣手续费合计', '抵扣金额', '抵扣本金', '本金-循环保证金', '交易手续费', '退款手续费',
  '拒付手续费', '提现手续费', '一次性费用', '其他手续费', '常规入账资金', '客资账户余额'
];

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const CURRENCIES = ['USD', 'EUR', 'CNY', 'JPY', 'GBP'];

function xmlEscape(s) {
  if (s == null) return '';
  const str = String(s);
  if (str.indexOf('&') < 0 && str.indexOf('<') < 0 && str.indexOf('>') < 0) return str;
  return str.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function columnLetter(n) {
  let s = '';
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function buildRowXml(rowIdx, cells) {
  let s = `<row r="${rowIdx}">`;
  for (let c = 0; c < cells.length; c++) {
    const ref = columnLetter(c + 1) + rowIdx;
    const value = cells[c];
    if (value === '' || value == null) {
      s += `<c r="${ref}" t="inlineStr"><is><t/></is></c>`;
    } else {
      s += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }
  }
  s += '</row>';
  return s;
}

// 第 i 行（数据行，1-based 数据序号）的 48 列值。内容仿真。
function buildDataRow(i) {
  const day = String((i % 28) + 1).padStart(2, '0');
  const cells = new Array(FLOW_HEADERS.length);
  cells[0] = `2026-03-${day}`;                       // 账单日期
  cells[1] = `OBZ${1000000000 + i}`;                 // originBizId
  cells[2] = `ACC${100000 + (i % 5000)}`;            // 主体大账号
  cells[3] = `公司主体${(i % 30)}`;                   // 公司主体
  cells[4] = (i % 3 === 0) ? '支付' : (i % 3 === 1 ? '退款' : '提现'); // 流水类型
  cells[5] = `业务部门${(i % 12)}`;                   // 业务部门
  cells[6] = `RMID${20260300000000 + i}`;            // 对账主Id（唯一）
  cells[7] = (i % 2 === 0) ? '收入' : '支出';         // 出入方向
  cells[8] = `FLOW${9000000000 + i}`;                // 流水单号
  cells[9] = `U${500000 + (i % 80000)}`;             // 用户编号
  cells[10] = `A${700000 + (i % 60000)}`;            // 账户编号
  cells[11] = (i % 4 === 0) ? '本金' : '手续费';      // 拆分类型
  const amt = ((i % 100000) + 1) / 100;              // 0.01 ~ 1000.00
  cells[12] = amt.toFixed(2);                        // 对账金额
  cells[13] = CURRENCIES[i % CURRENCIES.length];     // 币种
  cells[14] = (i % 2 === 0) ? '内部户' : '外部户';    // 账户类型
  cells[15] = `2026-03-${day} 08:${String(i % 60).padStart(2, '0')}:00`; // 流水开始时间
  cells[16] = `2026-03-${day} 08:${String((i + 5) % 60).padStart(2, '0')}:00`; // 流水完成时间
  cells[17] = `渠道${(i % 20)}`;                      // 渠道
  cells[18] = `NET${String(i % 999).padStart(3, '0')}`; // MerchantId
  cells[19] = `2026-03-${day}`;                      // valueDate
  cells[20] = `BANKREF${800000000 + i}`;             // BankRef
  cells[21] = (i % 7 === 0) ? 'Y' : 'N';             // Pending标识
  cells[22] = `FBZ${600000000 + i}`;                 // 流水BizId
  cells[23] = `PEN${400000000 + i}`;                 // 穿透ID
  cells[24] = `op${(i % 50)}`;                        // 操作人
  cells[25] = `2026-03-${day} 09:00:00`;             // 系统创建时间
  cells[26] = `2026-03-${day} 09:05:00`;             // 系统修改时间
  cells[27] = `MID${300000 + (i % 4000)}`;           // MID
  cells[28] = amt.toFixed(2);                        // 通道清算金额（关键列）
  cells[29] = CURRENCIES[i % CURRENCIES.length];     // 通道清算币种（关键列）
  cells[30] = `ORD${200000000 + i}`;                 // 交易订单号
  cells[31] = `关联渠道${(i % 10)}`;                  // 关联渠道
  cells[32] = `RMID${100000 + (i % 4000)}`;          // 关联MID
  cells[33] = CURRENCIES[(i + 1) % CURRENCIES.length]; // 关联通道清算币种
  cells[34] = (amt * 0.99).toFixed(2);               // 关联通道清算金额
  cells[35] = (i % 2 === 0) ? '收' : '付';            // 抵扣资金方向
  cells[36] = (amt * 0.01).toFixed(4);               // 抵扣手续费合计
  cells[37] = (amt * 0.5).toFixed(2);                // 抵扣金额
  cells[38] = (amt * 0.49).toFixed(2);               // 抵扣本金
  cells[39] = (amt * 0.1).toFixed(2);                // 本金-循环保证金
  cells[40] = (amt * 0.006).toFixed(4);              // 交易手续费
  cells[41] = '0.0000';                              // 退款手续费
  cells[42] = '0.0000';                              // 拒付手续费
  cells[43] = '0.0000';                              // 提现手续费
  cells[44] = '0.0000';                              // 一次性费用
  cells[45] = '0.0000';                              // 其他手续费
  cells[46] = (amt * 0.98).toFixed(2);               // 常规入账资金
  cells[47] = (10000 + (i % 50000)).toFixed(2);      // 客资账户余额
  return cells;
}

async function genFixture(rows, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const zipfile = new yazl.ZipFile();

  // 静态 part
  zipfile.addBuffer(Buffer.from(`${XML_HEAD}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`), '[Content_Types].xml');

  zipfile.addBuffer(Buffer.from(`${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`), '_rels/.rels');

  zipfile.addBuffer(Buffer.from(`${XML_HEAD}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`), 'xl/workbook.xml');

  zipfile.addBuffer(Buffer.from(`${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`), 'xl/_rels/workbook.xml.rels');

  // sheet1.xml 用 Readable 流式喂入（_read pull 模式 — 避免 push 早于 yazl 消费导致内容丢失）
  const { Readable } = require('node:stream');
  let rowIdx = 0;       // 0 = 还没发表头；1 = 已发表头；之后为数据行序号 +1
  let dataDone = false;
  const sheetStream = new Readable({
    read() {
      // 被消费方拉取时才产数据，天然 back-pressure 安全
      if (rowIdx === 0) {
        rowIdx = 1;
        this.push(`${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`);
        this.push(buildRowXml(1, FLOW_HEADERS)); // 表头行 r=1
        return;
      }
      if (dataDone) {
        this.push(null);
        return;
      }
      // 每次 _read 产 1000 行
      let buf = '';
      const end = Math.min(rowIdx - 1 + 1000, rows);
      for (let i = rowIdx; i <= end; i++) {
        buf += buildRowXml(i + 1, buildDataRow(i)); // 数据行从 r=2 起
      }
      rowIdx = end + 1;
      if (end % 50000 === 0 || end === rows) {
        process.stdout.write(`\r  生成进度：${end}/${rows} 行`);
      }
      if (rowIdx > rows) {
        buf += '</sheetData></worksheet>';
        dataDone = true;
      }
      this.push(buf);
    }
  });
  zipfile.addReadStream(sheetStream, 'xl/worksheets/sheet1.xml');

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    zipfile.outputStream.pipe(out);
    out.on('finish', () => { process.stdout.write('\n'); resolve(); });
    out.on('error', reject);
    zipfile.end();
  });

  const stat = fs.statSync(outPath);
  return { outPath, rows, bytes: stat.size };
}

async function main() {
  const rows = parseInt(process.argv[2], 10) || 500000;
  const outPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.resolve(__dirname, '..', '..', 'tmp', `poc-acquiring-flow-${rows}.xlsx`);

  console.log(`[gen-fixture] 生成收单流水 fixture：${rows} 行 × ${FLOW_HEADERS.length} 列`);
  const t0 = Date.now();
  const r = await genFixture(rows, outPath);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[gen-fixture] 完成：${r.outPath}`);
  console.log(`[gen-fixture] 行数=${r.rows}  体积=${(r.bytes / 1024 / 1024).toFixed(1)} MB  耗时=${sec}s`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { genFixture, buildDataRow, FLOW_HEADERS };
