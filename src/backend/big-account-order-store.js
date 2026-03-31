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

    return {
      templateId: String(parsed.templateId || templateId),
      assignments: parsed.assignments
        .map((item) => ({
          rowIndex: Number(item.rowIndex || 0),
          merchantId: normalizeCell(item.merchantId),
          currency: normalizeCell(item.currency)
        }))
        .filter((item) => item.merchantId !== '')
    };
  } catch (_error) {
    return null;
  }
}

function writeBigAccountOrder(storageRoot, templateId, assignments) {
  const filePath = getOrderFilePath(storageRoot, templateId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const payload = {
    templateId: String(templateId),
    assignments: assignments.map((item) => ({
      rowIndex: Number(item.rowIndex || 0),
      merchantId: normalizeCell(item.merchantId),
      currency: normalizeCell(item.currency)
    })),
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

module.exports = { readBigAccountOrder, writeBigAccountOrder };
