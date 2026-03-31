const fs = require('node:fs');
const path = require('node:path');

function getModeFilePath(storageRoot, templateId) {
  return path.join(storageRoot, 'big-account-modes', `${String(templateId)}.json`);
}

function readBigAccountMode(storageRoot, templateId) {
  const filePath = getModeFilePath(storageRoot, templateId);
  if (!fs.existsSync(filePath)) return 'unfixed';

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed.mode === 'fixed' ? 'fixed' : 'unfixed';
  } catch (_error) {
    return 'unfixed';
  }
}

function writeBigAccountMode(storageRoot, templateId, mode) {
  const filePath = getModeFilePath(storageRoot, templateId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  fs.writeFileSync(filePath, `${JSON.stringify({
    templateId: String(templateId),
    mode: mode === 'fixed' ? 'fixed' : 'unfixed',
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
}

module.exports = { readBigAccountMode, writeBigAccountMode };
