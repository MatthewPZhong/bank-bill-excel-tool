// v3.0.4 块 E 需求3：BOC 调拨订单修复引擎跨表字段映射「单一真相」（仿 adm-bank-deposit-fields.js）。
//
// 🔴 资金红线（spec §4 F3 / R-1）：渠道账单（小写 channelName/reconciliationId）/ 网关账单（驼峰 OrderId）/
//    BOC链接表（中文：分组/调拨单号/资金对账不平表链接ID/货币1金额）三方字段名口径不一致，绝不能假设同名。
//    BOC 引擎（runBocDispatchOrderFix）必须全程经本文件常量 pick，禁止手敲字段名。本文件是这批字段名的唯一来源。
//
// 字段名口径对照（务必记牢）：
//   概念          渠道账单(小写)        网关账单(驼峰)   BOC链接表(中文)
//   渠道名        channelName           —               —
//   对账ID        reconciliationId      —               资金对账不平表链接ID（链接表侧匹配热列）
//   订单/调拨号    —                    OrderId          调拨单号
//   金额          —                    —               货币1金额（输出 Amount 源）
//   分组          —                    —               分组

const { FIELD_MAP: BOC_FX_FIELD_MAP } = require('./boc-fx-link-fields');

// —— BOC 渠道名兜底（引擎优先从 scenario.config.channelName 读，缺失时回退本常量；与种子 config.channelName 同源）——
//   D5：channelName trim 后精确等值、大小写敏感。
const BOC_CHANNEL_NAME = 'BOC';

// —— 跨表字段映射（显式，含口径差异）——
//   chXxx = 渠道账单（gateway 子模式下的「渠道账单」sheet，小写）；gwXxx = 网关账单（驼峰）；
//   linkXxx = BOC链接表（中文，readBocFxLinkRows 产物，字段名 = 交割表真实表头 + 3 新字段）。
const FIELD_MAP = Object.freeze({
  // 渠道账单（小写）
  chChannelName: 'channelName',
  chReconId: 'reconciliationId',
  // 网关账单（驼峰）
  gwOrderId: 'OrderId',
  // BOC链接表（中文 3 新字段 + 金额列；引用 boc-fx-link-fields.js 常量，加载期断言对齐）
  linkGroup: BOC_FX_FIELD_MAP.linkGroup, // '分组'
  linkAllocationNo: BOC_FX_FIELD_MAP.linkAllocationNo, // '调拨单号'
  linkReconLinkId: BOC_FX_FIELD_MAP.linkReconLinkId, // '资金对账不平表链接ID'
  linkCcy1Amount: '货币1金额' // 输出 Amount 源（原值透传，D10）
});

// 模块加载期断言：与 boc-fx-link-fields.js 的 3 新字段名 byte-for-byte 对齐（防两文件字段名漂移失配）。
//   🔴 R-1 护栏：引擎按本 FIELD_MAP pick BOC链接表字段，链接表又由 boc-fx-link-builder 按 boc-fx-link-fields.js
//      写入；两侧字段名一旦不一致，引擎读不到值 → 整组匹配失败、资金对账修复行全空。
for (const [key, expected] of [
  ['linkGroup', BOC_FX_FIELD_MAP.linkGroup],
  ['linkAllocationNo', BOC_FX_FIELD_MAP.linkAllocationNo],
  ['linkReconLinkId', BOC_FX_FIELD_MAP.linkReconLinkId]
]) {
  if (FIELD_MAP[key] !== expected) {
    throw new Error(
      `[boc-dispatch-order-fields] FIELD_MAP.${key}（「${FIELD_MAP[key]}」）与 boc-fx-link-fields.js（「${expected}」）不一致 — 链接表字段名疑似漂移，须同步`
    );
  }
}

module.exports = {
  BOC_CHANNEL_NAME,
  FIELD_MAP
};
