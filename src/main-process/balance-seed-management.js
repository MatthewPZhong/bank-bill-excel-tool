'use strict';

// v3.2.16 模板管理【余额管理】：按渠道 / 普通模板查看余额种子，修改余额或删除单条种子
//   （spec：changes/v3.2.16/feat/balance-seed-management/spec.md）。
//   - 种子文件按名称的银行段存放（balance-seeds/<银行段>.json），生成账单时按“账号 + 币种”在整个文件里查找，
//     与写入者无关。本模块只用记录上的 templateName 决定某个渠道 / 模板能看到、能改哪些记录，不改变生成时的读取口径。
//   - 只有写入者属于“另一个读同一种子文件的现有渠道 / 普通模板”时才隐藏：渠道可见渠道名与其子模板名写入的记录
//     （含迁移前子模板写的种子），普通模板可见自己写入的记录；写入者为空、已改名或删除、或其现在的归属读的是另一份
//     种子文件的记录，在同一银行段的所有选项下都可见，避免生成仍按账号读取、界面却看不到的种子。
//     “同一文件”按实际文件名判断（与 getBalanceSeedFilePath 同一规范化，再忽略大小写，Windows / macOS 默认不区分）。
//     渠道名、普通模板名是当前输出身份，优先认领；子模板名只认领迁移前的旧记录，与某个输出名重名时让给该输出名。
//   - 修改只改余额：生成方式改为「人工录入」，templateName 改为渠道 / 模板的输出名（与补录一致）。
//   - 修改、删除都先重新读文件，按渲染层带回的原值核对（乐观并发），不一致时不写文件，返回 conflict。

const path = require('node:path');
const { normalizeCell, parseNumericValue } = require('../backend/file-service');
const {
  BALANCE_SEED_GENERATION_METHODS,
  getBalanceSeedFilePath,
  readBalanceSeedRecords,
  splitTemplateName,
  writeBalanceSeedRecords
} = require('../backend/balance-seed-store');

const OWNER_KINDS = Object.freeze({ channel: 'channel', template: 'template' });
const CONFLICT_MESSAGE = '余额种子已变化，请刷新后重试';

class BalanceSeedManagementError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'BalanceSeedManagementError';
    this.code = code;
    this.context = context;
  }
}

function ownerLabel(owner) {
  return owner.kind === OWNER_KINDS.channel ? `渠道「${owner.outputName}」` : `模板「${owner.outputName}」`;
}

// 种子文件身份：与 getBalanceSeedFilePath 相同的文件名规范化，再按 NFC 与小写比较。
function seedFileIdentity(bankName) {
  return path.basename(getBalanceSeedFilePath('', bankName)).normalize('NFC').toLowerCase();
}

// 写入者名称 → 现有归属 { key, outputName }。渠道名、普通模板名先认领；子模板名只在未被认领时归所属渠道。
function buildWriterClaims(database, templates) {
  const claims = new Map();
  const claim = (name, key, outputName) => {
    const writer = normalizeCell(name);
    if (writer && !claims.has(writer)) claims.set(writer, { key, outputName: normalizeCell(outputName) });
  };
  (database.listStatementChannels() || []).forEach((channel) => {
    claim(channel.name, `channel:${Number(channel.id)}`, channel.name);
  });
  templates.filter((template) => !(Number(template.channelId) > 0)).forEach((template) => {
    claim(template.name, `template:${Number(template.id)}`, template.name);
  });
  templates.filter((template) => Number(template.channelId) > 0).forEach((template) => {
    claim(template.name, `channel:${Number(template.channelId)}`, template.channelName || template.name);
  });
  return claims;
}

function buildOwner(database, { kind, id, outputName, templates }) {
  const bankName = splitTemplateName(outputName).bankName;
  return {
    kind,
    id,
    key: `${kind}:${id}`,
    outputName,
    bankName,
    fileIdentity: seedFileIdentity(bankName),
    claims: buildWriterClaims(database, templates)
  };
}

