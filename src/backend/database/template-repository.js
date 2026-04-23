const { randomUUID } = require('node:crypto');
const {
  buildTemplateSummaryFromRow,
  groupBigAccountRows,
  normalizeText,
  parseJsonArray
} = require('./utils');

function listTemplates(db) {
  // v1.5.3 R2 §3.1：bigAccountCount / singleBigAccountMerchantId 不含自有账号
  // JOIN ON 条件加 ba.account_nature='client'（保留 LEFT JOIN 语义：无 client 的模板仍返回 count=0）
  const statement = db.prepare(`
    SELECT
      t.id,
      t.template_key AS templateKey,
      t.name,
      t.source_file_name AS sourceFileName,
      t.headers_json AS headersJson,
      t.created_at AS createdAt,
      t.updated_at AS updatedAt,
      t.date_format AS dateFormat,
      t.is_parent AS isParent,
      t.parent_template_id AS parentTemplateId,
      t.filename_fixed_field AS filenameFixedField,
      COUNT(DISTINCT m.id) AS mappingCount,
      COUNT(DISTINCT ba.merchant_id) AS bigAccountCount,
      merchant_mapping.mapped_field AS merchantIdMappedField,
      MIN(ba.merchant_id) AS singleBigAccountMerchantId
    FROM templates t
    LEFT JOIN template_mappings m ON m.template_id = t.id
    LEFT JOIN template_big_accounts ba
      ON ba.template_id = t.id AND ba.account_nature = 'client'
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
        t.date_format AS dateFormat,
        t.is_parent AS isParent,
        t.parent_template_id AS parentTemplateId,
        t.filename_fixed_field AS filenameFixedField,
        (
          SELECT COUNT(1)
          FROM template_mappings m
          WHERE m.template_id = t.id
        ) AS mappingCount,
        (
          SELECT COUNT(DISTINCT merchant_id)
          FROM template_big_accounts ba
          WHERE ba.template_id = t.id AND ba.account_nature = 'client'
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
          WHERE ba.template_id = t.id AND ba.account_nature = 'client'
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

// v1.5.3 R2 迁移专用：按 bankName 查所有 splitTemplateName(name).bankName 匹配的模板
// 注：splitTemplateName 实现在 balance-seed-store.js —— 这里按 '-' 前缀匹配，避免循环依赖
function getTemplatesByBankName(db, bankName) {
  const target = normalizeText(bankName);
  if (!target) return [];
  return db
    .prepare(`
      SELECT id, name
      FROM templates
      WHERE name = ? OR name LIKE ?
      ORDER BY id ASC
    `)
    .all(target, `${target}-%`)
    .map((row) => ({ id: row.id, name: normalizeText(row.name) }))
    .filter((t) => {
      // 与 splitTemplateName 口径严格一致：name.split('-')[0] === bankName
      const firstPart = t.name.split('-')[0] || '';
      return firstPart === target;
    });
}

function listChildTemplates(db, parentTemplateId) {
  return db.prepare(`
    SELECT
      t.id,
      t.template_key AS templateKey,
      t.name,
      t.source_file_name AS sourceFileName,
      t.headers_json AS headersJson,
      t.created_at AS createdAt,
      t.updated_at AS updatedAt,
      t.date_format AS dateFormat,
      t.is_parent AS isParent,
      t.parent_template_id AS parentTemplateId,
      t.filename_fixed_field AS filenameFixedField,
      (SELECT COUNT(1) FROM template_mappings m WHERE m.template_id = t.id) AS mappingCount,
      (SELECT COUNT(DISTINCT merchant_id) FROM template_big_accounts ba WHERE ba.template_id = t.id AND ba.account_nature = 'client') AS bigAccountCount,
      (SELECT mapped_field FROM template_mappings mm WHERE mm.template_id = t.id AND mm.template_field = 'MerchantId' LIMIT 1) AS merchantIdMappedField,
      (SELECT MIN(merchant_id) FROM template_big_accounts ba WHERE ba.template_id = t.id AND ba.account_nature = 'client') AS singleBigAccountMerchantId
    FROM templates t
    WHERE t.parent_template_id = ?
    ORDER BY t.id ASC
  `).all(parentTemplateId).map((row) => buildTemplateSummaryFromRow(row));
}

function setParentStatus(db, templateId, isParent) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE templates SET is_parent = ?, updated_at = ? WHERE id = ?').run(isParent ? 1 : 0, now, templateId);
    if (!isParent) {
      // 取消主模板身份时，将子模板的 parent_template_id 置 NULL
      db.prepare('UPDATE templates SET parent_template_id = NULL, updated_at = ? WHERE parent_template_id = ?').run(now, templateId);
    }
    // 设为主模板时，确保自身不是子模板
    if (isParent) {
      db.prepare('UPDATE templates SET parent_template_id = NULL, updated_at = ? WHERE id = ?').run(now, templateId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function setChildParent(db, templateId, parentTemplateId) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    if (parentTemplateId) {
      // 设为子模板：设置 parent_template_id，清除 is_parent
      db.prepare('UPDATE templates SET parent_template_id = ?, is_parent = 0, updated_at = ? WHERE id = ?')
        .run(parentTemplateId, now, templateId);
    } else {
      // 取消子模板身份
      db.prepare('UPDATE templates SET parent_template_id = NULL, updated_at = ? WHERE id = ?')
        .run(now, templateId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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

// v1.5.2 需求 3：保存模板的文件名固定字段
// 输入：templateId（数字），value（字符串，允许空串）
function saveTemplateFilenameFixedField(db, templateId, value) {
  const now = new Date().toISOString();
  db
    .prepare('UPDATE templates SET filename_fixed_field = ?, updated_at = ? WHERE id = ?')
    .run(String(value ?? ''), now, templateId);
}

// v1.5.3 R2 §3.1：默认仅返回 account_nature='client'；
// R1 月度余额导出场景显式传 { includeOwn: true } 才返回自有账号
function getTemplateBigAccounts(db, templateId, { includeOwn = false } = {}) {
  const natureClause = includeOwn ? '' : "AND account_nature = 'client'";
  return db
    .prepare(`
      SELECT
        merchant_id AS merchantId,
        currency,
        row_index AS rowIndex,
        account_nature AS accountNature
      FROM template_big_accounts
      WHERE template_id = ? ${natureClause}
      ORDER BY row_index ASC, id ASC
    `)
    .all(templateId)
    .map((row) => ({
      merchantId: normalizeText(row.merchantId),
      currency: normalizeText(row.currency),
      rowIndex: Number(row.rowIndex || 0),
      accountNature: normalizeText(row.accountNature) || 'client'
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

function getAmountSplitRules(db, templateId) {
  return db
    .prepare(`
      SELECT
        target_field AS targetField,
        condition_field AS conditionField,
        condition_value AS conditionValue,
        mapped_field AS mappedField,
        row_index AS rowIndex
      FROM template_amount_split_rules
      WHERE template_id = ?
      ORDER BY row_index ASC
    `)
    .all(templateId)
    .map((row) => ({
      targetField: normalizeText(row.targetField),
      conditionField: normalizeText(row.conditionField),
      conditionValue: normalizeText(row.conditionValue),
      mappedField: normalizeText(row.mappedField),
      rowIndex: Number(row.rowIndex || 0)
    }));
}

function saveAmountSplitRules(db, templateId, rules = []) {
  const now = new Date().toISOString();
  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM template_amount_split_rules WHERE template_id = ?').run(templateId);

    const insertStatement = db.prepare(`
      INSERT INTO template_amount_split_rules (
        template_id, target_field, condition_field, condition_value, mapped_field, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    rules.forEach((rule, index) => {
      insertStatement.run(
        templateId,
        normalizeText(rule.targetField),
        normalizeText(rule.conditionField),
        normalizeText(rule.conditionValue),
        normalizeText(rule.mappedField),
        Number.isInteger(rule.rowIndex) ? rule.rowIndex : index,
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
  const amountSplitRules = getAmountSplitRules(db, templateId);

  return {
    template,
    mappings,
    bigAccounts: groupBigAccountRows(bigAccountRows),
    fixedAssignments,
    amountSplitRules,
    billSplitMappings: getBillSplitMappings(db, templateId),
    billSplitRows: getBillSplitRows(db, templateId),
    billSplitAmountRules: getBillSplitAmountRules(db, templateId),
    billSplitMeta: getBillSplitMeta(db, templateId)
  };
}

// v1.5.3 R2 round 3 修复 (Codex Finding 5)：
// 用户在 mapping dialog 直接保存（不开维护大账号）时，前端 currentBigAccounts 来自 §3.1 过滤后的 client-only 列表，
// 旧 saveMappings 直接 DELETE all + INSERT all → 数据库 own 被静默删除。
// 修复：新增 `preserveOwn` 参数（默认 false 保持向后兼容旧行为；仅 mapping dialog 显式传 true 才生效）：
//   - false（默认 = 旧行为）→ DELETE all + INSERT all（caller 已显式接管 own，传含 own 全集；如 bundle 导入 / mapping dialog onDone 含 own 路径）
//   - true → DELETE 只删 client，INSERT 仅接收 client 行（own 不动；caller 是 mapping dialog 直接保存路径）
// 调用方约定：bigAccountsLoadedWithOwn=false → preserveOwn=true；=true → preserveOwn=false
function saveMappings(
  db,
  templateId,
  mappings,
  bigAccounts = [],
  fixedAssignments = [],
  dateFormat,
  amountSplitRules = null,
  { preserveOwn = false } = {}
) {
  const now = new Date().toISOString();
  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM template_mappings WHERE template_id = ?').run(templateId);
    if (preserveOwn) {
      // 仅删 client；own 保留（caller 没接管 own）
      db.prepare("DELETE FROM template_big_accounts WHERE template_id = ? AND account_nature = 'client'").run(templateId);
    } else {
      db.prepare('DELETE FROM template_big_accounts WHERE template_id = ?').run(templateId);
    }
    db.prepare('DELETE FROM template_fixed_assignments WHERE template_id = ?').run(templateId);

    const insertMappingStatement = db.prepare(`
      INSERT INTO template_mappings (
        template_id, template_field, mapped_field, mapped_fields_json, row_index, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    // v1.5.3 R2：account_nature 字段入库（前端缺省 → 'client'；'own' 仅迁移 / 导入 excel 带入）
    const insertBigAccountStatement = db.prepare(`
      INSERT INTO template_big_accounts (
        template_id, merchant_id, currency, row_index, account_nature, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
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
      // v1.5.3 R2：account_nature 仅接受 'client' / 'own'；缺省或非法 → 'client'
      const rawNature = normalizeText(item.accountNature);
      const accountNature = rawNature === 'own' ? 'own' : 'client';
      // preserveOwn=true 时 caller 应只传 client 行；防御性跳过 own 行避免与已存的 own 冲突 (UNIQUE 约束)
      if (preserveOwn && accountNature === 'own') {
        return;
      }
      insertBigAccountStatement.run(
        templateId,
        item.merchantId,
        item.currency,
        index,
        accountNature,
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

    if (amountSplitRules !== null) {
      db.prepare('DELETE FROM template_amount_split_rules WHERE template_id = ?').run(templateId);

      const insertRuleStatement = db.prepare(`
        INSERT INTO template_amount_split_rules (
          template_id, target_field, condition_field, condition_value, mapped_field, row_index, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      amountSplitRules.forEach((rule, index) => {
        insertRuleStatement.run(
          templateId,
          normalizeText(rule.targetField),
          normalizeText(rule.conditionField),
          normalizeText(rule.conditionValue),
          normalizeText(rule.mappedField),
          Number.isInteger(rule.rowIndex) ? rule.rowIndex : index,
          now,
          now
        );
      });
    }

    if (dateFormat) {
      db.prepare('UPDATE templates SET updated_at = ?, date_format = ? WHERE id = ?').run(now, dateFormat, templateId);
    } else {
      db.prepare('UPDATE templates SET updated_at = ? WHERE id = ?').run(now, templateId);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getBillSplitMappings(db, templateId) {
  return db
    .prepare(`
      SELECT
        row_index AS rowIndex,
        template_field AS templateField,
        mapped_field AS mappedField,
        mapped_fields_json AS mappedFieldsJson
      FROM template_bill_split_mappings
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
}

function saveBillSplitMappings(db, templateId, mappings = []) {
  const now = new Date().toISOString();
  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM template_bill_split_mappings WHERE template_id = ?').run(templateId);

    const insertStatement = db.prepare(`
      INSERT INTO template_bill_split_mappings (
        template_id, template_field, mapped_field, mapped_fields_json, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    (Array.isArray(mappings) ? mappings : []).forEach((mapping, index) => {
      const templateField = normalizeText(mapping.templateField);
      const mappedField = normalizeText(mapping.mappedField);
      const mappedFields = Array.from(
        new Set(
          (Array.isArray(mapping.mappedFields) ? mapping.mappedFields : [])
            .map((value) => normalizeText(value))
            .filter((value) => value !== '')
        )
      );
      if (!templateField || (!mappedField && mappedFields.length === 0)) {
        return;
      }
      insertStatement.run(
        templateId,
        templateField,
        mappedField,
        JSON.stringify(mappedFields),
        Number.isInteger(mapping.rowIndex) ? mapping.rowIndex : index,
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

function getBillSplitRows(db, templateId) {
  return db
    .prepare(`
      SELECT
        seq_no AS seqNo,
        currency_source_field AS currencySourceField,
        credit_source_field AS creditSourceField,
        debit_source_field AS debitSourceField,
        amount_source_field AS amountSourceField,
        row_status AS rowStatus,
        merged_group_seq AS mergedGroupSeq
      FROM template_bill_split_rows
      WHERE template_id = ?
      ORDER BY seq_no ASC
    `)
    .all(templateId)
    .map((row) => ({
      seqNo: Number(row.seqNo),
      currencySourceField: normalizeText(row.currencySourceField),
      creditSourceField: normalizeText(row.creditSourceField),
      debitSourceField: normalizeText(row.debitSourceField),
      amountSourceField: normalizeText(row.amountSourceField),
      rowStatus: normalizeText(row.rowStatus) || 'draft',
      mergedGroupSeq: row.mergedGroupSeq === null || row.mergedGroupSeq === undefined ? null : Number(row.mergedGroupSeq)
    }));
}

function saveBillSplitRowCount(db, templateId, nextN) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    if (nextN === 0) {
      db.prepare('DELETE FROM template_bill_split_rows WHERE template_id = ?').run(templateId);
      db.exec('COMMIT');
      return;
    }

    const existingRows = db
      .prepare('SELECT seq_no, merged_group_seq FROM template_bill_split_rows WHERE template_id = ? ORDER BY seq_no ASC')
      .all(templateId);
    const currentM = existingRows.length;

    if (nextN > currentM) {
      const insertStmt = db.prepare(`
        INSERT INTO template_bill_split_rows (
          template_id, seq_no, currency_source_field, credit_source_field, debit_source_field,
          amount_source_field, row_status, merged_group_seq, created_at, updated_at
        ) VALUES (?, ?, '', '', '', '', 'draft', NULL, ?, ?)
      `);
      for (let seq = currentM + 1; seq <= nextN; seq += 1) {
        insertStmt.run(templateId, seq, now, now);
      }
    } else if (nextN < currentM) {
      const dissolvedGroups = db
        .prepare('SELECT DISTINCT merged_group_seq FROM template_bill_split_rows WHERE template_id = ? AND seq_no > ? AND merged_group_seq IS NOT NULL')
        .all(templateId, nextN)
        .map((row) => Number(row.merged_group_seq));
      if (dissolvedGroups.length > 0) {
        const placeholders = dissolvedGroups.map(() => '?').join(',');
        db.prepare(`UPDATE template_bill_split_rows SET merged_group_seq = NULL, updated_at = ? WHERE template_id = ? AND merged_group_seq IN (${placeholders})`)
          .run(now, templateId, ...dissolvedGroups);
      }
      db.prepare('DELETE FROM template_bill_split_rows WHERE template_id = ? AND seq_no > ?').run(templateId, nextN);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function saveBillSplitRow(db, templateId, row) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE template_bill_split_rows
    SET currency_source_field = ?,
        credit_source_field = ?,
        debit_source_field = ?,
        amount_source_field = ?,
        row_status = ?,
        updated_at = ?
    WHERE template_id = ? AND seq_no = ?
  `).run(
    normalizeText(row.currencySourceField),
    normalizeText(row.creditSourceField),
    normalizeText(row.debitSourceField),
    normalizeText(row.amountSourceField),
    row.rowStatus === 'completed' ? 'completed' : 'draft',
    now,
    templateId,
    Number(row.seqNo)
  );
}

function deleteBillSplitRow(db, templateId, seqNo) {
  // Q-OT6 = C / C1 surgical: 删除行 + 解除受影响的合并组以维护 PRD §Q-A3 不变量
  // 受影响 = (1) 删除行自身所在的合并组 (2) 任一其它合并组中存在 seq >= seqNo 的成员
  const now = new Date().toISOString();
  const dissolvedGroups = [];
  db.exec('BEGIN');
  try {
    const target = db
      .prepare('SELECT merged_group_seq FROM template_bill_split_rows WHERE template_id = ? AND seq_no = ?')
      .get(templateId, seqNo);
    if (!target) {
      db.exec('COMMIT');
      return { dissolvedGroups };
    }

    if (target.merged_group_seq !== null && target.merged_group_seq !== undefined) {
      dissolvedGroups.push(Number(target.merged_group_seq));
    }
    const otherAffected = db
      .prepare(`
        SELECT DISTINCT merged_group_seq
        FROM template_bill_split_rows
        WHERE template_id = ?
          AND merged_group_seq IS NOT NULL
          AND seq_no >= ?
          AND seq_no != ?
      `)
      .all(templateId, seqNo, seqNo)
      .map((row) => Number(row.merged_group_seq))
      .filter((groupSeq) => !dissolvedGroups.includes(groupSeq));
    dissolvedGroups.push(...otherAffected);

    if (dissolvedGroups.length > 0) {
      const placeholders = dissolvedGroups.map(() => '?').join(',');
      db.prepare(`
        UPDATE template_bill_split_rows
        SET merged_group_seq = NULL, updated_at = ?
        WHERE template_id = ? AND merged_group_seq IN (${placeholders})
      `).run(now, templateId, ...dissolvedGroups);
    }

    db.prepare('DELETE FROM template_bill_split_rows WHERE template_id = ? AND seq_no = ?').run(templateId, seqNo);

    db.prepare(`
      UPDATE template_bill_split_rows
      SET seq_no = seq_no - 1,
          updated_at = ?
      WHERE template_id = ? AND seq_no > ?
    `).run(now, templateId, seqNo);

    db.exec('COMMIT');
    return { dissolvedGroups };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function saveBillSplitMergeGroup(db, templateId, seqNos = []) {
  if (!Array.isArray(seqNos) || seqNos.length < 2) {
    return;
  }
  const minSeq = Math.min(...seqNos.map(Number));
  const now = new Date().toISOString();
  const placeholders = seqNos.map(() => '?').join(',');
  db.prepare(`
    UPDATE template_bill_split_rows
    SET merged_group_seq = ?,
        updated_at = ?
    WHERE template_id = ? AND seq_no IN (${placeholders})
  `).run(minSeq, now, templateId, ...seqNos.map(Number));
}

function clearBillSplitMergeGroups(db, templateId) {
  const now = new Date().toISOString();
  db.prepare('UPDATE template_bill_split_rows SET merged_group_seq = NULL, updated_at = ? WHERE template_id = ? AND merged_group_seq IS NOT NULL')
    .run(now, templateId);
}

function getBillSplitAmountRules(db, templateId) {
  return db
    .prepare(`
      SELECT
        target_field AS targetField,
        condition_field AS conditionField,
        condition_value AS conditionValue,
        mapped_field AS mappedField,
        row_index AS rowIndex
      FROM template_bill_split_amount_rules
      WHERE template_id = ?
      ORDER BY row_index ASC
    `)
    .all(templateId)
    .map((row) => ({
      targetField: normalizeText(row.targetField),
      conditionField: normalizeText(row.conditionField),
      conditionValue: normalizeText(row.conditionValue),
      mappedField: normalizeText(row.mappedField),
      rowIndex: Number(row.rowIndex || 0)
    }));
}

function saveBillSplitAmountRules(db, templateId, rules = []) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM template_bill_split_amount_rules WHERE template_id = ?').run(templateId);
    const insertStmt = db.prepare(`
      INSERT INTO template_bill_split_amount_rules (
        template_id, target_field, condition_field, condition_value, mapped_field, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    (Array.isArray(rules) ? rules : []).forEach((rule, index) => {
      insertStmt.run(
        templateId,
        normalizeText(rule.targetField),
        normalizeText(rule.conditionField),
        normalizeText(rule.conditionValue),
        normalizeText(rule.mappedField),
        Number.isInteger(rule.rowIndex) ? rule.rowIndex : index,
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

function getBillSplitMeta(db, templateId) {
  const row = db
    .prepare(`
      SELECT
        signed_amount_source_field AS signedAmountSourceField,
        signed_amount_target_seq_nos AS signedAmountTargetSeqNos,
        by_field_amount_target_seq_nos AS byFieldAmountTargetSeqNos
      FROM template_bill_split_meta
      WHERE template_id = ?
    `)
    .get(templateId);
  return {
    signedAmountSourceField: row ? normalizeText(row.signedAmountSourceField) : '',
    signedAmountTargetSeqNos: row && row.signedAmountTargetSeqNos
      ? row.signedAmountTargetSeqNos.split(',').filter(Boolean).map(Number)
      : [],
    byFieldAmountTargetSeqNos: row && row.byFieldAmountTargetSeqNos
      ? row.byFieldAmountTargetSeqNos.split(',').filter(Boolean).map(Number)
      : []
  };
}

function saveBillSplitMeta(db, templateId, meta = {}) {
  const now = new Date().toISOString();
  const value = normalizeText(meta && meta.signedAmountSourceField);
  const signedTargetSeqNos = Array.isArray(meta.signedAmountTargetSeqNos)
    ? meta.signedAmountTargetSeqNos.join(',')
    : '';
  const byFieldTargetSeqNos = Array.isArray(meta.byFieldAmountTargetSeqNos)
    ? meta.byFieldAmountTargetSeqNos.join(',')
    : '';
  const existing = db.prepare('SELECT 1 FROM template_bill_split_meta WHERE template_id = ?').get(templateId);
  if (existing) {
    db.prepare(`
      UPDATE template_bill_split_meta
      SET signed_amount_source_field = ?,
          signed_amount_target_seq_nos = ?,
          by_field_amount_target_seq_nos = ?,
          updated_at = ?
      WHERE template_id = ?
    `).run(value, signedTargetSeqNos, byFieldTargetSeqNos, now, templateId);
  } else {
    db.prepare(`
      INSERT INTO template_bill_split_meta (
        template_id, signed_amount_source_field, signed_amount_target_seq_nos,
        by_field_amount_target_seq_nos, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(templateId, value, signedTargetSeqNos, byFieldTargetSeqNos, now, now);
  }
}

function listTemplateBundleEntries(db) {
  return listTemplates(db).map((template) => {
    const payload = getTemplateMappings(db, template.id);

    // v1.5.1: 主/子模板关系
    let parentTemplateKey = null;
    if (template.parentTemplateId) {
      const parentRow = db.prepare('SELECT template_key FROM templates WHERE id = ?').get(template.parentTemplateId);
      parentTemplateKey = parentRow ? normalizeText(parentRow.template_key) : null;
    }

    // v1.5.3 R2：bundle 导出带 accountNature，且包含 own 账号（bundle 是全量备份/恢复场景，特例放行）
    // 独立再查一次大账号（含 own），然后分组，避免依赖 payload.bigAccounts（后者来自 getTemplateMappings 默认过滤 own）
    const allBigAccountsWithNature = groupBigAccountRows(
      getTemplateBigAccounts(db, template.id, { includeOwn: true })
    );

    return {
      templateKey: template.templateKey,
      name: template.name,
      sourceFileName: template.sourceFileName,
      headers: template.headers,
      isParent: Boolean(template.isParent),
      parentTemplateKey,
      // v1.5.2 需求 3：文件名固定字段随 bundle 透传
      filenameFixedField: template.filenameFixedField || '',
      mappings: payload ? payload.mappings.map((mapping) => ({ ...mapping })) : [],
      bigAccounts: allBigAccountsWithNature.map((item) => ({
        merchantId: item.merchantId,
        currencies: item.currencies.slice(),
        isMultiCurrency: Boolean(item.isMultiCurrency),
        // v1.5.3 R2：bundleVersion 保持 v3，字段可选，旧版读取时被忽略
        accountNature: item.accountNature || 'client'
      })),
      fixedAssignments: payload ? payload.fixedAssignments.map((item) => ({ ...item })) : [],
      amountSplitRules: payload && Array.isArray(payload.amountSplitRules)
        ? payload.amountSplitRules.map((rule) => ({ ...rule }))
        : [],
      billSplitMappings: payload && Array.isArray(payload.billSplitMappings)
        ? payload.billSplitMappings.map((m) => ({ ...m, mappedFields: Array.isArray(m.mappedFields) ? m.mappedFields.slice() : [] }))
        : [],
      billSplitRows: payload && Array.isArray(payload.billSplitRows)
        ? payload.billSplitRows.map((r) => ({ ...r }))
        : [],
      billSplitAmountRules: payload && Array.isArray(payload.billSplitAmountRules)
        ? payload.billSplitAmountRules.map((r) => ({ ...r }))
        : [],
      billSplitMeta: payload && payload.billSplitMeta
        ? { signedAmountSourceField: payload.billSplitMeta.signedAmountSourceField || '' }
        : { signedAmountSourceField: '' },
      dateFormat: template.dateFormat || 'auto',
      createdAt: template.createdAt,
      updatedAt: template.updatedAt
    };
  });
}

module.exports = {
  clearBillSplitMergeGroups,
  deleteBillSplitRow,
  deleteTemplate,
  getAmountSplitRules,
  getBillSplitAmountRules,
  getBillSplitMappings,
  getBillSplitMeta,
  getBillSplitRows,
  getTemplate,
  getTemplateBigAccounts,
  getTemplateFixedAssignments,
  getTemplateByKey,
  getTemplateByName,
  getTemplateMappings,
  getTemplatesByBankName,
  listChildTemplates,
  listTemplateBundleEntries,
  listTemplates,
  renameTemplate,
  saveAmountSplitRules,
  saveBillSplitAmountRules,
  saveBillSplitMappings,
  saveBillSplitMergeGroup,
  saveBillSplitMeta,
  saveBillSplitRow,
  saveBillSplitRowCount,
  saveMappings,
  saveTemplateFilenameFixedField,
  setChildParent,
  setParentStatus,
  upsertTemplate
};
