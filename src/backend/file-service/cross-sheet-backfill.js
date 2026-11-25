'use strict';

// v3.2.21：原始账单预处理「跨 Sheet 回填」（spec：changes/v3.2.21/feat/cross-sheet-backfill/spec.md）。
//   主表（模板读取的第一个 sheet）中命中「待回填行条件」的行，按配对值与同一工作簿中来源 sheet 的行一对一配对，
//   把配置的字段从来源行回填到主表的空单元格；配不上的行跳过（不进入明细与余额）并记入 issues。
//   典型场景：换汇卖出行没有日期，用描述中的买入金额去买入 sheet 的入账金额里找，取其日期。
// 口径：
//   - 配对按主表物理顺序，每行取来源 sheet 中第一笔未使用、配对值相等的行；配上即消耗（之后该行因日期 / 币种被跳过也不归还），
//     保证同金额多笔时「第 k 笔 ↔ 第 k 笔」在追加新行后不变。「已使用」只在单次运行内有效，不落库。
//   - 只有待回填行参与配对：已有值的行（含再导入回填后的原始账单时已回填的行）按普通行处理，不消耗来源行。
//     不承诺回填后的文件再导入与首次结果一致（同额来源不足等情况下可能不同），再导入应使用银行原始账单（用户决定，2026-11-21）。
//   - 只填空单元格，不覆盖银行原值；读到的空值其实是 Excel 错误值或没有结果的公式时跳过该行，不覆盖。
//   - 日期目标列写 yyyy-mm-dd（与模板日期顺序无关）：数值按工作簿日期系统换算，文本只认明确写法（不存在的日期识别不出）；
//     其他列写来源单元格原值。
//   - 该行实际走主映射时，主映射币种列为空则补成本 sheet 非待回填行该列唯一的非空值，不从来源行取；走拆分映射时不补
//     （币种取自各拆分行）。
// 本模块不读文件：来源 sheet 由调用方通过 readSourceSheet 提供，便于单测。

const { FileValidationError, normalizeCell } = require('./common');
const {
  normalizeRowFilterRules,
  validateRowFilterRules,
  collectRowFilterRuleFields,
  compileRowFilterRules,
  matchesRowFilterRules
} = require('./row-filter-rules');
const XLSX = require('xlsx');
const { normalizeDateExportValue } = require('./normalizers');

const CROSS_SHEET_BACKFILL_LABEL = '跨 Sheet 回填';
// 勾选了却没有有效规则时的报错（保存与生成共用）
const CROSS_SHEET_BACKFILL_MISSING_MESSAGE = `已勾选「${CROSS_SHEET_BACKFILL_LABEL}」，请在【规则设置】中完成设置`;
const CROSS_SHEET_BACKFILL_ROW_RULES_MISSING_MESSAGE = `${CROSS_SHEET_BACKFILL_LABEL}：请至少设置一条待回填行条件`;
const CROSS_SHEET_BACKFILL_MATCH_MODES = Object.freeze(['amount', 'exact']);
const CROSS_SHEET_BACKFILL_DATE_ORDERS = Object.freeze(['auto', 'DMY', 'MDY']);
const MATCH_MODE_LABELS = Object.freeze({ amount: '按金额', exact: '按原值' });

const SKIP_REASONS = Object.freeze({
  'match-value-missing': '无法识别配对值',
  'match-value-imprecise': '配对值是 16 位及以上的数字，Excel 只保留 15 位有效数字，无法按原值比较（请把该列存为文本）',
  'source-value-imprecise': '来源回填值是 16 位及以上的数字，Excel 只保留 15 位有效数字，无法保证与原编号一致（请把来源列存为文本）',
  'source-value-unreadable': '来源回填值读成了无效的数值（无法还原原文），不能写入',
  'currency-conflicts-account': '本表推断的币种与该行账户号在账户管理中维护的币种不一致，未补币种',
  'no-source-row': '来源 Sheet 中没有可配对的行',
  'source-date-invalid': '来源日期无法识别',
  'currency-undetermined': '无法确定本表币种',
  'route-changed': '回填或补上本表币种后该行改走另一种映射（主映射 / 拆分映射），收支、币种与账单日期无法按同一映射确定',
  'account-changed': '回填或补上本表币种后该行的账户号（MerchantId）随之改变（币种列同时是账户映射的输入），未改动该行',
  'amount-changed': '回填或补上本表币种后该行的收支方向、金额或余额随之改变（回填的字段或币种列同时是发生额或余额的取值来源或条件），未改动该行',
  'backfilled-date-unmapped': '回填的日期按本表账单日期的映射取不到有效日期（如映射取的是特征值）',
  'target-cell-unreadable': '本表待回填单元格是错误值或没有结果的公式，不能按空单元格回填',
  'target-cell-unwritable': '本表待回填单元格属于合并单元格或数组公式，不能单独填写'
});

