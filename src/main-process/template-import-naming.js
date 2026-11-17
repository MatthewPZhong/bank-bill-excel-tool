'use strict';

// v3.2.18【导入模板】命名：选中的文件识别为新模板后，由用户输入「银行渠道名」「地区」，模板名 = 渠道名-地区。
// spec：changes/v3.2.18/feat/template-import-naming/spec.md。本模块不读写数据库与文件，供 main.js 与测试共用。
const crypto = require('node:crypto');

const NAME_PART_PATTERN = /^[A-Za-z0-9 ]+$/;
const PENDING_IMPORT_TTL_MS = 30 * 60 * 1000;

function normalizeNamePart(value) {
  return String(value === null || value === undefined ? '' : value).trim().replace(/\s+/g, ' ');
}

// D1：只允许英文字母、数字和空格（首尾去空、连续空格并为一个），不能为空；保存时转大写。
// 名称按「-」切出银行段与开户地，因此两段内都不能含「-」（由字符集保证）。
function normalizeTemplateImportName({ bankName, region } = {}) {
  const fields = [
    { key: 'bankName', label: '银行渠道名', value: normalizeNamePart(bankName) },
    { key: 'region', label: '地区', value: normalizeNamePart(region) }
  ];
  const empty = fields.filter((field) => !field.value).map((field) => field.label);
  if (empty.length) {
    return { ok: false, errorCode: 'TEMPLATE_IMPORT_NAME_INVALID', message: `请填写${empty.join('和')}` };
  }
  const invalid = fields.filter((field) => !NAME_PART_PATTERN.test(field.value)).map((field) => field.label);
  if (invalid.length) {
    return {
      ok: false,
      errorCode: 'TEMPLATE_IMPORT_NAME_INVALID',
      message: `${invalid.join('、')}只能输入英文字母、数字和空格`
    };
  }
  const normalizedBankName = fields[0].value.toUpperCase();
  const normalizedRegion = fields[1].value.toUpperCase();
  return {
    ok: true,
    bankName: normalizedBankName,
    region: normalizedRegion,
    templateName: `${normalizedBankName}-${normalizedRegion}`
  };
}

function nameKey(value) {
  return String(value || '').normalize('NFC').trim().toLowerCase();
}

// D2：与已有模板（含渠道内子模板）或渠道重名时拒绝，忽略大小写——种子文件等按名称落盘，
// Windows / macOS 默认文件系统不区分大小写。
function findTemplateImportNameConflict({ templateName, templates = [], channels = [] } = {}) {
  const key = nameKey(templateName);
  const template = templates.find((item) => nameKey(item && item.name) === key);
  if (template) {
    return {
      errorCode: 'TEMPLATE_NAME_DUPLICATED',
      message: `已有同名模板「${template.name}」，请修改银行渠道名或地区。如是该模板所在渠道的另一种格式，请在模板管理的渠道行点【导入子模板】`
    };
  }
  const channel = channels.find((item) => nameKey(item && item.name) === key);
  if (channel) {
    return {
      errorCode: 'TEMPLATE_NAME_CHANNEL_CONFLICT',
      message: `已有同名渠道「${channel.name}」，普通模板与渠道同名会使两者的输出名称相同。如是该渠道的另一种格式，请在渠道行点【导入子模板】，否则请修改银行渠道名或地区`
    };
  }
  return null;
}

// 预检选中的文件登记在 Main，渲染层只拿到 token，确认时不回传路径。每个窗口只保留最新一次预检，超时作废。
function createPendingTemplateImportStore({ now = () => Date.now(), createToken = () => crypto.randomUUID(), ttlMs = PENDING_IMPORT_TTL_MS } = {}) {
  const pending = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [token, entry] of pending) {
      if (entry.createdAt < cutoff) pending.delete(token);
    }
  }

  function register({ ownerId, filePath, sourceFileName, headers }) {
    prune();
    for (const [token, entry] of pending) {
      if (entry.ownerId === ownerId) pending.delete(token);
    }
    const importToken = createToken();
    pending.set(importToken, {
      ownerId,
      filePath,
      sourceFileName,
      headers: Array.isArray(headers) ? headers.slice() : [],
      createdAt: now()
    });
    return importToken;
  }

  function peek(importToken, ownerId) {
    prune();
    const entry = pending.get(String(importToken || ''));
    if (!entry || entry.ownerId !== ownerId) return null;
    return { ...entry, headers: entry.headers.slice() };
  }

  function consume(importToken, ownerId) {
    const entry = peek(importToken, ownerId);
    if (entry) pending.delete(String(importToken || ''));
    return entry;
  }

  function discard(importToken, ownerId) {
    const key = String(importToken || '');
    const entry = pending.get(key);
    if (entry && entry.ownerId === ownerId) pending.delete(key);
  }

  return { register, peek, consume, discard, size: () => pending.size };
}

module.exports = {
  createPendingTemplateImportStore,
  findTemplateImportNameConflict,
  normalizeTemplateImportName
};
