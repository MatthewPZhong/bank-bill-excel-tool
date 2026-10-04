'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { installBoundedWorkbookStreams } = require('../../../src/main-process/bounded-workbook-streams');
function fixture() {
  const callbacks = [];
  const sink = new Writable({ highWaterMark: 32, write(_chunk, _encoding, callback) { callbacks.push(callback); } });
  const zip = new EventEmitter(); zip.append = (source) => source.pipe(sink);
  const writer = { stream: new EventEmitter(), zip, _openStream() {} };
  const flow = installBoundedWorkbookStreams(writer, { maxInFlightBytes: 512, maxSingleRecordBytes: 256, highWaterMark: 32 });
  return { writer, flow, sink, callbacks };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('慢下游真实阻塞回调，逐行等待不会把所有 XML 累积在流里', async () => {
  const { writer, flow, sink, callbacks } = fixture(); const stream = writer._openStream('sheet.xml');
  stream.write(Buffer.alloc(128)); stream.write(Buffer.alloc(128));
  let drained = false; const pending = flow.drain().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); assert.equal(flow.snapshot().pendingBytes, 128);
  callbacks.shift()(); await tick(); await pending;
  assert.equal(flow.snapshot().pendingBytes, 0); assert.ok(flow.snapshot().peakPendingBytes <= 512);
  callbacks.shift()(); stream.end(); await tick(); sink.destroy();
});
test('输出错误和提前关闭使等待失败；过宽单行在进入 ZIP 前拒绝', async () => {
  for (const kind of ['error', 'close']) {
    const { writer, flow, sink } = fixture(); const stream = writer._openStream('sheet.xml');
    assert.throws(() => stream.write(Buffer.alloc(257)), { code: 'EXECUTION_OUTPUT_BUFFER_LIMIT' });
    stream.write(Buffer.alloc(128)); stream.write(Buffer.alloc(128));
    const wait = flow.drain();
    if (kind === 'error') writer.stream.emit('error', Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    else stream.destroy();
    await assert.rejects(wait, { code: kind === 'error' ? 'ENOSPC' : 'XLSX_STREAM_CLOSED' });
    flow.abort(); sink.destroy();
  }
});
