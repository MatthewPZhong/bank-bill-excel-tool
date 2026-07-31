'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const {
  EXCEL_CELL_TEXT_MAX_UTF16_UNITS,
  assertExcelCellTextLength
} = require('../toolbox-format/excel-text');
const {
  loadToolboxSharedStrings
} = require('../toolbox-format/xlsx-pass');
const {
  POSITION_SST_LRU_MAX_ENTRIES,
  POSITION_SST_MEMORY_BUDGET_BYTES
} = require('./constants');

const INDEX_RECORD_BYTES = 12;
const LENGTH_PREFIX_BYTES = 4;
const MAX_SST_PAYLOAD_BYTES = EXCEL_CELL_TEXT_MAX_UTF16_UNITS * 4;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

class PositionSharedStringsError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'PositionSharedStringsError';
    this.code = 'position-import-parser-parity-unproven';
    this.detailLines = Array.isArray(detailLines) ? detailLines.slice() : [];
  }
}

class MemorySharedStringsProvider {
  constructor(values = []) {
    this.values = values;
    this.mode = 'memory';
    this.count = values.length;
    this.closed = false;
  }

  get(index) {
    if (this.closed) throw new PositionSharedStringsError('shared strings provider 已关闭');
    return Number.isSafeInteger(index) && index >= 0 ? this.values[index] : undefined;
  }

  async close() {
    this.closed = true;
    this.values.length = 0;
  }
}

class AdaptiveSharedStringsProvider {
  constructor({
    tempRoot,
    memoryBudgetBytes = POSITION_SST_MEMORY_BUDGET_BYTES,
    lruMaxEntries = POSITION_SST_LRU_MAX_ENTRIES,
    preserveOnClose = false
  } = {}) {
    const budget = Number(memoryBudgetBytes);
    const lruSize = Number(lruMaxEntries);
    if (!Number.isSafeInteger(budget) || budget < 1) {
      throw new TypeError('SST memory budget 必须是正安全整数');
    }
    if (!Number.isSafeInteger(lruSize) || lruSize < 1) {
      throw new TypeError('SST LRU 上限必须是正安全整数');
    }
    this.tempRoot = path.resolve(String(tempRoot || ''));
    this.memoryBudgetBytes = budget;
    this.lruMaxEntries = lruSize;
    this.preserveOnClose = preserveOnClose === true;
    this.mode = 'memory';
    this.count = 0;
    this.estimatedMemoryBytes = 0;
    this.values = [];
    this.binPath = '';
    this.idxPath = '';
    this.binFd = null;
    this.idxFd = null;
    this.binOffset = 0;
    this.cache = new Map();
    this.closed = false;
  }

  _assertOpen() {
    if (this.closed) throw new PositionSharedStringsError('shared strings provider 已关闭');
  }

