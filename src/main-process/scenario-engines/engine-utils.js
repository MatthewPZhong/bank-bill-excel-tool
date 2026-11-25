// v2.0.0-beta.3：场景算法引擎共享工具
//
// 仅依赖纯 JS（无 Electron / DB / FS），便于单元测试

// 字符串/数字规范化（用于条件判定 + 配对比较）
function normalizeCellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  return String(value).trim();
}

function isEmptyValue(value) {
  return normalizeCellValue(value) === '';
}

// 数值规范化（C3 发生额绝对值 + 数值 join 用）
// 返回 number（Number.isFinite 通过） 或 null
function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const cleaned = String(value).replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// 交易编号归一化为纯数字串（v3.0.5 决策9：单一真相，下沉自 boc-fx-link-builder.js）。
//   纯数字原样（'123'→'123'）；带尾零小数（'123.0' / '926181062.0'）去尾零取整数部分；
//   空 / 含非数字字符（含字母 / 分隔符）/ 科学计数法（'1.2e3'）/ 非零小数（'123.5'）→ ''。
//   number 入参（如交割表「交易编号」926181062）经 normalizeCellValue 转 String 后同口径处理（9 位纯数字无科学计数风险）。
//   🔴 三处共用单一真相（builder 派生分组 / 仓储 fx upsert 幂等键 / migration 键列回填）——禁内联第二份（防口径漂移）。
//     boc-fx-link-builder 仍 re-export 本函数（既有单测从 builder import，行为字节不变）。
function normalizeTransactionNo(value) {
  const s = normalizeCellValue(value);
  if (s === '') return '';
  // 纯整数
  if (/^\d+$/.test(s)) return s;
  // 带小数点但小数部分全为 0（去尾零）：123.0 / 123.00 → 123；123.5 不接受
  const m = s.match(/^(\d+)\.0+$/);
  if (m) return m[1];
  // 其余（含字母 / 科学计数 / 非零小数 / 千分位）一律视为非交易编号
  return '';
}

// 条件判定（C1 conditions / C2 billTypes 共用）
// op ∈ '等于' / '不等于' / '包含' / '不包含' / '空值' / '非空值' / '开头为'
function evaluateCondition(row, condition) {
  if (!condition || !condition.field) return false;
  const cellValue = normalizeCellValue(row[condition.field]);
  const op = condition.op;
  const expected = condition.value === undefined || condition.value === null
    ? ''
    : String(condition.value);

  switch (op) {
    case '等于':       return cellValue === expected;
    case '不等于':     return cellValue !== expected;
    case '包含':       return expected !== '' && cellValue.indexOf(expected) >= 0;
    case '不包含':     return expected === '' || cellValue.indexOf(expected) < 0;
    case '空值':       return cellValue === '';
    case '非空值':     return cellValue !== '';
    case '开头为':     return expected !== '' && cellValue.startsWith(expected);
    default:
      return false;
  }
}

// 给行打 _rowId（如果还没有），用于 first-match-wins 锁定
// 关键：必须写回 row._rowId，否则 C2 后续 leftRow._rowId / rightRow._rowId 取值会得到 undefined
// （Codex PR #31 F1 P1 修复）
function ensureRowId(row, fallbackIndex) {
  if (row._rowId !== undefined && row._rowId !== null) return row._rowId;
  const generated = `row_${fallbackIndex}`;
  row._rowId = generated;
  return generated;
}

// 简化的 warning 收集器
function makeWarningCollector(scenarioId, scenarioName) {
  const warnings = [];
  return {
    push(payload) {
      warnings.push({
        scenarioId,
        scenarioName,
        ...payload
      });
    },
    list() {
      return warnings;
    }
  };
}

// 修改记录收集器
// - record(rowId, column, oldValue, newValue) — 实际改了字段的行（用于标黄）
// - lock(rowId) — 参与场景命中但未必改字段的行（用于 first-match-wins）
//   每次 record 自动调 lock；C2 配对成功时 leftRow 也要单独 lock
// （Codex PR #31 F2 P1 修复：C2 leftRow 之前没有进入锁集合）
function makeModificationCollector() {
  const modifications = [];
  const lockedRowIds = new Set();
  return {
    record(rowId, column, oldValue, newValue) {
      modifications.push({ rowId, column, oldValue, newValue });
      lockedRowIds.add(rowId);
    },
    lock(rowId) {
      lockedRowIds.add(rowId);
    },
    listModifications() {
      return modifications;
    },
    listLockedRowIds() {
      return lockedRowIds;
    }
  };
}

