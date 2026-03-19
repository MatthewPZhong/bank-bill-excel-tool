const { randomUUID } = require('node:crypto');
const { normalizeText } = require('./utils');

function hasColumn(db, tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => normalizeText(column.name) === normalizeText(columnName));
}

function ensureTemplateKeySupport(db) {
  db.exec('BEGIN');

  try {
    if (!hasColumn(db, 'templates', 'template_key')) {
      db.exec('ALTER TABLE templates ADD COLUMN template_key TEXT;');
    }

    const rows = db
      .prepare(`
        SELECT id
        FROM templates
        WHERE COALESCE(template_key, '') = ''
      `)
      .all();

    const updateStatement = db.prepare(`
      UPDATE templates
      SET template_key = ?
      WHERE id = ?
    `);

    rows.forEach((row) => {
      updateStatement.run(randomUUID(), row.id);
    });

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS templates_template_key_unique
      ON templates(template_key);
    `);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureTemplateMappingEnhancements(db) {
  db.exec('BEGIN');

  try {
    if (!hasColumn(db, 'template_mappings', 'mapped_fields_json')) {
      db.exec('ALTER TABLE template_mappings ADD COLUMN mapped_fields_json TEXT NOT NULL DEFAULT \'[]\';');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS template_fixed_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        merchant_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE(template_id, row_index)
      );
    `);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  ensureTemplateMappingEnhancements,
  ensureTemplateKeySupport,
  hasColumn
};
