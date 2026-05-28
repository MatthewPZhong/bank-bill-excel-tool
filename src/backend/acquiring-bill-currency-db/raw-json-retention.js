// v2.1.10 N4-cont-1 T23 (Phase 4)：raw_json idle 自动清理函数（v0.2 重写 · 极简单 SQL）
//
// 资金红线：本函数不可逆 UPDATE raw_json = NULL；NOT IN 子查询是数据保护核心 — 差异行 raw_json 永远保留
//
// 核心 SQL（spec §4.2.1）：
//   UPDATE acquiring_bill_currency_bill_imports
//   SET raw_json = NULL
//   WHERE id IN (
//     SELECT b.id FROM acquiring_bill_currency_bill_imports b
//     WHERE b.raw_json IS NOT NULL
//       AND b.imported_at < datetime('now', '-' || ? || ' days')
//       AND b.id NOT IN (
//         SELECT DISTINCT bill_import_id FROM acquiring_bill_currency_diff_rows
//       )
//   )
//
// SQL 关键不变量（spec §4.2.2）：
//   - `b.raw_json IS NOT NULL`：跳过已清的行（idempotent — 多次 idle 触发不重复清同行）
//   - `b.imported_at < datetime('now', '-' || ? || ' days')`：仅清"老于 N 天"的行
//   - `NOT IN (SELECT DISTINCT bill_import_id FROM acquiring_bill_currency_diff_rows)`：
//     排除差异行 — 保证差异行 raw_json 永远不被清（writer.js:184 重导差异 xlsx 依赖）
//   - `SET raw_json = NULL`：保留行骨架 + 业务字段；不删整行；不破坏 N4-cont-2 FK CASCADE 路径
//
// 调用契约：
//   - retentionDays 必须来自 settings getter（settings-repository.getAcquiringBillRawJsonRetentionDays）
//   - 参数化绑定（防 SQL injection）— retentionDays 直接传给 stmt.run(?)
//   - 不在函数内 BEGIN/COMMIT（如 caller 已在事务中可复用）
//   - 不调 activity log（caller 在 idle cleanup 中追加 log entry）
//   - 不修改 diff_rows 表
//   - 不删 bill_imports 行（只 NULL 化 raw_json 字段）
//   - 失败：throw（catch 留给 caller idle cleanup）
//
// 性能：单条 UPDATE WHERE id IN (SELECT … WHERE NOT IN …) 在 100w 行规模 < 5s（spec §五.2 N1' 共存性能预期）

'use strict';

const CLEAR_STALE_SQL = `
  UPDATE acquiring_bill_currency_bill_imports
  SET raw_json = NULL
  WHERE id IN (
    SELECT b.id FROM acquiring_bill_currency_bill_imports b
    WHERE b.raw_json IS NOT NULL
      AND b.imported_at < datetime('now', '-' || ? || ' days')
      AND b.id NOT IN (
        SELECT DISTINCT bill_import_id FROM acquiring_bill_currency_diff_rows
      )
  )
`;

/**
 * 清理对账成功（不在 diff_rows 中）且 imported_at < retentionDays 天前的 bill_imports.raw_json。
 *
 * @param {DatabaseSync} db - SQLite 连接（必须能访问 acquiring_bill_currency_bill_imports + diff_rows 两表）
 * @param {Object} options
 * @param {number} options.retentionDays - 保留窗口天数（来自 settings getter，范围 [1, 30]，外回退 7）
 * @returns {{ clearedCount: number, elapsedMs: number }} 清理统计
 * @throws {Error} SQL 错误（SQLITE_BUSY / SQLITE_CORRUPT / FK schema 异常等）
 */
function clearStaleSuccessfulRawJson(db, { retentionDays } = {}) {
  if (db == null || typeof db.prepare !== 'function') {
    throw new Error('clearStaleSuccessfulRawJson: db 参数无效（缺少 prepare 方法）');
  }
  // retentionDays 严校验：caller 应已用 settings getter 做范围外回退，此处仍兜底防御
  //   注：底层 SQL 用 parameterized binding（`stmt.run(?)`）+ SQLite datetime modifier 接受 integer days
  //   不接受字符串如 '7 OR 1=1' — 即使绑定也会 SQL 语义错误（参数化绑定本身就防 SQL injection）
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(
      `clearStaleSuccessfulRawJson: retentionDays 必须是 ≥ 1 的整数，收到：${JSON.stringify(retentionDays)}`
    );
  }

  const startTs = Date.now();
  const result = db.prepare(CLEAR_STALE_SQL).run(retentionDays);
  const elapsedMs = Date.now() - startTs;

  return {
    clearedCount: result.changes || 0,
    elapsedMs
  };
}

module.exports = {
  clearStaleSuccessfulRawJson,
  // export SQL for potential test inspection（不在主线代码中调用）
  __CLEAR_STALE_SQL__: CLEAR_STALE_SQL
};