// v3.2.22（🔴 资金红线）：账户映射「链接表账户号 → 清结算系统银行账号」的唯一取值口径。
//   调拨对账单派生 big_account（fund-transfer-recon-builder）与 R5s2 网关 merchantid（r5-fund-transfer-backfill、
//   多对多检测器网关侧）共用：先 normalizeCellValue（与 getMappingMap 写入键同口径，幂等），命中 → 清结算账号，
//   未命中 → 原值。用 ?? 而非 ||：只有键缺失才回退。非 Map（缺省 / 误传）按空表处理 = 原值 passthrough。
//   v3.2.22 转义护栏（🔴 资金红线，fail-closed）：单工作表 .xlsx 链接表经流式读取导入时不解 Excel 的 `_xHHHH_` 转义，
//   且富文本单元格各片段直接拼接（片段边界丢失）；多工作表经 SheetJS 读取时会解。落库字符串里的 `_xHHHH_` 可能是
//   控制字符 / 下划线的转义、也可能就是字面量或跨片段拼出来的，真实账户号有多种解释且无法枚举。映射非空时，账号含
//   这种写法一律返回空串：调用方的非空账号护栏使其不参与匹配，由网关来源告警 / 派生计数提示人工核对。实际的账户号
//   不含这种写法；映射为空时不判（与改动前一致）。
//   v3.2.22 数值写法护栏（🔴 资金红线，fail-closed）：链接表单元格按数值存放的长账号，读取库把它解析成 JS 数值，大于
//   9007199254740991 的会被舍入（`9007199254740993` 落库成 `'9007199254740992'`，19 位卡号 `6222020200112233445` 落库成
//   `'6222020200112233000'`），Excel 数值本身只存 15 位有效数字，带前导 0 的账号（`00123`）按数值存放时读入即为 `'123'`，
//   落库字符串无法确认原文。账号是数值的标准写法、且与映射里的链接表账户号对得上（mappedAccountAmbiguity 返回
//   'precision'：某键是带前导 0 等非标准写法、数值相同，或可能已丢失精度且按数值 / 位数与前 15 位相同；含正好是映射键）时
//   同样返回空串：既不按丢失格式或精度后的值命中映射，也不让本该命中的账号静默漏掉；对不上任何映射键时原值返回（与未映射行
//   一致，不会被换成清结算账号）。
function resolveMappedAccount(accountMappingMap, rawAccount) {
  const account = normalizeCellValue(rawAccount);
  if (!(accountMappingMap instanceof Map)) return account;
  if (isAmbiguousMappedAccount(accountMappingMap, account)) return '';
  return accountMappingMap.get(account) ?? account;
}

// 与读取端同口径：`_x` + 4 位十六进制（不分大小写）+ `_`。
const OOXML_ESCAPE_TEST = /_x[0-9A-Fa-f]{4}_/i;
// 文本（已归一化）含 `_xHHHH_` 写法：单工作表 `.xlsx` 流式导入的链接表保留转义原文、经 SheetJS 读取的表已解码，
//   这类字符串无法判断是转义还是字面量。
function containsOoxmlEscape(text) {
  return typeof text === 'string' && OOXML_ESCAPE_TEST.test(text);
}

// v3.2.22（🔴 资金红线）：按数值存放的长账号可能已丢失精度——Excel 数值单元格只保留 15 位有效数字（录入的第 16 位起被
//   置 0），大于 9007199254740991 的数值读入 JS 时还会被舍入。
const EXCEL_SIGNIFICANT_DIGITS = 15;
// 整数数值的十进制数字串（不含符号）；指数写法（≥ 1e21）按 JS 标准写法的有效数字补 0（与 String(n) 同口径，不取二进制精确值）。
function integerDigitsOfNumber(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) return null;
  const text = String(Math.abs(n));
  const exp = /^(\d)(?:\.(\d+))?e\+(\d+)$/.exec(text);
  if (!exp) return text;
  return (exp[1] + (exp[2] || '')).padEnd(Number(exp[3]) + 1, '0');
}
// 数值、或数值的 JS 标准写法文本（String(Number(text)) === text，含 `1e+21` 这类指数写法）可能已丢失精度时返回其十进制数字串，
//   否则 null：16 位及以上，且大于 9007199254740991（可能被 JS 舍入）或第 16 位起全为 0（可能被 Excel 截断）。不是标准写法的
//   文本（如 `9007199254740993`、带前导 0）只能来自文本单元格；在精确范围内、第 16 位起有非 0 数字的数也没有丢失精度：原文可信。
function precisionLostDigitsOf(value) {
  let n = value;
  if (typeof value === 'string') {
    if (value === '') return null;
    n = Number(value);
    if (String(n) !== value) return null;
  }
  const digits = integerDigitsOfNumber(n);
  if (digits === null || digits.length <= EXCEL_SIGNIFICANT_DIGITS) return null;
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER || /^0+$/.test(digits.slice(EXCEL_SIGNIFICANT_DIGITS))) return digits;
  return null;
}
// 文本（已归一化）可能是按数值读入、已丢失精度的长数字写法（见 precisionLostDigitsOf；只判文本）。
function mayBeRoundedLongNumber(text) {
  return typeof text === 'string' && precisionLostDigitsOf(text) !== null;
}

