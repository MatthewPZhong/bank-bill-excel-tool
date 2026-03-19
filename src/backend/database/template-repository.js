const { randomUUID } = require('node:crypto');
const {
  buildTemplateSummaryFromRow,
  groupBigAccountRows,
  normalizeText,
  parseJsonArray
} = require('./utils');

function listTemplates(db) {
  const statement = db.prepare(`
    SELECT
      t.id,
      t.template_key AS templateKey,
      t.name,
      t.source_file_name AS sourceFileName,
      t.headers_json AS headersJson,
      t.created_at AS createdAt,
      t.updated_at AS updatedAt,
      COUNT(DISTINCT m.id) AS mappingCount,
      COUNT(DISTINCT ba.merchant_id) AS bigAccountCount,
      merchant_mapping.mapped_field AS merchantIdMappedField,
      MIN(ba.merchant_id) AS singleBigAccountMerchantId
    FROM templates t
    LEFT JOIN template_mappings m ON m.template_id = t.id
    LEFT JOIN template_big_accounts ba ON ba.template_id = t.id
    LEFT JOIN template_mappings merchant_mapping
      ON merchant_mapping.template_id = t.id
      AND merchant_mapping.template_field = 'MerchantId'
    GROUP BY t.id
    ORDER BY t.updated_at DESC, t.id DESC
  `);

  return statement.all().map((row) => buildTemplateSummaryFromRow(row));
}

function getTemplate(db, templateId) {
  const row = db
    .prepare(`
      SELECT
        t.id,
        t.template_key AS templateKey,
        t.name,
        t.source_file_name AS sourceFileName,
        t.headers_json AS headersJson,
        t.created_at AS createdAt,
        t.updated_at AS updatedAt,
        (
          SELECT COUNT(1)
          FROM template_mappings m
          WHERE m.template_id = t.id
        ) AS mappingCount,
        (
          SELECT COUNT(DISTINCT merchant_id)
          FROM template_big_accounts ba
          WHERE ba.template_id = t.id
        ) AS bigAccountCount,
        (
          SELECT mapped_field
          FROM template_mappings merchant_mapping
          WHERE merchant_mapping.template_id = t.id
            AND merchant_mapping.template_field = 'MerchantId'
          LIMIT 1
        ) AS merchantIdMappedField,
        (
          SELECT MIN(merchant_id)
          FROM template_big_accounts ba
          WHERE ba.template_id = t.id
        ) AS singleBigAccountMerchantId
      FROM templates t
      WHERE t.id = ?
    `)
    .get(templateId);

  return row ? buildTemplateSummaryFromRow(row) : null;
}

function getTemplateByKey(db, templateKey) {
  const row = db
    .prepare(`
      SELECT id
      FROM templates
      WHERE template_key = ?
    `)
    .get(templateKey);

  return row ? getTemplate(db, row.id) : null;
}

function getTemplateByName(db, name) {
  const row = db
    .prepare(`
      SELECT id
      FROM templates
      WHERE name = ?
    `)
    .get(name);

  return row ? getTemplate(db, row.id) : null;
}

