(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__vccChannelCorrection = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createChannelCorrection() {
  'use strict';

  // v3.2.17 VCC 通道明细预检补录：主进程、导入 worker 与预检弹窗共用的字段清单与分组规则。
  // 权威校验在后端 row-mapper（与正式导入同一套规则）；本模块的校验只用于弹窗即时提示。
  const CORRECTABLE_FIELDS = Object.freeze([
    '借贷方向', '通道名称', 'billdate',
    '交易币种', '交易金额', '清算币种', '清算金额', '结算币种', '实际到账金额'
  ]);
  const GROUP_FIELDS = Object.freeze({
    transaction: Object.freeze(['交易币种', '交易金额']),
    clearing: Object.freeze(['清算币种', '清算金额']),
    settlement: Object.freeze(['结算币种', '实际到账金额'])
  });
  const CURRENCIES = Object.freeze(['AUD', 'CAD', 'CNY', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'USD', 'CNH']);
  const DIRECTIONS = Object.freeze(['in', 'out']);

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  // 弹窗内只接受 YYYY-MM-DD 或 YYYY/M/D 形式的日期。
  function parseIsoDate(value) {
    const match = text(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function monthEnd(targetMonth) {
    const match = text(targetMonth).match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    return new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).toISOString().slice(0, 10);
  }

  // 与 mapChannel 同一规则：CITI 用交易币种/金额；其他通道 billdate 晚于账期月末取清算，否则取结算/实际到账。
  function amountGroupFor(channelName, isoBilldate, targetMonth) {
    const channel = text(channelName);
    if (!channel) return null;
    if (channel === 'CITI') return 'transaction';
    if (!isoBilldate) return null;
    const end = monthEnd(targetMonth);
    if (!end) return null;
    return isoBilldate > end ? 'clearing' : 'settlement';
  }

  function requiredFieldsFor(channelName, amountGroup) {
    const fields = ['借贷方向', '通道名称'];
    const channel = text(channelName);
    if (channel && channel !== 'CITI') fields.push('billdate');
    return amountGroup ? [...fields, ...GROUP_FIELDS[amountGroup]] : fields;
  }

  function validateField(field, value) {
    const normalized = text(value);
    if (!normalized) return `${field}不能为空`;
    if (field === '借贷方向') return DIRECTIONS.includes(normalized) ? '' : '借贷方向仅允许 in 或 out';
    if (field === '通道名称') return '';
    if (field === 'billdate') return parseIsoDate(normalized) ? '' : 'billdate 请填写 YYYY-MM-DD 格式的有效日期';
    if (field.endsWith('币种')) {
      return CURRENCIES.includes(normalized) ? '' : `${field}须为 ${CURRENCIES.join('、')} 之一（标准大写）`;
    }
    // 与导入金额规则一致地放宽：允许千分位逗号与正负号；小数位与有效位数的最终判定在后端。
    const plain = normalized.replace(/,/g, '');
    if (!Number.isFinite(Number(plain))) return `${field}须为数字`;
    // 与 canonicalizeVccAmount 一致：先去掉小数尾随零再数位数（12.3400 视为 12.34）。
    const decimals = plain.match(/^[+-]?\d*\.(\d+)$/);
    if (decimals && decimals[1].replace(/0+$/, '').length > 2) return `${field}最多 2 位小数`;
    return '';
  }

  return Object.freeze({
    CORRECTABLE_FIELDS,
    GROUP_FIELDS,
    parseIsoDate,
    monthEnd,
    amountGroupFor,
    requiredFieldsFor,
    validateField
  });
}));
