'use strict';

const { PassThrough } = require('node:stream');

// ExcelJS 4.4 的默认 StreamBuf 不等待下游 callback。只替换本 writer 的 worksheet
// stream，保持 OOXML 生成与 ZIP 完全不变；调用方每行等待 drain 才能取得有界保证。
function installBoundedWorkbookStreams(writer, { maxInFlightBytes, maxSingleRecordBytes, highWaterMark = 64 * 1024 }) {
  if (![maxInFlightBytes, maxSingleRecordBytes, highWaterMark].every((value) => Number.isSafeInteger(value) && value > 0) ||
      maxSingleRecordBytes > maxInFlightBytes || typeof writer?._openStream !== 'function') {
    throw new TypeError('输出流预算或 ExcelJS 写入接口无效');
  }
  const pending = new Set();
  const streams = new Set();
  let pendingBytes = 0;
  let peakPendingBytes = 0;
  let failed = null;
  let signalFailure;
  const failure = new Promise((resolve) => { signalFailure = resolve; });
  const fail = (error) => { if (!failed) { failed = error; signalFailure(); } };
  writer.stream.on('error', fail);
  writer.zip.on('error', fail);
  writer._openStream = function openBoundedStream(entryPath) {
    const stream = new PassThrough({ highWaterMark });
    streams.add(stream);
    stream.on('error', fail);
    stream.once('finish', () => stream.emit('zipped'));
    stream.once('close', () => {
      streams.delete(stream);
      if (!stream.writableFinished || !stream.readableEnded) {
        fail(Object.assign(new Error('输出工作表流提前关闭'), { code: 'XLSX_STREAM_CLOSED' }));
      }
    });
    writer.zip.append(stream, { name: entryPath });
    const write = stream.write.bind(stream);
    stream.write = (value, encoding, callback) => {
      if (failed) throw failed;
      const chunk = typeof value === 'string' || Buffer.isBuffer(value) ? value : value.toBuffer();
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk.length;
      if (bytes > maxSingleRecordBytes || bytes > maxInFlightBytes - pendingBytes) {
        throw Object.assign(new Error('输出单条记录或未写入数据超过获批预算'), { code: 'EXECUTION_OUTPUT_BUFFER_LIMIT' });
      }
      pendingBytes += bytes;
      peakPendingBytes = Math.max(peakPendingBytes, pendingBytes);
      let done;
      const completion = new Promise((resolve) => { done = resolve; });
      pending.add(completion);
      return write(chunk, typeof encoding === 'string' ? encoding : undefined, (error) => {
        pendingBytes -= bytes;
        pending.delete(completion);
        if (error) fail(error);
        done();
        const cb = typeof encoding === 'function' ? encoding : callback;
        if (typeof cb === 'function') cb(error);
      });
    };
    return stream;
  };
  return Object.freeze({
    async drain() {
      if (failed) throw failed;
      await Promise.race([Promise.all([...pending]), failure]);
      if (failed) throw failed;
    },
    snapshot() { return { pendingBytes, peakPendingBytes, streamCount: streams.size }; },
    abort(error) {
      for (const stream of streams) stream.destroy(error);
    }
  });
}

module.exports = { installBoundedWorkbookStreams };
