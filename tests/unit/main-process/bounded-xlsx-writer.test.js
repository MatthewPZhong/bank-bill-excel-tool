'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { withBoundedWorkbook, waitForStream, MAX_QUEUE_BYTES, MAX_ROW_BYTES } = require('../../../src/main-process/bounded-xlsx-writer');

test('drain 等待可取消；错误和提前 close 均结束等待并释放监听器', async () => {
  for (const mode of ['cancel', 'error', 'close']) {
    const stream = new PassThrough({ highWaterMark: 1 }); stream.on('error', () => {});
    stream.write(Buffer.alloc(100)); const controller = new AbortController();
    const waiting = waitForStream(stream, 'drain', { signal: controller.signal });
    if (mode === 'cancel') controller.abort(Object.assign(new Error('cancel'), { code: 'CANCEL_TEST' }));
    else stream.destroy(mode === 'error' ? Object.assign(new Error('disk failed'), { code: 'ENOSPC' }) : undefined);
    await assert.rejects(waiting, { code: { cancel: 'CANCEL_TEST', error: 'ENOSPC', close: 'XLSX_STREAM_CLOSED' }[mode] });
    assert.equal(stream.listenerCount('drain'), 0); stream.destroy();
  }
});

test('慢输出保持队列有界；输出错误和提前关闭不会卡在 Workbook commit', { timeout: 10000 }, async () => {
  let output;
  const result = await withBoundedWorkbook({ filePath: 'unused', createOutput() {
    output = new Writable({ highWaterMark: 1024, write(_chunk, _encoding, callback) { setImmediate(callback); } }); return output;
  } }, async (session) => {
    const sheet = session.addWorksheet('流式');
    for (let n = 0; n < 12000; n += 1) { sheet.addRow([String(n), '数据'.repeat(200)]); await session.commitRow(sheet.lastRow); }
    await session.commitSheet(sheet); return { finished: true };
  });
  assert.equal(result.finished, true); assert.equal(output.closed, true);
  assert.ok(result.peakBufferedBytes < MAX_QUEUE_BYTES + MAX_ROW_BYTES);
  for (const error of [undefined, Object.assign(new Error('disk full'), { code: 'ENOSPC' })]) {
    await assert.rejects(withBoundedWorkbook({ filePath: 'unused', createOutput() {
      return new Writable({ write(_chunk, _encoding, callback) { this.destroy(error); callback(); } });
    } }, async (session) => {
      const sheet = session.addWorksheet('拒绝'); sheet.addRow(['data']); await session.commitRow(sheet.lastRow); await session.commitSheet(sheet);
    }), { code: error?.code || 'XLSX_STREAM_CLOSED' });
  }
});
