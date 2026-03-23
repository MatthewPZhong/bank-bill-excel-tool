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

function listAccountMappings(db) {
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
      ORDER BY row_index ASC, id ASC
    `)
    .all();
}

function saveAccountMappings(db, mappings) {
  const now = new Date().toISOString();
  db.exec('BEGIN');

  try {
    db.exec('DELETE FROM account_mappings');

    const insertStatement = db.prepare(`
      INSERT INTO account_mappings (
        bank_account_id, clearing_account_id, no_currency, currency, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    mappings.forEach((mapping, index) => {
      insertStatement.run(
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
  getBackgroundConfig,
  getEnumConfig,
  getSetting,
  listAccountMappings,
  saveAccountMappings,
  setBackgroundConfig,
  setEnumConfig,
  setSetting
};
