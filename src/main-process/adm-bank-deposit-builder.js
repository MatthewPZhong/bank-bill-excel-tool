// v2.1.16-beta.5 需求3：ADM 银行对账单链接表派生纯函数（逻辑A）
//
// 🔴 资金对账敏感（PRD §5.3 / TECH §三）：本模块把银行对账单表里 Channel=ADM 的调拨入金行派生成
//    隐藏的「ADM 银行对账单链接表」行，并与中台调拨订单（调拨单号 / 渠道流水号 / 收款金额）按
//    「CustomerRef ↔ 渠道流水号」唯一匹配回填「调拨号 / Fundtransfer-in金额」。派生 / 匹配错误会写错
//    调拨号 / 调拨入金金额，进而让 JPM 引擎步骤4 金额汇总错配资金对账ID。两侧匹配必须在赋值之前完成唯一性校验。
//
// 纯函数（不读 DB / 不碰 FS / 不依赖 Electron）：bankDepositRows / midAllocationRows 由 main.js 注入，便于单测。
//   · bankDepositRows：已是 pickBankDepositFields 裁后的 13 银行字段对象数组（linked-table-repository.BANK_DEPOSIT_FIELDS）。
//   · midAllocationRows：readLinkedTableRows('mid-allocation') 还原的中台调拨整行对象数组（字段名=中文真实表头）。
//
// 跨表字段名一律经 src/constants/adm-bank-deposit-fields.js 常量 pick，绝不手敲（四张表大小写不一致，TECH §七 / R-1）。
//   本模块只用到：CHANNEL_VALUE / ADM_FUND_TYPES / ADM_EXTRA_FIELDS / FIELD_MAP。
//
// 🔴 金额不在此比较：Fundtransfer-in金额 仅取中台「收款金额」原值落库（String 化，不做数值转换 / 比较），
//    步骤4 整组金额汇总比较在 PR-3 JPM 引擎做（逐笔转分累加，容差 0）。

const {
  normalizeDateExportValue
} = require('../backend/file-service/normalizers');
const { normalizeCellValue } = require('./scenario-engines/engine-utils');
const {
  CHANNEL_VALUE,
  ADM_FUND_TYPES,
  ADM_EXTRA_FIELDS,
  FIELD_MAP
} = require('../constants/adm-bank-deposit-fields');

// 单元格归一：trim（number → String，null/undefined → ''）。复用 engine-utils.normalizeCellValue。
//   normKey（匹配键归一）= 同一口径 String().trim()，大小写敏感（TECH §3.5 normKey 定义）。两者等价，别名以表语义。
const normCell = normalizeCellValue;
const normKey = normalizeCellValue;