// 账号文本集合的「数值写法指纹」，十进制写法（可带符号、小数、指数；不含 `0x` 等其他进制写法）的账号：
//   aliases：不是数值标准写法的账号（如带前导 0 的 `00123`）的数值——按数值读入的单元格不保留显示格式，`00123` 读入即为 123；
//   values：数值 ≥ 1e15 的账号的数值（判断 JS 舍入后是否相同）；
//   prefixes：有效数字超过 15 位的账号（整数或小数）的截断键「符号 + 数量级 + 前 15 位有效数字」（按原文数字，判断 Excel
//     截断后是否相同；Excel 截断尾数不改变正负号与数量级）。
const DECIMAL_NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DECIMAL_PARTS = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
// 十进制写法 → { sign, digits, exponent }：digits 为有效数字（去掉前导与末尾的 0），数值 = 0.digits × 10^exponent；0 或
//   不是十进制写法 → null。
function decimalFormOfText(text) {
  const match = typeof text === 'string' ? DECIMAL_PARTS.exec(text) : null;
  if (!match || (match[2] === '' && (match[3] || '') === '')) return null;
  const all = match[2] + (match[3] || '');
  const leading = all.length - all.replace(/^0+/, '').length;
  const digits = all.slice(leading).replace(/0+$/, '');
  if (digits === '') return null;
  return { sign: match[1] === '-' ? '-' : '', digits, exponent: match[2].length + Number(match[4] || 0) - leading };
}
// 数值按 JS 标准写法（与 String(n) 同口径，含指数写法）的十进制形式。
function decimalFormOfNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) ? decimalFormOfText(String(n)) : null;
}
function precisionPrefixOf(form) {
  return `${form.sign}${form.exponent}:${form.digits.slice(0, EXCEL_SIGNIFICANT_DIGITS).padEnd(EXCEL_SIGNIFICANT_DIGITS, '0')}`;
}
function precisionFingerprintsOf(accounts) {
  const fingerprints = { values: new Set(), prefixes: new Set(), aliases: new Set() };
  for (const account of accounts || []) {
    if (typeof account !== 'string' || !DECIMAL_NUMBER_TEXT.test(account)) continue;
    const n = Number(account);
    if (!Number.isFinite(n)) continue;
    if (String(n) !== account) fingerprints.aliases.add(n);
    const form = decimalFormOfText(account);
    if (form && form.digits.length > EXCEL_SIGNIFICANT_DIGITS) fingerprints.prefixes.add(precisionPrefixOf(form));
    if (Math.abs(n) >= 1e15) fingerprints.values.add(n);
  }
  return fingerprints;
}
// 按数值读入的 n 与指纹里的账号对得上（不含 aliases）：
//   截断：n 的有效数字不超过 15 位，且与某个有效数字超过 15 位的账号符号、数量级、前 15 位相同（该账号按数值存放时 Excel
//     截断即为 n；整数、小数同一规则）；
//   同值：n 可能已丢失精度（precisionLostDigitsOf：映射外的真实账号按整数写法考虑）且与某账号按数值相同。
function collidesByPrecision(n, fingerprints) {
  if (!fingerprints) return false;
  const form = decimalFormOfNumber(n);
  if (form === null) return false;
  if (form.digits.length <= EXCEL_SIGNIFICANT_DIGITS && fingerprints.prefixes.has(precisionPrefixOf(form))) return true;
  return precisionLostDigitsOf(n) !== null && fingerprints.values.has(n);
}
// v3.2.22（🔴 资金红线）：按数值读入的账号（JS 数值，或数值的 JS 标准写法文本——链接表单元格按数值存放时落库即为这种写法）
//   与 fingerprints 里的账号对得上、无法确定真实账号 → true：它的数值是某个非标准写法账号的数值（前导 0 等显示格式已丢），
//   或是某个有效数字超过 15 位的账号经 Excel 截断后的值、或可能已丢失精度且与某账号按数值相同（collidesByPrecision）。
//   不是标准写法的文本（如 `00123`、`9007199254740993`）只能来自文本单元格，原文可信，不算。
function numericReadValueOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && String(n) === value ? n : null;
}
function numericReadAccountAmbiguous(value, fingerprints) {
  if (!fingerprints) return false;
  const n = numericReadValueOf(value);
  if (n === null) return false;
  if (fingerprints.aliases.has(n)) return true;
  return collidesByPrecision(n, fingerprints);
}
// 账号集合的数值写法反查：返回函数 (value) → 与按数值读入的 value 对得上的账号数组（与 numericReadAccountAmbiguous 同一判据，
//   等价于逐个账号判断，按指纹建索引、不随账号数线性扫描）。
function numericReadCollisionIndexOf(accounts) {
  const byAlias = new Map();
  const byValue = new Map();
  const byPrefix = new Map();
  const add = (map, key, account) => {
    const list = map.get(key);
    if (list) list.push(account);
    else map.set(key, [account]);
  };
  for (const account of accounts || []) {
    const fingerprints = precisionFingerprintsOf([account]);
    fingerprints.aliases.forEach((n) => add(byAlias, n, account));
    fingerprints.values.forEach((n) => add(byValue, n, account));
    fingerprints.prefixes.forEach((prefix) => add(byPrefix, prefix, account));
  }
  return (value) => {
    const n = numericReadValueOf(value);
    if (n === null) return [];
    const found = new Set(byAlias.get(n) || []);
    const form = decimalFormOfNumber(n);
    if (form !== null && form.digits.length <= EXCEL_SIGNIFICANT_DIGITS) {
      for (const account of byPrefix.get(precisionPrefixOf(form)) || []) found.add(account);
    }
    if (precisionLostDigitsOf(n) !== null) {
      for (const account of byValue.get(n) || []) found.add(account);
    }
    return Array.from(found);
  };
}
// 映射键的数值写法指纹（按映射对象缓存，键数变化时重算；生产每轮新建映射、不改写）。
const KEY_PRECISION_FINGERPRINTS = new WeakMap();
function keyPrecisionFingerprintsOf(accountMappingMap) {
  const cached = KEY_PRECISION_FINGERPRINTS.get(accountMappingMap);
  if (cached && cached.size === accountMappingMap.size) return cached.fingerprints;
  const fingerprints = precisionFingerprintsOf(accountMappingMap.keys());
  KEY_PRECISION_FINGERPRINTS.set(accountMappingMap, { size: accountMappingMap.size, fingerprints });
  return fingerprints;
}