// owner 只收 { kind, id }；名称、子模板一律从库里解析，不用渲染层传来的名称。
function resolveSeedOwner(database, owner) {
  const kind = normalizeCell(owner && owner.kind);
  const id = Number(owner && owner.id);
  if (!Object.values(OWNER_KINDS).includes(kind) || !Number.isSafeInteger(id) || id <= 0) {
    throw new BalanceSeedManagementError('BALANCE_SEED_OWNER_INVALID', '请选择渠道或模板', { owner });
  }

  if (kind === OWNER_KINDS.channel) {
    const channel = database.getStatementChannel(id);
    const outputName = normalizeCell(channel && channel.name);
    if (!outputName) {
      throw new BalanceSeedManagementError('BALANCE_SEED_OWNER_NOT_FOUND', '未找到对应渠道，请刷新后重试', { owner });
    }
    return buildOwner(database, { kind, id, outputName, templates: database.listTemplates() || [] });
  }

  const template = database.getTemplate(id);
  const outputName = normalizeCell(template && template.name);
  if (!outputName) {
    throw new BalanceSeedManagementError('BALANCE_SEED_OWNER_NOT_FOUND', '未找到对应模板，请刷新后重试', { owner });
  }
  if (Number(template.channelId) > 0) {
    throw new BalanceSeedManagementError(
      'BALANCE_SEED_OWNER_IN_CHANNEL',
      `模板「${outputName}」属于渠道「${normalizeCell(template.channelName)}」，请选择该渠道`,
      { owner }
    );
  }
  return buildOwner(database, { kind, id, outputName, templates: database.listTemplates() || [] });
}

function isVisibleToOwner(record, owner) {
  const claim = owner.claims.get(normalizeCell(record.templateName));
  if (!claim || claim.key === owner.key) return true;
  return seedFileIdentity(splitTemplateName(claim.outputName).bankName) !== owner.fileIdentity;
}

function describeOwner(owner, storageRoot) {
  return {
    kind: owner.kind,
    id: owner.id,
    name: owner.outputName,
    bankName: owner.bankName,
    seedFileName: path.basename(getBalanceSeedFilePath(storageRoot, owner.bankName))
  };
}

// fileIdentity：这条记录所在种子文件的身份，渲染层随原值带回，写入时核对（见 matchesExpected）。
function toPublicRecord(record, owner) {
  return {
    merchantId: record.merchantId,
    currency: record.currency,
    billDate: record.billDate,
    endBalance: record.endBalance,
    generationMethod: record.generationMethod,
    templateName: record.templateName,
    updatedAt: record.updatedAt,
    fileIdentity: owner.fileIdentity
  };
}

// 账户号、币种升序，同一账号的日期从新到旧。
function compareForDisplay(left, right) {
  return left.merchantId.localeCompare(right.merchantId)
    || left.currency.localeCompare(right.currency)
    || right.billDate.localeCompare(left.billDate);
}

function listOwnerSeeds({ database, storageRoot, owner }) {
  const resolved = resolveSeedOwner(database, owner);
  const records = readBalanceSeedRecords(storageRoot, resolved.bankName)
    .filter((record) => isVisibleToOwner(record, resolved))
    .sort(compareForDisplay)
    .map((record) => toPublicRecord(record, resolved));
  return { owner: describeOwner(resolved, storageRoot), records };
}

function normalizeKey(key) {
  return {
    merchantId: normalizeCell(key && key.merchantId),
    currency: normalizeCell(key && key.currency),
    billDate: normalizeCell(key && key.billDate)
  };
}

function sameKey(record, key) {
  return record.merchantId === key.merchantId
    && record.currency === key.currency
    && record.billDate === key.billDate;
}

// 渲染层带回列表里的原值；任一字段与文件当前值不同即视为期间已被生成、补录或另一次修改改过。
//   还须是同一份种子文件：列表读取后渠道 / 模板跨银行段改名时，当前解析出的文件已换成另一份，
//   即使另一份文件里恰有字段相同的记录（如旧格式记录），也不能改到它。
function matchesExpected(record, expected, owner) {
  if (!expected || typeof expected !== 'object') return false;
  return normalizeCell(expected.fileIdentity) === owner.fileIdentity
    && parseNumericValue(expected.endBalance) === record.endBalance
    && normalizeCell(expected.generationMethod) === record.generationMethod
    && normalizeCell(expected.templateName) === record.templateName
    && normalizeCell(expected.updatedAt) === record.updatedAt;
}

// 读文件并定位当前 owner 可见、未被改过的那一条；不满足时返回 conflict 结果。
function locateSeed({ database, storageRoot, payload }) {
  const owner = resolveSeedOwner(database, payload && payload.owner);
  const key = normalizeKey(payload && payload.key);
  if (!key.merchantId || !key.billDate) {
    throw new BalanceSeedManagementError('BALANCE_SEED_KEY_INVALID', '缺少账户号或日期，请刷新后重试', { key });
  }
  const records = readBalanceSeedRecords(storageRoot, owner.bankName);
  const matchedIndexes = records
    .map((record, index) => (sameKey(record, key) ? index : -1))
    .filter((index) => index >= 0);
  if (matchedIndexes.length > 1) {
    throw new BalanceSeedManagementError(
      'BALANCE_SEED_DUPLICATE',
      '种子文件中同一账户号、币种、日期有多条记录，请检查种子文件后重试',
      { key, seedFilePath: getBalanceSeedFilePath(storageRoot, owner.bankName) }
    );
  }
  const index = matchedIndexes.length ? matchedIndexes[0] : -1;
  const record = index >= 0 ? records[index] : null;
  if (!record || !isVisibleToOwner(record, owner) || !matchesExpected(record, payload.expected, owner)) {
    return { conflict: true, owner, key };
  }
  return { conflict: false, owner, key, records, index, record };
}