// 金额前后可出现的币种标记：常见符号，或「币种代码集合」中的代码（如 $65.45、USD 65.45、65.45 USD、USDT 65.45）。
//   币种代码由调用方按币种映射表传入（REF、TXN 这类大写词不会被当成币种），按完整的词比较（不限三个字母）；
//   未传时用下方常见代码。
// 币种标记与金额之间可以有正负号或左括号（USD -65.45、$(65.45)），最多两个（USD (-65.45)、$-(65.45)）；币种代码归前一个数字
//   还是后一个数字，前缀与后缀两侧按同一规则判断（第三十五轮审查：USD (-65.45) 原先前缀不认、后缀却认，USD 被归给前面的参考号）
//   货币符号按 Unicode 货币符号类别（含全角 ￥、＄、￡ 等）
// 正负号：ASCII 与 Unicode 负号（−）、全角（－ ＋）、小写连字符负号（﹣）、连字符与各类短横（‐ ‑ ‒ – —）。金额前与币种前后两侧
//   另加左括号（含全角），同一组（第二十七轮）；科学计数的指数正负号同样按这一组判断（第二十八轮）
const PLUS_MINUS_CHARS = '\\-+\\u2212\\uFF0D\\uFF0B\\uFE63\\u2010\\u2011\\u2012\\u2013\\u2014';
const SIGN_CHARS = `${PLUS_MINUS_CHARS}(\\uFF08\\[\\uFF3B`;
const SIGN_RUN = `(?:[${SIGN_CHARS}]\\s*)`;
const CURRENCY_SYMBOL_PATTERN = new RegExp(`\\p{Sc}\\s*${SIGN_RUN}{0,2}$`, 'u');
const CURRENCY_CODE_BEFORE_PATTERN = new RegExp(`(?:^|[^\\p{L}\\p{N}])([A-Z][A-Z0-9]*)\\s*${SIGN_RUN}{0,2}$`, 'u');
const SIGNED_NUMBER_AFTER_PATTERN = new RegExp(`^\\s*${SIGN_RUN}{1,2}\\d`, 'u');
const NUMBER_AFTER_PATTERN = new RegExp(`^\\s*${SIGN_RUN}{0,2}\\d`, 'u');
// 紧贴数字的字母串（REF42、42ABC、订单42、42账，按 Unicode 字母）：不是完整的币种代码时该数字属于编号，不作为金额候选
const GLUED_WORD_BEFORE_PATTERN = /(\p{L}[\p{L}\p{N}]*)$/u;
const GLUED_WORD_AFTER_PATTERN = /^(\p{L}[\p{L}\p{N}]*)/u;
const CURRENCY_CODE_AFTER_PATTERN = /^\s*([A-Z][A-Z0-9]*)(?![\p{L}\p{N}])/u;
// 中文货币字样：紧贴在数字后（100元、100万元、100美元、100元整）或数字前（人民币100、港币100）时与货币符号一样标明这是金额。
//   本功能不支持这类写法（不换算万、不识别币种），该数字作为取不到的候选：选中即整格取不到，不当成编号丢掉后改用参考号
const CURRENCY_WORD_AFTER_PATTERN = /^\p{Script=Han}{0,2}[元圆币]/u;
const CURRENCY_WORD_BEFORE_PATTERN = /[元圆币]$/u;
// 紧贴在数字后的借贷标记（65.45CR、100DR）与带两位小数或千分位的金额写法（金额65.45、1,234.56X）：同样标明这是金额，
//   紧贴其他字母时作为取不到的候选（第二十五轮）
const DEBIT_CREDIT_WORD_PATTERN = /^(?:CR|DR)$/i;
const AMOUNT_LIKE_PATTERN = /^(?:\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})$/;
const CURRENCY_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
const DEFAULT_CURRENCY_CODES = Object.freeze(new Set([
  'AED', 'AUD', 'BDT', 'BRL', 'CAD', 'CHF', 'CNH', 'CNY', 'CZK', 'DKK', 'EGP', 'EUR', 'GBP', 'GHS', 'HKD', 'HUF',
  'IDR', 'ILS', 'INR', 'JPY', 'KES', 'KRW', 'KWD', 'MAD', 'MXN', 'MYR', 'NGN', 'NOK', 'NZD', 'PHP', 'PKR', 'PLN',
  'QAR', 'RUB', 'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'VND', 'XAF', 'XOF', 'ZAR'
]));
// 数字片段：数字、小数点、千分位逗号组成的最长连续串（再按严格金额写法校验，避免只取到 REF123.45 或 .50 的一部分）
const NUMBER_RUN_PATTERN = /[\d.,]*\d[\d.,]*/g;
const STRICT_AMOUNT_PATTERN = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
// 科学计数法（1.23E+03）：不支持，该片段（尾数与指数）不作为金额候选；单元格中另有明确的金额（如 Ref: 1E03; Trade - $65.45
//   中的 $65.45）照常识别
//   两侧紧贴的字母串是完整的币种代码时（USD1E03、1E03USD）同样是科学计数金额；紧贴其他字母（REF1E03）属于编号
const SCIENTIFIC_AMOUNT_PATTERN = new RegExp(`(?<!\\p{N})\\d[\\d.,]*[eE][${PLUS_MINUS_CHARS}]?\\d+(?!\\p{N})`, 'gu');
// 紧跟在「数字 + E + 正负号」之后的数字是指数，不作为金额候选（REF1E+5 这类编号中的一段）
const EXPONENT_BEFORE_PATTERN = new RegExp(`\\d[eE][${PLUS_MINUS_CHARS}]?$`, 'u');
// 不支持的千分位写法（空格、窄不换行空格、撇号分组，如 €1 234,56、CHF 1'234.56）会被切成几段数字：选中的数字与相邻的
//   三位数字只隔分组符时（连续多个同样如此，如 USD 1  234.56），整段无法识别，不取其中一段（否则 1 234,56 会配成 1.00）；
//   一两位数字的分组后面还接着分组时同样如此（印度式 ₹1 23 456.78），后面接日期等其他写法（USD 100 26/09/2026）不算分组
const GROUP_SEPARATOR = "[\\s'’ʼ′]+";
const GROUPED_DIGITS_AFTER_PATTERN = new RegExp(`^${GROUP_SEPARATOR}(?:\\d{3}(?!\\d)|\\d{1,2}${GROUP_SEPARATOR}\\d)`);
// 左侧同样按整数分组判断（含逗号分组的 1,234 后接空白分组的 567.89）
const GROUPED_DIGITS_BEFORE_PATTERN = new RegExp(`(?:^|[^\\d.,])\\d{1,3}(?:,\\d{3})*${GROUP_SEPARATOR}$`);
// 选中的片段是不带小数的整数时，右侧再接空白 / 撇号分组的数字说明它只是用分组符写的金额的前半段（USD 1,234 567.89；
//   前半段本身不是合法分组的同样如此，CHF 1234'567.89，第三十轮审查），整段取不到，不截取前半段配对
const INTEGER_RUN_PATTERN = /^\d[\d,]*$/;
// 撇号夹在数字之间（CHF 1'234.56、CHF 1'23.45、1234'56.78 CHF）：撇号只作分组符，选中的片段紧挨着「撇号 + 数字」或
//   「数字 + 撇号」时整段取不到，不论两侧各有几位（第三十、三十一轮审查）；只隔空白时仍按上面的分组规则（只认一到三位的
//   组头），不把「编号 + 空格 + 金额」（INV 20260925 100.00 USD）当成分组
const APOSTROPHE_JOINED_AFTER_PATTERN = /^\s*['’ʼ′][\s'’ʼ′]*\d/;
const APOSTROPHE_JOINED_BEFORE_PATTERN = /\d\s*['’ʼ′][\s'’ʼ′]*$/;
// 片段紧挨非 ASCII 数字（全角１、阿拉伯-印度数字等），或只隔一个非 ASCII 标点就接着数字（全角逗号、句点等，如 ￥1，234.56）：
//   它只是用全角写法的金额的一部分，不支持这种写法，整段取不到（不截取其中一段配对、占用来源行）
const FOREIGN_DIGIT_BEFORE_PATTERN = /(?:(?![0-9])\p{Nd}|\p{Nd}(?=\p{P})[^\x00-\x7F])$/u;
const FOREIGN_DIGIT_AFTER_PATTERN = /^(?:(?![0-9])\p{Nd}|(?=\p{P})[^\x00-\x7F]\p{Nd})/u;
// 含非 ASCII 数字的数字串（全角１２３、阿拉伯-印度数字等，可与 ASCII 数字、全角或半角的小数点 / 分组符相连）
const FOREIGN_NUMBER_RUN_PATTERN = /[\p{Nd}.,，．、]*(?:(?![0-9])\p{Nd})[\p{Nd}.,，．、]*/gu;