// 映射非空时账号无法确定真实值的原因（见 resolveMappedAccount）：'escape' = 含 `_xHHHH_` 写法；'precision' = 数值写法、
//   与映射里的链接表账户号对得上（numericReadAccountAmbiguous：前导 0 等格式已丢，或可能已丢失精度）；其余 null。
function mappedAccountAmbiguity(accountMappingMap, rawAccount) {
  if (!(accountMappingMap instanceof Map) || accountMappingMap.size === 0) return null;
  const account = normalizeCellValue(rawAccount);
  if (containsOoxmlEscape(account)) return 'escape';
  if (numericReadAccountAmbiguous(account, keyPrecisionFingerprintsOf(accountMappingMap))) return 'precision';
  return null;
}

// 映射非空且账号无法确定真实值（转义写法 / 与映射键对得上的数值写法）→ true。
function isAmbiguousMappedAccount(accountMappingMap, rawAccount) {
  return mappedAccountAmbiguity(accountMappingMap, rawAccount) !== null;
}

// v3.2.22：账号是否命中映射（决定 R5s2 网关是否按「映射目标账号」追加同渠道校验、缺渠道诊断是否视为映射行）：
//   原账号是映射键（含 CLR → CLR 同值映射）。无法确定真实值的账号（已换成空串、不参与匹配）为 false。
function isMappedAccountHit(accountMappingMap, rawAccount) {
  if (!(accountMappingMap instanceof Map) || accountMappingMap.size === 0) return false;
  const account = normalizeCellValue(rawAccount);
  if (isAmbiguousMappedAccount(accountMappingMap, account)) return false;
  return accountMappingMap.has(account);
}

