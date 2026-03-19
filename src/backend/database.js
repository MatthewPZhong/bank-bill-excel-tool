const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureTemplateKeySupport,
  ensureTemplateMappingEnhancements,
  hasColumn
} = require('./database/migrations');
const settingsRepository = require('./database/settings-repository');
const templateRepository = require('./database/template-repository');

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
        template_key TEXT,
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
        mapped_fields_json TEXT NOT NULL DEFAULT '[]',
        row_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE(template_id, row_index)
      );

      CREATE TABLE IF NOT EXISTS template_big_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        merchant_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE(template_id, merchant_id, currency)
      );

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

    this.ensureTemplateKeySupport();
    this.ensureTemplateMappingEnhancements();
  }

  hasColumn(tableName, columnName) {
    return hasColumn(this.db, tableName, columnName);
  }

  ensureTemplateKeySupport() {
    return ensureTemplateKeySupport(this.db);
  }

  ensureTemplateMappingEnhancements() {
    return ensureTemplateMappingEnhancements(this.db);
  }

  listTemplates() {
    return templateRepository.listTemplates(this.db);
  }

  getTemplate(templateId) {
    return templateRepository.getTemplate(this.db, templateId);
  }

  getTemplateByKey(templateKey) {
    return templateRepository.getTemplateByKey(this.db, templateKey);
  }

  getTemplateByName(name) {
    return templateRepository.getTemplateByName(this.db, name);
  }

  upsertTemplate({ templateKey = '', name, sourceFileName, headers }) {
    return templateRepository.upsertTemplate(this.db, { templateKey, name, sourceFileName, headers });
  }

  renameTemplate(templateId, nextName) {
    return templateRepository.renameTemplate(this.db, templateId, nextName);
  }

  deleteTemplate(templateId) {
    return templateRepository.deleteTemplate(this.db, templateId);
  }

  getTemplateBigAccounts(templateId) {
    return templateRepository.getTemplateBigAccounts(this.db, templateId);
  }

  getTemplateMappings(templateId) {
    return templateRepository.getTemplateMappings(this.db, templateId);
  }

  saveMappings(templateId, mappings, bigAccounts = [], fixedAssignments = []) {
    return templateRepository.saveMappings(this.db, templateId, mappings, bigAccounts, fixedAssignments);
  }

  listTemplateBundleEntries() {
    return templateRepository.listTemplateBundleEntries(this.db);
  }

  getSetting(settingKey) {
    return settingsRepository.getSetting(this.db, settingKey);
  }

  setSetting(settingKey, settingValue) {
    return settingsRepository.setSetting(this.db, settingKey, settingValue);
  }

  getEnumConfig() {
    return settingsRepository.getEnumConfig(this.db);
  }

  setEnumConfig(enumConfig) {
    return settingsRepository.setEnumConfig(this.db, enumConfig);
  }

  getBackgroundConfig() {
    return settingsRepository.getBackgroundConfig(this.db);
  }

  setBackgroundConfig(backgroundConfig) {
    return settingsRepository.setBackgroundConfig(this.db, backgroundConfig);
  }

  listAccountMappings() {
    return settingsRepository.listAccountMappings(this.db);
  }

  saveAccountMappings(mappings) {
    return settingsRepository.saveAccountMappings(this.db, mappings);
  }
}

module.exports = {
  AppDatabase
};
