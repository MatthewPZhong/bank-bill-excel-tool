// v2.1.10 N4-cont-1 T23 (Phase 4)：raw_json idle 自动清理函数（v0.5 修订 · partial run 守卫）
//
// ⚠️ v0.5 修订（2026-05-28 SR-FIX-1 Round 3 Codex F1）：新增"partial run 关联 month 排除"子查询
//   触发场景：chunked run 跑到 chunk M/N → cancel / worker crash → chunk_progress.status='partial'
//     - 此时 diff_rows 仅包含「已处理 mismatches」；任何"后续 bill rows（resume 时会变 mismatches 的）"仍未进 diff_rows
//     - 如 idle retention 在 bill imported_at 老于窗口时跑 → 清掉这些"未来 mismatch"的 raw_json
//     - 用户 resume 后 → INSERT 进来的 diff rows，writer 路径仍解析 d.bill_raw_json → 输出 broken / 不完整
//   修复（Round 3 F1）：排除 partial run 关联 month 的所有 bill（不仅差异行）— 直到 partial 完成 resume → status='complete'
//
// v0.3 (2026-05-28)：sentinel 从 NULL 改 ''（保留下面的历史注释）
//
// 资金红线：本函数不可逆 UPDATE raw_json = ''；NOT IN 子查询是数据保护核心 — 差异行 raw_json 永远保留
//
// ⚠️ v0.3 修订（2026-05-28）：sentinel 从 NULL 改 ''
//   原因：bill_imports.raw_json schema = `TEXT NOT NULL`（migrations.js:1500，v2.1.8 N4 引入约束）
//   后果：SET raw_json = NULL 被 SQLite 拒绝 → 永远清不掉 → 治理效果 0
//   修复：sentinel 改 ''（保持 NOT NULL 兼容，字节代价仅 +1 vs NULL；语义不变"已清"）
//
// 核心 SQL（spec §4.2.1 v0.5）：
//   UPDATE acquiring_bill_currency_bill_imports
//   SET raw_json = ''
//   WHERE id IN (
//     SELECT b.id FROM acquiring_bill_currency_bill_imports b
//     WHERE b.raw_json != ''
//       AND b.imported_at < datetime('now', '-' || ? || ' days')
//       AND b.id NOT IN (
//         SELECT DISTINCT bill_import_id FROM acquiring_bill_currency_diff_rows
//       )
//       -- v0.5 (Round 3 F1) 新增：排除 partial run 关联月份的所有 bill
//       AND b.month_key NOT IN (
//         SELECT DISTINCT month_key FROM acquiring_bill_currency_runs
//         WHERE chunk_progress IS NOT NULL
//           AND json_extract(chunk_progress, '$.status') = 'partial'
//       )
//   )
//
// SQL 关键不变量（spec §4.2.2 v0.5）：
//   - `b.raw_json != ''`：跳过已清的行（idempotent — 多次 idle 触发不重复清同行；'' 是 "已清" sentinel）
//   - `b.imported_at < datetime('now', '-' || ? || ' days')`：仅清"老于 N 天"的行
//   - `NOT IN (SELECT DISTINCT bill_import_id FROM acquiring_bill_currency_diff_rows)`：
//     排除差异行 — 保证差异行 raw_json 永远不被清（writer.js:184 重导差异 xlsx 依赖）
//   - **v0.5 新增** `b.month_key NOT IN (SELECT month_key FROM runs WHERE chunk_progress IS NOT NULL AND json_extract(...) = 'partial')`：
//     排除 partial run 关联月份的全部 bill（无论是否已进 diff_rows）— 保证 resume 后新增 mismatch 行的 raw_json 完整
//     注：`chunk_progress` 是 v2.1.10 A4 T19 新加的 TEXT JSON 字段；`json_extract` 是 SQLite 内置（v2.1.8 N4 已使用）
//     如 partial run 完成 resume → status='complete' → 不再排除 → 下次 idle cleanup 可清非差异行
//   - `SET raw_json = ''`：保留行骨架 + 业务字段；不删整行；不破坏 N4-cont-2 FK CASCADE 路径；
//     兼容 v2.1.8 N4 NOT NULL 约束（不动 schema）
//
// 调用契约：
//   - retentionDays 必须来自 settings getter（settings-repository.getAcquiringBillRawJsonRetentionDays）
//   - 参数化绑定（防 SQL injection）— retentionDays 直接传给 stmt.run(?)
//   - 不在函数内 BEGIN/COMMIT（如 caller 已在事务中可复用）
//   - 不调 activity log（caller 在 idle cleanup 中追加 log entry）
//   - 不修改 diff_rows 表 / runs 表
//   - 不删 bill_imports 行（只 NULL 化 raw_json 字段）
//   - 失败：throw（catch 留给 caller idle cleanup）
//
// 性能：单条 UPDATE WHERE id IN (SELECT … WHERE NOT IN … AND month_key NOT IN …) 在 100w 行规模 < 5s
//   - 双 NOT IN 子查询：diff_rows 子查询命中 PK index；runs 子查询行数 < 100（每月最多 1-2 run，partial 时刻通常 ≤ 1）
//   - json_extract 在 runs 子查询 SELECT 列上调（行数小，cost 可忽略）

'use strict';

// v0.5 (2026-05-28 SR-FIX-1 Round 3 F1)：新增 partial run 关联 month 排除子查询
// v0.3 (2026-05-28): sentinel 从 NULL 改 ''
//   - bill_imports.raw_json schema = `TEXT NOT NULL`（v2.1.8 N4）— NULL 会被 SQLite 拒绝
//   - '' 兼容 NOT NULL + 等价 "已清" sentinel（字节 +1 vs NULL；vs v0.1 '{}' 仍省 1 字节）
const CLEAR_STALE_SQL = `
  UPDATE acquiring_bill_currency_bill_imports
  SET raw_json = ''
  WHERE id IN (
    SELECT b.id FROM acquiring_bill_currency_bill_imports b
    WHERE b.raw_json != ''
      AND b.imported_at < datetime('now', '-' || ? || ' days')
      AND b.id NOT IN (
        SELECT DISTINCT bill_import_id FROM acquiring_bill_currency_diff_rows
      )
      AND b.month_key NOT IN (
        SELECT DISTINCT month_key FROM acquiring_bill_currency_runs
        WHERE chunk_progress IS NOT NULL
          AND json_extract(chunk_progress, '$.status') = 'partial'
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
