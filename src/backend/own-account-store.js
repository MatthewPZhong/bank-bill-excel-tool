const fs = require('node:fs');
const path = require('node:path');

function sanitizeBankName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .trim() || 'unknown-bank';
}

function getOwnAccountFilePath(storageRoot, bankName) {
  return path.join(storageRoot, 'own-accounts', `${sanitizeBankName(bankName)}.json`);
}

function readOwnAccounts(storageRoot, bankName) {
  const filePath = getOwnAccountFilePath(storageRoot, bankName);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function writeOwnAccounts(storageRoot, bankName, accounts) {
  const filePath = getOwnAccountFilePath(storageRoot, bankName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(accounts, null, 2)}\n`, 'utf8');
}

module.exports = {
  readOwnAccounts,
  writeOwnAccounts,
  sanitizeBankName
};