function fail(message) {
  throw new FileValidationError('FILE_READ', message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 接受对象或 JSON 字符串；不是对象时返回 null（未设置）。只做形状规范化，不做必填校验。
function normalizeCrossSheetBackfillRule(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try {
      value = JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }
  if (!isPlainObject(value)) return null;
  const matchMode = normalizeCell(value.matchMode);
  const sourceDateOrder = normalizeCell(value.sourceDateOrder);
  const backfillFields = (Array.isArray(value.backfillFields) ? value.backfillFields : [])
    .filter(isPlainObject)
    .map((item) => ({
      targetField: normalizeCell(item.targetField),
      sourceField: normalizeCell(item.sourceField)
    }))
    .filter((item) => item.targetField !== '' || item.sourceField !== '');
  // Sheet 名按原文保存与查找（工作簿可同时有「USD」与「USD 」两张表），只有全为空白时视为未填写
  const rawSheetName = value.sourceSheetName === null || value.sourceSheetName === undefined ? '' : String(value.sourceSheetName);
  return {
    sourceSheetName: rawSheetName.trim() ? rawSheetName : '',
    rowRules: normalizeRowFilterRules(value.rowRules),
    matchMode: CROSS_SHEET_BACKFILL_MATCH_MODES.includes(matchMode) ? matchMode : 'amount',
    matchField: normalizeCell(value.matchField),
    sourceMatchField: normalizeCell(value.sourceMatchField),
    sourceDateOrder: CROSS_SHEET_BACKFILL_DATE_ORDERS.includes(sourceDateOrder) ? sourceDateOrder : 'auto',
    backfillFields
  };
}

// 是否存有任何设置（用于模板包版本判定、未勾选但存有设置时保留）
function hasCrossSheetBackfillSettings(raw) {
  const rule = normalizeCrossSheetBackfillRule(raw);
  return Boolean(rule && (
    rule.sourceSheetName
    || rule.rowRules.length
    || rule.matchField
    || rule.sourceMatchField
    || rule.backfillFields.length
  ));
}

// 返回规范化后的规则。headers 为数组时校验本表字段在模板表头中；excludedTargetFields：不能作为回填目标的本表字段
//   （发生额、余额、币种、账户所用的源列，含拆分配置；保存时由 main.js collectCrossSheetBackfillExcludedTargets、生成时由
//   file-service.js 按实际生效的配置给出）。渲染端 configuration.js 按草稿主映射先校验一遍。
function validateCrossSheetBackfillRule(raw, headers, { excludedTargetFields = [] } = {}) {
  const rule = normalizeCrossSheetBackfillRule(raw);
  if (!rule || !hasCrossSheetBackfillSettings(rule)) {
    fail(CROSS_SHEET_BACKFILL_MISSING_MESSAGE);
  }
  const headerSet = Array.isArray(headers)
    ? new Set(headers.map((header) => normalizeCell(header)).filter(Boolean))
    : null;
  const ensureMainField = (field) => {
    if (headerSet && !headerSet.has(field)) {
      fail(`映射字段不存在：${field}`);
    }
  };
  if (!rule.sourceSheetName) {
    fail(`${CROSS_SHEET_BACKFILL_LABEL}：请填写来源 Sheet 名`);
  }
  rule.rowRules = validateRowFilterRules(rule.rowRules, headers, {
    missingMessage: CROSS_SHEET_BACKFILL_ROW_RULES_MISSING_MESSAGE,
    ruleLabel: `${CROSS_SHEET_BACKFILL_LABEL}：待回填行条件`
  });
  if (!rule.matchField) {
    fail(`${CROSS_SHEET_BACKFILL_LABEL}：请选择本表配对字段`);
  }
  ensureMainField(rule.matchField);
  if (!rule.sourceMatchField) {
    fail(`${CROSS_SHEET_BACKFILL_LABEL}：请填写来源配对字段`);
  }
  if (!rule.backfillFields.length) {
    fail(`${CROSS_SHEET_BACKFILL_LABEL}：请至少设置一个回填字段`);
  }
  const excludedSet = new Set((excludedTargetFields || []).map((field) => normalizeCell(field)).filter(Boolean));
  const seenTargets = new Set();
  rule.backfillFields.forEach((item, index) => {
    const label = `${CROSS_SHEET_BACKFILL_LABEL}：回填字段第 ${index + 1} 行`;
    if (!item.targetField) {
      fail(`${label}请选择本表字段`);
    }
    if (!item.sourceField) {
      fail(`${label}请填写来源字段`);
    }
    ensureMainField(item.targetField);
    if (seenTargets.has(item.targetField)) {
      fail(`${CROSS_SHEET_BACKFILL_LABEL}：本表字段「${item.targetField}」重复设置`);
    }
    seenTargets.add(item.targetField);
    if (excludedSet.has(item.targetField)) {
      fail(`${CROSS_SHEET_BACKFILL_LABEL}：「${item.targetField}」用于发生额、余额、币种或账户映射，不能作为回填字段`);
    }
  });
  return rule;
}

// 规则用到的本表字段（模板【更新】失效引用用）：待回填行条件字段、本表配对字段、回填目标字段
function collectCrossSheetBackfillMainFields(raw) {
  const rule = normalizeCrossSheetBackfillRule(raw);
  if (!rule) return [];
  const fields = [];
  const push = (field) => {
    if (field && !fields.includes(field)) fields.push(field);
  };
  collectRowFilterRuleFields(rule.rowRules).forEach(push);
  push(rule.matchField);
  rule.backfillFields.forEach((item) => push(item.targetField));
  return fields;
}

// 十进制金额文本（无符号、无千分位）→ 分：按十进制四舍五入到分（不经二进制浮点，1.005 → 101）；超出安全整数时 null
function decimalTextToCents(text) {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(String(text || ''));
  if (!match) return null;
  const fraction = (match[2] || '').padEnd(3, '0');
  let cents = Number(match[1]) * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) cents += 1;
  return Number.isSafeInteger(cents) ? cents : null;
}

// 数值 → 分（取绝对值）：按最短十进制表示（String）处理，指数写法的小数展开为定点小数
function numberToCents(numberValue) {
  if (!Number.isFinite(numberValue)) return null;
  const absolute = Math.abs(numberValue);
  let text = String(absolute);
  if (/e/i.test(text)) {
    if (absolute >= 1e21) return null;
    text = absolute.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  }
  return decimalTextToCents(text);
}

function resolveCurrencyCodeSet(currencyCodes) {
  if (currencyCodes instanceof Set && currencyCodes.size) return currencyCodes;
  if (Array.isArray(currencyCodes) && currencyCodes.length) {
    const codes = new Set(currencyCodes.map((code) => normalizeCell(code).toUpperCase()).filter((code) => CURRENCY_CODE_PATTERN.test(code)));
    return codes.size ? codes : DEFAULT_CURRENCY_CODES;
  }
  return DEFAULT_CURRENCY_CODES;
}

// 数字片段两侧紧贴的字母串与币种标记：gluedCode* 为紧贴完整的币种代码；unsupportedMarked 为紧贴了其他字母、但标明了是金额
//   （旁边有货币符号或币种代码：$65.45abc、USD 65.45CR；紧贴中文货币字样或借贷标记：￥100元、100港币、人民币100、100CR；
//   或本身是带两位小数、千分位的金额写法：金额65.45）——写法不支持，不能当作编号丢掉后改用参考号
function glueOf(text, start, end, codes) {
  const wordBefore = GLUED_WORD_BEFORE_PATTERN.exec(text.slice(0, start));
  const wordAfter = GLUED_WORD_AFTER_PATTERN.exec(text.slice(end));
  // 紧贴的单词按大写与币种代码比较（usd65.45、65.45usd 与 USD65.45 同样是币种标记）；隔空格的币种代码仍只认大写，
  //   避免把 all、try 这类普通单词当成币种
  const gluedCodeBefore = Boolean(wordBefore && codes.has(wordBefore[1].toUpperCase()));
  const gluedCodeAfter = Boolean(wordAfter && codes.has(wordAfter[1].toUpperCase()));
  const otherWordBefore = Boolean(wordBefore && !gluedCodeBefore);
  const otherWordAfter = Boolean(wordAfter && !gluedCodeAfter);
  const glued = otherWordBefore || otherWordAfter;
  const before = text.slice(0, start);
  const codeBefore = CURRENCY_CODE_BEFORE_PATTERN.exec(before);
  // 隔开的币种代码只看前面（USD 65.45CR）：数字后隔开的代码多半属于下一个金额（REF42 USD -65.45 中的 USD 属于 65.45）
  const unsupportedMarked = glued && (
    gluedCodeBefore || gluedCodeAfter
    || CURRENCY_SYMBOL_PATTERN.test(before)
    || Boolean(codeBefore && codes.has(codeBefore[1]))
    || (otherWordBefore && CURRENCY_WORD_BEFORE_PATTERN.test(wordBefore[1]))
    || (otherWordAfter && (CURRENCY_WORD_AFTER_PATTERN.test(wordAfter[1]) || DEBIT_CREDIT_WORD_PATTERN.test(wordAfter[1])))
    || AMOUNT_LIKE_PATTERN.test(text.slice(start, end))
  );
  return { wordBefore, gluedCodeBefore, gluedCodeAfter, glued, unsupportedMarked };
}

// 从单元格中识别金额（返回分，取绝对值）；识别不出或有歧义时返回 null。
//   数值直接取；文本：紧贴非币种代码字母的数字（REF42、42ABC）属于编号，先排除；剩下只有一个数字片段就取它，多个时取
//   紧跟币种符号或币种代码（中间可隔正负号，如 USD -65.45）的那一个，仍不唯一则 null；
//   取到的片段不是完整的金额写法（如 .50、1.2.3、1.234,56）时同样 null，不取其中一部分。
function parseAmountCents(value, { currencyCodes } = {}) {
  if (typeof value === 'number') {
    return numberToCents(value);
  }
  const text = normalizeCell(value);
  if (!text) return null;
  const codes = resolveCurrencyCodeSet(currencyCodes);
  // 科学计数片段（不属于编号的）作为取不到的候选参与选择（第二十六轮）：带币种或借贷标记时选中即整格取不到，不因它被排除就改用
  //   唯一剩下的参考号（REF: 22 USD -1E03、REF: 22; Trade - 1E3CR 不取 22）；紧贴其他字母的（REF1E03、TXN4E5A2）是编号
  const scientificTokens = [];
  const scientificSpans = Array.from(text.matchAll(SCIENTIFIC_AMOUNT_PATTERN))
    .filter((found) => {
      const start = found.index;
      const end = start + found[0].length;
      const glue = glueOf(text, start, end, codes);
      if (glue.glued && !glue.unsupportedMarked) return false;
      scientificTokens.push({
        raw: found[0], start, end, valid: false, scientific: true,
        gluedCurrency: glue.gluedCodeBefore || glue.gluedCodeAfter || glue.unsupportedMarked
      });
      return true;
    })
    .map((found) => [found.index, found.index + found[0].length]);
  // 作为完整的词出现、本身含数字的币种代码（如映射表中的 USD1）：其中的数字属于代码，不作为金额候选
  const codeSpans = Array.from(text.matchAll(/\p{L}[\p{L}\p{N}]*/gu))
    .filter((found) => /\d/.test(found[0]) && codes.has(found[0].toUpperCase()))
    .map((found) => [found.index, found.index + found[0].length]);
  const tokens = scientificTokens.slice();
  NUMBER_RUN_PATTERN.lastIndex = 0;
  let match = NUMBER_RUN_PATTERN.exec(text);
  while (match) {
    // 句末标点（65.45. / 65.45,）不属于金额
    const raw = match[0].replace(/[.,]+$/, '');
    const start = match.index;
    const end = start + raw.length;
    const {
      wordBefore, gluedCodeBefore, gluedCodeAfter, glued, unsupportedMarked
    } = glueOf(text, start, end, codes);
    const partOfIdentifier = (glued && !unsupportedMarked)
      || EXPONENT_BEFORE_PATTERN.test(text.slice(0, start))
      || scientificSpans.some(([spanStart, spanEnd]) => start < spanEnd && end > spanStart)
      || codeSpans.some(([spanStart, spanEnd]) => start < spanEnd && end > spanStart);
    // 紧贴在前的代码加上片段开头的数字又是另一个代码（USD165.45，映射表同时有 USD 与 USD1）：分界有歧义，该片段取不到
    const gluedBoundaryAmbiguous = gluedCodeBefore && Array.from(raw.match(/^\d+/) ? raw.match(/^\d+/)[0] : '')
      .some((_digit, index) => codes.has(`${wordBefore[1].toUpperCase()}${raw.slice(0, index + 1)}`));
    const adjoinsForeignDigits = FOREIGN_DIGIT_BEFORE_PATTERN.test(text.slice(0, start))
      || FOREIGN_DIGIT_AFTER_PATTERN.test(text.slice(end));
    if (!partOfIdentifier) {
      tokens.push({
        raw,
        start,
        end,
        valid: STRICT_AMOUNT_PATTERN.test(raw) && !gluedBoundaryAmbiguous && !adjoinsForeignDigits && !unsupportedMarked,
        gluedCurrency: gluedCodeBefore || gluedCodeAfter || unsupportedMarked
      });
    }
    match = NUMBER_RUN_PATTERN.exec(text);
  }
  // 含非 ASCII 数字的数字串不支持，作为取不到的候选参与选择：带币种标记时选中它即整格取不到，不因它不在 ASCII 候选中而改用
  //   唯一剩下的参考号（REF: 22; Trade - ￥１２３ 不取 22）；与之相连的 ASCII 片段（￥１234.56 中的 234.56）并入这一候选。
  //   紧贴非币种代码字母的（ＲＥＦ１２、第１期）与 ASCII 数字一样是编号，不作候选；紧贴货币符号或中文货币字样的（￥１００元）除外
  for (const found of text.matchAll(FOREIGN_NUMBER_RUN_PATTERN)) {
    const raw = found[0].replace(/[.,，．、]+$/, '');
    const start = found.index + (found[0].length - found[0].replace(/^[.,，．、]+/, '').length);
    const end = found.index + raw.length;
    if (end <= start) continue;
    const {
      gluedCodeBefore, gluedCodeAfter, glued, unsupportedMarked
    } = glueOf(text, start, end, codes);
    if (glued && !unsupportedMarked) continue;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      if (tokens[index].start < end && tokens[index].end > start) tokens.splice(index, 1);
    }
    tokens.push({ raw, start, end, valid: false, gluedCurrency: gluedCodeBefore || gluedCodeAfter || unsupportedMarked });
  }
  if (!tokens.length) return null;
  let picked = tokens;
  // 排除了科学计数片段（多半就是金额本身，如 REF: 22; Trade - $1E03）时，剩下的数字须带独立的币种标记才采用，
  //   不把唯一剩下的参考号当成金额（Ref: 1E03; Trade - $65.45 中的 $65.45 照常识别）
  if (tokens.length > 1 || scientificSpans.length > 0) {
    picked = tokens.filter((token) => {
      const before = text.slice(0, token.start);
      const after = text.slice(token.end);
      const codeBefore = CURRENCY_CODE_BEFORE_PATTERN.exec(before);
      const codeAfter = CURRENCY_CODE_AFTER_PATTERN.exec(after);
      // 数字后的币种代码紧接着正负号或左括号与数字（22 USD -65.45）时是下一个数字的前缀，不算这个数字的币种标记（第二十六轮）；
      //   代码后直接是数字（42 USD 65.45）时两边都可能，仍都算（有歧义，取不到）；科学计数片段本身取不到，其后的代码只要后接数字
      //   就归下一个数字（1.23E+03 USD 65.45 取 65.45，第十三轮口径）
      const codeAfterOwned = Boolean(codeAfter && codes.has(codeAfter[1]))
        && !(token.scientific ? NUMBER_AFTER_PATTERN : SIGNED_NUMBER_AFTER_PATTERN).test(after.slice(codeAfter[0].length));
      return token.gluedCurrency
        || CURRENCY_SYMBOL_PATTERN.test(before)
        || Boolean(codeBefore && codes.has(codeBefore[1]))
        || codeAfterOwned;
    });
  }
  if (picked.length !== 1 || !picked[0].valid) return null;
  const { raw, start, end } = picked[0];
  if ((INTEGER_RUN_PATTERN.test(raw) && GROUPED_DIGITS_AFTER_PATTERN.test(text.slice(end)))
    || (/^\d{3}(?!\d)/.test(raw) && GROUPED_DIGITS_BEFORE_PATTERN.test(text.slice(0, start)))
    || APOSTROPHE_JOINED_AFTER_PATTERN.test(text.slice(end))
    || APOSTROPHE_JOINED_BEFORE_PATTERN.test(text.slice(0, start))) {
    return null;
  }
  return decimalTextToCents(raw.replace(/,/g, ''));
}

