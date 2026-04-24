// 自研流式 xlsx 写入器（和 streaming-xlsx-reader 对称）
// 解决 `XLSX.writeFile` 对 121 万行 × 31 列内存峰值 2-3GB，同步阻塞 UI thread 的问题
//
// 产物结构：最简 xlsx zip
//   [Content_Types].xml
//   _rels/.rels
//   xl/workbook.xml
//   xl/_rels/workbook.xml.rels
//   xl/worksheets/sheet1.xml   ← 大头，Node.js Readable 流式 push
//
// 所有 cell 用 inline-string（`t="inlineStr"`），省去 sharedStrings 二次处理
// 约束：
// - 字段值按字符串原样存储（调用者已预处理为 string）
// - 空值存 `<c r="..." t="inlineStr"><is><t/></is></c>`（兼容 xlsx / ExcelJS 读回）
// - XML 特殊字符 &<> 已转义；控制字符（\0 - \x08 等）xlsx 规范不允许，不做转义（实际数据应无）

const fs = require('node:fs');
const { Readable } = require('node:stream');
const JSZip = require('jszip');

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const CONTENT_TYPES_XML = `${XML_HEAD}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS_XML = `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_XML = `${XML_HEAD}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS_XML = `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

function xmlEscape(s) {
  if (s == null) return '';
  const str = String(s);
  if (str.indexOf('&') < 0 && str.indexOf('<') < 0 && str.indexOf('>') < 0) return str;
  return str.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// 1-based column index → letters: 1→A, 26→Z, 27→AA
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

// rowsIterable: 同步 / 异步可迭代对象，每项为 string[]（单行 cells，长度 = headers.length）
// headers: string[]
// 返回 Promise，resolve 时 xlsx 已写完
async function writeStreamedXlsx(filePath, headers, rowsIterable) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
  zip.file('_rels/.rels', ROOT_RELS_XML);
  zip.file('xl/workbook.xml', WORKBOOK_XML);
  zip.file('xl/_rels/workbook.xml.rels', WORKBOOK_RELS_XML);

  // sheet1.xml 作 Node.js Readable 流喂给 JSZip
  const sheetStream = new Readable({ read() { /* manual push */ } });

  (async () => {
    try {
      sheetStream.push(`${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`);
      sheetStream.push(buildRowXml(1, headers));
      let rowIdx = 1;
      let batchBuf = '';
      for await (const row of rowsIterable) {
        rowIdx += 1;
        batchBuf += buildRowXml(rowIdx, row);
        // 每 1000 行 flush 一次；防止单次 push 字符串过大
        if (rowIdx % 1000 === 0) {
          sheetStream.push(batchBuf);
          batchBuf = '';
          // 让出 event loop，防 back-pressure 堆积
          await new Promise((r) => setImmediate(r));
        }
      }
      if (batchBuf.length > 0) sheetStream.push(batchBuf);
      sheetStream.push('</sheetData></worksheet>');
      sheetStream.push(null); // end
    } catch (err) {
      sheetStream.destroy(err);
    }
  })();

  // JSZip 接 Readable 作为 file 内容
  zip.file('xl/worksheets/sheet1.xml', sheetStream);

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    zip.generateNodeStream({
      type: 'nodebuffer',
      streamFiles: true,
      compression: 'DEFLATE',
      compressionOptions: { level: 4 } // 中等压缩平衡速度 / 体积
    })
      .pipe(out);
    out.on('finish', () => resolve(filePath));
    out.on('error', reject);
  });
}

module.exports = {
  writeStreamedXlsx,
  // 暴露内部测试用
  __internal: { buildRowXml, columnLetter, xmlEscape }
};