  _openDiskMode() {
    if (this.mode === 'disk') return;
    if (!this.tempRoot) {
      throw new PositionSharedStringsError('SST 超过内存预算但未提供临时目录');
    }
    fs.mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 });
    this.binPath = path.join(this.tempRoot, 'sst.bin');
    this.idxPath = path.join(this.tempRoot, 'sst.idx');
    this.binFd = fs.openSync(this.binPath, 'w+', 0o600);
    this.idxFd = fs.openSync(this.idxPath, 'w+', 0o600);
    this.mode = 'disk';
    const buffered = this.values;
    this.values = [];
    this.count = 0;
    for (const value of buffered) this._appendDisk(value);
    this.estimatedMemoryBytes = 0;
  }

  _appendDisk(value) {
    const payload = Buffer.from(value, 'utf8');
    if (payload.length > MAX_SST_PAYLOAD_BYTES) {
      throw new PositionSharedStringsError('单个 shared string 超出索引长度上限');
    }
    if (!Number.isSafeInteger(this.binOffset + LENGTH_PREFIX_BYTES + payload.length)) {
      throw new PositionSharedStringsError('SST spill 文件偏移超出安全范围');
    }
    const prefix = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
    prefix.writeUInt32LE(payload.length, 0);
    const payloadOffset = this.binOffset + LENGTH_PREFIX_BYTES;
    this._writeExact(this.binFd, prefix, this.binOffset, 'sst.bin length prefix');
    if (payload.length > 0) {
      this._writeExact(this.binFd, payload, payloadOffset, 'sst.bin payload');
    }
    const index = Buffer.allocUnsafe(INDEX_RECORD_BYTES);
    index.writeBigUInt64LE(BigInt(payloadOffset), 0);
    index.writeUInt32LE(payload.length, 8);
    this._writeExact(
      this.idxFd,
      index,
      this.count * INDEX_RECORD_BYTES,
      'sst.idx'
    );
    this.binOffset = payloadOffset + payload.length;
    this.count += 1;
  }

  append(value) {
    this._assertOpen();
    const normalized = String(value == null ? '' : value);
    assertExcelCellTextLength(normalized);
    if (this.mode === 'disk') {
      this._appendDisk(normalized);
      return;
    }
    const estimate = Buffer.byteLength(normalized, 'utf8') + 16;
    if (this.estimatedMemoryBytes + estimate > this.memoryBudgetBytes) {
      this._openDiskMode();
      this._appendDisk(normalized);
      return;
    }
    this.values.push(normalized);
    this.estimatedMemoryBytes += estimate;
    this.count = this.values.length;
  }

  _remember(index, value) {
    if (this.cache.has(index)) this.cache.delete(index);
    this.cache.set(index, value);
    while (this.cache.size > this.lruMaxEntries) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  _writeExact(fd, buffer, position, label) {
    let offset = 0;
    while (offset < buffer.length) {
      const bytesWritten = fs.writeSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        position + offset
      );
      if (bytesWritten <= 0) {
        throw new PositionSharedStringsError(`${label} 写入不完整`);
      }
      offset += bytesWritten;
    }
  }

  _readExact(fd, buffer, position, label) {
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        position + offset
      );
      if (bytesRead <= 0) {
        throw new PositionSharedStringsError(`${label} 已截断`);
      }
      offset += bytesRead;
    }
  }

  get(index) {
    this._assertOpen();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) return undefined;
    if (this.mode === 'memory') return this.values[index];
    if (this.cache.has(index)) {
      const cached = this.cache.get(index);
      this._remember(index, cached);
      return cached;
    }

    const record = Buffer.allocUnsafe(INDEX_RECORD_BYTES);
    this._readExact(this.idxFd, record, index * INDEX_RECORD_BYTES, 'sst.idx');
    const offsetBig = record.readBigUInt64LE(0);
    const length = record.readUInt32LE(8);
    if (offsetBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PositionSharedStringsError('sst.idx offset 超出安全范围');
    }
    const offset = Number(offsetBig);
    if (offset < LENGTH_PREFIX_BYTES) {
      throw new PositionSharedStringsError('sst.idx offset 非法');
    }
    const prefix = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
    this._readExact(this.binFd, prefix, offset - LENGTH_PREFIX_BYTES, 'sst.bin length prefix');
    if (prefix.readUInt32LE(0) !== length) {
      throw new PositionSharedStringsError('sst.bin 与 sst.idx 长度不一致');
    }
    if (length > MAX_SST_PAYLOAD_BYTES) {
      throw new PositionSharedStringsError('sst.idx 文本长度超出 Excel 单元格上限');
    }
    const payload = Buffer.allocUnsafe(length);
    if (length > 0) this._readExact(this.binFd, payload, offset, 'sst.bin payload');
    let value;
    try {
      value = UTF8_DECODER.decode(payload);
      assertExcelCellTextLength(value);
    } catch (error) {
      throw new PositionSharedStringsError(
        'sst.bin 包含无效 UTF-8 或超长文本',
        [error && error.message ? error.message : String(error)]
      );
    }
    this._remember(index, value);
    return value;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.binFd !== null) {
      try { fs.closeSync(this.binFd); } catch (_error) {}
      this.binFd = null;
    }
    if (this.idxFd !== null) {
      try { fs.closeSync(this.idxFd); } catch (_error) {}
      this.idxFd = null;
    }
    this.values.length = 0;
    this.cache.clear();
    if (this.mode === 'disk' && !this.preserveOnClose && this.tempRoot) {
      await fs.promises.rm(this.tempRoot, { recursive: true, force: true });
    }
  }
}

async function loadSharedStringsProvider(zip, entry, options = {}) {
  if (!entry) return new MemorySharedStringsProvider();
  const provider = new AdaptiveSharedStringsProvider(options);
  const cancelToken = options.cancelToken && typeof options.cancelToken === 'object'
    ? options.cancelToken
    : null;

  try {
    await loadToolboxSharedStrings(zip, entry, options.sourceFile || '', {
      skipDeclaredSizeLimit: true,
      cancelToken,
      onValue(value) {
        provider.append(value);
      }
    });
    return provider;
  } catch (error) {
    await provider.close();
    throw error;
  }
}

module.exports = {
  INDEX_RECORD_BYTES,
  LENGTH_PREFIX_BYTES,
  PositionSharedStringsError,
  MemorySharedStringsProvider,
  AdaptiveSharedStringsProvider,
  loadSharedStringsProvider
};