// 16 位及以上的数值（如数值型订单号）：Excel 只保留 15 位有效数字（末位可能已被截成 0），超过安全整数范围时读取还会再丢
//   精度，不同的原编号可能存成同一个数；按原值配对时不能比较，也不能作为回填值写入（文本编号按原文处理，不受影响）
function isImpreciseNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) >= 1e15;
}

function buildMatchKey(value, matchMode, currencyCodes) {
  // 读取库读成 NaN、Infinity 的值无法还原原文，不作为配对键（按原值时不转成字符串 NaN 互相配对）
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (matchMode === 'exact') {
    if (isImpreciseNumber(value)) return null;
    const text = normalizeCell(value);
    return text === '' ? null : text;
  }
  const cents = parseAmountCents(value, { currencyCodes });
  return cents === null ? null : String(cents);
}

function formatMatchKey(key, matchMode) {
  if (matchMode === 'exact') return key;
  const cents = Number(key);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function formatIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// 单元格 → yyyy-mm-dd；识别不出时为空串。数值按工作簿日期系统换算；文本按给定日期顺序，只认明确的写法
//   （不回退到 JavaScript Date，02/30/2026 这类不存在的日期识别不出）。
//   数值与主映射（file-service.js resolveDateRawValueByMapping）同口径：按文本处理，Excel 序号范围内（大于 365、小于 200000）
//   按序号换算（带时分的取日期部分），260926、20260926 这类按六位 / 八位日期写法识别
function parseBackfillDate(value, { dateOrder = 'auto', excelDateSystem = '1900' } = {}) {
  let text;
  if (typeof value === 'number' && Number.isFinite(value)) {
    text = !Number.isInteger(value) && value > 365 && value < 200000 ? String(Math.floor(value)) : String(value);
  } else {
    text = normalizeCell(value);
  }
  const result = normalizeDateExportValue(text, { dateParseOrder: dateOrder, excelDateSystem, looseFallback: false });
  return result.date ? formatIsoDate(result.date) : '';
}

function resolveRequiredIndex(indexByField, field, sheetLabel) {
  const index = indexByField.get(field);
  if (index === undefined) {
    fail(sheetLabel ? `${CROSS_SHEET_BACKFILL_LABEL}：来源 Sheet「${sheetLabel}」中没有字段「${field}」` : `映射字段不存在：${field}`);
  }
  return index;
}

// 来源 sheet：第一行包含来源配对字段与全部来源回填字段的行为表头，之后的行为数据行。
//   本规则引用的来源字段在表头中出现多次时报错（不按列顺序静默取第一列）。
function locateSourceTable(sourceRows, sourceRowNumbers, requiredFields, sheetName, columnOffset = 0) {
  const rows = Array.isArray(sourceRows) ? sourceRows : [];
  const headerIndex = rows.findIndex((row) => {
    const cells = new Set((Array.isArray(row) ? row : []).map((cell) => normalizeCell(cell)));
    return requiredFields.every((field) => cells.has(field));
  });
  if (headerIndex < 0) {
    fail(`${CROSS_SHEET_BACKFILL_LABEL}：来源 Sheet「${sheetName}」中没有同时包含「${requiredFields.join('」「')}」的表头行`);
  }
  const indexByField = new Map();
  const columnsByField = new Map();
  rows[headerIndex].forEach((cell, index) => {
    const field = normalizeCell(cell);
    if (!field) return;
    if (!indexByField.has(field)) indexByField.set(field, index);
    if (!columnsByField.has(field)) columnsByField.set(field, []);
    columnsByField.get(field).push(index);
  });
  requiredFields.forEach((field) => {
    const columns = columnsByField.get(field) || [];
    if (columns.length > 1) {
      const letters = columns.map((index) => XLSX.utils.encode_col(index + (Number(columnOffset) > 0 ? Number(columnOffset) : 0)));
      fail(`${CROSS_SHEET_BACKFILL_LABEL}：来源 Sheet「${sheetName}」的表头中「${field}」出现多次（第 ${letters.join('、')} 列），无法确定取哪一列，请修改来源表头或规则`);
    }
  });
  const dataRows = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = Array.isArray(rows[index]) ? rows[index] : [];
    dataRows.push({ row, rowNumber: (sourceRowNumbers && sourceRowNumbers[index]) || index + 1 });
  }
  return { indexByField, dataRows };
}

