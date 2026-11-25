// v2.1.16-beta.2 R5 场景2「中台调拨订单对账ID回填」引擎（🔴 资金红线）
// PRD §四 需求 2（R2.1~R2.6） / TECH_DESIGN §5.3 / §4（跨表字段映射）
//
// 业务语义：
//   网关 TradeType=FundTransfer-out 行 ↔ 第四轮（R4）处理过的银行 FundType=FundTransfer-out 行；
//   FundTransfer-in 同逻辑（两方向各自独立跑，互不串池）。命中 → 把网关 reconciliationid
//   回填进银行 ReconciliationId（标黄 ReconciliationId 列）。
//
// 跨表字段（显式映射，绝不假设同名 —— TECH_DESIGN §4）：
//   网关（gateway-bill，真实表头）：
//     gw.TradeType            交易类型（用于按 direction 过滤）
//     gw.merchantid（小写）    商户 ID（v3.2.22：先按账户映射换成清结算系统银行账号，再与 bank.MerchantId 比较）
//     gw.currency（小写）      币种
//     gw.amount（小写，单列）  金额（含正负方向，本场景取绝对值）
//     gw.Billdate            账单日期
//     gw.reconciliationid（小写） 对账 ID（回填的来源）
//   银行（bank statement，驼峰）：
//     bank.FundType                  资金性质（R4 后的当前值，用于按 direction 过滤）
//     bank.MerchantId（驼峰）        商户 ID
//     bank.Currency                  币种
//     bank['Credit Amount'] + bank['Debit Amount']（双列） 发生额
//     bank['Extra Fee']             有符号手续费（空值按 0）
//     bank.BillDate                  账单日期
//     bank.ReconciliationId          对账 ID（回填的目标）
//     bank._rowId                    行唯一键（上游注入，全局唯一）
//
// 金额比对口径（🔴 v3.0.26 Extra Fee）：
//   银行匹配金额     = |（Credit Amount || 0） − （Debit Amount || 0）| + signed Extra Fee
//   网关金额绝对值   = |amount|
//   amountEqual = 先加总，再 Math.round(金额*100) 精确到分比较，容差 0；合计后不再取绝对值。
//   Extra Fee 空值按 0；非空非法值使该银行行退出 R5，并产生一次可见 warning。
//   —— bankAmountAbs 保留旧口径，只供 DBS-Charge 等旧调用方继续复用，不得并入 Extra Fee。
//
// 日期两阶段（🔴 PRD R2.4「优先同日」是硬约束）：
//   Phase1：严格同日（sameDay）。先把所有 gw 跑完，消费掉同日命中的银行行。
//   Phase2：仅 Phase1 未命中的 gw，对未被消费的银行行用 ±dateToleranceDays（dayDiffWithin）再匹配。
//   日期解析复用 engine-date-utils 的 sameDay / dayDiffWithin（内部走 normalizeDateExportValue，勿自写解析）。
//
// 账户映射（🔴 v3.2.22）：options.accountMappingMap（链接表账户号 → 清结算系统银行账号，与调拨对账单派生
//   big_account 同一张表）只作用于匹配用的网关账号：engine-utils.resolveMappedAccount(map, gw.merchantid)，
//   命中替换、未命中原值；空表 / 缺省 = 改动前口径。匹配账号属本方向「映射目标账号」的网关行（映射命中行与争用同一
//   目标账号的原账号行）只与同 Channel 的银行行配对（防映射跨渠道错配）；本方向无映射命中时不加此校验。
//   网关行本身与回填的 reconciliationid 不变。
//   options.channelMissingDiagnosticGwRows：按渠道读池时被滤掉的空渠道网关行（readR5MappedChannelDiagnosticRows 取得），
//   只用于缺渠道告警，不参与匹配、不消费银行行。
//
// 严格 1v1：usedBankRowId 单向消费（每个 direction 独立一份），一条银行行最多被一条网关行回填。
// 多候选 tie-break：同日优先（Phase 分离已保证）→ 银行行原序最前（cand 保持 bankPool 顺序，取 cand[0]）+ warning。
//
// ⚠️ 资金红线：金额归分错误或日期 ±1day 配错会写错 ReconciliationId（资金对账ID错配，下游影响大）。

const {
  makeModificationCollector,
  makeWarningCollector,
  containsOoxmlEscape,
  createEscapeSameValueWarning,
  isAmbiguousMappedAccount,
  isEscapeAmbiguousSameValue,
  isMappedAccountHit,
  mappedAccountAmbiguity,
  normalizeCellValue,
  numericReadAccountAmbiguous,
  numericReadCollisionIndexOf,
  parseNumber,
  precisionFingerprintsOf,
  resolveMappedAccount,
  showOoxmlEscapes
} = require('./engine-utils');

const { sameDay, dayDiffWithin, toDate } = require('./engine-date-utils');
const { validateBankDirection } = require('./bank-direction-validator');
const {
  CANONICAL_FUND_TRANSFER_DIRECTIONS,
  normalizeFundTransferDatePolicy,
  validateFundTransferDirections
} = require('./fund-transfer-engine-policy');

const MS_PER_DAY = 86400000;

const BANK_EXTRA_FEE_FIELD = 'Extra Fee';
const INVALID_EXTRA_FEE_WARNING_CODE = 'r5-invalid-extra-fee';
const INVALID_DIRECTIONS_WARNING_CODE = 'r5-fund-transfer-directions-invalid';
const DIRECTION_MISMATCH_WARNING_CODE = 'fund-transfer-direction-mismatch';
const DATE_MISMATCH_WARNING_CODE = 'fund-transfer-date-mismatch';
// v3.2.22：账户映射目标账号上多条网关行争用同一银行行（严格 1:1 只回填其一），供人工复核未回填的网关对账ID。
const MAPPED_ACCOUNT_CONTENTION_WARNING_CODE = 'r5-mapped-account-contention';
// v3.2.22：映射目标账号上账号 / 币种 / 金额相符，但网关或银行 Channel 为空，无法证明同渠道 → 排除该候选并告警。
const MAPPED_ACCOUNT_CHANNEL_MISSING_WARNING_CODE = 'r5-mapped-account-channel-missing';
// v3.2.22：映射非空且网关账号含 `_xHHHH_` 转义写法、无法确定真实账户号（engine-utils.mappedAccountAmbiguity），不参与回填。
const MAPPED_ACCOUNT_ESCAPE_AMBIGUOUS_WARNING_CODE = 'r5-mapped-account-escape-ambiguous';
// v3.2.22：映射非空且网关账号是按数值读入的写法、与映射键对得上（engine-utils.mappedAccountAmbiguity：前导 0 已丢，或可能已丢失
//   精度），不参与回填。
const MAPPED_ACCOUNT_PRECISION_AMBIGUOUS_WARNING_CODE = 'r5-mapped-account-precision-ambiguous';
const MAPPED_ACCOUNT_CHANNEL_ESCAPE_AMBIGUOUS_WARNING_CODE = 'r5-mapped-account-channel-escape-ambiguous';
// v3.2.22：银行 MerchantId 按数值读入（或被前序场景按链接表原文改写成数值写法），可能已丢失前导零或精度，与映射目标账号对得上，
//   不参与账户映射后的回填。
const MAPPED_ACCOUNT_BANK_PRECISION_AMBIGUOUS_WARNING_CODE = 'r5-mapped-account-bank-precision-ambiguous';
// v3.2.22：银行 MerchantId 被前序场景按链接表原文改写、含 `_xHHHH_` 写法，文字是映射目标账号，不参与账户映射后的回填。
const MAPPED_ACCOUNT_BANK_ESCAPE_AMBIGUOUS_WARNING_CODE = 'r5-mapped-account-bank-escape-ambiguous';

// 银行发生额绝对值 = |（Credit Amount || 0） − （Debit Amount || 0）|
//   credit / debit 任一非数值按 0 计（与 C3 getBankRowValueForC3 一致）；两者皆非数值 → 仍返回 0（非 null）
//   —— 与 amountEqual 配合：网关侧若非数值会先被判非有限数而整体不命中。
function bankAmountAbs(bankRow) {
  const credit = parseNumber(bankRow && bankRow['Credit Amount']) || 0;
  const debit = parseNumber(bankRow && bankRow['Debit Amount']) || 0;
  return Math.abs(credit - debit);
}

