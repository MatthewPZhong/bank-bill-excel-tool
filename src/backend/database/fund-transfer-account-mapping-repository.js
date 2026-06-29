// v3.0.12 功能2（批A）：账户映射管理仓储 —— 全局对照表「中台调拨单账户号 → 清结算系统银行账号」。
//   表：fund_transfer_account_mappings（migrations.ensureFundTransferAccountMappingSupport 建表，UNIQUE(mid_account_id)）。
//   归一化口径：账号统一走引擎 normalizeCellValue（trim + String 化），与调拨派生 / 对账引擎单一真相对齐
//   —— 批B 派生 buildFundTransferReconRows 时用 getMappingMap 快查替换 big_account，键值口径必须与本仓写入一致。
//   保存语义：事务内全删 + 重插（整表覆盖），与 settings-repository.saveAccountMappings 同范式。
const { normalizeCellValue } = require('../../main-process/scenario-engines/engine-utils');

// 按 row_index 升序返回 [{ midAccountId, clearingAccountId }]（UI 回填 / 列表展示用，保留用户编辑顺序）。
function listMappings(db) {
  return db
    .prepare(`
      SELECT
        mid_account_id AS midAccountId,
        clearing_account_id AS clearingAccountId
      FROM fund_transfer_account_mappings
      ORDER BY row_index ASC, id ASC
    `)
    .all();
}

// 整表覆盖保存：先归一化 + 校验（校验失败不动 DB），再事务内全删重插。
//   - 两列皆空 → 跳过（空行不入库，与 account_mappings 同口径）。
//   - 仅一列为空 → 抛错（防半填脏映射）。
//   - 账号统一 normalizeCellValue（写入即归一化，使存量与 getMappingMap 口径一致）。
//   - 重复 mid_account_id 由 UNIQUE 约束兜底（违例 → 事务回滚；友好提示由 IPC 层 validate 先行拦截）。
function saveMappings(db, mappings) {
  const list = Array.isArray(mappings) ? mappings : [];
  const now = new Date().toISOString();

  const cleaned = [];
  list.forEach((mapping) => {
    const midAccountId = normalizeCellValue(mapping && mapping.midAccountId);
    const clearingAccountId = normalizeCellValue(mapping && mapping.clearingAccountId);

    if (midAccountId === '' && clearingAccountId === '') {
      return; // 空行跳过
    }
    if (midAccountId === '' || clearingAccountId === '') {
      throw new Error('账户映射存在未填写完整的行（中台调拨单账户号 / 清结算系统银行账号 必须同时填写）');
    }
    cleaned.push({ midAccountId, clearingAccountId });
  });

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM fund_transfer_account_mappings').run();

    const insertStatement = db.prepare(`
      INSERT INTO fund_transfer_account_mappings (
        mid_account_id, clearing_account_id, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `);

    cleaned.forEach((mapping, index) => {
      insertStatement.run(mapping.midAccountId, mapping.clearingAccountId, index, now, now);
    });

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// 返回归一化 Map<midAccountId, clearingAccountId>（供批B派生快查；键值再归一化一遍幂等托底）。
//   🔴 空键护栏：归一化后键为空的行不进 Map（与引擎 big_account 非空护栏同理，防空账号误命中）。
function getMappingMap(db) {
  const rows = db
    .prepare(`
      SELECT
        mid_account_id AS midAccountId,
        clearing_account_id AS clearingAccountId
      FROM fund_transfer_account_mappings
      ORDER BY row_index ASC, id ASC
    `)
    .all();

  const map = new Map();
  rows.forEach((row) => {
    const key = normalizeCellValue(row.midAccountId);
    if (key === '') return; // 空键护栏
    map.set(key, normalizeCellValue(row.clearingAccountId));
  });
  return map;
}

module.exports = {
  listMappings,
  saveMappings,
  getMappingMap,
};