function isEmptyCell(value) {
  return normalizeCell(value) === '';
}

/**
 * 在映射前对主表源行执行跨 Sheet 回填。
 * @param {object} options
 * @param {Array<Array>} options.rows 主表行（rows[0] 为表头）
 * @param {Array<number>} options.rowNumbers 与 rows 平行的物理行号
 * @param {Map<string, number>} options.sourceIndexByField 主表字段 → 列下标
 * @param {object|null} options.rule 已规范化的规则；为空时不处理
 * @param {(sheetName: string) => {rows: Array<Array>, rowNumbers: Array<number>}} options.readSourceSheet
 * @param {Set<string>} [options.dateTargetFields] 按日期处理的本表字段（主映射 / 拆分映射 BillDate、ValueDate 所用源列）
 * @param {Set<string>} [options.billDateFields] BillDate 所用源列（日期区间提示）；resolveRowContext 未给出时使用
 * @param {string} [options.currencyField] Currency 所用源列；为空时不补币种；resolveRowContext 未给出时使用
 * @param {(row: Array) => {currencyField: string, billDateFields: Set<string>}} [options.resolveRowContext]
 *   按该行实际走的映射（主映射或拆分映射）给出币种列与 BillDate 源列
 * @param {(row: Array) => string} [options.resolveRowAmounts] 该行按实际映射求出的收支（可比较的字符串）；补币种前后不同时跳过
 * @param {(row: Array) => string} [options.resolveRowAccountKey] 该行按实际映射解析的账户号（回填前后比较，不同时跳过）
 * @param {(row: Array) => boolean} [options.isSummaryRow] 该行（按未修改的源行）是否是账单自带的合计行：合计行不参与回填
 * @param {(row: Array, sheetCurrency: string) => string} [options.resolveAccountCurrencyStatus] 该行账户号在账户管理中维护了
 *   「无币种时的币种」时：与本表推断的币种不一致返回 'conflict'（跳过），一致返回 'account'（不补币种，由账户兜底）；否则 ''
 * @param {(row: Array) => string} [options.resolveRowBillDate] 返回该行账单日期 yyyy-mm-dd（按该行实际映射），无效为空串
 * @param {(rowNumber: number, columnIndex: number) => (string|boolean)} [options.isUnreadableCell] 'unwritable'（合并单元格 / 数组公式从属位置）或其他真值（错误值 / 公式）
 *   该单元格读到的空值是否其实是 Excel 错误值或没有结果的公式（这类单元格不按空单元格回填）
 * @param {Array<string>} [options.excludedTargetFields] 不能作为回填目标的本表字段（生成时再校验一次）
 * @param {Set<string>|Array<string>} [options.currencyCodes] 按金额识别时认作币种的代码（币种映射表的英文代码）
 * @param {string} [options.excelDateSystem] 工作簿日期系统 '1900' / '1904'（数值日期换算）
 * @param {string} [options.sourceFileName] 源文件名，写入 issues（多个文件一起导入时区分）
 * @param {string} [options.sourceFilePath] 源文件路径，写入 issues（同名文件按路径区分，展示时只取末尾几级）
 * @param {Array<Array>} [options.mainHeaderRows] 主表各分段表头的整行（含模板表头范围以外的列；缺省取 rows[0]），核对规则引用的列是否重名
 * @param {number} [options.mainHeaderColumnOffset] mainHeaderRows 第 0 列的物理列下标（报错时换算列字母）
 */