function conflictResult(storageRoot, located) {
  return {
    status: 'conflict',
    message: CONFLICT_MESSAGE,
    owner: describeOwner(located.owner, storageRoot)
  };
}

function updateOwnerSeed({ database, storageRoot, payload, now = new Date() }) {
  const endBalance = parseNumericValue(payload && payload.endBalance);
  // 超出数值范围的输入解析为 Infinity，写回时会被种子库当作无效记录过滤掉，须在这里拒绝。
  if (endBalance === null || !Number.isFinite(endBalance)) {
    throw new BalanceSeedManagementError('BALANCE_SEED_BALANCE_INVALID', '余额必须是有效数字', {
      endBalance: payload && payload.endBalance
    });
  }
  const located = locateSeed({ database, storageRoot, payload });
  if (located.conflict) return conflictResult(storageRoot, located);

  const { owner, records, index, record } = located;
  if (record.endBalance === endBalance) {
    return {
      status: 'success',
      changed: false,
      message: '余额未变化',
      owner: describeOwner(owner, storageRoot),
      previous: toPublicRecord(record, owner),
      record: toPublicRecord(record, owner)
    };
  }

  const nextRecord = {
    merchantId: record.merchantId,
    currency: record.currency,
    billDate: record.billDate,
    endBalance,
    templateName: owner.outputName,
    generationMethod: BALANCE_SEED_GENERATION_METHODS.manual,
    updatedAt: now.toISOString()
  };
  const nextRecords = records.slice();
  nextRecords[index] = nextRecord;
  const filePath = writeBalanceSeedRecords(storageRoot, owner.bankName, nextRecords);
  return {
    status: 'success',
    changed: true,
    message: '余额种子已修改',
    owner: describeOwner(owner, storageRoot),
    ownerLabel: ownerLabel(owner),
    filePath,
    previous: toPublicRecord(record, owner),
    record: toPublicRecord(nextRecord, owner)
  };
}

function deleteOwnerSeed({ database, storageRoot, payload }) {
  const located = locateSeed({ database, storageRoot, payload });
  if (located.conflict) return conflictResult(storageRoot, located);

  const { owner, records, index, record } = located;
  const nextRecords = records.filter((_item, itemIndex) => itemIndex !== index);
  const filePath = writeBalanceSeedRecords(storageRoot, owner.bankName, nextRecords);
  return {
    status: 'success',
    message: '余额种子已删除',
    owner: describeOwner(owner, storageRoot),
    ownerLabel: ownerLabel(owner),
    filePath,
    previous: toPublicRecord(record, owner)
  };
}

// 活动日志：修改记原值 → 新值与原生成方式、原写入者，删除记被删记录的全部内容，便于事后核对与恢复。
function buildBalanceSeedActivityLog(action, result) {
  const previous = result.previous;
  const keyLines = [
    `所属：${result.ownerLabel}`,
    `种子文件：${result.filePath}`,
    `账户号：${previous.merchantId}`,
    `币种：${previous.currency || '（空）'}`,
    `日期：${previous.billDate}`
  ];
  const writerLine = `原写入者：${previous.templateName || '（空）'}`;
  if (action === 'update') {
    return {
      message: '修改余额种子成功',
      details: [
        ...keyLines,
        `余额：${previous.endBalance} → ${result.record.endBalance}`,
        `生成方式：${previous.generationMethod} → ${result.record.generationMethod}`,
        writerLine
      ]
    };
  }
  return {
    message: '删除余额种子成功',
    details: [...keyLines, `余额：${previous.endBalance}`, `生成方式：${previous.generationMethod}`, writerLine]
  };
}

module.exports = {
  BalanceSeedManagementError,
  CONFLICT_MESSAGE,
  buildBalanceSeedActivityLog,
  deleteOwnerSeed,
  listOwnerSeeds,
  resolveSeedOwner,
  updateOwnerSeed
};
