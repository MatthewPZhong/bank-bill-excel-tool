// v2.1.16-beta.2 T2：5 轮对账引擎共用日期工具
//
// 设计要点（TECH_DESIGN §5.3 / §6）：
//   - 日期解析一律复用 normalizers.normalizeDateExportValue（禁止自写日期解析）：
//     它已覆盖 Excel 序列号（number，如 46155）、多种字符串格式（YYYY-MM-DD / YYYY/MM/DD / 中文年月日等）、
//     Date 实例、空/无效值；返回结构里取 .date（本地 new Date(y,m,d)，时分秒归零）。
//   - toDate(v)      : 取 normalizeDateExportValue(v).date；无效 / 空 → null。
//   - sameDay(a,b)   : 两侧 toDate，均非空且同「年-月-日」→ true；任一 null → false。
//   - dayDiffWithin(a,b,n): 两侧 toDate，均非空且 |round((da-db)/天毫秒)| <= n → true；任一 null → false。
//       · .date 为本地午夜，两本地午夜相减跨 DST 可能差 ±1 小时，Math.round 归整到整数天后判定（符合设计公式）。
//
// 用于 R5 场景2（FundTransfer 回填 ReconciliationId）的日期两阶段匹配（同日 / ±1day）。

const { normalizeDateExportValue } = require('../../backend/file-service/normalizers');

const MS_PER_DAY = 86400000;

// 解析任意日期输入为 Date（本地午夜）；无效 / 空 → null
function toDate(v) {
  const result = normalizeDateExportValue(v);
  if (!result || !result.date || Number.isNaN(result.date.getTime())) {
    return null;
  }
  return result.date;
}

// 两值是否同一「年-月-日」（任一无法解析 → false）
function sameDay(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return false;
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// 两值日期差是否在 n 天以内（含 n；任一无法解析 → false）
function dayDiffWithin(a, b, n) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return false;
  const diffDays = Math.abs(Math.round((da.getTime() - db.getTime()) / MS_PER_DAY));
  return diffDays <= n;
}

module.exports = { toDate, sameDay, dayDiffWithin };
