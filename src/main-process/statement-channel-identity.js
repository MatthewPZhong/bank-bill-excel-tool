'use strict';

// v3.2.15 网银账单渠道：输出身份、生成分组与余额方式（纯函数，spec §4.1、§4.5，TechDoc T3–T5）。
//   - 输出身份：属于渠道的模板按渠道名输出（明细 Channel 列、余额银行名称与所在地、种子、余额调整、文件名），
//     普通模板按模板名，取值规则都是“银行段-所在地段”。
//   - 生成分组：渠道内的子模板合为一组（一条余额链），普通模板各自一组。
//   - 余额方式：同一渠道必须一致（D2）。

const BALANCE_DISABLED_OPTION = '无';
const BALANCE_CALCULATED_OPTION = '通过发生额计算';

const BALANCE_MODE_LABELS = Object.freeze({
  none: '不出余额',
  statement: '取账单余额列',
  calculated: '通过发生额计算'
});

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function resolveStatementOutputName(template) {
  if (!template) return '';
  const channelId = Number(template.channelId || 0);
  const channelName = normalizeText(template.channelName);
  if (channelId > 0 && channelName) return channelName;
  return normalizeText(template.name);
}

// template：{ id, channelId }；模板已删除时传 { id: matchedTemplateId }，按模板独立成组（沿用删除模板的跳过处理）。
function resolveGenerationGroupKey(template) {
  const channelId = Number(template && template.channelId || 0);
  if (channelId > 0) return `channel:${channelId}`;
  return `template:${Number(template && template.id || 0)}`;
}

function resolveTemplateBalanceMode(mappings) {
  const balanceMapping = (Array.isArray(mappings) ? mappings : []).find(
    (mapping) => normalizeText(mapping && mapping.templateField) === 'Balance'
  );
  const value = normalizeText(balanceMapping && balanceMapping.mappedField);
  if (!value || value === BALANCE_DISABLED_OPTION) return 'none';
  if (value === BALANCE_CALCULATED_OPTION) return 'calculated';
  return 'statement';
}

function describeBalanceMode(mode) {
  return BALANCE_MODE_LABELS[mode] || String(mode || '');
}

// entries：[{ templateName, balanceMode }]；全部一致返回 null，否则返回逐行明细。
function findBalanceModeMismatch(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const modes = new Set(list.map((entry) => entry.balanceMode));
  if (modes.size <= 1) return null;
  return list.map((entry) => `${entry.templateName}：${describeBalanceMode(entry.balanceMode)}`);
}

module.exports = {
  BALANCE_MODE_LABELS,
  describeBalanceMode,
  findBalanceModeMismatch,
  resolveGenerationGroupKey,
  resolveStatementOutputName,
  resolveTemplateBalanceMode
};