function applyCrossSheetBackfill({
  rows,
  rowNumbers,
  sourceIndexByField,
  rule,
  readSourceSheet,
  dateTargetFields = new Set(),
  billDateFields = new Set(),
  currencyField = '',
  resolveRowContext = null,
  resolveRowAmounts = null,
  resolveRowAccountKey = null,
  isSummaryRow = null,
  resolveAccountCurrencyStatus = null,
  resolveRowBillDate = null,
  isUnreadableCell = null,
  excludedTargetFields = [],
  currencyCodes = null,
  excelDateSystem = '1900',
  sourceFileName = '',
  sourceFilePath = '',
  mainHeaderRows = null,
  mainHeaderColumnOffset = 0
}) {
  const emptyStats = { targetRows: 0, backfilledRows: 0, skippedRows: 0 };
  if (!rule) {
    return { enabled: false, rows, rowNumbers, issues: [], patches: [], skippedRows: [], stats: emptyStats };
  }
  const validated = validateCrossSheetBackfillRule(rule, null, { excludedTargetFields });
  // 规则引用的本表字段在主表表头（各分段表头的整行，含模板表头范围以外的列）中出现多次时报错，与来源表同口径：规则只按
  //   列名保存，按列顺序静默取第一列会把值写进另一列，或因第一列已有值而漏填。决定哪些行待回填的字段（条件字段、回填目标）
  //   先核对；只用于配对的字段在确有待回填行时才核对（没有待回填行的普通账单不受影响）
  const headerRowsToCheck = Array.isArray(mainHeaderRows) && mainHeaderRows.length ? mainHeaderRows : [rows[0]];
  const assertMainFieldsUnique = (fields) => {
    headerRowsToCheck.forEach((headerRow) => {
      const columnsByField = new Map();
      (Array.isArray(headerRow) ? headerRow : []).forEach((cell, index) => {
        const field = normalizeCell(cell);
        if (!field) return;
        if (!columnsByField.has(field)) columnsByField.set(field, []);
        columnsByField.get(field).push(index);
      });
      fields.forEach((field) => {
        const columns = columnsByField.get(field) || [];
        if (columns.length > 1) {
          const offset = Number(mainHeaderColumnOffset) > 0 ? Number(mainHeaderColumnOffset) : 0;
          const letters = columns.map((index) => XLSX.utils.encode_col(index + offset));
          fail(`${CROSS_SHEET_BACKFILL_LABEL}：主表表头中「${field}」出现多次（第 ${letters.join('、')} 列），无法确定规则指的是哪一列，请修改表头或规则`);
        }
      });
    });
  };
  assertMainFieldsUnique(collectRowFilterRuleFields(validated.rowRules)
    .concat(validated.backfillFields.map((item) => item.targetField)));
  const compiledRowRules = compileRowFilterRules(validated.rowRules, sourceIndexByField, {
    missingMessage: CROSS_SHEET_BACKFILL_ROW_RULES_MISSING_MESSAGE
  });
  const matchIndex = resolveRequiredIndex(sourceIndexByField, validated.matchField);
  const targets = validated.backfillFields.map((item) => ({
    ...item,
    targetIndex: resolveRequiredIndex(sourceIndexByField, item.targetField),
    isDate: dateTargetFields.has(item.targetField)
  }));
  const codes = resolveCurrencyCodeSet(currencyCodes);
  const contextOf = typeof resolveRowContext === 'function'
    ? (row) => resolveRowContext(row) || {}
    : () => ({ currencyField, billDateFields });
  const checkedCurrencyFields = new Set();
  const assertCurrencyFieldUnique = (field) => {
    if (checkedCurrencyFields.has(field)) return;
    assertMainFieldsUnique([field]);
    checkedCurrencyFields.add(field);
  };
  const currencyIndexOf = (context) => {
    const field = normalizeCell(context && context.currencyField);
    const index = field ? sourceIndexByField.get(field) : undefined;
    return index === undefined ? null : { field, index };
  };
  // 读成空值、但不能按空单元格回填的目标：返回跳过原因（Excel 错误值 / 公式，或合并单元格 / 数组公式的从属位置）
  const blockedReasonOf = (rowNumber, columnIndex) => {
    const kind = typeof isUnreadableCell === 'function' ? isUnreadableCell(rowNumber, columnIndex) : '';
    if (kind === 'unwritable') return 'target-cell-unwritable';
    return kind ? 'target-cell-unreadable' : '';
  };

  // 待回填行：命中待回填行条件，且至少一个回填目标单元格为空（需要从来源行取值）。目标单元格都已有值的行（如条件是
  //   「描述包含 Trade」而该行银行已带日期）按普通行处理，不消耗来源行（D11）；币种只给待回填行补。
  const targetRowIndexes = new Set();
  //   账单自带的合计行（按未修改的源行判定，如账单日期取「Date，其次 Remarks」时 Date 为空、Remarks 为「合计」）不参与回填：
  //   补上日期后映射就看不到合计标签，合计金额会被当成交易再导出一次
  for (let index = 1; index < rows.length; index += 1) {
    if (matchesRowFilterRules(rows[index], compiledRowRules)
        && targets.some((target) => isEmptyCell(rows[index][target.targetIndex]))
        && !(typeof isSummaryRow === 'function' && isSummaryRow(rows[index]))) {
      targetRowIndexes.add(index);
    }
  }
  if (!targetRowIndexes.size) {
    return { enabled: true, rows, rowNumbers, issues: [], patches: [], skippedRows: [], stats: emptyStats };
  }
  assertMainFieldsUnique([validated.matchField]);

  // 来源 sheet：配对值 → 按物理顺序的来源行与下一笔未使用行的下标（游标前移即消耗，同值大组也是线性的）
  const source = readSourceSheet(validated.sourceSheetName) || {};
  const requiredSourceFields = [validated.sourceMatchField]
    .concat(validated.backfillFields.map((item) => item.sourceField))
    .filter((field, index, list) => list.indexOf(field) === index);
  const { indexByField: sourceFieldIndex, dataRows: sourceDataRows } = locateSourceTable(
    source.rows,
    source.rowNumbers,
    requiredSourceFields,
    validated.sourceSheetName,
    source.columnOffset
  );
  const sourceMatchIndex = resolveRequiredIndex(sourceFieldIndex, validated.sourceMatchField, validated.sourceSheetName);
  const sourceIndexes = targets.map((item) => resolveRequiredIndex(sourceFieldIndex, item.sourceField, validated.sourceSheetName));
  const queueByKey = new Map();
  sourceDataRows.forEach((entry) => {
    const key = buildMatchKey(entry.row[sourceMatchIndex], validated.matchMode, codes);
    if (key === null) return;
    if (!queueByKey.has(key)) queueByKey.set(key, { entries: [], next: 0 });
    queueByKey.get(key).entries.push(entry);
  });
  const takeSource = (key) => {
    const queue = queueByKey.get(key);
    if (!queue || queue.next >= queue.entries.length) return null;
    const entry = queue.entries[queue.next];
    queue.next += 1;
    return entry;
  };
  const sourceDateOf = (entry, targetIndex) => parseBackfillDate(entry.row[sourceIndexes[targetIndex]], {
    dateOrder: validated.sourceDateOrder,
    excelDateSystem
  });

  // 本 sheet 币种：同一币种列上，非待回填行该列唯一的非空值（按币种列分别计算）
  const accountCurrencyStatusOf = (row, sheetCurrency) => (
    typeof resolveAccountCurrencyStatus === 'function' ? resolveAccountCurrencyStatus(row, sheetCurrency) || '' : ''
  );
  const sheetCurrencyByField = new Map();
  const sheetCurrencyOf = (currency) => {
    if (!sheetCurrencyByField.has(currency.field)) {
      const values = new Set();
      for (let index = 1; index < rows.length; index += 1) {
        if (targetRowIndexes.has(index)) continue;
        const rowCurrency = currencyIndexOf(contextOf(rows[index]));
        if (!rowCurrency || rowCurrency.field !== currency.field) continue;
        const value = normalizeCell(rows[index][currency.index]);
        if (value) values.add(value);
      }
      sheetCurrencyByField.set(currency.field, values.size === 1 ? Array.from(values)[0] : '');
    }
    return sheetCurrencyByField.get(currency.field);
  };

  const issues = [];
  const patches = [];
  const skippedRows = [];
  const nextRows = [rows[0]];
  const nextRowNumbers = [rowNumbers[0]];
  const billDateCheckRows = [];
  let backfilledRows = 0;

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = rowNumbers[index] || index + 1;
    if (!targetRowIndexes.has(index)) {
      nextRows.push(row);
      nextRowNumbers.push(rowNumber);
      continue;
    }
    const matchRaw = row[matchIndex];
    const skip = (reason, extra = {}) => {
      skippedRows.push({ row, rowNumber });
      issues.push({
        type: 'cross-sheet-backfill-skipped',
        rowNumber,
        reason,
        reasonText: SKIP_REASONS[reason],
        matchField: validated.matchField,
        matchValue: normalizeCell(matchRaw),
        sourceSheetName: validated.sourceSheetName,
        sourceMatchField: validated.sourceMatchField,
        ...(sourceFileName ? { sourceFileName } : {}),
        ...(sourceFilePath ? { sourceFilePath } : {}),
        ...extra
      });
    };
    const key = buildMatchKey(matchRaw, validated.matchMode, codes);
    if (key === null) {
      skip(validated.matchMode === 'exact' && isImpreciseNumber(matchRaw) ? 'match-value-imprecise' : 'match-value-missing');
      continue;
    }
    const sourceEntry = takeSource(key);
    if (!sourceEntry) {
      skip('no-source-row', { matchKey: formatMatchKey(key, validated.matchMode) });
      continue;
    }
    // 回填前的映射路径与收支：回填的普通字段（如拆分条件字段）或补上的币种都不能改变银行原始交易的路径、方向与金额
    const originalRoute = contextOf(row).route || '';
    const originalAmounts = typeof resolveRowAmounts === 'function' ? resolveRowAmounts(row) : null;
    const originalAccount = typeof resolveRowAccountKey === 'function' ? resolveRowAccountKey(row) : null;
    const nextRow = row.slice();
    const cells = [];
    // 来源值为空、没有填入的目标字段（非日期字段允许为空，D2）：整行一个也没填入时单独提示，配对仍占用该来源行
    const emptySourceFields = [];
    let skipReason = '';
    for (let targetIndex = 0; !skipReason && targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      if (!isEmptyCell(nextRow[target.targetIndex])) continue;
      const blockedReason = blockedReasonOf(rowNumber, target.targetIndex);
      if (blockedReason) {
        skipReason = blockedReason;
        break;
      }
      const sourceValue = sourceEntry.row[sourceIndexes[targetIndex]];
      if (target.isDate) {
        const isoDate = sourceDateOf(sourceEntry, targetIndex);
        if (!isoDate) {
          skipReason = 'source-date-invalid';
          break;
        }
        nextRow[target.targetIndex] = isoDate;
        cells.push({ field: target.targetField, columnIndex: target.targetIndex, value: isoDate, kind: 'date' });
      } else if (isImpreciseNumber(sourceValue)) {
        skipReason = 'source-value-imprecise';
        break;
      } else if (typeof sourceValue === 'number' && !Number.isFinite(sourceValue)) {
        skipReason = 'source-value-unreadable';
        break;
      } else if (!isEmptyCell(sourceValue)) {
        nextRow[target.targetIndex] = sourceValue;
        cells.push({ field: target.targetField, columnIndex: target.targetIndex, value: sourceValue, kind: 'value' });
      } else {
        emptySourceFields.push(target.targetField);
      }
    }
    // 币种与 BillDate 源列按回填后的行实际走的映射确定（拆分映射的币种取自各拆分行，不补主映射币种列）
    const context = skipReason ? {} : contextOf(nextRow);
    if (!skipReason && (context.route || '') !== originalRoute) skipReason = 'route-changed';
    const currency = skipReason ? null : currencyIndexOf(context);
    if (currency && isEmptyCell(nextRow[currency.index])) {
      // 补币种同样向原表写值：币种列在主表表头中重名时与回填目标同样整份报错（只有列名，无法判定哪列是该笔交易的币种）
      assertCurrencyFieldUnique(currency.field);
      const sheetCurrency = sheetCurrencyOf(currency);
      const blockedReason = blockedReasonOf(rowNumber, currency.index);
      if (blockedReason) {
        skipReason = blockedReason;
      } else if (!sheetCurrency) {
        skipReason = 'currency-undetermined';
      } else if (accountCurrencyStatusOf(nextRow, sheetCurrency) === 'conflict') {
        skipReason = 'currency-conflicts-account';
      } else if (accountCurrencyStatusOf(nextRow, sheetCurrency) === 'account') {
        // 该行账户维护了「无币种时的币种」且与本表推断一致：不补本表写法（如 usd），由账户兜底给出与同账户其他行相同的币种值
      } else {
        nextRow[currency.index] = sheetCurrency;
        cells.unshift({ field: currency.field, columnIndex: currency.index, value: sheetCurrency, kind: 'value' });
      }
    }
    // 回填、补币种后按最终的行重新确定映射：生成明细时按补完的行判断是否走拆分，与回填前不同则跳过；同一路径下收支
    //   方向或金额改变（如「Ccy 为空记支出、Ccy=NGN 记收入」，或回填的字段是发生额条件）同样跳过
    const finalContext = contextOf(nextRow);
    if (!skipReason && (finalContext.route || '') !== originalRoute) {
      skipReason = 'route-changed';
    }
    if (!skipReason && originalAmounts !== null && resolveRowAmounts(nextRow) !== originalAmounts) {
      skipReason = 'amount-changed';
    }
    // 账户归属同样不能因回填或补币种改变（如 MerchantId 拼接「账号 + 币种」，补上 USD 后指向另一个清算账号）
    if (!skipReason && originalAccount !== null && resolveRowAccountKey(nextRow) !== originalAccount) {
      skipReason = 'account-changed';
    }
    const rowBillDateFields = finalContext.billDateFields instanceof Set ? finalContext.billDateFields : new Set();
    const billDateBackfilled = !skipReason && cells.some((cell) => cell.kind === 'date' && rowBillDateFields.has(cell.field));
    // 回填了账单日期所用的列：按该行实际的账单日期映射核对能取到有效日期（如映射取「8 位纯数字」特征值时，回填的
    //   yyyy-mm-dd 取不到），取不到时跳过该行，不输出空账单日期的交易
    if (billDateBackfilled && typeof resolveRowBillDate === 'function' && !normalizeCell(resolveRowBillDate(nextRow))) {
      skipReason = 'backfilled-date-unmapped';
    }
    if (skipReason) {
      skip(skipReason, { sourceRowNumber: sourceEntry.rowNumber });
      continue;
    }
    nextRows.push(nextRow);
    nextRowNumbers.push(rowNumber);
    if (cells.length) {
      backfilledRows += 1;
      patches.push({ rowNumber, sourceRowNumber: sourceEntry.rowNumber, cells });
    } else {
      // 已配上来源行、但来源行中要回填的字段都为空（且不需补币种）：该行保留（是否写入明细仍按「过滤账单」等后续处理）、来源行已占用，没有任何改动；
      //   单独记录两边行号与空字段，不算已回填，也不算跳过
      issues.push({
        type: 'cross-sheet-backfill-matched-empty',
        rowNumber,
        sourceRowNumber: sourceEntry.rowNumber,
        sourceSheetName: validated.sourceSheetName,
        emptyFields: emptySourceFields.slice(),
        ...(sourceFileName ? { sourceFileName } : {}),
        ...(sourceFilePath ? { sourceFilePath } : {})
      });
    }
    if (billDateBackfilled) {
      billDateCheckRows.push({ originalIndex: index, rowNumber, row: nextRow });
    }
  }

  // 日期区间提示：与该行之前、之后最近的、日期有效的非待回填行比较（含端点，正序倒序均可）。
  //   只有一侧时按本表日期的整体顺序（首个与最后一个有效日期）只比较这一侧；整体顺序无法判断时不提示。
  //   前后最近的有效日期各一次线性遍历预先算好。
  if (billDateCheckRows.length && typeof resolveRowBillDate === 'function') {
    const neighborDates = rows.map((row, index) => (
      index > 0 && !targetRowIndexes.has(index) ? normalizeCell(resolveRowBillDate(row)) : ''
    ));
    const previousDates = new Array(rows.length).fill('');
    const followingDates = new Array(rows.length).fill('');
    for (let index = 1, last = ''; index < rows.length; index += 1) {
      previousDates[index] = last;
      if (neighborDates[index]) last = neighborDates[index];
    }
    for (let index = rows.length - 1, last = ''; index >= 1; index -= 1) {
      followingDates[index] = last;
      if (neighborDates[index]) last = neighborDates[index];
    }
    const validDates = neighborDates.filter(Boolean);
    const firstDate = validDates[0] || '';
    const lastDate = validDates[validDates.length - 1] || '';
    const direction = firstDate && lastDate && firstDate !== lastDate
      ? (firstDate < lastDate ? 'asc' : 'desc')
      : '';
    billDateCheckRows.forEach(({ originalIndex, rowNumber, row }) => {
      const date = normalizeCell(resolveRowBillDate(row));
      if (!date) return;
      const prevDate = previousDates[originalIndex];
      const nextDate = followingDates[originalIndex];
      let outOfRange = false;
      if (prevDate && nextDate) {
        const [low, high] = [prevDate, nextDate].sort();
        outOfRange = date < low || date > high;
      } else if (prevDate) {
        outOfRange = (direction === 'asc' && date < prevDate) || (direction === 'desc' && date > prevDate);
      } else if (nextDate) {
        outOfRange = (direction === 'asc' && date > nextDate) || (direction === 'desc' && date < nextDate);
      }
      if (outOfRange) {
        issues.push({
          type: 'cross-sheet-backfill-date-out-of-range',
          rowNumber,
          date,
          prevDate,
          nextDate,
          ...(sourceFileName ? { sourceFileName } : {}),
          ...(sourceFilePath ? { sourceFilePath } : {})
        });
      }
    });
  }

  return {
    enabled: true,
    rows: nextRows,
    rowNumbers: nextRowNumbers,
    issues,
    patches,
    skippedRows,
    stats: { targetRows: targetRowIndexes.size, backfilledRows, skippedRows: skippedRows.length },
    sourceSheetName: validated.sourceSheetName
  };
}

