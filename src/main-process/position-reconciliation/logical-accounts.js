'use strict';

const { normalizeCellValue } = require('../scenario-engines/engine-utils');
const { REASON_CODES } = require('./contracts');

const BANK_ACCOUNT_FIELDS = Object.freeze([
  'Payee CardNo',
  'Drawee CardNo',
  'MerchantId'
]);

function makeUnionFind(size) {
  const parent = Array.from({ length: size }, (_value, index) => index);
  const find = (value) => {
    let current = value;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  return { find, union };
}

function accountAliases(row) {
  return Array.from(new Set([
    normalizeCellValue(row && row['银行账号']),
    normalizeCellValue(row && row['系统账号'])
  ].filter(Boolean)));
}

function buildLogicalAccounts(accountRows) {
  const rows = (Array.isArray(accountRows) ? accountRows : [])
    .filter((row) => normalizeCellValue(row && row['账户状态']) === '正常')
    .map((row, index) => ({
      row,
      index,
      aliases: accountAliases(row),
      nature: normalizeCellValue(row && row['账户性质']),
      currency: normalizeCellValue(row && row['币种'])
    }))
    .filter((record) => record.aliases.length > 0);

  const unionFind = makeUnionFind(rows.length);
  const firstByAlias = new Map();
  rows.forEach((record, index) => {
    for (const alias of record.aliases) {
      if (firstByAlias.has(alias)) unionFind.union(index, firstByAlias.get(alias));
      else firstByAlias.set(alias, index);
    }
  });

  const groups = new Map();
  rows.forEach((record, index) => {
    const root = unionFind.find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(record);
  });

  return Array.from(groups.values()).map((records, logicalIndex) => {
    const aliases = new Set();
    const currencies = new Set();
    const natures = new Set();
    for (const record of records) {
      record.aliases.forEach((alias) => aliases.add(alias));
      if (record.currency !== '') currencies.add(record.currency);
      if (record.nature !== '') natures.add(record.nature);
    }
    const reasons = [];
    if (currencies.size !== 1) reasons.push('同一逻辑账户的币种为空或不唯一');
    if (natures.size !== 1) reasons.push('同一逻辑账户的账户性质为空或不唯一');
    return {
      id: `logical-account-${logicalIndex}`,
      aliases: Array.from(aliases),
      currencies: Array.from(currencies),
      natures: Array.from(natures),
      currency: currencies.size === 1 ? Array.from(currencies)[0] : '',
      nature: natures.size === 1 ? Array.from(natures)[0] : '',
      rows: records.map((record) => record.row),
      valid: reasons.length === 0,
      reasons
    };
  });
}

function matchAccountFields(bankRow, logicalAccount, excludedFields = new Set()) {
  const matches = [];
  for (const field of BANK_ACCOUNT_FIELDS) {
    if (excludedFields.has(field)) continue;
    const bankValue = normalizeCellValue(bankRow && bankRow[field]);
    if (bankValue === '') continue;
    const aliases = logicalAccount.aliases.filter((alias) => bankValue.includes(alias));
    if (aliases.length > 0) matches.push({ field, bankValue, aliases });
  }
  return matches;
}

function accountIssue(code, message, details = {}) {
  return {
    ok: false,
    code,
    message,
    details
  };
}

function identifyAccountPair(bankRow, logicalAccounts) {
  const accounts = Array.isArray(logicalAccounts) ? logicalAccounts : [];
  const allMatches = accounts.map((account) => ({
    account,
    matches: matchAccountFields(bankRow, account)
  })).filter((entry) => entry.matches.length > 0);

  const ownEntries = allMatches.filter((entry) => (
    entry.account.natures.includes('自有')
  ));
  const conflictedOwn = ownEntries.filter((entry) => !entry.account.valid || entry.account.nature !== '自有');
  if (conflictedOwn.length > 0) {
    return accountIssue(
      REASON_CODES.ACCOUNT_CONFLICT,
      '命中的自有逻辑账户存在币种、账户性质或别名冲突',
      { accounts: conflictedOwn }
    );
  }
  if (ownEntries.length === 0) {
    return accountIssue(REASON_CODES.OWN_ACCOUNT_NOT_FOUND, '未唯一识别到自有账户');
  }
  if (ownEntries.length !== 1) {
    return accountIssue(
      REASON_CODES.OWN_ACCOUNT_MULTIPLE,
      `识别到${ownEntries.length}个自有逻辑账户`,
      { accounts: ownEntries }
    );
  }

  const ownEntry = ownEntries[0];
  const excludedFields = new Set(ownEntry.matches.map((match) => match.field));
  const otherEntries = accounts.map((account) => ({
    account,
    matches: matchAccountFields(bankRow, account, excludedFields)
  })).filter((entry) => (
    entry.matches.length > 0
    && entry.account.natures.some((nature) => nature !== '自有')
  ));
  const conflictedOther = otherEntries.filter((entry) => !entry.account.valid || entry.account.nature === '自有');
  if (conflictedOther.length > 0) {
    return accountIssue(
      REASON_CODES.ACCOUNT_CONFLICT,
      '命中的非自有逻辑账户存在币种、账户性质或别名冲突',
      { accounts: conflictedOther }
    );
  }
  if (otherEntries.length === 0) {
    return accountIssue(REASON_CODES.OTHER_ACCOUNT_NOT_FOUND, '未从剩余账户字段唯一识别到非自有账户');
  }
  if (otherEntries.length !== 1) {
    return accountIssue(
      REASON_CODES.OTHER_ACCOUNT_MULTIPLE,
      `从剩余账户字段识别到${otherEntries.length}个非自有逻辑账户`,
      { accounts: otherEntries }
    );
  }

  return {
    ok: true,
    own: ownEntry,
    other: otherEntries[0],
    excludedFields: Array.from(excludedFields)
  };
}

module.exports = {
  BANK_ACCOUNT_FIELDS,
  accountAliases,
  buildLogicalAccounts,
  matchAccountFields,
  identifyAccountPair
};
