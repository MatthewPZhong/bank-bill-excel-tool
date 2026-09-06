'use strict';

const fs = require('node:fs');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { setImmediate: yieldMessages } = require('node:timers/promises');
const ExcelJS = require('exceljs');
const { encodeExcelStXstring } = require('../../backend/toolbox-format/excel-text');
const { WATERMARK_AUTHOR } = require('../workbook-watermark');
const { fail } = require('./contracts');

// ExcelJS 4.4 的 StreamBuf.write 无背压；保留其 OOXML/ZIP 实现，仅以 Node
// PassThrough 承接页流，调用方在每行后等待 drain。StringBuf 立即拷贝，不能缓存共享实例。
class SheetStream extends PassThrough {
  write(value, ...args) { return super.write(typeof value === 'string' || Buffer.isBuffer(value) ? value : value.toBuffer(), ...args); }
}
class BoundedWorkbookWriter extends ExcelJS.stream.xlsx.WorkbookWriter {
  _openStream(name) {
    const stream = new SheetStream({ highWaterMark: 65536 });
    this.zip.append(stream, { name });
    stream.once('finish', () => stream.emit('zipped'));
    return stream;
  }
}
async function writeExportWorkbook({ filePath, spool, expected, safePoint }) {
  if (require('exceljs/package.json').version !== '4.4.0') fail('BIZOP_WRITER_COMPATIBILITY_REQUIRED');
  const output = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
  const writer = new BoundedWorkbookWriter({ stream: output, useStyles: true, useSharedStrings: false });
  writer.lastModifiedBy = WATERMARK_AUTHOR;
  let streamError = null; let current = null; let peakBufferedBytes = 0;
  const failed = (error) => { streamError = streamError || error; current?.destroy(error); };
  output.on('error', failed); writer.zip.on('error', failed);
  try {
    await writer.promise;
    for (const page of expected.pages) {
      safePoint();
      const sheet = writer.addWorksheet(page.name);
      current = sheet.stream; current.on('error', (error) => { streamError = streamError || error; });
      const emit = async (values) => {
        safePoint(); if (streamError) throw streamError;
        const row = sheet.addRow(values.map((cell) => cell.t === 'null' ? null : cell.t === 'number' ? Number(cell.v)
          : cell.t === 'text' ? encodeExcelStXstring(cell.v) : cell.v));
        values.forEach((cell, index) => { if (cell.t !== 'null') row.getCell(index + 1).numFmt = cell.f; });
        row.commit();
        peakBufferedBytes = Math.max(peakBufferedBytes, current.writableLength + current.readableLength);
        if (current.writableNeedDrain) await once(current, 'drain');
      };
      await emit(page.headers.map((value) => ({ t: 'text', v: value, f: '@' })));
      let count = 0;
      for (const row of spool.rows(page)) {
        await emit(JSON.parse(row.cells));
        if (++count % 256 === 0) await yieldMessages();
      }
      if (count !== page.rowCount) fail('BIZOP_OUTPUT_ROW_COUNT');
      const completed = once(current, 'finish'); sheet.commit(); await completed;
    }
    await writer.commit();
    if (!output.closed) await once(output, 'close');
    if (streamError) throw streamError;
    return { peakBufferedBytes };
  } catch (error) {
    // 候选保留到 Main 按归属清理；先结束 ZIP 和实际输出句柄，不能一边写一边删。
    current?.destroy(); writer.zip.abort(); output.destroy();
    if (!output.closed) await new Promise((resolve) => output.once('close', resolve));
    throw error;
  }
}
module.exports = { writeExportWorkbook };
