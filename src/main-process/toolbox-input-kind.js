'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FileValidationError } = require('../backend/file-service/common');
const { ensureSupportedFile } = require('../backend/file-service/readers');

const OLE_CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGICS = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08])
];

function startsWith(buffer, prefix) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= prefix.length
    && buffer.subarray(0, prefix.length).equals(prefix);
}

function readToolboxFileMagic(filePath, fsImpl = fs) {
  const buffer = Buffer.alloc(8);
  const fd = fsImpl.openSync(filePath, 'r');
  try {
    const bytesRead = fsImpl.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * 工具箱所有入口的唯一文件类型判定。
 *
 * 文件内容 magic 优先于扩展名：扩展名写成 .xls 的 OOXML 仍走 XLSX，
 * 扩展名写成 .xlsx 的 OLE/CFB 仍走 BIFF8。只有 CSV 没有稳定 magic，
 * 因此仅 CSV 使用扩展名作为契约。
 */
function detectToolboxInputKind(filePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  ensureSupportedFile(filePath);
  if (!filePath || !fsImpl.existsSync(filePath)) {
    throw new FileValidationError('FILE_READ', '源文件不存在或已被移动，请重新导入');
  }
  const stat = fsImpl.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  const magic = readToolboxFileMagic(filePath, fsImpl);
  if (ZIP_MAGICS.some((candidate) => startsWith(magic, candidate))) return 'xlsx';
  if (startsWith(magic, OLE_CFB_MAGIC)) return 'xls';

  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.csv') return 'csv';

  const asciiHead = magic.toString('ascii').trimStart().toLowerCase();
  if (asciiHead.startsWith('<?xml') || asciiHead.startsWith('<workboo')) {
    throw new FileValidationError(
      'TOOLBOX_UNSUPPORTED_SPREADSHEET_XML',
      '该文件不是标准 Excel 工作簿，请另存为 .xlsx 或 Excel 97–2003 .xls 后重试'
    );
  }
  throw new FileValidationError(
    'FILE_READ',
    '文件内容与扩展名不一致或文件已损坏，请重新导入'
  );
}

module.exports = {
  OLE_CFB_MAGIC,
  ZIP_MAGICS,
  detectToolboxInputKind,
  readToolboxFileMagic
};