// 不能单独填写的区域（合并单元格、数组公式；{ s: { r, c }, e: { r, c } }，物理坐标）中，左上角以外的位置不能单独写入。
//   按物理列建索引，且只为实际检查的列建立；列内保留区间表示（按起始行排序，记前缀最大结束行），查询时二分定位后只回看
//   可能覆盖该行的区域——不按区域跨越的行数分配内存（表头与末笔交易相隔数十万行、旁边的列跨这些行纵向合并时同样只占区域数）
function createUnwritableCellLookup(ranges) {
  const list = Array.isArray(ranges) ? ranges : [];
  const byColumn = new Map();
  const indexOf = (column) => {
    if (!byColumn.has(column)) {
      const sorted = list.filter((range) => column >= range.s.c && column <= range.e.c).sort((a, b) => a.s.r - b.s.r);
      const maxEnds = [];
      sorted.forEach((range, index) => maxEnds.push(index ? Math.max(maxEnds[index - 1], range.e.r) : range.e.r));
      byColumn.set(column, { sorted, maxEnds });
    }
    return byColumn.get(column);
  };
  return (row, column) => {
    if (!list.length) return false;
    const { sorted, maxEnds } = indexOf(column);
    let low = 0;
    let high = sorted.length - 1;
    let last = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (sorted[middle].s.r <= row) {
        last = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    for (let index = last; index >= 0 && maxEnds[index] >= row; index -= 1) {
      const range = sorted[index];
      if (range.e.r >= row && !(row === range.s.r && column === range.s.c)) return true;
    }
    return false;
  };
}

module.exports = {
  CROSS_SHEET_BACKFILL_LABEL,
  CROSS_SHEET_BACKFILL_MISSING_MESSAGE,
  CROSS_SHEET_BACKFILL_MATCH_MODES,
  CROSS_SHEET_BACKFILL_DATE_ORDERS,
  MATCH_MODE_LABELS,
  SKIP_REASONS,
  normalizeCrossSheetBackfillRule,
  hasCrossSheetBackfillSettings,
  validateCrossSheetBackfillRule,
  collectCrossSheetBackfillMainFields,
  parseAmountCents,
  parseBackfillDate,
  createUnwritableCellLookup,
  applyCrossSheetBackfill
};
