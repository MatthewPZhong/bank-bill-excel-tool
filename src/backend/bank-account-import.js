const { normalizeCell, FileValidationError } = require('./file-service/common');
const { readRows } = require('./file-service/readers');

const REQUIRED_COLUMNS = ['账户性质', '账户状态', '是否参与对账', '银行账号', '币种'];

function parseBankAccountExcel(filePath) {
  const rows = readRows(filePath);

  if (!rows || rows.length <= 1) {
    throw new FileValidationError('FILE_READ', '导入的文件为空或只有表头');
  }

  const headerRow = rows[0];
  const columnIndexMap = new Map();

  headerRow.forEach((cell, index) => {
    const normalizedName = normalizeCell(cell);
    if (normalizedName && !columnIndexMap.has(normalizedName)) {
      columnIndexMap.set(normalizedName, index);
    }
  });

  const missingColumns = REQUIRED_COLUMNS.filter(
    (columnName) => !columnIndexMap.has(columnName)
  );

  if (missingColumns.length) {
    throw new FileValidationError(
      'FILE_READ',
      `导入的文件中缺少必需列：${missingColumns.join('、')}`
    );
  }

  const accountNatureIndex = columnIndexMap.get('账户性质');
  const accountStatusIndex = columnIndexMap.get('账户状态');
  const reconFlagIndex = columnIndexMap.get('是否参与对账');
  const bankAccountIndex = columnIndexMap.get('银行账号');
  const currencyIndex = columnIndexMap.get('币种');

  const clientAccountMap = new Map();
  const ownAccountMap = new Map();
  let skippedCount = 0;

  rows.slice(1).forEach((row) => {
    const accountNature = normalizeCell(row[accountNatureIndex]);
    const accountStatus = normalizeCell(row[accountStatusIndex]);
    const reconFlag = normalizeCell(row[reconFlagIndex]);
    const bankAccount = normalizeCell(row[bankAccountIndex]);
    const rawCurrency = normalizeCell(row[currencyIndex]);
    const currency = rawCurrency.toUpperCase();

    if (accountStatus !== '正常' || reconFlag !== '是') {
      return;
    }

    if (!bankAccount || !currency) {
      skippedCount += 1;
      return;
    }

    if (accountNature === '客资') {
      if (!clientAccountMap.has(bankAccount)) {
        clientAccountMap.set(bankAccount, new Set());
      }
      clientAccountMap.get(bankAccount).add(currency);
    } else if (accountNature === '自有') {
      if (!ownAccountMap.has(bankAccount)) {
        ownAccountMap.set(bankAccount, new Set());
      }
      ownAccountMap.get(bankAccount).add(currency);
    }
  });

  function buildAccountList(accountMap) {
    return Array.from(accountMap.entries()).map(([merchantId, currencySet]) => {
      const currencies = Array.from(currencySet);
      return {
        merchantId,
        currencies,
        isMultiCurrency: currencies.length > 1
      };
    });
  }

  return {
    clientAccounts: buildAccountList(clientAccountMap),
    ownAccounts: buildAccountList(ownAccountMap),
    skippedCount
  };
}

module.exports = {
  parseBankAccountExcel
};