function isEmptyAmountValue(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

// R5 银行匹配金额 = 旧发生额绝对值 + signed Extra Fee。
//   🔴 顺序固定：先加总，调用方再按现有分精度比较；合计后不得再次 Math.abs。
//   空 fee=0；非空非法 fee 返回 NaN，供 R5 两种来源和多对多审计统一 fail closed。
function bankAmountWithExtraFee(bankRow) {
  const rawExtraFee = bankRow && bankRow[BANK_EXTRA_FEE_FIELD];
  if (isEmptyAmountValue(rawExtraFee)) return bankAmountAbs(bankRow);
  const extraFee = parseNumber(rawExtraFee);
  if (extraFee === null) return NaN;
  return bankAmountAbs(bankRow) + extraFee;
}

function hasInvalidExtraFee(bankRow) {
  const rawExtraFee = bankRow && bankRow[BANK_EXTRA_FEE_FIELD];
  return !isEmptyAmountValue(rawExtraFee) && parseNumber(rawExtraFee) === null;
}

function createInvalidExtraFeeWarning(bankRow) {
  const rowId = bankRow && bankRow._rowId;
  const rawValue = bankRow && bankRow[BANK_EXTRA_FEE_FIELD];
  return {
    rowId,
    code: INVALID_EXTRA_FEE_WARNING_CODE,
    field: BANK_EXTRA_FEE_FIELD,
    rawValue,
    context: {
      rowId,
      field: BANK_EXTRA_FEE_FIELD,
      rawValue
    },
    message: `银行行 Extra Fee 原始值「${String(rawValue)}」不是合法金额，已退出 R5 调拨回填与多对多审计，请人工核对`
  };
}

// 非法 Extra Fee warning 去重：稳定 _rowId 优先；无有效 _rowId 时才按银行对象身份。
// 返回函数仅在首次看到该行时返回 true，供两条 R5 来源共享相同的“一行一次”口径。
function makeInvalidExtraFeeWarningDeduper() {
  const warnedRowIds = new Set();
  const warnedRowsWithoutId = new Set();
  return (bankRow) => {
    const rowId = normalizeCellValue(bankRow && bankRow._rowId);
    if (rowId !== '') {
      if (warnedRowIds.has(rowId)) return false;
      warnedRowIds.add(rowId);
      return true;
    }
    if (warnedRowsWithoutId.has(bankRow)) return false;
    warnedRowsWithoutId.add(bankRow);
    return true;
  };
}

// 网关金额绝对值 = |amount|；amount 非数值 → NaN（→ amountEqual 判非有限数 → 不命中）
function gwAmountAbs(gwRow) {
  const n = parseNumber(gwRow && gwRow.amount);
  return Math.abs(n ?? NaN);
}

// DBS-Charge 兼容口径：银行 |Credit-Debit| ↔ 网关 |amount|，精确到分；明确忽略 Extra Fee。
//   🔴 DBS step2 必须使用本函数，不能复用 R5 含手续费的 amountEqual。
function bankAmountEqualWithoutExtraFee(gwRow, bankRow) {
  const bankAbs = bankAmountAbs(bankRow);
  const gwAbs = gwAmountAbs(gwRow);
  if (!Number.isFinite(bankAbs) || !Number.isFinite(gwAbs)) return false;
  return Math.round(bankAbs * 100) === Math.round(gwAbs * 100);
}

// R5 银行匹配金额与网关金额精确到分比对（🔴 v3.0.26，容差 0）
//   两侧都必须是有限数；否则不命中（防 NaN 误判相等）。v3.2.22：精确到分后溢出为 ±Infinity 也不命中
//   （与候选桶、多对多审计同一 amountCents 判据，防 Infinity === Infinity 误判相等）。
function amountEqual(gwRow, bankRow) {
  const bankCents = amountCents(bankAmountWithExtraFee(bankRow));
  const gwCents = amountCents(gwAmountAbs(gwRow));
  return bankCents !== null && gwCents !== null && bankCents === gwCents;
}

// 下标 [0, length) 上第一个满足 pred 的下标（pred 须前段 false、后段 true）；都不满足返回 length。
function firstIndexWhere(length, pred) {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// 区间最小值稀疏表：返回 query(l, r)，给出 values[l..r] 中最小值的下标（并列取左）。建表 O(n log n)，查询 O(1)。
function buildRangeMinIndex(values) {
  const table = [values.map((_, i) => i)];
  for (let k = 1; (1 << k) <= values.length; k += 1) {
    const prev = table[k - 1];
    const half = 1 << (k - 1);
    const level = new Array(values.length - (1 << k) + 1);
    for (let i = 0; i < level.length; i += 1) {
      const a = prev[i];
      const b = prev[i + half];
      level[i] = values[b] < values[a] ? b : a;
    }
    table.push(level);
  }
  return (l, r) => {
    const k = 31 - Math.clz32(r - l + 1);
    const a = table[k][l];
    const b = table[k][r - (1 << k) + 1];
    return values[b] < values[a] ? b : a;
  };
}

// 年月日键：与 engine-date-utils.sameDay 同口径（toDate 结果的本地年、月、日都相同）。月 0–11、日 1–31，按年步长 10000 编码不重叠。
function localDayKey(date) {
  return date.getFullYear() * 10000 + date.getMonth() * 100 + date.getDate();
}

function dateMismatchReason(counterpartDateValue, bankDateValue) {
  if (!toDate(counterpartDateValue)) return 'counterpart-date-invalid';
  if (!toDate(bankDateValue)) return 'bank-date-invalid';
  return 'outside-tolerance';
}

// v3.2.22：金额精确到分（与 amountEqual 同为 Math.round(x*100)）。金额本身有限、乘 100 后溢出为 ±Infinity 时返回 null
//   （fail-closed：JSON 会把 ±Infinity 都编码成 null，不能让正负溢出值撞进同一候选桶）。
function amountCents(amount) {
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  return Number.isFinite(cents) ? cents : null;
}

// v3.2.22：账号 + 币种 + 金额分 组合键，与 baseFieldEq 判据等价（账号、币种为已归一化字符串，须非空；金额按
//   amountCents 精确到分，溢出不入键）。不满足时返回 null。用 JSON 数组编码：账号、币种可含任意字符（含 NUL），
//   拼接分隔符会让不同组合撞成同一键、把不同账号的行串进同一候选桶。
function accountCurrencyCentsKey(account, currency, amount) {
  return accountCurrencyKeyForCents(account, currency, amountCents(amount));
}
function accountCurrencyKeyForCents(account, currency, cents) {
  if (account === '' || currency === '' || cents === null) return null;
  return JSON.stringify([account, currency, cents]);
}

/**
 * v3.2.22：取 R5s2 账户映射缺渠道诊断行（只读，只供告警）。由引擎在 R5s2 网关来源实际运行时、以当时的银行行调用
 *   （生产经 createR5ChannelMissingDiagnosticSource 包装）。
 *   按渠道读网关池（readGatewayBillRowPoolsByChannels.exactRows）读不到的网关行不参与任何轮次匹配：本批银行行都有
 *   Channel 时是渠道为空的行；本批有空渠道银行行时，还有纯空白渠道行和银行侧未出现的非空渠道行。其中映射命中行或原账号
 *   即映射目标的调拨行，若与银行行账号、币种、金额相符且无法确认同渠道（网关渠道不可核实——为空或含 `_xHHHH_` 转义写法，
 *   或网关有渠道而银行行渠道为空），需告警人工复核。
 *   预筛（逐行、在读取器内完成，不保留未通过的行）：只看调拨方向（FundType 为 FundTransfer-in/out、MerchantId 属映射值）
 *   的银行行，按「方向 + 账号 + 币种 + 金额分」建键；网关行须调拨方向、对账ID 非空，原账号是映射键，或原账号即本方向
 *   实际命中的映射目标（targetAccountsByTradeType；未传时按全部映射值），映射后同键能对上——渠道不可核实时对上任一渠道的
 *   银行行，渠道可核实时只对上空渠道银行行。没有可对上的银行行时不读库；没有空渠道银行键时只读渠道不可核实的网关行
 *   （unverifiableChannelOnly）。
 *   精确判断（桶内原序最前者）仍在引擎内。由引擎在方向配置通过校验后经 options.channelMissingDiagnosticSource 调用。
 * @param {(options: { channels: Array<*>, tradeTypes: Array<string>, unverifiableChannelOnly: boolean,
 *   matchesKeyDigest: (keyDigest: number, gwChannelUnverifiable: boolean) => boolean,
 *   select: (row: Object) => (Object|null) }) => Array<Object>} readOutOfPoolRows
 *   只读迭代池外网关行的读取器（生产为读池时暂存的候选，见 createR5ChannelMissingDiagnosticSource）；select 逐行裁决
 *   并只保留告警所需字段，select 抛错须向上传，不得当作坏行吞掉。matchesKeyDigest 供读取器按暂存的键摘要
 *   （channelMissingDiagnosticKeyDigest）先挑出可能对上的候选，是 select 的必要条件（摘要碰撞只多挑，不会漏挑）
 * @param {{ accountMappingMap?: Map<string,string>, bankChannels?: Array<*>, bankRows?: Array<Object>,
 *   targetAccountsByTradeType?: Map<string, Set<string>>,
 *   isRawRewrittenBankValue?: (bankRow: Object, column: string) => boolean }} [context]
 *   bankChannels：读网关池时用的银行渠道（决定池的补集）；bankRows：R5 运行时的银行行（决定预筛键）；
 *   targetAccountsByTradeType：引擎按方向收集的映射目标账号（网关 TradeType → 集合）；
 *   isRawRewrittenBankValue：银行行该列的当前值是否为前序场景按链接表原文改写（编排器提供，见 r5MappedBankAccountAmbiguity）
 * @returns {Array<Object>}
 */
function readR5MappedChannelDiagnosticRows(readOutOfPoolRows, {
  accountMappingMap, bankChannels, bankRows, targetAccountsByTradeType, isRawRewrittenBankValue
} = {}) {
  if (typeof readOutOfPoolRows !== 'function') return [];
  if (!(accountMappingMap instanceof Map) || accountMappingMap.size === 0) return [];
  const channels = Array.isArray(bankChannels) ? bankChannels : [];
  if (channels.length === 0) return [];
  const targetAccounts = new Set(Array.from(accountMappingMap.values(), (value) => normalizeCellValue(value)));
  const gwTradeTypeByBankFundType = new Map(
    CANONICAL_FUND_TRANSFER_DIRECTIONS.map((dir) => [dir.bankFundType, dir.gwTradeType])
  );
  const tradeTypes = new Set(gwTradeTypeByBankFundType.values());
  // 原账号不是映射键时，只有它即本方向实际命中的映射目标才可能告警（引擎 warnOutOfPoolMissingChannel 同一判据）。
  const isDirectionTarget = targetAccountsByTradeType instanceof Map
    ? (gwTradeType, rawAccount) => {
      const targets = targetAccountsByTradeType.get(gwTradeType);
      return targets instanceof Set && targets.has(rawAccount);
    }
    : (_gwTradeType, rawAccount) => targetAccounts.has(rawAccount);
  const bankKeys = new Set();
  const bankBlankChannelKeys = new Set();
  const targetFingerprints = precisionFingerprintsOf(targetAccounts);
  let collisionIndex = null;
  for (const bankRow of Array.isArray(bankRows) ? bankRows : []) {
    const gwTradeType = gwTradeTypeByBankFundType.get(normalizeCellValue(bankRow && bankRow.FundType));
    if (!gwTradeType) continue;
    const account = normalizeCellValue(bankRow && bankRow.MerchantId);
    // 无法确认真实账号的银行行（r5MappedBankAccountAmbiguity）不进映射回填候选，但引擎要为它告警（建候选桶时）：按它可能
    //   代表的每个映射目标（含文字相同的目标）建键，使对得上的池外网关行被读回、触发引擎建桶（不按它判缺渠道，见 buildBaseIndex）。
    const ambiguity = r5MappedBankAccountAmbiguity(bankRow, targetAccounts, targetFingerprints, isRawRewrittenBankValue);
    let accounts;
    if (ambiguity === 'precision') {
      if (collisionIndex === null) collisionIndex = numericReadCollisionIndexOf(targetAccounts);
      const candidates = new Set(collisionIndex(r5MappedBankAccountNumericValue(bankRow, isRawRewrittenBankValue)));
      if (targetAccounts.has(account)) candidates.add(account);
      accounts = candidates;
    } else {
      if (!targetAccounts.has(account)) continue;
      accounts = [account];
    }
    for (const candidate of accounts) {
      const key = channelMissingDiagnosticDirectionKey(
        gwTradeType, candidate, normalizeCellValue(bankRow && bankRow.Currency), bankAmountWithExtraFee(bankRow)
      );
      if (key === null) continue;
      bankKeys.add(key);
      if (normalizeCellValue(bankRow && bankRow.Channel) === '') bankBlankChannelKeys.add(key);
    }
  }
  if (bankKeys.size === 0) return [];
  const keepDiagnosticRow = (gw) => {
    const gwTradeType = normalizeCellValue(gw && gw.TradeType);
    if (!tradeTypes.has(gwTradeType)) return false;
    if (normalizeCellValue(gw && gw.reconciliationid) === '') return false;
    const rawAccount = normalizeCellValue(gw && gw.merchantid);
    if (!isMappedAccountHit(accountMappingMap, rawAccount) && !isDirectionTarget(gwTradeType, rawAccount)) return false;
    const key = gwChannelMissingDiagnosticKey(accountMappingMap, gw);
    if (key === null) return false;
    return isUnverifiableChannel(normalizeCellValue(gw && gw.Channel)) ? bankKeys.has(key) : bankBlankChannelKeys.has(key);
  };
  const bankKeyDigests = new Set(Array.from(bankKeys, channelMissingDiagnosticKeyDigest));
  const bankBlankChannelKeyDigests = new Set(Array.from(bankBlankChannelKeys, channelMissingDiagnosticKeyDigest));
  const rows = readOutOfPoolRows({
    channels,
    tradeTypes: Array.from(tradeTypes),
    // 没有空渠道银行键时，渠道可核实的池外网关行不可能告警，读取器只取渠道不可核实的行。
    unverifiableChannelOnly: bankBlankChannelKeys.size === 0,
    // 与 keepDiagnosticRow 末步同一判据的摘要版：渠道不可核实的网关行对上任一银行键，其余只对上空渠道银行键。
    matchesKeyDigest: (keyDigest, gwChannelUnverifiable) =>
      (gwChannelUnverifiable ? bankKeyDigests : bankBlankChannelKeyDigests).has(keyDigest),
    select: (gw) => (keepDiagnosticRow(gw) ? projectDiagnosticRow(gw) : null)
  });
  return Array.isArray(rows) ? rows : [];
}

// v3.2.22（🔴 资金红线）：网关渠道不可核实——为空，或含 `_xHHHH_` 转义写法（单工作表 `.xlsx` 流式导入的网关表保留转义
//   原文，银行账单经 SheetJS 读取已解码：落库的 `BANK_x000D_US` 可能是 `BANK\rUS`，也可能就是字面值），字符串比较
//   既不能证明同渠道、也不能证明不同渠道。
function isUnverifiableChannel(channel) {
  return channel === '' || containsOoxmlEscape(channel);
}

// v3.2.22：本方向网关池的「映射目标账号」集合：命中映射（isMappedAccountHit，含同值映射）的行的换后账号。R5s2 与检测器
//   映射补跑共用同一口径；映射为空时为空集合。
function collectR5MappedTargetAccounts(accountMappingMap, gwPool) {
  const targets = new Set();
  if (!(accountMappingMap instanceof Map) || accountMappingMap.size === 0) return targets;
  for (const gw of gwPool) {
    const rawAccount = normalizeCellValue(gw && gw.merchantid);
    if (!isMappedAccountHit(accountMappingMap, rawAccount)) continue;
    const account = resolveMappedAccount(accountMappingMap, rawAccount);
    if (account !== '') targets.add(account);
  }
  return targets;
}

// v3.2.22（🔴 资金红线）：网关行的匹配账号属本方向映射目标账号时需同渠道校验（映射命中行及争用同一目标的原账号行）。
function requiresR5SameChannel(accountMappingMap, mappedTargetAccounts, gw) {
  return mappedTargetAccounts instanceof Set && mappedTargetAccounts.size > 0 &&
    mappedTargetAccounts.has(resolveMappedAccount(accountMappingMap, normalizeCellValue(gw && gw.merchantid)));
}

// v3.2.22（🔴 资金红线）：本方向映射目标账号的数值写法指纹与碰撞索引（按集合缓存，大小变化时重算；各方向集合收集后
//   不再改动；碰撞索引只在命中映射键的行可能歧义时才建）。
const TARGET_NUMERIC_READ_CACHE = new WeakMap();
function targetNumericReadCacheOf(mappedTargetAccounts) {
  const cached = TARGET_NUMERIC_READ_CACHE.get(mappedTargetAccounts);
  if (cached && cached.size === mappedTargetAccounts.size) return cached;
  const entry = { size: mappedTargetAccounts.size, fingerprints: precisionFingerprintsOf(mappedTargetAccounts), collisionIndex: null };
  TARGET_NUMERIC_READ_CACHE.set(mappedTargetAccounts, entry);
  return entry;
}
// v3.2.22（🔴 资金红线）：网关行的原账号是按数值读入的写法、与本方向映射目标账号对得上（numericReadAccountAmbiguous：前导 0
//   已丢、Excel 截断或 JS 舍入后相同），无法确定按哪个账号匹配 → true：
//   未命中映射（不是映射键）：它可能就是某个映射目标，也可能不是，既不能按原值争用目标账号的银行行，也不能按原值匹配其他银行行；
//   命中映射键：对得上的目标里有不同于它映射结果的账号（如映射 `123 → CLR-A` 与 `G → 00123` 并存，按数值存放的 `00123` 读入为
//     `123`），可能是映射键，也可能就是那个目标账号，两种解读导向不同的银行账号；对得上的目标都是它自己的映射结果时不歧义。
//   R5s2 不参与匹配、逐条告警（不占用银行行）；检测器映射补跑同口径剔除。本方向没有映射目标、或原账号已因与映射键对得上而
//   歧义（isAmbiguousMappedAccount，另有告警）时为 false。
function isR5RawAccountTargetAmbiguous(accountMappingMap, mappedTargetAccounts, gw) {
  if (!(mappedTargetAccounts instanceof Set) || mappedTargetAccounts.size === 0) return false;
  if (!(accountMappingMap instanceof Map)) return false;
  const rawAccount = normalizeCellValue(gw && gw.merchantid);
  if (rawAccount === '' || isAmbiguousMappedAccount(accountMappingMap, rawAccount)) return false;
  const cache = targetNumericReadCacheOf(mappedTargetAccounts);
  if (!numericReadAccountAmbiguous(rawAccount, cache.fingerprints)) return false;
  if (!accountMappingMap.has(rawAccount)) return true;
  if (cache.collisionIndex === null) cache.collisionIndex = numericReadCollisionIndexOf(mappedTargetAccounts);
  const resolved = resolveMappedAccount(accountMappingMap, rawAccount);
  return cache.collisionIndex(rawAccount).some((target) => target !== resolved);
}

// v3.2.22（🔴 资金红线）：需同渠道校验而渠道不可核实（为空，或含 `_xHHHH_` 写法）的网关行，R5s2 一定不回填（为空 → 缺渠道
//   告警；含转义写法 → 不参与匹配、逐条告警）。检测器映射补跑按同一判据剔除，不把这类行算进「自动回填仅取其一」的分组。
function isR5MappedRowChannelUnverifiable(accountMappingMap, mappedTargetAccounts, gw) {
  return isUnverifiableChannel(normalizeCellValue(gw && gw.Channel)) &&
    requiresR5SameChannel(accountMappingMap, mappedTargetAccounts, gw);
}

// v3.2.22（🔴 资金红线）：要按映射目标账号比对的银行行，银行账号无法确认真实值时的原因（不进映射回填候选、逐行告警；
//   池外诊断不以它为准；检测器映射补跑以 isR5MappedBankRowUnverifiable 剔除）：
//   'precision' = MerchantId 是按数值读入的写法（r5MappedBankAccountNumericValue），与映射目标账号对得上
//     （engine-utils.numericReadAccountAmbiguous：某目标带前导 0 等非标准写法、数值相同；或可能已丢失精度——Excel 只存 15 位
//     有效数字、超出 9007199254740991 被 JS 舍入——且与某目标按数值相同或位数与前 15 位相同）；
//   'escape' = MerchantId 被前序场景按链接表单元格原文改写（isRawRewrittenBankValue，如 C3 按网关字段赋值；流式导入保留
//     `_xHHHH_` 转义原文），含这种写法且文字是映射目标账号（映射目标是用户录入的字面值，原文 `A_x0041_B` 可能代表 `AAB`）；
//   其余 null（银行账单的文本原值、用户配置写入的值均可信，文字相同即同一账号）。
//   targetFingerprints 为全部映射值的指纹（precisionFingerprintsOf），R5s2 建桶、池外诊断与检测器映射补跑同一口径。
function r5MappedBankAccountAmbiguity(bankRow, targetAccounts, targetFingerprints, isRawRewrittenBankValue) {
  if (numericReadAccountAmbiguous(r5MappedBankAccountNumericValue(bankRow, isRawRewrittenBankValue), targetFingerprints)) {
    return 'precision';
  }
  const account = normalizeCellValue(bankRow && bankRow.MerchantId);
  if (containsOoxmlEscape(account) && targetAccounts instanceof Set && targetAccounts.has(account) &&
    isR5RawRewrittenMerchantId(bankRow, isRawRewrittenBankValue)) return 'escape';
  return null;
}
function isR5RawRewrittenMerchantId(bankRow, isRawRewrittenBankValue) {
  return typeof isRawRewrittenBankValue === 'function' && isRawRewrittenBankValue(bankRow, 'MerchantId') === true;
}
// 银行 MerchantId 可能是按数值读入的写法时返回要比对的值，否则 null：单元格是数值（readBankStatement 原样保留数值单元格），
//   或被前序场景按链接表原文改写（链接表按数值存放的单元格落库为数值的 JS 标准写法，如 C3 复制网关账号 `123`，原文可能是
//   `00123`）。银行账单的文本单元格与用户配置写入的值原文可信，不算。
function r5MappedBankAccountNumericValue(bankRow, isRawRewrittenBankValue) {
  const value = bankRow && bankRow.MerchantId;
  if (typeof value === 'number') return value;
  return isR5RawRewrittenMerchantId(bankRow, isRawRewrittenBankValue) ? normalizeCellValue(value) : null;
}
// 检测器映射补跑用：R5s2 一定不按映射回填的银行行，与 r5MappedBankAccountAmbiguity 同一判据（mappingTargetFingerprints 为全部
//   映射值的指纹）。分组按银行账号原值，与映射目标账号不同的银行行所在分组里不会有映射命中的网关行（不会被报告），故转义只需
//   看本行：渠道为空（映射行要求同渠道）、按数值读入且与映射值对得上的账号、被前序场景按链接表原文改写且含 `_xHHHH_` 写法的账号。
function isR5MappedBankRowUnverifiable(bankRow, isRawRewrittenBankValue, mappingTargetFingerprints) {
  if (normalizeCellValue(bankRow && bankRow.Channel) === '') return true;
  if (numericReadAccountAmbiguous(r5MappedBankAccountNumericValue(bankRow, isRawRewrittenBankValue), mappingTargetFingerprints)) {
    return true;
  }
  return containsOoxmlEscape(normalizeCellValue(bankRow && bankRow.MerchantId)) &&
    isR5RawRewrittenMerchantId(bankRow, isRawRewrittenBankValue);
}
// 全部映射值（清结算账号，归一化）的数值写法指纹：R5s2 建桶、池外诊断与检测器映射补跑共用。
function mappingTargetFingerprintsOf(accountMappingMap) {
  if (!(accountMappingMap instanceof Map)) return precisionFingerprintsOf([]);
  return precisionFingerprintsOf(Array.from(accountMappingMap.values(), (value) => normalizeCellValue(value)));
}

// v3.2.22：缺渠道诊断的「方向 + 账号 + 币种 + 金额分」键（银行侧与网关侧同一编码）。不满足 accountCurrencyCentsKey 时为 null。
function channelMissingDiagnosticDirectionKey(gwTradeType, account, currency, amount) {
  const key = accountCurrencyCentsKey(account, currency, amount);
  return key === null ? null : JSON.stringify([gwTradeType, key]);
}

// v3.2.22：网关行的缺渠道诊断键（账号按本轮映射换出，含转义歧义护栏）。读池暂存与 R5 运行时精确裁决共用。
function gwChannelMissingDiagnosticKey(accountMappingMap, gw) {
  return channelMissingDiagnosticDirectionKey(
    normalizeCellValue(gw && gw.TradeType),
    resolveMappedAccount(accountMappingMap, normalizeCellValue(gw && gw.merchantid)),
    normalizeCellValue(gw && gw.currency),
    gwAmountAbs(gw)
  );
}

// v3.2.22：诊断键的 32 位摘要（FNV-1a，逐 UTF-16 单元）。只用于从暂存候选里先挑出可能对上的行：同键必同摘要，
//   碰撞只会多挑几行回读，回读后仍按完整键精确裁决。
function channelMissingDiagnosticKeyDigest(key) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// v3.2.22：转义告警只写账号尾号（较长时）、长度与转义片段（显示为 ⟨U+HHHH⟩），不写完整账号（错误报告单独落盘；网关
//   记录已由 ReconBillBizId 与对账ID 定位）。尾号也按同一显示规则，避免截到的片段在报告里被解码。
function describeEscapeAmbiguousAccount(rawAccount) {
  const chars = Array.from(rawAccount);
  const fragments = Array.from(new Set((rawAccount.match(/_x[0-9A-Fa-f]{4}_/gi) || []).map(showOoxmlEscapes))).slice(0, 3);
  const tail = chars.length > 8 ? `尾号「${chars.slice(-4).join('')}」，` : '';
  return `账户号（${tail}共 ${chars.length} 个字符）含 Excel 转义写法（_xHHHH_ 形式）：${fragments.join('、')}`;
}

// v3.2.22：数值写法歧义告警同样只写尾号与位数（账号本身可能就是映射键，不写全文）。
function describeAccountLength(account) {
  const chars = Array.from(account);
  const tail = chars.length > 8 ? `尾号「${chars.slice(-4).join('')}」，` : '';
  return `${tail}共 ${chars.length} 个字符`;
}
const NUMERIC_READ_ACCOUNT_REASON = '是按数值读入的数字，可能已丢失前导零或精度（Excel 数值不保留前导零、只保留 15 位有效数字，超过 9007199254740991 时还会被舍入）';
function describePrecisionAmbiguousAccount(rawAccount) {
  return `账户号（${describeAccountLength(rawAccount)}）${NUMERIC_READ_ACCOUNT_REASON}，且与账户映射里的链接表账户号对得上`;
}

// v3.2.22：渠道含转义写法时的告警片段：渠道按 ⟨U+HHHH⟩ 显示并说明写法。
function describeEscapeAmbiguousChannel(channel) {
  return `渠道「${showOoxmlEscapes(channel)}」（⟨U+HHHH⟩ 处落库为 Excel 转义写法 _xHHHH_）`;
}

// 池外诊断行只保留引擎生成缺渠道告警所需字段（原值不归一化，引擎同口径再归一化），不保留完整网关记录。
const DIAGNOSTIC_GW_FIELDS = Object.freeze(['TradeType', 'reconciliationid', 'Channel', 'merchantid', 'currency', 'amount', 'ReconBillBizId']);
function projectDiagnosticRow(gw) {
  const row = {};
  for (const field of DIAGNOSTIC_GW_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(gw, field)) row[field] = gw[field];
  }
  return row;
}

/**
 * v3.2.22：R5s2 账户映射缺渠道诊断的读池附加条件与候选暂存。按渠道读网关池时以
 *   readGatewayBillRowPoolsByChannels(channels, { outOfPoolDiagnostic }) 传入，同一次扫描暂存池外候选，R5 运行时
 *   不再二次全扫网关表。银行行要到 R5 运行时才定（前序轮次可能改写 FundType 等字段），这里只用本轮映射粗筛：调拨方向
 *   TradeType、对账ID 非空、原账号是映射键或映射值（readR5MappedChannelDiagnosticRows 的账号判据只会更窄）、诊断键
 *   非空。通过的行不保留网关记录，只在类型化数组里暂存 id、诊断键摘要与「渠道不可核实」位（每条 13 字节），R5 运行时按
 *   银行键摘要挑出可能对上的 id 再回读精确裁决（createR5ChannelMissingDiagnosticSource）。
 *   映射为空时返回 null：不收集、不诊断。
 * @param {Map<string,string>} accountMappingMap
 * @returns {{ tradeTypes: Array<string>, accounts: Array<string>, collect: (row: Object, rowId: number) => void,
 *   stagedCandidates: () => { count: number, ids: Float64Array, keyDigests: Uint32Array, unverifiableChannel: Uint8Array } }|null}
 *   collect 由仓储对 SQL 预筛通过的每一行调用（rowId 须为安全整数，否则抛 TypeError，不当坏行吞掉）
 */
function buildR5ChannelMissingDiagnosticPrefilter(accountMappingMap) {
  if (!(accountMappingMap instanceof Map) || accountMappingMap.size === 0) return null;
  const accounts = new Set();
  for (const [key, value] of accountMappingMap) {
    // 键值均含原文与归一化两种写法（getMappingMap 已归一化，二者通常相同），保证是精确判据的超集。
    for (const account of [String(key), normalizeCellValue(key), String(value ?? ''), normalizeCellValue(value)]) {
      if (account !== '') accounts.add(account);
    }
  }
  if (accounts.size === 0) return null;
  const tradeTypes = Array.from(new Set(CANONICAL_FUND_TRANSFER_DIRECTIONS.map((dir) => dir.gwTradeType)));
  const tradeTypeSet = new Set(tradeTypes);
  let count = 0;
  let ids = new Float64Array(1024);
  let keyDigests = new Uint32Array(1024);
  let unverifiableChannel = new Uint8Array(1024);
  const grow = () => {
    const capacity = ids.length * 2;
    const nextIds = new Float64Array(capacity);
    nextIds.set(ids);
    const nextDigests = new Uint32Array(capacity);
    nextDigests.set(keyDigests);
    const nextUnverifiable = new Uint8Array(capacity);
    nextUnverifiable.set(unverifiableChannel);
    ids = nextIds;
    keyDigests = nextDigests;
    unverifiableChannel = nextUnverifiable;
  };
  return Object.freeze({
    tradeTypes,
    accounts: Array.from(accounts),
    collect: (gw, rowId) => {
      if (!Number.isSafeInteger(rowId)) {
        throw new TypeError(`R5 缺渠道诊断候选的网关行 id 无效：${String(rowId)}`);
      }
      if (!tradeTypeSet.has(normalizeCellValue(gw && gw.TradeType))) return;
      if (normalizeCellValue(gw && gw.reconciliationid) === '') return;
      if (!accounts.has(normalizeCellValue(gw && gw.merchantid))) return;
      const key = gwChannelMissingDiagnosticKey(accountMappingMap, gw);
      if (key === null) return;
      if (count === ids.length) grow();
      ids[count] = rowId;
      keyDigests[count] = channelMissingDiagnosticKeyDigest(key);
      unverifiableChannel[count] = isUnverifiableChannel(normalizeCellValue(gw && gw.Channel)) ? 1 : 0;
      count += 1;
    },
    stagedCandidates: () => Object.freeze({
      count,
      ids: ids.subarray(0, count),
      keyDigests: keyDigests.subarray(0, count),
      unverifiableChannel: unverifiableChannel.subarray(0, count)
    })
  });
}

/**
 * v3.2.22：用读池时暂存的池外候选（buildR5ChannelMissingDiagnosticPrefilter 的 stagedCandidates）构造 R5s2 缺渠道
 *   诊断读取器，交给编排器 fundTransferChannelMissingDiagnosticSource。R5 运行时按当时的银行行算出键摘要，只挑出摘要
 *   对得上的候选 id，经 readRowsByIds 按 id 升序回读（同一运行快照：主路径持 op-lock，worker 在只读快照事务内），
 *   再精确裁决（readR5MappedChannelDiagnosticRows）并投影；select / 回读抛错向上传。
 * @param {{ accountMappingMap: Map<string,string>, bankChannels: Array<*>,
 *   prefilter: ReturnType<typeof buildR5ChannelMissingDiagnosticPrefilter>,
 *   readRowsByIds: (ids: Array<number>, onRow: (row: Object, rowId: number) => void) => void }} params
 * @returns {(context: { bankRows: Array<Object>, targetAccountsByTradeType?: Map<string, Set<string>> }) => Array<Object>}
 */
function createR5ChannelMissingDiagnosticSource({ accountMappingMap, bankChannels, prefilter, readRowsByIds } = {}) {
  const readStagedRows = ({ matchesKeyDigest, select }) => {
    if (!prefilter || typeof prefilter.stagedCandidates !== 'function') return [];
    const staged = prefilter.stagedCandidates();
    const pickedIds = [];
    for (let i = 0; i < staged.count; i += 1) {
      if (matchesKeyDigest(staged.keyDigests[i], staged.unverifiableChannel[i] === 1)) pickedIds.push(staged.ids[i]);
    }
    if (pickedIds.length === 0) return [];
    if (typeof readRowsByIds !== 'function') {
      throw new TypeError('R5 缺渠道诊断：缺少按 id 回读网关行的读取器');
    }
    const out = [];
    readRowsByIds(pickedIds, (gw) => {
      const selected = select(gw);
      if (selected !== null && selected !== undefined) out.push(selected);
    });
    return out;
  };
  return ({ bankRows, targetAccountsByTradeType, isRawRewrittenBankValue } = {}) => {
    // 没有暂存候选时不可能读回任何行：不遍历银行行、不建键（主进程同步执行）。
    if (!prefilter || typeof prefilter.stagedCandidates !== 'function' || prefilter.stagedCandidates().count === 0) return [];
    return readR5MappedChannelDiagnosticRows(readStagedRows, {
      accountMappingMap,
      bankChannels,
      bankRows,
      targetAccountsByTradeType,
      isRawRewrittenBankValue
    });
  };
}

/**
 * R5 场景2：FundTransfer 回填 ReconciliationId。
 *
 * @param {Array<Object>} gwRows   网关对账单行（链接表读回，真实小写表头）
 * @param {Array<Object>} bankRows R4 后的银行对账单行（带 _rowId，FundType/ReconciliationId 可能已被前序轮次改写）
 * @param {Object} [options]
 * @param {Array<{gwTradeType:string,bankFundType:string}>} [options.directions] 双方向定义（默认 out/in）
 * @param {number} [options.dateToleranceDays] Phase2 日期容差天数（默认 1）
 * @param {Map<string,string>} [options.accountMappingMap] v3.2.22 账户映射（链接表账户号 → 清结算系统银行账号），
 *   只用于网关 merchantid 的匹配取值；缺省 / 非 Map = 不映射
 * @param {Array<Object>} [options.channelMissingDiagnosticGwRows] v3.2.22 按渠道读池读不到的网关行，只用于缺渠道告警
 * @param {(context: { bankRows: Array<Object>, targetAccountsByTradeType: Map<string, Set<string>>,
 *   isRawRewrittenBankValue?: Function }) => Array<Object>}
 *   [options.channelMissingDiagnosticSource] v3.2.22 同上的惰性读取器（优先于数组）：仅在方向配置通过校验、有银行行且映射
 *   非空时调用一次，传入当时的银行行、按方向收集的映射目标账号与 options.isRawRewrittenBankValue
 * @param {(bankRow: Object, column: string) => boolean} [options.isRawRewrittenBankValue] v3.2.22 银行行该列的当前值是否为
 *   前序场景按链接表单元格原文改写（编排器按改写记录提供；缺省视为都不是，见 r5MappedBankAccountAmbiguity）
 * @returns {{ modifications: Array, warnings: Array, usedBankRowIds: Set, directionsValid: boolean }}
 *   modifications：实际改写 ReconciliationId 的行（{ rowId, column:'ReconciliationId', oldValue, newValue }），用于标黄
 *   warnings：multi-bank-match-backfill / r5-invalid-extra-fee / r5-mapped-account-contention / r5-mapped-account-channel-missing /
 *     r5-mapped-account-escape-ambiguous / r5-mapped-account-precision-ambiguous / r5-mapped-account-channel-escape-ambiguous（v3.2.22）
 *   usedBankRowIds：引擎内 1v1 消费的全部 bank _rowId 集合（🔴 v3.0.4 块 F 新增 additive 字段）——
 *     **含「消费但未写」行**（nv 空 / 与原值相同 → 不 record 不标黄，但仍 usedBankRowId.add 占用）。
 *     用于编排器把已被 R5s2 消费的银行行经 excludeBankRowIds 传 R5s2b 剔除（网关回填优先互斥）。
 *     与 modifications 的区别：modifications 仅「实写过」行（同值未写行取不到），usedBankRowIds 是完整消费集。
 *   directionsValid：v3.2.22 additive 字段，directions 通过校验、引擎实际建池匹配时为 true；非法配置整轮跳过时为 false
 *     （编排器据此决定多对多检测器是否按账户映射补跑网关侧）。
 */
function runRound5FundTransferBackfill(gwRows, bankRows, options = {}) {
  const warningCollector = makeWarningCollector('r5-fund-transfer-backfill', '中台调拨订单对账ID回填');
  const modCollector = makeModificationCollector();
  // 🔴 v3.0.4 块 F：跨 direction 聚合的消费集合（含同值未写行），作为新返回字段供 R5s2b 剔除。
  const consumedBankRowIds = new Set();
  // v3.0.26：稳定 _rowId 优先去重；无 _rowId 才按对象身份，保证非法 fee 银行行只告警一次。
  const shouldEmitInvalidExtraFeeWarning = makeInvalidExtraFeeWarningDeduper();

  const safeGwRows = Array.isArray(gwRows) ? gwRows : [];
  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];

  const directionsValidation = validateFundTransferDirections(options.directions, {
    allowDefault: !Object.prototype.hasOwnProperty.call(options, 'directions')
  });
  if (!directionsValidation.ok) {
    warningCollector.push({
      rowId: null,
      engine: 'r5-fund-transfer-backfill',
      code: INVALID_DIRECTIONS_WARNING_CODE,
      reason: directionsValidation.reason,
      message: `R5 调拨回填 directions 配置非法，整轮已失败关闭：${directionsValidation.reason}`
    });
    return {
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list(),
      usedBankRowIds: consumedBankRowIds,
      directionsValid: false
    };
  }
  const directions = directionsValidation.directions;
  const datePolicy = normalizeFundTransferDatePolicy(options);
  const dateToleranceDays = datePolicy.toleranceDays;

  // 无银行行 → 直接返回；无网关行时仍遍历方向银行池，以保证非法 Extra Fee warning 不被早退吞掉。
  if (safeBankRows.length === 0) {
    return {
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list(),
      usedBankRowIds: consumedBankRowIds,
      directionsValid: true
    };
  }

  // v3.2.22（🔴 资金红线）：网关账号按账户映射取值。由 directionEligibleCandidates 在扫描银行池前按网关行算一次
  //   传入 fieldEq（不建按行数增长的缓存）。「对账永远同 Channel」（v3.0.7 spec 修复 2 业务不变量）原本靠原账号相等
  //   保证；映射后的账号可能属于本批另一渠道的银行行，故本方向内凡是匹配账号落在「映射目标账号」集合里的网关行
  //   （映射命中行本身，以及原账号恰为该目标、与之争用同一批银行行的行）都追加同渠道校验。
  //   「命中映射」按原账号是否为映射表的键判断（含 CLR → CLR 这类同值映射），不按换后字符串是否变化；含 `_xHHHH_`
  //   写法的账号已换成空串、不参与匹配（engine-utils.isMappedAccountHit）。
  //   本方向没有任何网关行命中映射时集合为空，所有行不加渠道校验，与改动前逐字节一致。
  const accountMappingMap = options.accountMappingMap;
  let diagnosticGwRows = Array.isArray(options.channelMissingDiagnosticGwRows)
    ? options.channelMissingDiagnosticGwRows
    : [];
  const hasAccountMapping = accountMappingMap instanceof Map && accountMappingMap.size > 0;
  const resolveGwAccount = (gw) => {
    const rawAccount = normalizeCellValue(gw && gw.merchantid);
    const account = resolveMappedAccount(accountMappingMap, rawAccount);
    return { account, mapped: hasAccountMapping && isMappedAccountHit(accountMappingMap, rawAccount) };
  };
  const collectMappedTargetAccounts = (gwPool) => collectR5MappedTargetAccounts(accountMappingMap, gwPool);
  // v3.2.22（🔴 资金红线）：需同渠道校验的网关行，渠道含 `_xHHHH_` 写法时无法确认真实渠道（单工作表 `.xlsx` 流式导入的
  //   网关表保留转义原文，银行账单经 SheetJS 读取已解码：网关落库的 `BANK_x000D_US` 可能是 `BANK\rUS`，也可能就是字面值），
  //   字符串相等不能证明同渠道。这类行不参与匹配（不进候选组、不登记争用），逐条告警人工核对。
  //   原值按数值读入、与本方向映射目标对不清的行（isR5RawAccountTargetAmbiguous，含命中映射键的行）匹配账号置空：无候选、
  //   不占用银行行，已逐条告警。
  const gwAccountForMatching = (gw, mappedTargetAccounts) => {
    const account = isR5RawAccountTargetAmbiguous(accountMappingMap, mappedTargetAccounts, gw) ? '' : resolveGwAccount(gw).account;
    const requireChannel = mappedTargetAccounts.has(account);
    const channel = normalizeCellValue(gw && gw.Channel);
    return {
      account,
      requireChannel,
      channel,
      channelEscapeAmbiguous: requireChannel && containsOoxmlEscape(channel)
    };
  };

  // 对账字段全等：非空 merchantid（映射后）↔MerchantId、非空 currency↔Currency
  //   + (|Credit-Debit| + signed Extra Fee) 先加总后精确到分。
  const baseFieldEq = (gw, gwAccount, bank) => {
    const bankMerchantId = normalizeCellValue(bank && bank.MerchantId);
    const gwCurrency = normalizeCellValue(gw && gw.currency);
    const bankCurrency = normalizeCellValue(bank && bank.Currency);
    return (
      gwAccount.account !== '' &&
      bankMerchantId !== '' &&
      gwAccount.account === bankMerchantId &&
      gwCurrency !== '' &&
      bankCurrency !== '' &&
      gwCurrency === bankCurrency &&
      amountEqual(gw, bank)
    );
  };
  const warnedCandidateFailures = new Set();
  const warnDirectionFailure = (bankRow, expectedDirection, result) => {
    const key = `direction\u0000${String(bankRow && bankRow._rowId)}\u0000${expectedDirection}\u0000${result.code}`;
    if (warnedCandidateFailures.has(key)) return;
    warnedCandidateFailures.add(key);
    warningCollector.push({
      rowId: bankRow && bankRow._rowId,
      engine: 'r5-fund-transfer-backfill',
      code: DIRECTION_MISMATCH_WARNING_CODE,
      expectedDirection,
      reason: result.code,
      message: `R5 网关调拨近似候选银行行(${bankRow && bankRow._rowId})未通过 ${expectedDirection} 方向校验（${result.code}），未进入可写候选`
    });
  };
  const warnDateFailure = (gw, bankRow, expectedDirection) => {
    const reason = dateMismatchReason(gw && gw.Billdate, bankRow && bankRow.BillDate);
    // 同账号/币种/金额密集组可能形成 N 来源 × M 银行的日期失败边；warning 不含来源身份，
    // 按 sourceIndex 保留只会制造 N×M 条不可区分的重复告警。每个具体银行行 / 方向 /
    // 原因只报一次；bankOriginalIndex 在 _rowId 缺失或重复时仍保持银行行级区分。
    const key = [
      'date',
      bankOriginalIndex.get(bankRow) ?? '',
      String(bankRow && bankRow._rowId),
      expectedDirection,
      reason
    ].join('\u0000');
    if (warnedCandidateFailures.has(key)) return;
    warnedCandidateFailures.add(key);
    warningCollector.push({
      rowId: bankRow && bankRow._rowId,
      engine: 'r5-fund-transfer-backfill',
      code: DATE_MISMATCH_WARNING_CODE,
      expectedDirection,
      reason,
      message: `R5 网关调拨近似候选银行行(${bankRow && bankRow._rowId})未通过日期策略（${reason}），未进入可写候选`
    });
  };
  const bankOriginalIndex = new Map();
  safeBankRows.forEach((row, index) => {
    if (!bankOriginalIndex.has(row)) bankOriginalIndex.set(row, index);
  });

  // 命中回填：把网关 reconciliationid 写入银行 ReconciliationId（命中即覆盖，含非空原值；reconid-overwrite-backfill 告警已移除，覆盖行为不变）
  //   cand 已保证非空且按 bankPool 顺序；tie-break 取 cand[0]（原序最前）
  const backfill = (gw, cand, phase, usedBankRowId, onConsume) => {
    if (cand.length === 0) return; // 未命中，静默（编排器层面再统计未命中）
    backfillChosen(gw, cand[0], cand.length, phase, usedBankRowId, onConsume);
  };
  // v3.2.22：已知首个候选与候选数时直接回填（映射目标账号的候选组按原序游标与剩余数取得，不再逐条重扫）。
  const backfillChosen = (gw, chosen, candidateCount, phase, usedBankRowId, onConsume) => {
    if (candidateCount > 1) {
      warningCollector.push({
        rowId: chosen._rowId,
        code: 'multi-bank-match-backfill',
        phase,
        message: `网关调拨单在银行对账单中匹配到 ${candidateCount} 行可用候选（${phase}），取原序最前一条（数据脏）`
      });
    }

    usedBankRowId.add(chosen._rowId); // 严格 1v1 单向消费
    if (onConsume) onConsume(gw, chosen);

    const nv = normalizeCellValue(gw && gw.reconciliationid);
    const old = normalizeCellValue(chosen.ReconciliationId);
    if (nv !== '' && old !== nv) {
      // 命中即覆盖（含非空原值）；按需求移除 reconid-overwrite-backfill 告警，覆盖行为不变。
      chosen.ReconciliationId = nv;
      modCollector.record(chosen._rowId, 'ReconciliationId', old, nv);
    } else if (isEscapeAmbiguousSameValue(old, nv)) {
      // v3.2.22（🔴 资金红线·可观测）：网关对账ID 含 `_xHHHH_` 写法、与银行当前值文字相同，无法确认是否同一个值。
      warningCollector.push(createEscapeSameValueWarning({
        rowId: chosen._rowId,
        engine: 'r5-fund-transfer-backfill',
        column: 'ReconciliationId',
        value: nv,
        source: 'R5 网关调拨：网关对账ID'
      }));
    }
    // nv 为空（网关无 reconid）或与原值相同 → 不写、不标黄，但仍已消费该银行行（1v1 红线不变）
  };

  // v3.2.22（🔴 资金红线·可观测）：映射目标账号上的网关行告警，正文写明网关记录业务键 ReconBillBizId 与对账ID
  //   （网关链接表按业务键去重，对账ID 可能相同）。两类告警都按网关行至多一条，规模随行数线性增长；只读，不改匹配结果。
  const describeGw = (gw) => {
    const bizId = normalizeCellValue(gw && gw.ReconBillBizId);
    const reconId = normalizeCellValue(gw && gw.reconciliationid);
    return `网关记录 ${bizId || '（无业务键）'}（对账ID ${reconId || '空'}）`;
  };
  const warnMissingChannel = (warnedGw, gw, gwAccount, bankRow) => {
    if (warnedGw.has(gw)) return;
    warnedGw.add(gw);
    const side = gwAccount.channel === '' ? '网关' : '银行';
    warningCollector.push({
      rowId: bankRow && bankRow._rowId,
      engine: 'r5-fund-transfer-backfill',
      code: MAPPED_ACCOUNT_CHANNEL_MISSING_WARNING_CODE,
      message: `R5 网关调拨：账户映射后${describeGw(gw)}与银行行(${bankRow && bankRow._rowId})账号、币种、金额相符，` +
        `但${side}渠道为空，无法确认同渠道，已排除该候选，请人工复核`
    });
  };
  const warnOutOfPoolChannelEscape = (warnedGw, gw, gwAccount, bankRow) => {
    if (warnedGw.has(gw)) return;
    warnedGw.add(gw);
    warningCollector.push({
      rowId: bankRow && bankRow._rowId,
      engine: 'r5-fund-transfer-backfill',
      code: MAPPED_ACCOUNT_CHANNEL_ESCAPE_AMBIGUOUS_WARNING_CODE,
      message: `R5 网关调拨：账户映射后${describeGw(gw)}与银行行(${bankRow && bankRow._rowId})账号、币种、金额相符，` +
        `但网关${describeEscapeAmbiguousChannel(gwAccount.channel)}，无法确认与银行行是否同渠道，未参与本轮回填，请人工核对渠道`
    });
  };
  // v3.2.22：银行行金额分与方向校验结果按行缓存（R5 只改写 ReconciliationId，不改金额与方向字段），
  //   映射目标账号的候选组、争用索引与逐行比较共用，每条银行行每个方向只解析一次。
  const bankCentsCache = new Map();
  const bankCentsOf = (bankRow) => {
    if (!bankCentsCache.has(bankRow)) bankCentsCache.set(bankRow, amountCents(bankAmountWithExtraFee(bankRow)));
    return bankCentsCache.get(bankRow);
  };
  const directionResultCaches = new Map();
  const directionResultOf = (bankRow, expectedDirection) => {
    let cache = directionResultCaches.get(expectedDirection);
    if (!cache) {
      cache = new Map();
      directionResultCaches.set(expectedDirection, cache);
    }
    if (!cache.has(bankRow)) cache.set(bankRow, validateBankDirection(bankRow, expectedDirection));
    return cache.get(bankRow);
  };

  // 争用告警：未匹配上的映射目标账号网关行，若有「字段、渠道、方向、日期都满足、但已被另一条网关行匹配并占用」的
  //   银行行，告警一次（rowId = 其中原序最前的银行行）。已占用银行行按「账号 + 币种 + 渠道 + 金额分」建一次索引、
  //   日期预解析；启用日期时桶内再按日期排序并建区间最小值表，每条未匹配网关行二分出容差区间后 O(1) 取原序最前者，
  //   不逐条扫描桶内过期行。胜出者必在 matchedGw 中，未匹配网关行不可能是自己所争银行行的胜出者。
  const warnMappedAccountContention = (dir, gwPool, bankPool, mappedTargetAccounts, contention, usedBankRowId) => {
    const keyOf = (account, currency, channel, cents) => JSON.stringify([account, currency, channel, cents]);
    let consumedIndex = null;
    const buildConsumedIndex = () => {
      const index = new Map();
      bankPool.forEach((bankRow, order) => {
        if (!usedBankRowId.has(bankRow._rowId)) return;
        const winner = contention.consumerByBankRowId.get(bankRow._rowId);
        if (!winner) return;
        const channel = normalizeCellValue(bankRow.Channel);
        if (channel === '') return;
        const cents = bankCentsOf(bankRow);
        if (cents === null) return;
        if (!directionResultOf(bankRow, dir.expectedBankDirection).ok) return;
        let bankTime = null;
        if (datePolicy.enabled) {
          const bankDate = toDate(bankRow.BillDate);
          if (!bankDate) return; // 日期无法解析的银行行通不过日期策略
          bankTime = bankDate.getTime();
        }
        const key = keyOf(
          normalizeCellValue(bankRow.MerchantId),
          normalizeCellValue(bankRow.Currency),
          channel,
          cents
        );
        if (!index.has(key)) index.set(key, { entries: [], lookup: null });
        index.get(key).entries.push({ bankRow, winner, bankTime, order });
      });
      return index;
    };
    // 与匹配同一日期判据：|round((网关日 − 银行日) / 天)| ≤ 容差。按银行日期升序时 round(...) 单调不增，
    //   故区间两端可二分；区间内取 bankPool 原序最前者。
    const findContendedEntry = (bucket, gwTime) => {
      if (!datePolicy.enabled) return bucket.entries[0];
      if (!bucket.lookup) {
        const sorted = bucket.entries.slice().sort((a, b) => a.bankTime - b.bankTime || a.order - b.order);
        bucket.lookup = { sorted, rangeMin: buildRangeMinIndex(sorted.map((entry) => entry.order)) };
      }
      const { sorted, rangeMin } = bucket.lookup;
      const dayOffset = (i) => Math.round((gwTime - sorted[i].bankTime) / MS_PER_DAY);
      const lo = firstIndexWhere(sorted.length, (i) => dayOffset(i) <= dateToleranceDays);
      const hi = firstIndexWhere(sorted.length, (i) => dayOffset(i) < -dateToleranceDays);
      return lo < hi ? sorted[rangeMin(lo, hi - 1)] : null;
    };
    const describeOutcome = datePolicy.enabled
      ? '已按同日优先、同阶段网关原序只匹配其一'
      : '日期匹配已关闭，已按网关原序只匹配其一';
    for (const gw of gwPool) {
      if (contention.matchedGw.has(gw)) continue;
      const gwAccount = gwAccountForMatching(gw, mappedTargetAccounts);
      if (!gwAccount.requireChannel || gwAccount.channel === '' || gwAccount.channelEscapeAmbiguous) continue;
      const gwCents = amountCents(gwAmountAbs(gw));
      const gwCurrency = normalizeCellValue(gw && gw.currency);
      if (gwAccount.account === '' || gwCurrency === '' || gwCents === null) continue;
      if (!consumedIndex) consumedIndex = buildConsumedIndex();
      const bucket = consumedIndex.get(keyOf(gwAccount.account, gwCurrency, gwAccount.channel, gwCents));
      if (!bucket) continue;
      let gwTime = null;
      if (datePolicy.enabled) {
        const gwDate = toDate(gw && gw.Billdate);
        if (!gwDate) continue;
        gwTime = gwDate.getTime();
      }
      const hit = findContendedEntry(bucket, gwTime);
      if (!hit) continue;
      warningCollector.push({
        rowId: hit.bankRow._rowId,
        engine: 'r5-fund-transfer-backfill',
        code: MAPPED_ACCOUNT_CONTENTION_WARNING_CODE,
        expectedDirection: dir.expectedBankDirection,
        message: `R5 网关调拨：账户映射后${describeGw(gw)}未匹配，其可用银行行(${hit.bankRow._rowId})已被${describeGw(hit.winner)}匹配并占用；` +
          `${describeOutcome}，请人工复核`
      });
    }
  };

  // 按「账号 + 币种 + 金额分」给本方向银行池建一次索引（懒建），与 baseFieldEq 判据完全等价：两侧账号、币种非空且相同，
  //   金额按 amountEqual 同口径精确到分。桶内保持 bankPool 原序，并记下原序最前的空渠道银行行。
  //   只服务映射目标账号上的网关行（缺渠道诊断与可写候选），每条银行行的金额只解析一次；其余网关行仍走原逐行比较。
  //   只为 accounts（本方向会查询的账号）内的银行行建桶，其余账号的行不解析金额、不占索引内存。
  //   v3.2.22（🔴 资金红线）：银行账号无法确认真实值（r5MappedBankAccountAmbiguity：按数值读入、与映射值对得上——前导 0 已丢
  //   或可能已丢失精度；被前序场景按链接表原文改写、含 `_xHHHH_` 写法且是要查询的账号）时不进桶，每条银行行告警一次（文本
  //   单元格、银行原值照常进桶）。数值写法按全部映射值判断（accounts 都是映射值），与池外诊断、检测器映射补跑同一口径。
  const buildBaseIndex = (bankPool, accounts) => {
    const index = new Map();
    const fingerprints = getMappingTargetFingerprints();
    for (const bankRow of bankPool) {
      const bankAmbiguity = r5MappedBankAccountAmbiguity(bankRow, accounts, fingerprints, options.isRawRewrittenBankValue);
      if (bankAmbiguity !== null) {
        warnAmbiguousBankAccount(bankRow, bankAmbiguity);
        continue;
      }
      const account = normalizeCellValue(bankRow && bankRow.MerchantId);
      if (!accounts.has(account)) continue;
      const key = accountCurrencyKeyForCents(
        account,
        normalizeCellValue(bankRow && bankRow.Currency),
        bankCentsOf(bankRow)
      );
      if (key === null) continue;
      let bucket = index.get(key);
      if (!bucket) {
        bucket = { rows: [], firstBlankChannelRow: null };
        index.set(key, bucket);
      }
      bucket.rows.push(bankRow);
      if (!bucket.firstBlankChannelRow && normalizeCellValue(bankRow.Channel) === '') bucket.firstBlankChannelRow = bankRow;
    }
    return index;
  };
  let mappingTargetFingerprints = null;
  const getMappingTargetFingerprints = () => {
    if (mappingTargetFingerprints === null) mappingTargetFingerprints = mappingTargetFingerprintsOf(accountMappingMap);
    return mappingTargetFingerprints;
  };
  // 原值按数值读入、与本方向映射目标对不清的网关行（isR5RawAccountTargetAmbiguous）：每条告警一次（池内、池外诊断行共用）。
  const warnedTargetAmbiguousGw = new Set();
  const warnTargetAmbiguousGw = (gw) => {
    if (warnedTargetAmbiguousGw.has(gw)) return;
    warnedTargetAmbiguousGw.add(gw);
    const rawAccount = normalizeCellValue(gw && gw.merchantid);
    warningCollector.push({
      rowId: null,
      reconId: normalizeCellValue(gw && gw.reconciliationid),
      engine: 'r5-fund-transfer-backfill',
      code: MAPPED_ACCOUNT_PRECISION_AMBIGUOUS_WARNING_CODE,
      message: `R5 网关调拨：${describeGw(gw)}的账户号（${describeAccountLength(rawAccount)}）${NUMERIC_READ_ACCOUNT_REASON}，` +
        '且与账户映射后的清结算账号对得上，无法确定真实账户号，已不参与本轮回填，请人工核对账户号与账户映射（网关账单里的账号宜按文本存放）'
    });
  };
  const warnedAmbiguousBankRows = new Set();
  const warnAmbiguousBankAccount = (bankRow, ambiguity) => {
    if (warnedAmbiguousBankRows.has(bankRow)) return;
    warnedAmbiguousBankRows.add(bankRow);
    const account = normalizeCellValue(bankRow.MerchantId);
    const precision = ambiguity === 'precision';
    const rewritten = typeof bankRow.MerchantId !== 'number';
    warningCollector.push({
      rowId: bankRow._rowId,
      engine: 'r5-fund-transfer-backfill',
      code: precision ? MAPPED_ACCOUNT_BANK_PRECISION_AMBIGUOUS_WARNING_CODE : MAPPED_ACCOUNT_BANK_ESCAPE_AMBIGUOUS_WARNING_CODE,
      message: precision
        ? `R5 网关调拨：银行行(${bankRow._rowId})的 MerchantId（${describeAccountLength(account)}）` +
          `${rewritten ? '被前序场景按链接表原文改写，' : ''}${NUMERIC_READ_ACCOUNT_REASON}，` +
          '与账户映射的清结算账号对得上，无法确认是否同一账号，未参与账户映射后的网关调拨回填，请人工核对' +
          (rewritten ? '（链接表里的账号宜按文本存放）' : '（银行对账单里的账号宜按文本存放）')
        : `R5 网关调拨：银行行(${bankRow._rowId})的 MerchantId 被前序场景按链接表原文改写，${describeEscapeAmbiguousAccount(account)}` +
          '，可能代表看不见的字符，与账户映射的清结算账号文字相同但无法确认是否同一账号，未参与账户映射后的网关调拨回填，请人工核对'
    });
  };
  const baseBucketFor = (getBaseIndex, gw, account) => {
    const key = accountCurrencyCentsKey(account, normalizeCellValue(gw && gw.currency), gwAmountAbs(gw));
    return key === null ? null : (getBaseIndex().get(key) || null);
  };
  // 缺渠道诊断只看「是否存在账号、币种、金额相符且无法确认同渠道的银行行」，不看该行是否已被占用，结果不随网关行顺序变化：
  //   网关渠道为空 → 桶内原序最前的行；网关渠道非空 → 桶内原序最前的空渠道银行行。
  const warnMissingChannelFromBucket = (warnedGw, gw, gwAccount, bucket) => {
    if (!bucket) return;
    const bankRow = gwAccount.channel === '' ? bucket.rows[0] : bucket.firstBlankChannelRow;
    if (bankRow) warnMissingChannel(warnedGw, gw, gwAccount, bankRow);
  };

  // 池外网关行（见 readR5MappedChannelDiagnosticRows）：只读诊断，不参与匹配、不消费银行行。映射命中行或原账号即本方向
  //   映射目标的行，与本方向银行池中某行账号、币种、金额相符且无法确认同渠道时告警一次：网关渠道为空 → 桶内原序最前者；
  //   网关渠道含转义写法 → 桶内原序最前者，按渠道转义告警（解码后可能与银行渠道相同）；网关有渠道（银行侧未出现的
  //   渠道）→ 桶内原序最前的空渠道银行行，无则不告警（渠道不同不是缺渠道）。
  const warnOutOfPoolMissingChannel = (dir, gwPool, getBaseIndex, mappedTargetAccounts, warnedGw) => {
    if (diagnosticGwRows.length === 0) return;
    const inPool = new Set(gwPool);
    for (const gw of diagnosticGwRows) {
      if (!gw || typeof gw !== 'object' || inPool.has(gw)) continue;
      if (normalizeCellValue(gw.TradeType) !== dir.gwTradeType) continue;
      if (normalizeCellValue(gw.reconciliationid) === '') continue;
      const { account, mapped } = resolveGwAccount(gw);
      if (account === '' || !(mapped || mappedTargetAccounts.has(account))) continue;
      if (isR5RawAccountTargetAmbiguous(accountMappingMap, mappedTargetAccounts, gw)) {
        warnTargetAmbiguousGw(gw);
        continue;
      }
      const gwAccount = { account, channel: normalizeCellValue(gw.Channel) };
      const bucket = baseBucketFor(getBaseIndex, gw, account);
      if (containsOoxmlEscape(gwAccount.channel)) {
        if (bucket) warnOutOfPoolChannelEscape(warnedGw, gw, gwAccount, bucket.rows[0]);
        continue;
      }
      warnMissingChannelFromBucket(warnedGw, gw, gwAccount, bucket);
    }
  };

  // F1（🔴 P1）：仅保留 reconciliationid 非空的网关行 —— 空 reconid 无可回填，
  //   若放进 gwPool 会在 backfill 里先 usedBankRowId.add 消费掉银行行（「不写但占用」），
  //   挡住后续有效网关行回填。空 reconid 不进池 → 不参与匹配、不消费 usedBankRowId。
  //   v3.2.22：各方向网关池与映射目标集合先算好，供池外诊断读取器按方向预筛。
  const directionGwPools = directions.map((dir) => {
    const gwPool = safeGwRows.filter(
      (g) =>
        normalizeCellValue(g && g.TradeType) === dir.gwTradeType &&
        normalizeCellValue(g && g.reconciliationid) !== ''
    );
    return { gwPool, mappedTargetAccounts: collectMappedTargetAccounts(gwPool) };
  });
  // v3.2.22（🔴 资金红线·可观测）：映射非空时账号无法确定真实值（含转义写法 / 与映射键对得上的数值写法）的网关行已在
  //   resolveMappedAccount 换成空账号，不参与匹配；逐条告警（每条网关行一次），提示人工核对账户号与映射。
  if (hasAccountMapping) {
    for (const { gwPool, mappedTargetAccounts } of directionGwPools) {
      for (const gw of gwPool) {
        const rawAccount = normalizeCellValue(gw && gw.merchantid);
        const ambiguity = mappedAccountAmbiguity(accountMappingMap, rawAccount);
        if (ambiguity === null) {
          if (isR5RawAccountTargetAmbiguous(accountMappingMap, mappedTargetAccounts, gw)) warnTargetAmbiguousGw(gw);
          continue;
        }
        const precision = ambiguity === 'precision';
        warningCollector.push({
          rowId: null,
          reconId: normalizeCellValue(gw && gw.reconciliationid),
          engine: 'r5-fund-transfer-backfill',
          code: precision ? MAPPED_ACCOUNT_PRECISION_AMBIGUOUS_WARNING_CODE : MAPPED_ACCOUNT_ESCAPE_AMBIGUOUS_WARNING_CODE,
          message: `R5 网关调拨：${describeGw(gw)}的` +
            `${precision ? describePrecisionAmbiguousAccount(rawAccount) : describeEscapeAmbiguousAccount(rawAccount)}，` +
            '无法确定真实账户号，已不参与本轮回填，请人工核对账户号与账户映射' +
            (precision ? '（链接表里的账号宜按文本存放）' : '')
        });
      }
    }
    for (const { gwPool, mappedTargetAccounts } of directionGwPools) {
      for (const gw of gwPool) {
        const gwAccount = gwAccountForMatching(gw, mappedTargetAccounts);
        if (!gwAccount.channelEscapeAmbiguous) continue;
        warningCollector.push({
          rowId: null,
          reconId: normalizeCellValue(gw && gw.reconciliationid),
          engine: 'r5-fund-transfer-backfill',
          code: MAPPED_ACCOUNT_CHANNEL_ESCAPE_AMBIGUOUS_WARNING_CODE,
          message: `R5 网关调拨：账户映射后${describeGw(gw)}的${describeEscapeAmbiguousChannel(gwAccount.channel)}，` +
            '无法确认与银行行是否同渠道，已不参与本轮回填，请人工核对渠道'
        });
      }
    }
  }
  if (hasAccountMapping && typeof options.channelMissingDiagnosticSource === 'function') {
    const targetAccountsByTradeType = new Map(
      directions.map((dir, index) => [dir.gwTradeType, directionGwPools[index].mappedTargetAccounts])
    );
    const rows = options.channelMissingDiagnosticSource({
      bankRows: safeBankRows,
      targetAccountsByTradeType,
      isRawRewrittenBankValue: options.isRawRewrittenBankValue
    });
    diagnosticGwRows = Array.isArray(rows) ? rows : [];
  }

  // 每个 direction 独立跑：独立 gwPool / bankPool / usedBankRowId（两方向不串池）
  for (const [directionIndex, dir] of directions.entries()) {
    const { gwPool, mappedTargetAccounts } = directionGwPools[directionIndex];
    const bankPool = safeBankRows.filter((b) => {
      if (normalizeCellValue(b && b.FundType) !== dir.bankFundType) return false;
      if (!hasInvalidExtraFee(b)) return true;
      if (shouldEmitInvalidExtraFeeWarning(b)) {
        warningCollector.push(createInvalidExtraFeeWarning(b));
      }
      return false;
    });
    const usedBankRowId = new Set();
    // 映射命中时才记录消费归属（用于争用告警）；无映射命中 = null，不改既有路径。
    const contention = mappedTargetAccounts.size > 0
      ? { matchedGw: new Set(), consumerByBankRowId: new Map() }
      : null;
    // 缺渠道告警按网关行去重（池内行与池外诊断行共用）。
    const channelMissingWarnedGw = new Set();
    let baseIndex = null;
    // 会查询候选桶的账号：映射目标账号（可写候选与池内缺渠道诊断），以及本方向池外诊断行中映射命中行映射后的账号
    //   （原账号即映射目标的诊断行已含在映射目标账号中）。
    const baseIndexAccounts = () => {
      const accounts = new Set(mappedTargetAccounts);
      for (const gw of diagnosticGwRows) {
        if (!gw || typeof gw !== 'object') continue;
        if (normalizeCellValue(gw.TradeType) !== dir.gwTradeType) continue;
        if (normalizeCellValue(gw.reconciliationid) === '') continue;
        const { account, mapped } = resolveGwAccount(gw);
        if (mapped && account !== '') accounts.add(account);
      }
      return accounts;
    };
    const getBaseIndex = () => {
      if (!baseIndex) baseIndex = buildBaseIndex(bankPool, baseIndexAccounts());
      return baseIndex;
    };
    // 映射目标账号的候选组：桶内同一非空渠道的银行行按原序分为方向通过（eligible）与未通过（failed），记录原序游标与
    //   未占用的可用行数（remaining）。占用只增不减，游标单调前移；按 _rowId 登记，_rowId 重复时一并扣减，
    //   与逐条「!usedBankRowId.has(_rowId)」筛选等价。
    //   开启日期匹配时，组内可用行再按银行日期（toDate 只解析一次）分段：同一时间戳为一段，段内保持原序并同样记录
    //   原序游标与未占用数，段按日期升序排列；日期无法解析的行单列。同日候选 = 年月日相同的各段，容差候选 = 偏移
    //   |round((网关日 − 银行日) / 天)| ≤ 容差的连续若干段，均按段取首个未占用行与未占用数，不逐行比较。
    const groupsByRowId = new Map();
    const registerUnusedCounts = (counter, unusedCountByRowId) => {
      for (const [rowId, count] of unusedCountByRowId) {
        if (!groupsByRowId.has(rowId)) groupsByRowId.set(rowId, []);
        groupsByRowId.get(rowId).push({ group: counter, count });
      }
    };
    const buildDateSegments = (group) => {
      const invalidPositions = [];
      const dated = [];
      group.eligible.forEach((bankRow, position) => {
        const date = toDate(bankRow.BillDate);
        if (date) dated.push({ position, time: date.getTime(), dayKey: localDayKey(date) });
        else invalidPositions.push(position);
      });
      dated.sort((a, b) => a.time - b.time || a.position - b.position);
      const segments = [];
      const segmentsByDayKey = new Map();
      dated.forEach((entry, sortedIndex) => {
        let segment = segments[segments.length - 1];
        if (!segment || segment.time !== entry.time) {
          segment = { time: entry.time, start: sortedIndex, positions: [], cursor: 0, remaining: 0 };
          segments.push(segment);
          if (!segmentsByDayKey.has(entry.dayKey)) segmentsByDayKey.set(entry.dayKey, []);
          segmentsByDayKey.get(entry.dayKey).push(segment);
        }
        segment.positions.push(entry.position);
      });
      for (const segment of segments) {
        const unusedCountByRowId = new Map();
        for (const position of segment.positions) {
          const rowId = group.eligible[position]._rowId;
          if (usedBankRowId.has(rowId)) continue;
          segment.remaining += 1;
          unusedCountByRowId.set(rowId, (unusedCountByRowId.get(rowId) || 0) + 1);
        }
        registerUnusedCounts(segment, unusedCountByRowId);
      }
      const sortedPositions = dated.map((entry) => entry.position);
      // 超出容差告警的「下一个未处理行」并查集（按日期序）：行在被告警或已占用后跳过，每行至多处理一次。
      const nextPending = Array.from({ length: sortedPositions.length + 1 }, (_v, i) => i);
      return {
        segments,
        segmentsByDayKey,
        sortedPositions,
        invalidPositions,
        nextPending,
        counterpartInvalidWarned: false,
        bankInvalidWarned: false
      };
    };
    // 首次使用某个桶时把桶内银行行按渠道一次分组（各组保持银行原序），之后每个被查询的渠道只处理本渠道的行，
    //   日期分段也只为被查询的渠道建立；多渠道同账号同金额的批次不再为每个新渠道重扫整桶。
    const channelGroupFor = (bucket, channel) => {
      if (!bucket.channelGroups) {
        bucket.channelGroups = new Map();
        bucket.rowsByChannel = new Map();
        for (const bankRow of bucket.rows) {
          const bankChannel = normalizeCellValue(bankRow.Channel);
          let rows = bucket.rowsByChannel.get(bankChannel);
          if (!rows) {
            rows = [];
            bucket.rowsByChannel.set(bankChannel, rows);
          }
          rows.push(bankRow);
        }
      }
      let group = bucket.channelGroups.get(channel);
      if (group) return group;
      group = { eligible: [], failed: [], cursor: 0, remaining: 0, failedChecked: false, dates: null };
      const unusedCountByRowId = new Map();
      for (const bankRow of bucket.rowsByChannel.get(channel) || []) {
        if (!directionResultOf(bankRow, dir.expectedBankDirection).ok) {
          group.failed.push(bankRow);
          continue;
        }
        group.eligible.push(bankRow);
        if (usedBankRowId.has(bankRow._rowId)) continue;
        group.remaining += 1;
        unusedCountByRowId.set(bankRow._rowId, (unusedCountByRowId.get(bankRow._rowId) || 0) + 1);
      }
      registerUnusedCounts(group, unusedCountByRowId);
      if (datePolicy.enabled) group.dates = buildDateSegments(group);
      bucket.channelGroups.set(channel, group);
      return group;
    };
    const firstUnusedInGroup = (group) => {
      while (group.cursor < group.eligible.length && usedBankRowId.has(group.eligible[group.cursor]._rowId)) {
        group.cursor += 1;
      }
      return group.eligible[group.cursor] || null;
    };
    // 段内首个未占用行在组内的下标；无则 -1。
    const firstUnusedPositionInSegment = (group, segment) => {
      while (segment.cursor < segment.positions.length
        && usedBankRowId.has(group.eligible[segment.positions[segment.cursor]]._rowId)) {
        segment.cursor += 1;
      }
      return segment.cursor < segment.positions.length ? segment.positions[segment.cursor] : -1;
    };
    const isUnusedPosition = (group, position) => !usedBankRowId.has(group.eligible[position]._rowId);
    // 网关日期（本地午夜毫秒）落在容差内的段区间 [lo, hi)：段按日期升序时偏移单调不增，两端可二分。
    const toleranceSegmentRange = (dates, gwTime) => {
      const offset = (i) => Math.round((gwTime - dates.segments[i].time) / MS_PER_DAY);
      const lo = firstIndexWhere(dates.segments.length, (i) => offset(i) <= dateToleranceDays);
      const hi = firstIndexWhere(dates.segments.length, (i) => offset(i) < -dateToleranceDays);
      return { lo, hi };
    };
    // 日期失败告警（逐条可审计）：与逐条比较时「本网关行可见的未占用可用行中，未通过日期容差者各告警一次」结果一致，
    //   按告警状态摊还：网关日期无法解析 → 组内全部未占用行（之后的同类网关行可见行只会更少、均已告警）；
    //   银行日期无法解析 → 这些未占用行（同理每组一次）；超出容差 → 容差区间两侧尚未处理的行（处理后跳过）。
    //   同一网关行的告警仍按组内原序发出。
    const emitMappedDateFailures = (gw, gwDate, group) => {
      const dates = group.dates;
      const positions = [];
      if (!gwDate) {
        if (dates.counterpartInvalidWarned) return;
        dates.counterpartInvalidWarned = true;
        for (let position = group.cursor; position < group.eligible.length; position += 1) {
          if (isUnusedPosition(group, position)) positions.push(position);
        }
      } else {
        if (!dates.bankInvalidWarned) {
          dates.bankInvalidWarned = true;
          for (const position of dates.invalidPositions) {
            if (isUnusedPosition(group, position)) positions.push(position);
          }
        }
        const { lo, hi } = toleranceSegmentRange(dates, gwDate.getTime());
        const total = dates.sortedPositions.length;
        const startOf = (segmentIndex) => (segmentIndex < dates.segments.length ? dates.segments[segmentIndex].start : total);
        const findPending = (index) => {
          let root = index;
          while (dates.nextPending[root] !== root) root = dates.nextPending[root];
          while (dates.nextPending[index] !== root) {
            const next = dates.nextPending[index];
            dates.nextPending[index] = root;
            index = next;
          }
          return root;
        };
        const collectOutside = (from, to) => {
          for (let index = findPending(from); index < to; index = findPending(index + 1)) {
            const position = dates.sortedPositions[index];
            if (isUnusedPosition(group, position)) positions.push(position);
            dates.nextPending[index] = index + 1;
          }
        };
        if (lo < hi) {
          collectOutside(0, startOf(lo));
          collectOutside(startOf(hi), total);
        } else {
          collectOutside(0, total); // 容差为负等情形：区间为空，全部超出容差
        }
        positions.sort((a, b) => a - b);
      }
      for (const position of positions) warnDateFailure(gw, group.eligible[position], dir.expectedBankDirection);
    };
    // 开启日期时映射目标账号网关行的一次匹配：phase 为 'same-day'（同日段）或容差阶段（区间内各段按天数差、银行行原序
    //   取最前者；候选数为区间内未占用行数）。返回是否已回填。
    const backfillMappedByDate = (gw, gwAccount, sameDayPhase) => {
      const group = mappedChannelGroup(gw, gwAccount);
      if (!group || !firstUnusedInGroup(group)) return false;
      const gwDate = toDate(gw && gw.Billdate);
      emitMappedDateFailures(gw, gwDate, group);
      if (!gwDate) return false;
      const dates = group.dates;
      let chosenPosition = -1;
      let candidateCount = 0;
      if (sameDayPhase) {
        for (const segment of dates.segmentsByDayKey.get(localDayKey(gwDate)) || []) {
          const position = firstUnusedPositionInSegment(group, segment);
          if (position < 0) continue;
          candidateCount += segment.remaining;
          if (chosenPosition < 0 || position < chosenPosition) chosenPosition = position;
        }
      } else {
        const gwTime = gwDate.getTime();
        const { lo, hi } = toleranceSegmentRange(dates, gwTime);
        let chosenRank = null;
        for (let i = lo; i < hi; i += 1) {
          const segment = dates.segments[i];
          const position = firstUnusedPositionInSegment(group, segment);
          if (position < 0) continue;
          candidateCount += segment.remaining;
          const rank = [
            Math.abs(Math.round((gwTime - segment.time) / MS_PER_DAY)),
            bankOriginalIndex.get(group.eligible[position]) ?? Number.MAX_SAFE_INTEGER
          ];
          if (!chosenRank || rank[0] < chosenRank[0] || (rank[0] === chosenRank[0] && rank[1] < chosenRank[1])) {
            chosenRank = rank;
            chosenPosition = position;
          }
        }
      }
      if (chosenPosition < 0) return false;
      const phase = sameDayPhase ? 'same-day' : `±${dateToleranceDays}day`;
      backfillChosen(gw, group.eligible[chosenPosition], candidateCount, phase, usedBankRowId, onConsume);
      return true;
    };
    // 映射目标账号：只在账号 + 币种 + 金额相符的桶内找（与 baseFieldEq 等价、保持原序）；缺渠道诊断不看占用状态；
    //   可写候选要求两侧渠道非空且相同、未被占用、方向通过。方向未通过的未占用行在首次触及时逐条告警（与逐条扫描时
    //   的去重结果一致：未通过方向的行不会成为任何候选，只可能因 _rowId 重复被占用）。
    const mappedChannelGroup = (sourceRow, gwAccount) => {
      if (gwAccount.channelEscapeAmbiguous) return null; // 已逐条告警，不参与匹配
      const bucket = baseBucketFor(getBaseIndex, sourceRow, gwAccount.account);
      warnMissingChannelFromBucket(channelMissingWarnedGw, sourceRow, gwAccount, bucket);
      if (!bucket || gwAccount.channel === '') return null;
      const group = channelGroupFor(bucket, gwAccount.channel);
      if (!group.failedChecked) {
        group.failedChecked = true;
        for (const bankRow of group.failed) {
          if (usedBankRowId.has(bankRow._rowId)) continue;
          warnDirectionFailure(bankRow, dir.expectedBankDirection, directionResultOf(bankRow, dir.expectedBankDirection));
        }
      }
      return group;
    };
    const onConsume = (gw, bankRow) => {
      const entries = groupsByRowId.get(bankRow._rowId);
      if (entries) {
        groupsByRowId.delete(bankRow._rowId);
        for (const { group, count } of entries) group.remaining -= count;
      }
      // 争用告警只查映射目标账号的银行行，只为这些行登记消费归属（其余账号的成功匹配不进争用索引）；
      //   被消费银行行的账号即网关行的匹配账号，属映射目标 ⇔ 该网关行需同渠道校验。
      if (contention && mappedTargetAccounts.has(normalizeCellValue(bankRow.MerchantId))) {
        contention.matchedGw.add(gw);
        contention.consumerByBankRowId.set(bankRow._rowId, gw);
      }
    };
    // 非映射目标账号的网关行：逐行比较（旧口径）。映射目标账号的网关行走候选组（见上）。
    const directionEligibleCandidates = (sourceRow, gwAccount) => {
      // 匹配账号为空（原账号为空，或转义歧义已换成空串）时 baseFieldEq 恒为 false：直接返回，不扫整个银行池。
      if (gwAccount.account === '') return [];
      const nearCandidates = bankPool.filter((b) => !usedBankRowId.has(b._rowId) && baseFieldEq(sourceRow, gwAccount, b));
      const eligible = [];
      for (const bankRow of nearCandidates) {
        const directionResult = directionResultOf(bankRow, dir.expectedBankDirection);
        if (directionResult.ok) {
          eligible.push(bankRow);
        } else {
          warnDirectionFailure(bankRow, dir.expectedBankDirection, directionResult);
        }
      }
      return eligible;
    };

    if (!datePolicy.enabled) {
      for (const gw of gwPool) {
        const gwAccount = gwAccountForMatching(gw, mappedTargetAccounts);
        if (gwAccount.requireChannel) {
          // 关闭日期时首个未占用可用行即选择结果，候选数即 remaining，不逐条重扫候选组。
          const group = mappedChannelGroup(gw, gwAccount);
          const chosen = group ? firstUnusedInGroup(group) : null;
          if (chosen) backfillChosen(gw, chosen, group.remaining, 'date-disabled', usedBankRowId, onConsume);
          continue;
        }
        backfill(gw, directionEligibleCandidates(gw, gwAccount), 'date-disabled', usedBankRowId, onConsume);
      }
      if (contention) warnMappedAccountContention(dir, gwPool, bankPool, mappedTargetAccounts, contention, usedBankRowId);
      warnOutOfPoolMissingChannel(dir, gwPool, getBaseIndex, mappedTargetAccounts, channelMissingWarnedGw);
      for (const consumedRowId of usedBankRowId) consumedBankRowIds.add(consumedRowId);
      continue;
    }

    // ===== Phase1：严格同日 —— 先把所有 gw 跑完，消费掉同日命中（保证「优先同日」硬约束）=====
    //   记录 Phase1 未命中的 gw（cand 为空），留给 Phase2 用 ±tolerance 再匹配。
    const unmatchedAfterPhase1 = [];
    for (const gw of gwPool) {
      const gwAccount = gwAccountForMatching(gw, mappedTargetAccounts);
      if (gwAccount.requireChannel) {
        if (!backfillMappedByDate(gw, gwAccount, true)) unmatchedAfterPhase1.push(gw);
        continue;
      }
      const directionEligible = directionEligibleCandidates(gw, gwAccount);
      for (const bankRow of directionEligible) {
        if (!dayDiffWithin(gw && gw.Billdate, bankRow.BillDate, dateToleranceDays)) {
          warnDateFailure(gw, bankRow, dir.expectedBankDirection);
        }
      }
      const cand = directionEligible.filter(
        (b) => sameDay(gw && gw.Billdate, b.BillDate)
      );
      if (cand.length === 0) {
        unmatchedAfterPhase1.push(gw);
        continue;
      }
      backfill(gw, cand, 'same-day', usedBankRowId, onConsume);
    }

    // ===== Phase2：仅 Phase1 未命中的 gw，对未被消费的银行行用 ±dateToleranceDays 再匹配 =====
    for (const gw of unmatchedAfterPhase1) {
      const gwAccount = gwAccountForMatching(gw, mappedTargetAccounts);
      if (gwAccount.requireChannel) {
        backfillMappedByDate(gw, gwAccount, false);
        continue;
      }
      const directionEligible = directionEligibleCandidates(gw, gwAccount);
      const cand = [];
      for (const bankRow of directionEligible) {
        if (dayDiffWithin(gw && gw.Billdate, bankRow.BillDate, dateToleranceDays)) {
          cand.push(bankRow);
        } else {
          // near-candidate 的日期失败原因必须逐条可审计，即使同一来源另有合法候选最终成功。
          warnDateFailure(gw, bankRow, dir.expectedBankDirection);
        }
      }
      // F2（P2）：dateToleranceDays>1 时，按「与网关 Billdate 的绝对天数差」升序稳定排序，
      //   让差 1 天的优先于差 2 天（JS Array.sort 对相等键稳定 → 同天数差保持 bankPool 原序）。
      //   Phase1 严格同日不受影响。
      const gwDate = toDate(gw && gw.Billdate);
      const dayDiffAbs = (b) => {
        const bd = toDate(b && b.BillDate);
        if (!gwDate || !bd) return Number.POSITIVE_INFINITY;
        return Math.abs(Math.round((gwDate.getTime() - bd.getTime()) / MS_PER_DAY));
      };
      cand.sort(
        (a, b) =>
          dayDiffAbs(a) - dayDiffAbs(b) ||
          (bankOriginalIndex.get(a) ?? Number.MAX_SAFE_INTEGER) -
            (bankOriginalIndex.get(b) ?? Number.MAX_SAFE_INTEGER)
      );
      backfill(gw, cand, `±${dateToleranceDays}day`, usedBankRowId, onConsume);
    }
    if (contention) warnMappedAccountContention(dir, gwPool, bankPool, mappedTargetAccounts, contention, usedBankRowId);
    warnOutOfPoolMissingChannel(dir, gwPool, getBaseIndex, mappedTargetAccounts, channelMissingWarnedGw);

    // 🔴 v3.0.4 块 F：把本 direction 消费的银行行（含同值未写行，1v1 单向消费集）并入跨方向聚合集。
    //   不改既有匹配/写值逻辑：仅在 direction 跑完后追加一次 union，纯 additive 收集。
    for (const consumedRowId of usedBankRowId) consumedBankRowIds.add(consumedRowId);
  }

  return {
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list(),
    usedBankRowIds: consumedBankRowIds,
    directionsValid: true
  };
}

module.exports = {
  runRound5FundTransferBackfill,
  readR5MappedChannelDiagnosticRows,
  buildR5ChannelMissingDiagnosticPrefilter,
  createR5ChannelMissingDiagnosticSource,
  channelMissingDiagnosticKeyDigest,
  collectR5MappedTargetAccounts,
  gwChannelMissingDiagnosticKey,
  isR5MappedBankRowUnverifiable,
  isR5MappedRowChannelUnverifiable,
  isR5RawAccountTargetAmbiguous,
  mappingTargetFingerprintsOf,
  r5MappedBankAccountAmbiguity,
  amountEqual,
  amountCents,
  bankAmountAbs,
  bankAmountEqualWithoutExtraFee,
  bankAmountWithExtraFee,
  createInvalidExtraFeeWarning,
  gwAmountAbs,
  hasInvalidExtraFee,
  makeInvalidExtraFeeWarningDeduper
};