function upsertTemplate(db, { templateKey = '', name, sourceFileName, headers }) {
  const normalizedTemplateKey = normalizeText(templateKey) || randomUUID();
  const now = new Date().toISOString();
  const existingByKey = normalizeText(templateKey)
    ? db.prepare('SELECT id FROM templates WHERE template_key = ?').get(normalizedTemplateKey)
    : null;
  const existingByName = db.prepare('SELECT id FROM templates WHERE name = ?').get(name);
  const existing = existingByKey || existingByName;

  if (existing) {
    db.exec('BEGIN');
    try {
      db
        .prepare(`
          UPDATE templates
          SET template_key = ?, name = ?, source_file_name = ?, headers_json = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(normalizedTemplateKey, name, sourceFileName, JSON.stringify(headers), now, existing.id);
      db.prepare('DELETE FROM template_mappings WHERE template_id = ?').run(existing.id);
      db.prepare('DELETE FROM template_big_accounts WHERE template_id = ?').run(existing.id);
      db.prepare('DELETE FROM template_fixed_assignments WHERE template_id = ?').run(existing.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return getTemplate(db, existing.id);
  }

  const result = db
    .prepare(`
      INSERT INTO templates (template_key, name, source_file_name, headers_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(normalizedTemplateKey, name, sourceFileName, JSON.stringify(headers), now, now);

  return getTemplate(db, result.lastInsertRowid);
}

function renameTemplate(db, templateId, nextName) {
  const now = new Date().toISOString();
  db
    .prepare(`
      UPDATE templates
      SET name = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(nextName, now, templateId);

  return getTemplate(db, templateId);
}

function deleteTemplate(db, templateId) {
  db.prepare('DELETE FROM templates WHERE id = ?').run(templateId);
}

function getTemplateBigAccounts(db, templateId) {
  return db
    .prepare(`
      SELECT
        merchant_id AS merchantId,
        currency,
        row_index AS rowIndex
      FROM template_big_accounts
      WHERE template_id = ?
      ORDER BY row_index ASC, id ASC
    `)
    .all(templateId)
    .map((row) => ({
      merchantId: normalizeText(row.merchantId),
      currency: normalizeText(row.currency),
      rowIndex: Number(row.rowIndex || 0)
    }));
}

function getTemplateFixedAssignments(db, templateId) {
  return db
    .prepare(`
      SELECT
        merchant_id AS merchantId,
        currency,
        row_index AS rowIndex
      FROM template_fixed_assignments
      WHERE template_id = ?
      ORDER BY row_index ASC, id ASC
    `)
    .all(templateId)
    .map((row) => ({
      merchantId: normalizeText(row.merchantId),
      currency: normalizeText(row.currency),
      rowIndex: Number(row.rowIndex || 0)
    }));
}

function getTemplateMappings(db, templateId) {
  const template = getTemplate(db, templateId);

  if (!template) {
    return null;
  }

  const mappings = db
    .prepare(`
      SELECT
        row_index AS rowIndex,
        template_field AS templateField,
        mapped_field AS mappedField,
        mapped_fields_json AS mappedFieldsJson
      FROM template_mappings
      WHERE template_id = ?
      ORDER BY row_index ASC
    `)
    .all(templateId)
    .map((row) => ({
      rowIndex: Number(row.rowIndex || 0),
      templateField: normalizeText(row.templateField),
      mappedField: normalizeText(row.mappedField),
      mappedFields: parseJsonArray(row.mappedFieldsJson)
        .map((value) => normalizeText(value))
        .filter((value) => value !== '')
    }));
  const bigAccountRows = getTemplateBigAccounts(db, templateId);
  const fixedAssignments = getTemplateFixedAssignments(db, templateId);

  return {
    template,
    mappings,
    bigAccounts: groupBigAccountRows(bigAccountRows),
    fixedAssignments
  };
}

function saveMappings(db, templateId, mappings, bigAccounts = [], fixedAssignments = []) {
  const now = new Date().toISOString();
  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM template_mappings WHERE template_id = ?').run(templateId);
    db.prepare('DELETE FROM template_big_accounts WHERE template_id = ?').run(templateId);
    db.prepare('DELETE FROM template_fixed_assignments WHERE template_id = ?').run(templateId);

    const insertMappingStatement = db.prepare(`
      INSERT INTO template_mappings (
        template_id, template_field, mapped_field, mapped_fields_json, row_index, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertBigAccountStatement = db.prepare(`
      INSERT INTO template_big_accounts (
        template_id, merchant_id, currency, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertFixedAssignmentStatement = db.prepare(`
      INSERT INTO template_fixed_assignments (
        template_id, merchant_id, currency, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    mappings.forEach((mapping, index) => {
      const mappedFields = Array.from(
        new Set(
          (Array.isArray(mapping.mappedFields) ? mapping.mappedFields : [])
            .map((value) => normalizeText(value))
            .filter((value) => value !== '')
        )
      );
      insertMappingStatement.run(
        templateId,
        mapping.templateField,
        mapping.mappedField,
        JSON.stringify(mappedFields),
        index,
        now
      );
    });

    bigAccounts.forEach((item, index) => {
      insertBigAccountStatement.run(
        templateId,
        item.merchantId,
        item.currency,
        index,
        now,
        now
      );
    });

    fixedAssignments.forEach((item, index) => {
      const merchantId = normalizeText(item.merchantId);

      if (!merchantId) {
        return;
      }

      insertFixedAssignmentStatement.run(
        templateId,
        merchantId,
        normalizeText(item.currency),
        Number.isInteger(item.rowIndex) ? item.rowIndex : index,
        now,
        now
      );
    });

    db
      .prepare('UPDATE templates SET updated_at = ? WHERE id = ?')
      .run(now, templateId);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function listTemplateBundleEntries(db) {
  return listTemplates(db).map((template) => {
    const payload = getTemplateMappings(db, template.id);
    return {
      templateKey: template.templateKey,
      name: template.name,
      sourceFileName: template.sourceFileName,
      headers: template.headers,
      mappings: payload ? payload.mappings.map((mapping) => ({ ...mapping })) : [],
      bigAccounts: payload ? payload.bigAccounts.map((item) => ({
        merchantId: item.merchantId,
        currencies: item.currencies.slice(),
        isMultiCurrency: Boolean(item.isMultiCurrency)
      })) : [],
      fixedAssignments: payload ? payload.fixedAssignments.map((item) => ({ ...item })) : [],
      createdAt: template.createdAt,
      updatedAt: template.updatedAt
    };
  });
}

module.exports = {
  deleteTemplate,
  getTemplate,
  getTemplateBigAccounts,
  getTemplateFixedAssignments,
  getTemplateByKey,
  getTemplateByName,
  getTemplateMappings,
  listTemplateBundleEntries,
  listTemplates,
  renameTemplate,
  saveMappings,
  upsertTemplate
};
