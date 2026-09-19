'use strict';

const fs = require('node:fs');
const { PassThrough } = require('node:stream');
const { setImmediate: yieldMessages, setTimeout: delay } = require('node:timers/promises');
const ExcelJS = require('exceljs');
const { WATERMARK_AUTHOR } = require('./workbook-watermark');

const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_ROW_BYTES = 16 * 1024 * 1024;
function writerError(code, message) { return Object.assign(new Error(message), { code }); }
function abortError(signal) { return signal?.reason instanceof Error ? signal.reason : writerError('ABORT_ERR', '导出已取消'); }
function throwIfAborted(signal) { if (signal?.aborted) throw abortError(signal); }

// ExcelJS 4.4.0 StreamBuf has no backpressure. Preserve its ZIP protocol while
// copying the reusable StringBuf into a standard Node stream immediately.
class SheetStream extends PassThrough {
  write(value, ...args) { return super.write(typeof value === 'string' || Buffer.isBuffer(value) ? value : value.toBuffer(), ...args); }
}
class BoundedWorkbookWriter extends ExcelJS.stream.xlsx.WorkbookWriter {
  _openStream(name) {
    const stream = new SheetStream({ highWaterMark: 65536 });
    this._boundedStreams ||= new Set();
    this._boundedStreams.add(stream);
    stream.on('error', (error) => { this._boundedError ||= error; this._streamErrorHandler?.(error); });
    stream.once('close', () => {
      if (!stream.writableFinished || !stream.readableEnded) {
        const error = writerError('XLSX_STREAM_CLOSED', '工作表流未完成即关闭');
        this._boundedError ||= error; this._streamErrorHandler?.(error);
      }
    });
    stream.once('end', () => this._boundedStreams.delete(stream));
    this.zip.append(stream, { name });
    stream.once('finish', () => stream.emit('zipped'));
    return stream;
  }
}

function waitForStream(stream, event, { signal } = {}) {
  const doneAlready = () => event === 'drain' ? !stream.writableNeedDrain
    : event === 'finish' ? stream.writableFinished : event === 'close' ? stream.closed : false;
  return new Promise((resolve, reject) => {
    const clean = () => {
      stream.off(event, done); stream.off('error', failed); stream.off('close', closed);
      signal?.removeEventListener('abort', aborted);
    };
    const settle = (error) => { clean(); error ? reject(error) : resolve(); };
    const done = () => settle();
    const failed = (error) => settle(error);
    const closed = () => settle(event === 'close' || (event === 'finish' && stream.writableFinished) ? null
      : writerError('XLSX_STREAM_CLOSED', `XLSX 流在 ${event} 完成前关闭`));
    const aborted = () => settle(abortError(signal));
    stream.once(event, done); stream.once('error', failed); stream.once('close', closed);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    else if (stream.errored) failed(stream.errored);
    else if (stream.destroyed && event !== 'close') closed();
    else if (doneAlready()) done();
  });
}
function awaitAbortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortError(signal));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
function bufferedBytes(writer, output) {
  const streams = new Set([...(writer._boundedStreams || []), writer.zip, writer.zip?._module?.engine, output]);
  let bytes = 0;
  for (const stream of streams) {
    if (!stream) continue;
    bytes += Number(stream.readableLength ?? stream._readableState?.length) || 0;
    bytes += Number(stream.writableLength ?? stream._writableState?.length) || 0;
  }
  return bytes;
}

async function withBoundedWorkbook({ filePath, signal, safePoint = () => {}, compatibilityError,
  createOutput = (name) => fs.createWriteStream(name, { flags: 'wx', mode: 0o600 }) }, callback) {
  if (require('exceljs/package.json').version !== '4.4.0') {
    throw compatibilityError?.() || writerError('XLSX_WRITER_COMPATIBILITY_REQUIRED', 'ExcelJS 版本变化，需要重新验证流式 Writer');
  }
  throwIfAborted(signal); safePoint();
  const output = createOutput(filePath);
  let writer, streamError, rowCount = 0;
  let rejectStreamFailure;
  const streamFailure = new Promise((_resolve, reject) => { rejectStreamFailure = reject; });
  streamFailure.catch(() => {});
  const metrics = { peakBufferedBytes: 0, drainWaits: 0, rowCount: 0 };
  const failed = (error) => {
    if (streamError) return;
    streamError ||= error;
    rejectStreamFailure(error);
    for (const stream of writer?._boundedStreams || []) if (!stream.destroyed) stream.destroy(error);
  };
  output.on('error', failed);
  output.once('close', () => {
    if (!output.writableFinished) failed(writerError('XLSX_STREAM_CLOSED', '输出文件在写入完成前关闭'));
  });
  const wait = (promise) => awaitAbortable(Promise.race([promise, streamFailure]), signal);
  const check = () => { throwIfAborted(signal); safePoint(); if (streamError || writer?._boundedError) throw streamError || writer._boundedError; };
  const observe = () => { const bytes = bufferedBytes(writer, output); metrics.peakBufferedBytes = Math.max(metrics.peakBufferedBytes, bytes); return bytes; };
  try {
    writer = new BoundedWorkbookWriter({ stream: output, useStyles: true, useSharedStrings: false });
    writer.lastModifiedBy = WATERMARK_AUTHOR;
    writer._streamErrorHandler = failed;
    writer.zip.on('error', failed);
    await wait(writer.promise);
    const session = {
      writer, metrics, check,
      addWorksheet(name, options) {
        check(); const sheet = writer.addWorksheet(name, options);
        return sheet;
      },
      async commitRow(row) {
        check();
        // Conservative encoded XML bound, including cells and entity expansion.
        const encoded = JSON.stringify(row.values).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
        const rowBytes = Buffer.byteLength(encoded, 'utf8') + row.values.length * 256;
        if (rowBytes > MAX_ROW_BYTES) throw writerError('XLSX_ROW_RESOURCE_LIMIT', '单行超过 16 MiB 写入预算');
        const stream = row.worksheet.stream;
        if (stream.destroyed) throw writerError('XLSX_STREAM_CLOSED', '工作表流已关闭');
        row.commit(); metrics.rowCount += 1; observe();
        if (stream.writableNeedDrain) { metrics.drainWaits += 1; await wait(waitForStream(stream, 'drain', { signal })); }
        while (observe() > MAX_QUEUE_BYTES) { check(); await wait(delay(10, undefined, { signal })); }
        if (++rowCount % 256 === 0) await yieldMessages();
        check();
      },
      async commitSheet(sheet) {
        check();
        const completed = waitForStream(sheet.stream, 'finish', { signal });
        sheet.commit(); await wait(completed); check();
      }
    };
    const result = await callback(session);
    check(); await wait(writer.commit());
    await waitForStream(output, 'close', { signal }); check();
    return { ...result, ...metrics };
  } catch (error) {
    for (const stream of writer?._boundedStreams || []) stream.destroy();
    writer?.zip.abort(); output.destroy();
    if (!output.closed) await waitForStream(output, 'close').catch(() => undefined);
    throw error;
  }
}

module.exports = { withBoundedWorkbook, waitForStream, awaitAbortable, bufferedBytes, MAX_QUEUE_BYTES, MAX_ROW_BYTES };
