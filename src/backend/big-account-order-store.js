const fs = require('node:fs');
const path = require('node:path');
const { normalizeCell } = require('./file-service/common');

function getOrderFilePath(storageRoot, templateId) {
  return path.join(storageRoot, 'big-account-orders', `${String(templateId)}.json`);
}

function readBigAccountOrder(storageRoot, templateId) {
  const filePath = getOrderFilePath(storageRoot, templateId);
  if (!fs.existsSync(filePath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.assignments)) return null;

    const order = {
      templateId: String(parsed.templateId || templateId),
      assignments: parsed.assignments
        .map((item) => ({
          rowIndex: Number(item.rowIndex || 0),
          merchantId: normalizeCell(item.merchantId),
          currency: normalizeCell(item.currency)
        }))
        .filter((item) => item.merchantId !== '')
    };

    if (Number.isInteger(parsed.fileCount) && Array.isArray(parsed.files)) {
      order.fileCount = parsed.fileCount;
      order.files = parsed.files.map((file) => ({
        fileIndex: Number(file.fileIndex || 0),
        accountCount: Number(file.accountCount || 0),
        accounts: Array.isArray(file.accounts)
          ? file.accounts.map((a) => ({
              merchantId: normalizeCell(a.merchantId),
              currency: normalizeCell(a.currency)
            })).filter((a) => a.merchantId !== '')
          : []
      }));
    }

    return order;
  } catch (_error) {
    return null;
  }
}

function writeBigAccountOrder(storageRoot, templateId, data) {
  const filePath = getOrderFilePath(storageRoot, templateId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const assignments = Array.isArray(data.assignments) ? data.assignments : (Array.isArray(data) ? data : []);

  const payload = {
    templateId: String(templateId),
    assignments: assignments.map((item) => ({
      rowIndex: Number(item.rowIndex || 0),
      merchantId: normalizeCell(item.merchantId),
      currency: normalizeCell(item.currency)
    })),
    updatedAt: new Date().toISOString()
  };

  if (Number.isInteger(data.fileCount) && Array.isArray(data.files)) {
    payload.fileCount = data.fileCount;
    payload.files = data.files.map((file) => ({
      fileIndex: Number(file.fileIndex || 0),
      accountCount: Number(file.accountCount || 0),
      accounts: Array.isArray(file.accounts)
        ? file.accounts.map((a) => ({
            merchantId: normalizeCell(a.merchantId),
            currency: normalizeCell(a.currency)
          })).filter((a) => a.merchantId !== '')
        : []
    }));
  }

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

module.exports = { readBigAccountOrder, writeBigAccountOrder };