// v3.2.22：银行账号单元格按数值读入（readBankStatement 原样保留数值单元格），与 fingerprints（precisionFingerprintsOf 收集的
//   映射目标账号）对得上（numericReadAccountAmbiguous）→ true。文本单元格的账号原文可信，不算。
function isPrecisionAmbiguousBankAccount(value, fingerprints) {
  return typeof value === 'number' && numericReadAccountAmbiguous(value, fingerprints);
}

// v3.2.22：告警里的 `_xHHHH_` 写法显示为「⟨U+HHHH⟩」。错误报告按 OOXML 原文写出，`_xHHHH_` 会被 Excel / 读取库解码成
//   对应字符（控制字符不可见），人工复核需要看到的是写法本身。替换结果不含下划线，不会拼出新的转义写法。
function showOoxmlEscapes(text) {
  return String(text).replace(/_x([0-9A-Fa-f]{4})_/gi, (_match, hex) => `⟨U+${hex.toUpperCase()}⟩`);
}

// v3.2.22（🔴 资金红线·可观测）：回填值来自链接表 / 派生表（单工作表 `.xlsx` 流式导入保留 `_xHHHH_` 转义原文，经 SheetJS
//   读取的会解码），银行账单原值经 SheetJS 读取已解码。两者文字相同且含这种写法时（`RID_x000D_X` 可能是 `RID\rX` 的转义原文，
//   也可能就是字面值），无法确认是否同一个值：调用方照常按相同处理（不改写、不标黄，仍消费该银行行），另告警人工核对。
const ESCAPE_SAME_VALUE_WARNING_CODE = 'linked-value-escape-same-value-ambiguous';
function isEscapeAmbiguousSameValue(oldValue, newValue) {
  return typeof newValue === 'string' && newValue !== '' && oldValue === newValue && containsOoxmlEscape(newValue);
}
// 告警不写完整值（C3 可配置为账号、卡号、附言等字段）：只写尾号（超过 8 个字符时的末 4 位，转义片段按 ⟨U+HHHH⟩ 显示）、
//   字符数与至多 3 个转义片段，由银行行号与字段名定位。
function describeEscapeValue(value) {
  const text = String(value);
  const chars = Array.from(text);
  const fragments = Array.from(new Set((text.match(/_x[0-9A-Fa-f]{4}_/gi) || []).map(showOoxmlEscapes))).slice(0, 3);
  const tail = chars.length > 8 ? `尾号「${showOoxmlEscapes(chars.slice(-4).join(''))}」，` : '';
  return `（${tail}共 ${chars.length} 个字符，含 Excel 转义写法：${fragments.join('、')}）`;
}
function createEscapeSameValueWarning({ rowId, engine, column, value, source }) {
  return {
    rowId,
    engine,
    code: ESCAPE_SAME_VALUE_WARNING_CODE,
    message: `${source}${describeEscapeValue(value)}与银行行(${rowId})「${column}」当前值文字相同，但 ⟨U+HHHH⟩ 处是` +
      ' _xHHHH_ 写法，可能代表看不见的字符，无法确认两者是否同一个值；已按相同处理、未改写，请人工核对'
  };
}

// 比较两端值是否相等（C2 / C3 配对用）
// 数字字段 → 比较 number；字符串字段 → 比较 normalize 后的字符串
function valuesEqual(left, right, { numeric = false } = {}) {
  if (numeric) {
    const a = parseNumber(left);
    const b = parseNumber(right);
    return a !== null && b !== null && a === b;
  }
  return normalizeCellValue(left) === normalizeCellValue(right);
}

module.exports = {
  ensureRowId,
  evaluateCondition,
  isEmptyValue,
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
  normalizeTransactionNo,
  parseNumber,
  containsOoxmlEscape,
  createEscapeSameValueWarning,
  ESCAPE_SAME_VALUE_WARNING_CODE,
  isAmbiguousMappedAccount,
  isEscapeAmbiguousSameValue,
  isPrecisionAmbiguousBankAccount,
  numericReadAccountAmbiguous,
  numericReadCollisionIndexOf,
  precisionFingerprintsOf,
  precisionLostDigitsOf,
  isMappedAccountHit,
  mappedAccountAmbiguity,
  mayBeRoundedLongNumber,
  resolveMappedAccount,
  showOoxmlEscapes,
  valuesEqual
};
