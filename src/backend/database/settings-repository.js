function getSetting(db, settingKey) {
  const row = db
    .prepare(`
      SELECT setting_value AS settingValue
      FROM app_settings
      WHERE setting_key = ?
    `)
    .get(settingKey);

  return row ? row.settingValue : null;
}

function setSetting(db, settingKey, settingValue) {
  const now = new Date().toISOString();
  db
    .prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value,
          updated_at = excluded.updated_at
    `)
    .run(settingKey, settingValue, now);
}

function getEnumConfig(db) {
  const raw = getSetting(db, 'enum_config');

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function setEnumConfig(db, enumConfig) {
  setSetting(db, 'enum_config', JSON.stringify(enumConfig));
}

function getBackgroundConfig(db) {
  const raw = getSetting(db, 'background_config');

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function setBackgroundConfig(db, backgroundConfig) {
  setSetting(db, 'background_config', JSON.stringify(backgroundConfig));
}

const UI_STYLE_KEY = 'ui_style';
const UI_STYLE_VALID = ['Clear', 'General'];
const UI_STYLE_DEFAULT = 'Clear';

function getUiStyle(db) {
  const value = getSetting(db, UI_STYLE_KEY);
  if (value && UI_STYLE_VALID.includes(value)) {
    return value;
  }
  return null;
}

function setUiStyle(db, style) {
  if (!UI_STYLE_VALID.includes(style)) {
    throw new Error(`Invalid ui_style: ${style}, must be one of ${UI_STYLE_VALID.join(' | ')}`);
  }
  setSetting(db, UI_STYLE_KEY, style);
}

function ensureUiStyleDefault(db) {
  const current = getUiStyle(db);
  if (!current) {
    setSetting(db, UI_STYLE_KEY, UI_STYLE_DEFAULT);
    return UI_STYLE_DEFAULT;
  }
  return current;
}

function listAccountMappings(db, templateId) {
  return db
    .prepare(`
      SELECT
        id,
        bank_account_id AS bankAccountId,
        clearing_account_id AS clearingAccountId,
        no_currency AS noCurrency,
        currency,
        row_index AS rowIndex
      FROM account_mappings
      WHERE template_id = ?
      ORDER BY row_index ASC, id ASC
    `)
    .all(templateId);
}

function saveAccountMappings(db, templateId, mappings) {
  const now = new Date().toISOString();
  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM account_mappings WHERE template_id = ?').run(templateId);

    const insertStatement = db.prepare(`
      INSERT INTO account_mappings (
        template_id, bank_account_id, clearing_account_id, no_currency, currency, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    mappings.forEach((mapping, index) => {
      insertStatement.run(
        templateId,
        mapping.bankAccountId,
        mapping.clearingAccountId,
        mapping.noCurrency ? 1 : 0,
        mapping.currency || '',
        index,
        now,
        now
      );
    });

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  ensureUiStyleDefault,
  getBackgroundConfig,
  getEnumConfig,
  getSetting,
  getUiStyle,
  listAccountMappings,
  saveAccountMappings,
  setBackgroundConfig,
  setEnumConfig,
  setSetting,
  setUiStyle
};
