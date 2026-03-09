const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class AppDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        source_file_name TEXT NOT NULL,
        headers_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS template_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        template_field TEXT NOT NULL,
        mapped_field TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE(template_id, row_index)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bank_account_id TEXT NOT NULL UNIQUE,
        clearing_account_id TEXT NOT NULL,
        row_index INTEGER NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  listTemplates() {
    const statement = this.db.prepare(`
      SELECT
        t.id,
        t.name,
        t.source_file_name AS sourceFileName,
        t.headers_json AS headersJson,
        t.created_at AS createdAt,
        t.updated_at AS updatedAt,
        COUNT(m.id) AS mappingCount
      FROM templates t
      LEFT JOIN template_mappings m ON m.template_id = t.id
      GROUP BY t.id
      ORDER BY t.updated_at DESC
    `);

    return statement.all().map((row) => ({
      id: row.id,
      name: row.name,
      sourceFileName: row.sourceFileName,
      headers: JSON.parse(row.headersJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      mappingCount: row.mappingCount
    }));
  }

  getTemplate(templateId) {
    const statement = this.db.prepare(`
      SELECT id, name, source_file_name AS sourceFileName, headers_json AS headersJson,
             created_at AS createdAt, updated_at AS updatedAt
      FROM templates
      WHERE id = ?
    `);
    const row = statement.get(templateId);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      sourceFileName: row.sourceFileName,
      headers: JSON.parse(row.headersJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  upsertTemplate({ name, sourceFileName, headers }) {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT id FROM templates WHERE name = ?')
      .get(name);

    if (existing) {
      this.db.exec('BEGIN');
      try {
        this.db
          .prepare(`
            UPDATE templates
            SET source_file_name = ?, headers_json = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(sourceFileName, JSON.stringify(headers), now, existing.id);
        this.db
          .prepare('DELETE FROM template_mappings WHERE template_id = ?')
          .run(existing.id);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }

      return this.getTemplate(existing.id);
    }

    const result = this.db
      .prepare(`
        INSERT INTO templates (name, source_file_name, headers_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(name, sourceFileName, JSON.stringify(headers), now, now);

    return this.getTemplate(result.lastInsertRowid);
  }

  deleteTemplate(templateId) {
    this.db.prepare('DELETE FROM templates WHERE id = ?').run(templateId);
  }

  getTemplateMappings(templateId) {
    const template = this.getTemplate(templateId);

    if (!template) {
      return null;
    }

    const rows = this.db
      .prepare(`
        SELECT row_index AS rowIndex, template_field AS templateField, mapped_field AS mappedField
        FROM template_mappings
        WHERE template_id = ?
        ORDER BY row_index ASC
      `)
      .all(templateId);

    return {
      template,
      mappings: rows
    };
  }

  saveMappings(templateId, mappings) {
    const now = new Date().toISOString();
    this.db.exec('BEGIN');

    try {
      this.db
        .prepare('DELETE FROM template_mappings WHERE template_id = ?')
        .run(templateId);

      const insertStatement = this.db.prepare(`
        INSERT INTO template_mappings (
          template_id, template_field, mapped_field, row_index, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `);

      mappings.forEach((mapping, index) => {
        insertStatement.run(
          templateId,
          mapping.templateField,
          mapping.mappedField,
          index,
          now
        );
      });

      this.db
        .prepare('UPDATE templates SET updated_at = ? WHERE id = ?')
        .run(now, templateId);

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getSetting(settingKey) {
    const row = this.db
      .prepare(`
        SELECT setting_value AS settingValue
        FROM app_settings
        WHERE setting_key = ?
      `)
      .get(settingKey);

    return row ? row.settingValue : null;
  }

  setSetting(settingKey, settingValue) {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE
        SET setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
      `)
      .run(settingKey, settingValue, now);
  }

  getEnumConfig() {
    const raw = this.getSetting('enum_config');

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }

  setEnumConfig(enumConfig) {
    this.setSetting('enum_config', JSON.stringify(enumConfig));
  }

  listAccountMappings() {
    return this.db
      .prepare(`
        SELECT
          id,
          bank_account_id AS bankAccountId,
          clearing_account_id AS clearingAccountId,
          row_index AS rowIndex
        FROM account_mappings
        ORDER BY row_index ASC, id ASC
      `)
      .all();
  }

  saveAccountMappings(mappings) {
    const now = new Date().toISOString();
    this.db.exec('BEGIN');

    try {
      this.db.exec('DELETE FROM account_mappings');

      const insertStatement = this.db.prepare(`
        INSERT INTO account_mappings (
          bank_account_id, clearing_account_id, row_index, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `);

      mappings.forEach((mapping, index) => {
        insertStatement.run(
          mapping.bankAccountId,
          mapping.clearingAccountId,
          index,
          now,
          now
        );
      });

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

module.exports = {
  AppDatabase
};
