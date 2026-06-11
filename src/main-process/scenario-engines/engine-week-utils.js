// v3.0.4 块 F「Payment线下调拨订单回填处理」—— 周数 / FTA 解析纯函数地基（🔴 资金红线）
// changes/payment-offline-allocation-backfill/spec.md §F3
//
// 设计要点（独立于 engine-date-utils，保持后者纯日期语义）：
//   - 🔴 日期解析必须复用 engine-date-utils 的 toDate（内部走 normalizeDateExportValue）——
//     **明令禁止本文件自写日期字符串解析**（防口径漂移；Excel 序列号/多格式字符串/Date 实例全覆盖）。
//   - weekTag 口径 = ISO 8601（周一为周首，含首个周四的周为 W1），YY 取 **ISO week-year**（非日历年）。
//     订单侧（调拨单号 FTA 派生）/ 银行侧（BillDate 派生）**共用同一实现**，防口径漂移。
//   - 「+1」（银行周 = 订单周 + 1）用**日期语义**实现 = 判断日期 +7 天所在周的 weekTag，
//     **禁止 YYWW 数字加法**（§2.4 已证年末必错：2653+1=2654 不存在）。
//   - 内部周数比较用 number（YY*100+WW）；展示零填充 String（'YYWW'）。
//
// ✅ Q2 拍板基准四元组（单测写死，weekTag 必须逐一通过）：
//   2026-06-02 → '2623'、2026-01-01 → '2601'、2025-12-29 → '2601'、2027-01-01 → '2653'

const { toDate } = require('./engine-date-utils');

const MS_PER_DAY = 86400000;

// FTA 特征码参数（仿 refund-backfill-fields.js 风格：Object.freeze 常量，禁手敲 regex）
const FTA_FEATURE = Object.freeze({ prefix: 'FTA', digitCount: 8 });
// /^FTA(\d{8})/ —— 锚定开头，捕获 8 位日期段（YYYYMMDD）
const FTA_RE = new RegExp(`^${FTA_FEATURE.prefix}(\\d{${FTA_FEATURE.digitCount}})`);

/**
 * 解析调拨单号 FTA 后 8 位为日期。
 *   - 规则：/^FTA(\d{8})/ 提取 YYYYMMDD → 复用 toDate 做合法日期校验。
 *   - 解析失败（非 FTA 开头 / 非 8 位数字 / 非法日期如 20260230）→ 返回 null。
 *
 * @param {string} dispatchNo 调拨单号（如 'FTA202606021000477'）
 * @returns {Date|null} 本地午夜 Date 或 null
 */
function parseFtaDate(dispatchNo) {
  if (dispatchNo === null || dispatchNo === undefined) return null;
  const s = String(dispatchNo).trim();
  const m = s.match(FTA_RE);
  if (!m) return null;
  const digits = m[1]; // YYYYMMDD
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  // 拼成 toDate 可解析的标准串（YYYY-MM-DD）；toDate 内部做合法日期校验，非法日期返回 null。
  const d = toDate(`${year}-${month}-${day}`);
  if (!d) return null;
  // 防御「日期回滚」误判合法：toDate 走 normalizeDateExportValue，对 2026-02-30 等非法值应已返回 null；
  //   再回比年月日，确保解析结果与输入逐字一致（不被静默修正为 3 月 2 日等）。
  if (
    d.getFullYear() !== Number(year) ||
    d.getMonth() + 1 !== Number(month) ||
    d.getDate() !== Number(day)
  ) {
    return null;
  }
  return d;
}

// 取某 Date 的「当周周四」（ISO：周一=周首）。
//   ISO week-year = 该周四的日历年；week number = 该周四是其年内第几个周四。
function isoThursdayOf(date) {
  // JS getDay()：周日=0…周六=6。ISO 周一=1…周日=7。
  const isoDow = date.getDay() === 0 ? 7 : date.getDay();
  // 本周周四 = 当前日期 + (4 - isoDow) 天
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  thursday.setDate(thursday.getDate() + (4 - isoDow));
  return thursday;
}

/**
 * ISO 8601 周标签（订单侧 / 银行侧共用）。
 *   口径：周一为周首，含首个周四的周为 W1；YY 取 ISO week-year（非日历年）。
 *
 * @param {*} value 任意日期输入（复用 toDate；Excel 序列号 / 多格式字符串 / Date 均可）
 * @returns {string|null} 'YYWW' 零填充（如 '2623'）；无法解析 → null
 */
function weekTag(value) {
  const date = toDate(value);
  if (!date) return null;
  const thursday = isoThursdayOf(date);
  const isoYear = thursday.getFullYear();
  // 周数 = (该周四 − 当年 1 月 1 日的天数差) / 7 向下取整 + 1
  const jan1 = new Date(isoYear, 0, 1);
  const dayOfYear = Math.round((thursday.getTime() - jan1.getTime()) / MS_PER_DAY); // 0-based
  const week = Math.floor(dayOfYear / 7) + 1;
  return formatWeekTag(isoYear, week);
}

/**
 * 「+1」周标签 = 判断日期 +7 天所在周的 weekTag（日期语义，禁 YYWW 数字加法）。
 *   用于银行行 join：银行周 = 订单周 + 1 → 等价于「订单判断日期 +7 天」落到的那一周。
 *
 * @param {*} value 任意日期输入
 * @returns {string|null} 'YYWW' 或 null
 */
function weekTagPlusOne(value) {
  const date = toDate(value);
  if (!date) return null;
  const plus7 = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7);
  return weekTag(plus7);
}

// 'YYWW' 零填充：YY = ISO week-year 后两位、WW = 周数两位（用于展示 / join key）
function formatWeekTag(isoYear, week) {
  const yy = String(isoYear % 100).padStart(2, '0');
  const ww = String(week).padStart(2, '0');
  return `${yy}${ww}`;
}

// weekTag → number（YY*100+WW）；用于内部周数比较（不做跨年数字加法）。null 入参 → null。
function weekTagToNumber(tag) {
  if (tag === null || tag === undefined) return null;
  const s = String(tag);
  if (!/^\d{4}$/.test(s)) return null;
  return Number(s);
}

module.exports = {
  parseFtaDate,
  weekTag,
  weekTagPlusOne,
  weekTagToNumber,
  FTA_FEATURE
};