// 日期归一为统一 YYYY-MM-DD（本地分量格式化，与 linked-table-repository.normalizeDateForRange 完全一致口径）。
//   🔴 必须取 result.date 再本地分量格式化，不能用 result.value：result.value 对 '2026/05/04' / '20260504' 保留原格式，
//      同组不同输入格式会让批次号分裂成多个（防 Excel 序列号 / 混合日期格式分裂，PRD §5.3.4）。
//   无法解析 / 空值 → 返回 ''（批次号该段留空，不阻断）。
function normalizeBillDateIso(value) {
  const result = normalizeDateExportValue(value);
  if (!result || !result.date || Number.isNaN(result.date.getTime())) {
    return '';
  }
  const d = result.date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// —— 步骤3：批次号生成（PRD §5.3.4 / TECH §3.4）——
//   按 ChannelOrderNo 分组，组内取「首个可解析的 BillDate」规范化为 YYYY-MM-DD，批次号 = <规范化日期>-<ChannelOrderNo>。
//   组内一致性 > 单行 BillDate：同一 ChannelOrderNo 的所有行共用首个可解析 BillDate，防 BillDate 脏数据致同组分裂多批次号。
//   ChannelOrderNo 为空 → 批次号为空（不阻断派生，该行仍落库）。
//   首个可解析日期也为空（整组 BillDate 都解析不出）→ 批次号 = `-<ChannelOrderNo>`（日期段留空，仍保留 ChannelOrderNo 归批）。
function assignBatchNo(admRows) {
  const FIELD_CHANNEL_ORDER_NO = FIELD_MAP.admChannelOrderNo; // 'ChannelOrderNo'
  const FIELD_BILL_DATE = FIELD_MAP.admBillDate;             // 'BillDate'
  const FIELD_BATCH_NO = FIELD_MAP.admBatchNo;              // '批次号'

  // 组键 → 规范化日期（首个可解析者；一旦定下不再被后续行覆盖）
  const groupDate = new Map();
  for (const a of admRows) {
    const con = normCell(a[FIELD_CHANNEL_ORDER_NO]);
    if (con === '' || groupDate.has(con)) continue;
    // F3a 修复（self-review）：取首个「可解析」BillDate（非空 ISO）才定批次日期段；解析失败则跳过、留待后续行，
    //   避免首行脏数据致整组批次号日期段误留空（注释原称"首个可解析"，实现曾误为"首个出现"无条件 set）。
    const iso = normalizeBillDateIso(a[FIELD_BILL_DATE]);
    if (iso !== '') groupDate.set(con, iso);
  }

  for (const a of admRows) {
    const con = normCell(a[FIELD_CHANNEL_ORDER_NO]);
    if (con === '') {
      a[FIELD_BATCH_NO] = '';
      continue;
    }
    const iso = groupDate.get(con) || '';
    a[FIELD_BATCH_NO] = `${iso}-${con}`;
  }
}

// —— 步骤4：中台匹配（CustomerRef ↔ 渠道流水号，PRD §5.3.5 / TECH §3.5 / 决策9）——
//   🔴 两侧任一重复 = 冲突，不赋值、进未匹配报错（防步骤4金额汇总重复累加）：
//     · 中台侧 bucket.length > 1（同一渠道流水号对应多条中台行）→ 'mid-duplicate'
//     · ADM 侧同一 CustomerRef 出现多行（ADM 侧不唯一）→ 'adm-duplicate'
//     · ADM 行 CustomerRef 为空 → 'empty-customerref'
//     · 中台无对应渠道流水号 → 'no-mid-match'
//   clean（两侧都唯一）→ 中台「调拨单号」→ADM「调拨号」、中台「收款金额」→ADM「Fundtransfer-in金额」（原值落库）。
//   normKey = String().trim()（大小写敏感）。
//   返回 { unmatched }：每项 { row, code, conflict? }（conflict 仅 mid-duplicate 带，列冲突的调拨单号供报错框参考）。
function matchAdmToMidAllocation(admRows, midRows) {
  const FIELD_ADM_CUSTOMER_REF = FIELD_MAP.admCustomerRef;        // 'CustomerRef'
  const FIELD_ADM_ALLOCATION_NO = FIELD_MAP.admAllocationNo;       // '调拨号'
  const FIELD_ADM_FUNDTRANSFER_IN = FIELD_MAP.admFundtransferInAmount; // 'Fundtransfer-in金额'
  const FIELD_MID_CHANNEL_SERIAL = FIELD_MAP.midChannelSerial;     // '渠道流水号'
  const FIELD_MID_ALLOCATION_NO = FIELD_MAP.midAllocationNo;       // '调拨单号'
  const FIELD_MID_RECEIVE_AMOUNT = FIELD_MAP.midReceiveAmount;     // '收款金额'

  // 中台索引：渠道流水号 → [midRow]（保留多条以检测冲突；空键不入索引）
  const midByRef = new Map();
  for (const m of midRows) {
    const key = normKey(m[FIELD_MID_CHANNEL_SERIAL]);
    if (key === '') continue;
    if (!midByRef.has(key)) midByRef.set(key, []);
    midByRef.get(key).push(m);
  }

  // ADM 侧重复检测：同 CustomerRef 出现次数（空键不计；> 1 即 ADM 侧不唯一）
  const admRefCount = new Map();
  for (const a of admRows) {
    const k = normKey(a[FIELD_ADM_CUSTOMER_REF]);
    if (k !== '') admRefCount.set(k, (admRefCount.get(k) || 0) + 1);
  }

  const unmatched = [];
  for (const a of admRows) {
    const refKey = normKey(a[FIELD_ADM_CUSTOMER_REF]);
    if (refKey === '') {
      unmatched.push({ row: a, code: 'empty-customerref' });
      continue;
    }
    if ((admRefCount.get(refKey) || 0) > 1) {
      unmatched.push({ row: a, code: 'adm-duplicate' });
      continue;
    }
    const bucket = midByRef.get(refKey) || [];
    if (bucket.length === 0) {
      unmatched.push({ row: a, code: 'no-mid-match' });
      continue;
    }
    if (bucket.length > 1) {
      unmatched.push({
        row: a,
        code: 'mid-duplicate',
        conflict: bucket.map((x) => normCell(x[FIELD_MID_ALLOCATION_NO]))
      });
      continue;
    }
    // clean：两侧都唯一 → 赋值（调拨号 / Fundtransfer-in金额 原值落库；金额比较在 PR-3）
    const m = bucket[0];
    a[FIELD_ADM_ALLOCATION_NO] = normCell(m[FIELD_MID_ALLOCATION_NO]);
    a[FIELD_ADM_FUNDTRANSFER_IN] = normCell(m[FIELD_MID_RECEIVE_AMOUNT]);
  }

  return { unmatched };
}

// —— 主入口：派生 ADM 行（PRD §5.3 / TECH §3.3）——
//   1) 筛选：Channel===CHANNEL_VALUE('ADM') ∧ FundType∈ADM_FUND_TYPES（精确等于、大小写敏感，normCell trim 后比）。
//   2) 构造：13 银行字段（原样复制）+ 6 新字段初值（批次号/调拨号/Fundtransfer-in金额/资金对账ID=''，两个匹配标志=0）。
//   3) 批次号：assignBatchNo（按 ChannelOrderNo 分组）。
//   4) 中台匹配：matchAdmToMidAllocation（两侧任一重复=冲突；clean 回填调拨号 / Fundtransfer-in金额）。
//   返回 { admRows, unmatched, midEmpty }：
//     · admRows —— 全部筛中的 ADM 行（含未匹配行，调拨号 / Fundtransfer-in金额 留空），整批落库（部分成功仍建表）。
//     · unmatched —— 未匹配明细 [{ row, code, conflict? }]（供前端报错框列出）。
//     · midEmpty —— 中台调拨订单表是否为空（true 时前端报错框额外提示「请先导入中台调拨订单表」）。
function buildAdmRows(bankDepositRows, midAllocationRows) {
  const bankRows = Array.isArray(bankDepositRows) ? bankDepositRows : [];
  const midRows = Array.isArray(midAllocationRows) ? midAllocationRows : [];

  const FIELD_CHANNEL = FIELD_MAP.admChannel;   // 'Channel'
  const FIELD_FUND_TYPE = FIELD_MAP.admFundType; // 'FundType'

  // 1) 筛选（精确等于、大小写敏感）
  const admSource = bankRows.filter((r) => {
    if (!r || typeof r !== 'object') return false;
    return normCell(r[FIELD_CHANNEL]) === CHANNEL_VALUE
      && ADM_FUND_TYPES.includes(normCell(r[FIELD_FUND_TYPE]));
  });

  // 2) 构造 ADM 行（13 银行字段原样复制 + 6 新字段初值）
  //    🔴 浅拷贝源行（{ ...r }）保 13 银行字段；再写 6 新字段初值（顺序按 ADM_EXTRA_FIELDS 唯一真相）。
  //    匹配标志用数值 0（PRD §5.3.3：是否与渠道账单匹配 / 是否与网关账单匹配 初始 0），其余新字段用空串。
  const admRows = admSource.map((r) => {
    const row = { ...r };
    for (const field of ADM_EXTRA_FIELDS) {
      row[field] = (field === FIELD_MAP.admChannelMatched || field === FIELD_MAP.admGatewayMatched)
        ? 0
        : '';
    }
    return row;
  });

  // 3) 批次号
  assignBatchNo(admRows);

  // 4) 中台匹配（clean 回填；冲突 / 无匹配 / 空 ref 进 unmatched）
  const { unmatched } = matchAdmToMidAllocation(admRows, midRows);

  return {
    admRows,
    unmatched,
    midEmpty: midRows.length === 0
  };
}

module.exports = {
  buildAdmRows,
  // 子函数导出供单测细粒度断言（批次号 / 中台匹配独立验证）
  assignBatchNo,
  matchAdmToMidAllocation,
  normalizeBillDateIso
};
