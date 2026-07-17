// v2.1.16-beta.4 ③ R5 场景4「中台退款订单回填」引擎（🔴 资金红线）
// PRD-中台退款订单回填-v2.1.16-beta.3 §5.1~§5.5 + §九（12 条已确认决议）
// TECH_DESIGN-中台退款订单回填-v2.1.16-beta.3 §3.2/§3.3
// refund-backfill-rules-v2（v3.0.5）：R1~R6 命中规则增强 + O1~O4 输出扩列（详见 changes/refund-backfill-rules-v2/spec.md）。
//
// 业务语义：
//   银行 FundType=Ach Return（且 FundType 未被 R4 改写）行 ↔ 中台退款订单 状态=SUBMITTED 行，
//   按「渠道大账号(MerchantId↔银行大账号) + 金额(|Credit-Debit|↔退款金额) + 币种」三元组唯一值分组；
//   同一唯一值下按策略链批量解析（命中即停，精准层 L1~L5 全排在模糊层 L6/S4 之前 → 精准优先由层序保证）：
//     L1 S1   渠道流水号等值                                              [精准]
//     L2 S2   附言层：JPM-HK T54[A-Z]{4} 宽正则(R1) ↔ 打款流水号等值 / 未中→CustomerRef 二跳(R3)；
//             JPM-US CustomerRef 二跳；JPM 链空/非 JPM → 常规 MTX 包含             [精准]
//     L3 S2b  附言包含入金 CustomerRef（限 JPM，等值层后）(R2)             [精准]
//     L4 S3   付款人/卡号/虚拟卡号按位等值                                  [精准]
//     L5 S3b  Drawee Name + 附言 DESC DATE ↔ 入金 ValueDate 二跳(R5)        [精准]
//     L6 S3c  附言原单日期(DTD)+金额(FOR)+币种 ↔ 入金表二跳(R6)             [模糊]
//   S4（链后）：单向 0 ≤ bank.BillDate − ro.valueDate ≤ 21(R4)             [模糊]
//   产出独立的回填模板行集合 + 未匹配/报错行集合（不改 bankRows）。
//
// v3.0.10 变更：
//   需求2（网关前置过滤）：银行 Ach Return 行入池前先与网关单做 reconid 匹配，命中网关 reconid 的静默移出退款池
//     （这些行已能与网关对账，不该再走退款回填，顺手闭合已知 no-op 缝隙）。
//   需求3.1（sheet1 标黄）：各 matcher 命中时附 `_matchedColumns`（实际参与比对的候选列，诚实列出），
//     buildBackfillRow 单点收口过滤为「∈ sheet1 列」非空才挂 row._matchedColumns，供 writer 标黄。
//   需求3.2（sheet2 改造）：报错/提示并入「报错/提示信息」前缀（【报错】/【提示】，单点加在 buildUnmatchedBankRow）；
//     refund-only（无对应银行行）的 refund 不再产 notice 行（完全静默，删两段收尾循环）。
// v3.0.10 退款回填输出细化（Change A/B）：
//   A. REFUND_BANK_COLUMNS 10→12（在常量侧加 Extra Information + Drawee Name），各 matcher 候选 `_matchedColumns` 不动——
//      原本被 buildBackfillRow 交集过滤丢弃的 Extra Information / Drawee Name 现入 sheet1 → 命中即自动标黄（S2-MTX/JPM-HK/S3/S3b/S3c 受益）。
//   B. S4 命中的 `_matchedColumns` 由 [BillDate,valueDate] 扩为按固定文案口径的 8 列（bank 4 + ro 4，全∈sheet1，见 matchS4）。
//
// 跨表字段映射全部走 refund-backfill-fields.js（显式映射，绝不假设同名）。4 条二跳路径共用入金表双 Map 索引(depIndex)。
//
// 纯函数：入参 rows 数组，不读 DB/session（由 main.js 注入）；与场景2/3 独立 usedBankRowId，不串池。
//   签名 runRound5RefundOrderBackfill(bankRows, refundOrderRows, depositRows, options={})
//   返回 { backfillRows, unmatchedRows, modifications:[], warnings, hitDepositBizIds }
//     backfillRows  —— sheet1 回填模板行（v3.0.10：33 列 = 固定 6 列含「命中类型」+ 银行 12 字段 + 中台 15 字段）
//     unmatchedRows —— sheet2 行（含「结果类型」= 报错-人工介入 / 未匹配-提示 + 信息列）
//     modifications —— 恒 []（本引擎不改 bankRows，保留与场景2/3 返回对称性）
//     hitDepositBizIds —— OPEN-7：本批以入金表为来源回填成功的桥接 BizId 去重数组（含 R3/R5/R6 二跳命中）
//
// ⚠️ 资金红线：列名映射 / 命中规则 / 命中类型 / 多笔报错-提示区分 任一错位都会写错回填（误改退款单状态 SUCCESS）。

const {
  makeWarningCollector,
  normalizeCellValue,
  parseNumber
} = require('./engine-utils');
const { toDate, sameDay, signedDayDiff } = require('./engine-date-utils');
const { buildFeatureRegex } = require('./c1-extract-recon-id');
const {
  canonicalizeDecimal,
  absoluteDecimal,
  subtractCanonicalDecimals,
  compareCanonicalDecimals
} = require('../financial-decimal');
const {
  REFUND_BACKFILL_FIELD_MAP: M,
  REFUND_BANK_COLUMNS,
  REFUND_RO_COLUMNS,
  REFUND_TEMPLATE_HEADERS, // v3.0.10 需求3.1：buildBackfillRow 单点过滤 _matchedColumns ⊆ sheet1 列基准
  MTX_FEATURE,
  T54_REFUND_RE
} = require('../../constants/refund-backfill-fields');

// v3.0.10 需求2：网关行 reconid 字段名（真实表头小写；与 r4 引擎同名常量同值——网关侧小写、银行侧驼峰，绝不假设同名）。
const GW_RECON_ID_FIELD = 'reconciliationid';

// 提取 regex 模板（仅当模板用，每次提取前 new RegExp(source,'g') 重建，避免 lastIndex 副作用 —— 同 C1）
const MTX_RE = buildFeatureRegex(MTX_FEATURE);          // /MTX\d{19}/g
// R1：JPM-HK 提取正则（T54+4字母+6数字；直写常量，extractFeature 仅用 .source 重建天然兼容）
const T54_RE = T54_REFUND_RE;                           // /T54[A-Z]{4}\d{6}/g

// 结果类型（sheet2「结果类型」列两种值；两类输出禁混）
const RESULT_ERROR = '报错-人工介入';
const RESULT_NOTICE = '未匹配-提示';

// 命中类型（O1：sheet1「命中类型」列两种值；= 策略层属性，精准层全在模糊层前由层序保证「精准优先」）。
//   L1~L5（S1/S2/S2b/S3/S3b）= 精准命中；L6（S3c）/ S4 = 模糊命中。
const HIT_TYPE_PRECISE = '精准命中';
const HIT_TYPE_FUZZY = '模糊命中';

// S4 命中详情固定文案（O2：✅ 2026-06-15 用户拍板；底层比对字段仍为 ro.valueDate，文案为业务展示叫法「退款提交日期」）。
const S4_DETAIL_TEXT = '命中唯一值:退款提交日期+大账号+金额+币种';
const BANK_PAYMENT_SERIAL_FUZZY_DETAIL_PREFIX = '银行对账单ChannelOrderNo/CustomerRef等于退款订单的银行打款流水号，金额差额=';
const BANK_PAYMENT_SERIAL_FUZZY_AMOUNT_LIMIT = '10';

// 银行发生额绝对值 = |（Credit Amount || 0） − （Debit Amount || 0）|（与场景2 口径一致）
//   任一非数值按 0；两者皆非数值 → 返回 0（非 null）
function bankAmountAbs(bankRow) {
  const credit = parseNumber(bankRow && bankRow['Credit Amount']) || 0;
  const debit = parseNumber(bankRow && bankRow['Debit Amount']) || 0;
  return Math.abs(credit - debit);
}

// 在文本里 matchAll 指定 feature regex 模板，返回去重命中数组（空文本 → []）
function extractFeature(text, reTemplate) {
  const s = normalizeCellValue(text);
  if (!s) return [];
  const fresh = new RegExp(reTemplate.source, 'g'); // 避免共享 regex 的 lastIndex 污染（同 C1）
  return Array.from(new Set(s.match(fresh) || []));
}

// 基数分类（同一唯一值分组下 bank/refund 各自条数）
function classifyCardinality(bankCount, refundCount) {
  const b = bankCount > 1 ? 'N' : '1';
  const r = refundCount > 1 ? 'N' : '1';
  return `${b}:${r}`;
}

// 简单分组：rows → Map<key, rows[]>（keyFn 返回 null/undefined → 该行不入组）
function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key === null || key === undefined) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

// —— 命中详情两句式（§5.1.4；O2：删「匹配成功:」前缀）——
function detailBankToRo(bankField, bankVal, roField, roVal) {
  return `"银行对账单${bankField}里的${normalizeCellValue(bankVal)}"匹配上了"refund order${roField}的${normalizeCellValue(roVal)}"`;
}
function detailBankToDeposit(bankField, bankVal, depField, depVal) {
  return `"银行对账单${bankField}里的${normalizeCellValue(bankVal)}"匹配上了"银行对账单入金表${depField}的${normalizeCellValue(depVal)}"`;
}

// —— OPEN-7（T5b-1）跨期重复命中：BizId 归一 + 提醒文案 + 跨期判定纯函数（与 detailBankToDeposit 同文件，文案/口径单一真相）——
//   引擎严守纯函数：绝不 require DB/仓储；归一口径 = String().trim()，与 linked-table-repository.js normalizeKey 字节一致。
// 归一 BizId（入金表 BANK_DEPOSIT_FIELDS[0]）：非空 → 去空白；null/undefined/空 → ''。
function normalizeBizIdKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// 跨期重复命中提醒文案（spec §3.6-5；T5b-2 注入回填行「匹配命中详情」）。
function buildStaleHitReminder(bizId, lastHitAt) {
  return `⚠️ 桥接入金表行 BizId=${bizId} 此前于 [${lastHitAt}] 已被命中，疑似历史残留`;
}

// 从本批命中 BizId 集合中挑出「跨期重复命中」需提醒项（spec §3.6-3）。
//   入参 markerMap：调用方（main.js）传入的 bizId → { last_hit_run, last_hit_at }（引擎自身不读库，保持纯函数）。
//   判定（runId 比较用字符串）：
//     · marker.last_hit_run 非空 且 String(last_hit_run) ≠ String(runId) → 跨期命中 → 入选 { bizId, lastHitAt }
//     · == runId → 同批，不入（同批 run/export 不误报）
//     · 空 last_hit_run / markerMap 未命中该 bizId → 首次命中，不入
function pickStaleHits(hitBizIds, markerMap, runId) {
  const out = [];
  if (!Array.isArray(hitBizIds) || !markerMap || typeof markerMap.get !== 'function') return out;
  const runKey = String(runId);
  for (const bizId of hitBizIds) {
    const marker = markerMap.get(bizId);
    if (!marker) continue; // 未命中标记 = 首次命中
    const lastRun = marker.last_hit_run;
    if (lastRun === null || lastRun === undefined || lastRun === '') continue; // 空 = 首次命中
    if (String(lastRun) === runKey) continue; // 同批，不误报
    out.push({ bizId, lastHitAt: marker.last_hit_at });
  }
  return out;
}

// —— 回填动作（§5.1.3）：1 条命中 refund order + 配对银行行 → 1 行回填模板（固定 6 列 + 银行 12 字段 + 中台 15 字段）——
//   hitType：O1 命中类型（精准/模糊命中），= 命中所在策略层属性，经 consumeAndBackfill 透传（写「命中类型」列）。
//   bridgeDepositBizId：OPEN-7（T5b-1）该回填行来源的桥接入金表 BizId（matchJpmUs 命中时非空，其他策略层为 undefined）。
//     产物挂内部字段 `_bridgeDepositBizId`（下划线前缀；T5b-2 据此精确定位该回填行注入跨期命中提醒；不进对外回填模板列）。
//   🔴 hitType 参数位置在 bridgeDepositBizId 之前（O1 新增；不破坏 OPEN-7 测试对 `_bridgeDepositBizId` 的断言）。
//   matchedColumns（v3.0.10 需求3.1）：该命中实际参与比对的候选列（matcher 诚实记录，可含 ∉ sheet1 字段）；
//     本函数单点收口过滤为「∈ REFUND_TEMPLATE_HEADERS」交集，非空才挂内部字段 `_matchedColumns`（仿 _bridgeDepositBizId 非空才挂），供 writer 标黄。
function buildBackfillRow(refundRow, bankRow, detailText, hitType, bridgeDepositBizId, matchedColumns) {
  const row = {
    '退款单号': normalizeCellValue(refundRow[M.backfill.fromRoSerialNo]),
    '状态': M.backfill.statusSuccess,
    '渠道流水号': normalizeCellValue(bankRow[M.backfill.fromBankReconId]),
    '渠道退款时间': bankRow[M.backfill.fromBankBillDate],
    '命中类型': hitType, // O1：精准命中 / 模糊命中
    '匹配命中详情': detailText
  };
  // 银行段：配对银行行 12 字段原数据（按 REFUND_BANK_COLUMNS 顺序；保留原始值不 normalize，与导出口径一致）
  for (const col of REFUND_BANK_COLUMNS) {
    row[col] = bankRow[col];
  }
  // O4 中台段：配对 refund order 15 字段原数据（按 REFUND_RO_COLUMNS 顺序；保留原始值不 normalize）。
  //   '流水号' 与表头 A「退款单号」同值但分列（用户明确要求，照做）。
  for (const col of REFUND_RO_COLUMNS) {
    row[col] = refundRow[col];
  }
  // OPEN-7 内部字段（仅非空时挂，避免给非桥接回填行塞 undefined 列）。
  if (bridgeDepositBizId !== undefined && bridgeDepositBizId !== null && bridgeDepositBizId !== '') {
    row._bridgeDepositBizId = bridgeDepositBizId;
  }
  // v3.0.10 需求3.1：交集标黄——单点收口过滤候选比对列为「∈ sheet1 列」交集 + 去重；零交集不挂（仿 _bridgeDepositBizId 非空才挂）。
  //   过滤口径单一真相在此（matcher 端只管诚实记候选列，避免各 matcher 各自过滤易漏）；用数组（JSON 友好 + 浅拷贝保引用 + deepEqual 直观）。
  //   去重：个别策略候选列含同名不同来源列（如 TwoHop 银行/入金侧均叫 'CustomerRef'）→ 投影同一 sheet1 列，去重避免重复标记。
  if (Array.isArray(matchedColumns)) {
    const inSheet1 = [...new Set(matchedColumns.filter((c) => REFUND_TEMPLATE_HEADERS.includes(c)))];
    if (inSheet1.length > 0) row._matchedColumns = inSheet1;
  }
  return row;
}

// —— sheet2 行：未匹配的银行行 12 字段 + 信息列（v3.0.10 需求3.2：sheet2 删「结果类型」列后靠「报错/提示信息」前缀区分）——
//   🔴 保留 row 上 '结果类型' key（仅不进 sheet2 投影，UNMATCHED_HEADERS 已无该列），以兼容引擎内部/核兼容测试的 filter(x=>x['结果类型']===...)。
//   报错/提示前缀单点加在此：8 个 push 点里走本函数的 bank 形状行全部自动带前缀。
function buildUnmatchedBankRow(bankRow, resultType, info) {
  const row = { '结果类型': resultType };
  for (const col of REFUND_BANK_COLUMNS) {
    row[col] = bankRow[col];
  }
  row['报错/提示信息'] = (resultType === RESULT_ERROR ? '【报错】' : '【提示】') + info;
  return row;
}

// ============================================================================
// 策略匹配器
//   入参：一条 bank 行 + 候选 refund order 行集合（同唯一值分组、未消费）
//   出参：{ refundRow, detail } 命中数组（命中到的 refund order 及其命中详情）
//   命中详情在匹配器内生成（含命中字段/值），由调度层据数量收敛结果类型。
// ============================================================================

// S1：refund「银行打款流水号」↔ bank ChannelOrderNo 或 CustomerRef
//   对每条候选 refund，其「银行打款流水号」与 bank 任一被查字段等值 → 命中
function matchS1(bankRow, refundCands) {
  const hits = [];
  for (const ro of refundCands) {
    const payNo = normalizeCellValue(ro[M.s1.roKey]);
    if (payNo === '') continue;
    for (const bankField of M.s1.bankFields) {
      const bankVal = normalizeCellValue(bankRow[bankField]);
      if (bankVal !== '' && bankVal === payNo) {
        // v3.0.10 需求3.1：候选比对列 = 命中的银行字段（ChannelOrderNo/CustomerRef，均∈sheet1）+ ro 银行打款流水号（∈sheet1）。
        hits.push({ refundRow: ro, detail: detailBankToRo(bankField, bankVal, M.s1.roKey, payNo), _matchedColumns: [bankField, M.s1.roKey] });
        break; // 同一 refund 命中一个被查字段即可，不重复记
      }
    }
  }
  return hits;
}

// S2 常规：bank Extra Information 提 MTX → refund「附言」.includes(mtx)（✅Q6 包含匹配）
function matchS2Mtx(bankRow, refundCands) {
  const mtxList = extractFeature(bankRow[M.s2.bankExtract], MTX_RE);
  if (mtxList.length === 0) return [];
  const hits = [];
  for (const ro of refundCands) {
    const memo = normalizeCellValue(ro[M.s2.roField]);
    if (memo === '') continue;
    const hitMtx = mtxList.find((mtx) => memo.includes(mtx));
    if (hitMtx) {
      // v3.0.10 需求3.1：候选 = bank Extra Information + ro 附言；退款回填输出细化后 Extra Information 已入 sheet1 → 两列均标黄。
      hits.push({ refundRow: ro, detail: detailBankToRo(M.s2.bankExtract, hitMtx, M.s2.roField, memo), _matchedColumns: [M.s2.bankExtract, M.s2.roField] });
    }
  }
  return hits;
}

// R3 共享二跳：refund「银行打款流水号」=payNo → 入金表行(ReconId OR ChannelOrderNo == payNo) → 取 dep.CustomerRef
//   → 与 bank.CustomerRef 严格等值（✅Q8）。US 与 HK 回落复用同一套（D8 中性命名）。
//   命中详情用 detailBankToDeposit（两句式·入金表版）；OPEN-7：hit 附被命中入金表行的 BizId（_depositBizId 内部字段）。
//   ⚠️ 资金红线：收口仍是「dep 行 ↔ ro 打款流水号等值 ∧ dep.CustomerRef ↔ bank.CustomerRef 等值」，无放松。
//   depIndex（commit ⑦ 注入）：若传 depIndex 则 O(1) Map 查双键并集；否则回落 depositRows 线性扫（行为一致）。
function matchCustomerRefTwoHop(bankRow, refundCands, depositRows, depIndex) {
  const bankRef = normalizeCellValue(bankRow[M.jpm.bankCompare]);
  if (bankRef === '') return [];
  const deps = Array.isArray(depositRows) ? depositRows : [];
  const hits = [];
  for (const ro of refundCands) {
    const payNo = normalizeCellValue(ro[M.jpm.usRoKey]);
    if (payNo === '') continue;
    const dep = lookupDepositByKeys(payNo, deps, depIndex);
    if (!dep) continue;
    const depRef = normalizeCellValue(dep[M.jpm.depositTake]);
    if (depRef !== '' && depRef === bankRef) {
      hits.push({
        refundRow: ro,
        detail: detailBankToDeposit(M.jpm.bankCompare, bankRef, M.jpm.depositTake, depRef),
        // v3.0.10 需求3.1：候选 = bank CustomerRef（∈sheet1）+ 入金侧取值列（同名 CustomerRef，但属入金表★，收口去重后仅标 sheet1 的 CustomerRef）。
        _matchedColumns: [M.jpm.bankCompare, M.jpm.depositTake],
        // OPEN-7（T5b-1）：归一 = String().trim()（与仓储 normalizeKey 字节一致；引擎纯函数不 require 仓储）。
        _depositBizId: normalizeBizIdKey(dep.BizId)
      });
    }
  }
  return hits;
}

// F-PERF：入金表双 Map 索引（一次性构建，4 条二跳路径复用；入金表可达 65 万行，O(n) find → O(1) 查）。
//   byReconId/byChannelOrderNo：normalizeCellValue(dep[key]) → dep[]（同键多值，保留插入序，与线性 find「首条命中」对齐）。
//   空键（归一后 ''）不入索引（线性 find 也要求 dv !== ''）→ 行为字节级一致。
//   🔴 Fix#1（codex 资金红线）：额外记录每个 dep 的全局行序 ordOf（= deps 中的下标），供 lookupDepositByKeys
//     按「入金行顺序首条命中」收敛——交叉键冲突（dep[i].ChannelOrderNo == dep[j].ReconciliationId == payNo）时
//     索引版若「键优先」会取 dep[j]、线性版「行优先」取 dep[i]，两者取不同入金行 CustomerRef → 误命中。
//     用 ordOf 让索引版与线性版严格一致（行序最小者）。byReconId/byChannelOrderNo 的 value 仍存 dep 对象数组
//     （不改 value 结构 → 既有 F-PERF 单测对 .get(k)[0].BizId 的断言零破坏；ord 单独挂 ordOf Map）。
function buildDepIndex(deps) {
  const byReconId = new Map();
  const byChannelOrderNo = new Map();
  const ordOf = new Map(); // dep 对象引用 → 全局行序（deps 下标）；Fix#1 行序首条命中用
  const addTo = (map, key, dep) => {
    if (key === '') return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(dep);
  };
  const list = Array.isArray(deps) ? deps : [];
  for (let i = 0; i < list.length; i++) {
    const dep = list[i];
    if (!ordOf.has(dep)) ordOf.set(dep, i); // 同一 dep 两键命中时 ord 相同，天然去重
    addTo(byReconId, normalizeCellValue(dep.ReconciliationId), dep);
    addTo(byChannelOrderNo, normalizeCellValue(dep.ChannelOrderNo), dep);
  }
  return { byReconId, byChannelOrderNo, ordOf };
}

// 入金行双键 OR 查找（ReconId / ChannelOrderNo == payNo）。
//   depIndex 存在 → byReconId/byChannelOrderNo 两 Map 候选并集中「全局行序最小者」（Fix#1：与线性版 deps.find 行优先一致）；
//   否则 depositRows 线性扫（结果一致）。
//   🔴 Fix#1：旧实现「先查 byReconId 命中即返回、再查 byChannelOrderNo」是键优先，交叉键冲突时与线性版（行优先）
//     取不同入金行 → 取不同 CustomerRef → 误命中。改为合并两键候选、按 ordOf 取 ord 最小者的 dep，与线性 find 严格一致。
function lookupDepositByKeys(payNo, deps, depIndex) {
  if (depIndex && depIndex.byReconId && depIndex.byChannelOrderNo) {
    const ordOf = depIndex.ordOf;
    const byRecon = depIndex.byReconId.get(payNo) || [];
    const byCh = depIndex.byChannelOrderNo.get(payNo) || [];
    let best = null;
    let bestOrd = Infinity;
    for (const dep of byRecon) {
      const ord = ordOf && ordOf.has(dep) ? ordOf.get(dep) : Infinity;
      if (ord < bestOrd) { bestOrd = ord; best = dep; }
    }
    for (const dep of byCh) {
      const ord = ordOf && ordOf.has(dep) ? ordOf.get(dep) : Infinity;
      if (ord < bestOrd) { bestOrd = ord; best = dep; }
    }
    return best;
  }
  return deps.find((d) =>
    M.jpm.depositKeys.some((k) => {
      const dv = normalizeCellValue(d[k]);
      return dv !== '' && dv === payNo;
    })) || null;
}

// S2 JPM-HK：清洗 // → 提 T54[A-Z]{4}（R1 放宽）→ 与 refund「银行打款流水号」单字段等值（✅Q7）；
//   未提到 / 未等值 → R3 回落 CustomerRef 二跳（同层内，仍属 L2）。
function matchJpmHk(bankRow, refundCands, depositRows, depIndex) {
  const clean = (v) => normalizeCellValue(v).split('//').join('');
  const swicList = [];
  for (const field of M.jpm.hkCleanFields) {
    for (const swic of extractFeature(clean(bankRow[field]), T54_RE)) {
      if (!swicList.includes(swic)) swicList.push(swic);
    }
  }
  if (swicList.length > 0) {
    const hits = [];
    for (const ro of refundCands) {
      const payNo = normalizeCellValue(ro[M.jpm.hkRoKey]);
      if (payNo === '') continue;
      const hitSwic = swicList.find((swic) => swic === payNo);
      if (hitSwic) {
        // 命中详情：银行 Extra Information/Payment Detail 提取值 ↔ refund order 银行打款流水号
        // v3.0.10 需求3.1：候选 = bank 附言来源字段（Extra Information / Payment Detail）+ ro 银行打款流水号；
        //   提取源可能来自任一附言字段，诚实列出全部候选。退款回填输出细化后 Extra Information/Payment Detail 均∈sheet1 → 三列全标黄。
        hits.push({
          refundRow: ro,
          detail: detailBankToRo(M.jpm.hkCleanFields.join('/'), hitSwic, M.jpm.hkRoKey, payNo),
          _matchedColumns: [...M.jpm.hkCleanFields, M.jpm.hkRoKey]
        });
      }
    }
    if (hits.length > 0) return hits;
    // T54 提到但无等值 → 继续 R3 二跳回落（不直接返回空）。
  }
  // R3：HK 分支 T54 未中 → CustomerRef 二跳回落（复用 US 二跳逻辑）。
  return matchCustomerRefTwoHop(bankRow, refundCands, depositRows, depIndex);
}

// S2 JPM-US：CustomerRef 二跳（薄壳，复用 matchCustomerRefTwoHop）。
function matchJpmUs(bankRow, refundCands, depositRows, depIndex) {
  return matchCustomerRefTwoHop(bankRow, refundCands, depositRows, depIndex);
}

// S2 综合：Channel=JPM 时先跑 JPM 链（HK/US 按地区，含 R3 二跳回落），未命中回落常规 MTX；非 JPM 直接常规 MTX
function matchS2(bankRow, refundCands, depositRows, depIndex) {
  const isJpm = normalizeCellValue(bankRow.Channel) === M.jpm.channelValue;
  if (isJpm) {
    const region = normalizeCellValue(bankRow[M.jpm.regionField]);
    let jpmHits = [];
    if (region === M.jpm.hkRegion) {
      jpmHits = matchJpmHk(bankRow, refundCands, depositRows, depIndex);
    } else if (region === M.jpm.usRegion) {
      jpmHits = matchJpmUs(bankRow, refundCands, depositRows, depIndex);
    }
    if (jpmHits.length > 0) return jpmHits;
    // JPM 链未命中 → 回落常规 MTX 包含匹配
  }
  return matchS2Mtx(bankRow, refundCands);
}

// S2b（R2 新层）：附言包含入金 CustomerRef。限 Channel=JPM；插在 S2（等值层）之后、S3 之前（L3）。
//   逻辑：对每条候选 ro，payNo → 入金行（双键 OR）→ dep.CustomerRef → 守卫（非空 + 不在黑名单 + 长度≥阈值）
//         → bank 附言字段（memoFields）任一 .includes(ref) → 命中（精准）；详情用 detailBankToDeposit。
//   🔴 设计依据（§8 决策 1）：必须独立成层、放在等值层之后 —— 若并入 matchJpmUs 内部回落，
//      等值命中与包含命中进同一冻结命中图会触发同层反向多笔，把 165 行等值主流拖进报错。
//   🔴 守卫为必选（占位短串会大面积假命中）；读银行主表附言（44 列恒有，不踩入金行 Payment Detail 存量缺字段坑）。
//   OPEN-7：命中桥接入金表行 → hit 附 _depositBizId（接 OPEN-7b）。
// Fix#2（codex 复审）：正则元字符转义（depRef 来自数据，构造边界正则前必须转义，防注入/误判）。
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Fix#2：占位符黑名单归一（去空格/连字符 + 大写）——拦 'NOT PROVIDED' / 'NON-REF' 等变体。
function normalizeForBlacklist(s) {
  return String(s).toUpperCase().replace(/[\s\-]/g, '');
}
function matchMemoContainsDepositRef(bankRow, refundCands, depositRows, depIndex) {
  if (normalizeCellValue(bankRow.Channel) !== M.jpm.channelValue) return []; // D7：限 Channel=JPM
  const cfg = M.s2b;
  // 预取 bank 附言字段值（非空者）。
  const memos = [];
  for (const field of cfg.memoFields) {
    const v = normalizeCellValue(bankRow[field]);
    if (v !== '') memos.push(v);
  }
  if (memos.length === 0) return [];
  const deps = Array.isArray(depositRows) ? depositRows : [];
  const blacklist = new Set((cfg.blacklist || []).map(normalizeForBlacklist)); // Fix#2：黑名单去空格/连字符归一
  const hits = [];
  for (const ro of refundCands) {
    const payNo = normalizeCellValue(ro[M.jpm.usRoKey]);
    if (payNo === '') continue;
    const dep = lookupDepositByKeys(payNo, deps, depIndex);
    if (!dep) continue;
    const depRef = normalizeCellValue(dep[M.jpm.depositTake]);
    // 守卫：非空 + 不在黑名单（去空格/连字符归一比对）+ 长度≥阈值。
    if (depRef === '') continue;
    if (blacklist.has(normalizeForBlacklist(depRef))) continue;
    if (depRef.length < cfg.minRefLength) continue;
    // Fix#2：token 边界匹配（非字母数字边界），防短 ref 作为更长无关串子串误命中（ABC123 ≠ XABC1234Y）。
    const refRe = new RegExp('(^|[^A-Za-z0-9])' + escapeRegExp(depRef) + '([^A-Za-z0-9]|$)');
    const hitMemoField = cfg.memoFields.find((field) => {
      const v = normalizeCellValue(bankRow[field]);
      return v !== '' && refRe.test(v);
    });
    if (hitMemoField) {
      // v3.0.10 需求3.1：候选 = 命中的 bank 附言字段（Payment Detail / Extra Information）；退款回填输出细化后两者均∈sheet1 → 命中哪个标哪个。
      //   ⚠️ 比对基准是「bank 附言 .includes(入金 CustomerRef)」——入金 CustomerRef 属入金表★、且本回填行的 CustomerRef 列取自银行行（未参与本次比对），
      //     其列名又与银行段 'CustomerRef' 同名（会被 includes 误留并错标本行 CustomerRef 列），故不列入候选（区别于 TwoHop：那里 bank.CustomerRef 本身就是比对基准）。
      hits.push({
        refundRow: ro,
        detail: detailBankToDeposit(hitMemoField, depRef, M.jpm.depositTake, depRef),
        _matchedColumns: [hitMemoField],
        _depositBizId: normalizeBizIdKey(dep.BizId)
      });
    }
  }
  return hits;
}

// S3：按位（付款人名称↔Drawee Name / 付款卡号↔Drawee CardNo / 虚拟卡号↔Payee CardNo），✅Q8b
//   对每条候选 refund，其三 ID 之一与 bank 对应位字段等值 → 命中
function matchS3(bankRow, refundCands) {
  const hits = [];
  for (const ro of refundCands) {
    for (const pair of M.s3) {
      const roVal = normalizeCellValue(ro[pair.roKey]);
      if (roVal === '') continue;
      const bankVal = normalizeCellValue(bankRow[pair.bankField]);
      if (bankVal !== '' && bankVal === roVal) {
        // v3.0.10 需求3.1：候选 = bank 付款人/卡号字段（Drawee Name/Drawee CardNo/Payee CardNo）+ 命中位 ro 列（付款人名称/付款卡号/虚拟卡号，∈sheet1，实际标黄）。
        //   退款回填输出细化后 Drawee Name 已入 sheet1 → 命中付款人名称位时 Drawee Name + 付款人名称两列均标黄；Drawee CardNo/Payee CardNo 仍∉sheet1（过滤后只剩 ro 列）。
        hits.push({ refundRow: ro, detail: detailBankToRo(pair.bankField, bankVal, pair.roKey, roVal), _matchedColumns: [pair.bankField, pair.roKey] });
        break; // 同一 refund 按位命中一项即可
      }
    }
  }
  return hits;
}

// 从 bank 多个附言字段里按 pattern 提第一个捕获组（capture group 1）；无 → null。
//   pattern 非 global（带捕获组），每次 new RegExp(source) 重建避免 lastIndex 副作用。
function extractFirstCapture(bankRow, memoFields, pattern) {
  if (!pattern) return null;
  for (const field of memoFields) {
    const s = normalizeCellValue(bankRow[field]);
    if (!s) continue;
    const m = s.match(new RegExp(pattern.source, pattern.flags.replace('g', '')));
    if (m && m[1]) return m[1];
  }
  return null;
}

// 6 位 YYMMDD → 'YYYY-MM-DD'（世纪固定 20YY，D1）；非 6 位数字 → null。
function yymmddToDateStr(token) {
  if (!/^\d{6}$/.test(token)) return null;
  return `20${token.slice(0, 2)}-${token.slice(2, 4)}-${token.slice(4, 6)}`;
}

// S3b（R5 新层，L5 精准）：Drawee Name 非空 ∧ 附言 DESC DATE token（YYMMDD）↔ 入金 ValueDate sameDay 二跳（D1/D2/D3）。
//   硬锚点：payNo 二跳等值（lookupDepositByKeys）+ DESC DATE ↔ dep.ValueDate 等日双重收口（精准）。
//   no-op 防御：datePattern 为 null → 整层跳过。OPEN-7：命中桥接入金行 → hit 附 _depositBizId。
function matchDraweeNameDate(bankRow, refundCands, depositRows, depIndex) {
  const cfg = M.s3b;
  if (!cfg || !cfg.datePattern) return []; // no-op 防御
  // D2：Drawee Name 仅作启用条件（非空才进 S3b）。
  if (normalizeCellValue(bankRow[cfg.draweeNameField]) === '') return [];
  const token = extractFirstCapture(bankRow, cfg.memoFields, cfg.datePattern);
  if (!token) return [];
  const tokenDateStr = yymmddToDateStr(token);
  if (!tokenDateStr) return [];
  const deps = Array.isArray(depositRows) ? depositRows : [];
  const hits = [];
  for (const ro of refundCands) {
    const payNo = normalizeCellValue(ro[M.jpm.usRoKey]);
    if (payNo === '') continue;
    const dep = lookupDepositByKeys(payNo, deps, depIndex);
    if (!dep) continue;
    if (sameDay(dep[cfg.depositDateField], tokenDateStr)) {
      // v3.0.10 需求3.1：候选 = Drawee Name（门控字段）+ 附言来源字段（Payment Detail/Extra Information，DESC DATE 提取源）+ 入金 ValueDate（★∉sheet1）；
      //   退款回填输出细化后 Drawee Name + 两附言列均∈sheet1 → 标黄；入金 ValueDate 仍∉sheet1（过滤后丢弃）。
      hits.push({
        refundRow: ro,
        detail: detailBankToDeposit(cfg.draweeNameField + '+DESC DATE', tokenDateStr, cfg.depositDateField, normalizeCellValue(dep[cfg.depositDateField])),
        _matchedColumns: [cfg.draweeNameField, ...cfg.memoFields, cfg.depositDateField],
        _depositBizId: normalizeBizIdKey(dep.BizId)
      });
    }
  }
  return hits;
}

// R6（Fix#4 codex 复审）：DTD token 按真实样例的美式 mm/dd/yyyy（MDY）明确解析为 ISO YYYY-MM-DD，消除通用 auto 的 M/D 歧义。
//   依据：真实原件 DTD05/21/2026（21 只能为「日」→ 月在前 = MDY）+ JPM US 美式日期惯例；故 DTD05/06/2026 → 2026-05-06。
//   ⚠️ 资金红线：日期格式判定错误 = 系统性误配，本判定基于现有样例 + codex「美式格式」，建议用户用真实退款单最终确认。
//   非法（mm∉[1,12] / dd∉[1,31] / 格式不符）→ null（该层整体不命中，宁漏勿误配）。
function parseDtdDateToken(token) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(normalizeCellValue(token));
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  if (!(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return null;
  return `${m[3]}-${m[1]}-${m[2]}`; // MDY（美式 mm/dd/yyyy）→ ISO YYYY-MM-DD（sameDay 解析 ISO 无歧义）
}

// S3c（R6 新层，L6 模糊）：附言 原单日期(DTD)+金额(FOR)+币种 三 token ↔ 入金表二跳（D4/D3/D5）。
//   收口：payNo 二跳 → 入金行日期 sameDay(DTD) ∧ 入金行金额(分比对)==FOR ∧ dep.Currency==币种（模糊）。
//   no-op 防御：datePattern/amountPattern 任一为 null → 整层跳过。金额分比对（Math.round(amt*100)）。
function matchMemoDateAmount(bankRow, refundCands, depositRows, depIndex) {
  const cfg = M.s3c;
  if (!cfg || !cfg.datePattern || !cfg.amountPattern) return []; // no-op 防御
  const dtdToken = extractFirstCapture(bankRow, cfg.memoFields, cfg.datePattern);
  const amtToken = extractFirstCapture(bankRow, cfg.memoFields, cfg.amountPattern);
  if (!dtdToken || !amtToken) return [];
  const dtdIso = parseDtdDateToken(dtdToken); // Fix#4：DTD 按 DMY 明确解析为 ISO；非法 → 整层不命中
  if (!dtdIso) return [];
  const amtCents = (() => {
    const n = parseNumber(String(amtToken).replace(/,/g, '')); // Fix#3：去千分位逗号再解析（FOR USD5,043.00 → 5043.00）
    return n === null || !Number.isFinite(n) ? null : Math.round(n * 100);
  })();
  if (amtCents === null) return [];
  const deps = Array.isArray(depositRows) ? depositRows : [];
  const hits = [];
  for (const ro of refundCands) {
    const payNo = normalizeCellValue(ro[M.jpm.usRoKey]);
    if (payNo === '') continue;
    const dep = lookupDepositByKeys(payNo, deps, depIndex);
    if (!dep) continue;
    // 三重收口：日期 sameDay（Fix#4：用 DMY 明确解析的 ISO，消歧义）∧ 金额分相等 ∧ 币种相等。
    if (!sameDay(dep[cfg.depositDateField], dtdIso)) continue;
    const depAmt = parseNumber(dep[cfg.depositAmountField]);
    if (depAmt === null || !Number.isFinite(depAmt) || Math.round(depAmt * 100) !== amtCents) continue;
    if (normalizeCellValue(dep[cfg.depositCurrencyField]) !== cfg.currency) continue;
    hits.push({
      refundRow: ro,
      detail: detailBankToDeposit('DTD+FOR', `${dtdToken}/${amtToken}/${cfg.currency}`, cfg.depositDateField, normalizeCellValue(dep[cfg.depositDateField])),
      // v3.0.10 需求3.1：候选 = bank 附言来源字段（DTD+FOR 提取源；Payment Detail/Extra Information）；退款回填输出细化后两者均∈sheet1 → 全标黄。
      //   ⚠️ 入金侧比对列（ValueDate/Credit Amount/Currency）属入金表★、且非本回填行的列——其中 'Currency' 与银行段同名，
      //     若列入候选会被 includes 误留并错标本行 Currency 列（本行 Currency 取自银行/ro，非比对基准），故不列入。
      _matchedColumns: [...cfg.memoFields],
      _depositBizId: normalizeBizIdKey(dep.BizId)
    });
  }
  return hits;
}

// S4：bank BillDate vs refund valueDate（R4：单向容差 0 ≤ bank.BillDate − ro.valueDate ≤ toleranceDays）。
//   命中 = 该 bank 行在候选 refund 里找到「窗内（diff∈[0,21]）」最近的一条（按 diff 升序；窗外不算命中）。
//   返回 { refundRow, detail, dayDiff } 数组（窗内全部候选，按天数差升序；空=无任何窗内候选）。
//   ⚠️ R4 方向收紧：bank.BillDate 早于 ro.valueDate（diff<0）= 时序矛盾，不算命中（旧 ±abs 会误命中）。
function matchS4(bankRow, refundCands) {
  const hits = [];
  for (const ro of refundCands) {
    const diff = signedDayDiff(bankRow[M.s4.bankDate], ro[M.s4.roDate]);
    if (diff !== null && diff >= 0 && diff <= M.s4.toleranceDays) {
      hits.push({
        refundRow: ro,
        dayDiff: diff,
        detail: S4_DETAIL_TEXT, // O2：S4 命中详情固定文案（底层比对仍 ro.valueDate）
        // v3.0.10：S4 命中详情固定文案为「命中唯一值:退款提交日期+大账号+金额+币种」→ 标黄按文案口径展开为 8 列
        //   （bank 侧 4 列 + ro 侧 4 列，全 ∈ sheet1；buildBackfillRow 交集过滤全保留）：
        //   bank：BillDate（退款提交日期/S4 日期比对列）+ MerchantId（大账号）+ Debit Amount（金额）+ Currency（币种）；
        //   ro  ：valueDate（S4 实际日期比对列，文案口径「退款提交日期」）+ 银行大账号 + 退款金额 + 币种。
        //   ⚠️ 资金红线说明：S4「金额」实际匹配口径是 |Credit Amount − Debit Amount| 绝对值（见 bankAmountAbs / 唯一值分组），
        //     非单看 Debit Amount 列；此处 Debit Amount 仅作 sheet1 银行金额展示列标黄（sheet1 银行段只放 Debit Amount，无 Credit Amount）。
        //   全部用 REFUND_BACKFILL_FIELD_MAP 常量，不硬编码中文列名；'Debit Amount' 为 sheet1 银行金额列字面（同 REFUND_BANK_COLUMNS）。
        _matchedColumns: [
          M.s4.bankDate, M.uniqueKey.bankAccount, 'Debit Amount', M.uniqueKey.bankCurrency,
          M.s4.roDate, M.uniqueKey.roAccount, M.uniqueKey.roAmount, M.uniqueKey.roCurrency
        ]
      });
    }
  }
  hits.sort((a, b) => a.dayDiff - b.dayDiff);
  return hits;
}

function fuzzyLookupKey(account, currency, paymentSerial) {
  return JSON.stringify([account, currency, paymentSerial]);
}

function calculateBankPaymentSerialAmountDifference(bankRow, refundRow) {
  const credit = canonicalizeDecimal(bankRow && bankRow['Credit Amount'], {
    emptyAsZero: true,
    label: '银行对账单Credit Amount'
  });
  const debit = canonicalizeDecimal(bankRow && bankRow['Debit Amount'], {
    emptyAsZero: true,
    label: '银行对账单Debit Amount'
  });
  const bankAmount = absoluteDecimal(subtractCanonicalDecimals(credit, debit, {
    leftLabel: '银行对账单Credit Amount',
    rightLabel: '银行对账单Debit Amount',
    label: '银行发生额'
  }));
  const refundAmount = canonicalizeDecimal(refundRow && refundRow[M.uniqueKey.roAmount], {
    label: `退款订单${M.uniqueKey.roAmount}`
  });
  return absoluteDecimal(subtractCanonicalDecimals(bankAmount, refundAmount, {
    leftLabel: '银行发生额绝对值',
    rightLabel: `退款订单${M.uniqueKey.roAmount}`,
    label: '模糊匹配金额差额'
  }));
}

function matchBankPaymentSerialFuzzy(bankRow, refundRow) {
  const bankAccount = normalizeCellValue(bankRow && bankRow[M.uniqueKey.bankAccount]);
  const refundAccount = normalizeCellValue(refundRow && refundRow[M.uniqueKey.roAccount]);
  if (bankAccount !== refundAccount) return null;

  const bankCurrency = normalizeCellValue(bankRow && bankRow[M.uniqueKey.bankCurrency]);
  const refundCurrency = normalizeCellValue(refundRow && refundRow[M.uniqueKey.roCurrency]);
  if (bankCurrency !== refundCurrency) return null;

  const paymentSerial = normalizeCellValue(refundRow && refundRow[M.s1.roKey]);
  if (paymentSerial === '') return null;
  const matchedBankSerialFields = M.s1.bankFields.filter((field) => (
    normalizeCellValue(bankRow && bankRow[field]) === paymentSerial
  ));
  if (matchedBankSerialFields.length === 0) return null;

  const amountDifference = calculateBankPaymentSerialAmountDifference(bankRow, refundRow);
  if (compareCanonicalDecimals(amountDifference, BANK_PAYMENT_SERIAL_FUZZY_AMOUNT_LIMIT) >= 0) {
    return null;
  }

  return {
    refundRow,
    amountDifference,
    detail: `${BANK_PAYMENT_SERIAL_FUZZY_DETAIL_PREFIX}${amountDifference}`,
    _matchedColumns: [
      ...matchedBankSerialFields,
      M.s1.roKey,
      'Credit Amount',
      'Debit Amount',
      M.uniqueKey.roAmount,
      M.uniqueKey.bankAccount,
      M.uniqueKey.roAccount,
      M.uniqueKey.bankCurrency,
      M.uniqueKey.roCurrency
    ]
  };
}

function replaceUnmatchedOutcome(outputRow, resultType, info) {
  outputRow['结果类型'] = resultType;
  outputRow['报错/提示信息'] = (resultType === RESULT_ERROR ? '【报错】' : '【提示】') + info;
}

function runBankPaymentSerialFuzzyFallback(options) {
  const {
    ordinaryUnmatchedEntries,
    refundPool,
    usedRefundIdx,
    blockedRefundIds,
    refundIdOf,
    usedBankRowId,
    backfillRows,
    unmatchedRows,
    warn,
    hitDepositBizIdSet
  } = options;
  if (!Array.isArray(ordinaryUnmatchedEntries) || ordinaryUnmatchedEntries.length === 0) return;

  const availableRefunds = refundPool.filter((refundRow) => {
    const refundId = refundIdOf(refundRow);
    return !usedRefundIdx.has(refundId) && !(blockedRefundIds && blockedRefundIds.has(refundId));
  });
  if (availableRefunds.length === 0) return;

  const refundsByLookupKey = new Map();
  for (const refundRow of availableRefunds) {
    const paymentSerial = normalizeCellValue(refundRow[M.s1.roKey]);
    if (paymentSerial === '') continue;
    const key = fuzzyLookupKey(
      normalizeCellValue(refundRow[M.uniqueKey.roAccount]),
      normalizeCellValue(refundRow[M.uniqueKey.roCurrency]),
      paymentSerial
    );
    if (!refundsByLookupKey.has(key)) refundsByLookupKey.set(key, []);
    refundsByLookupKey.get(key).push(refundRow);
  }

  const hitsByEntry = new Map();
  const errorsByEntry = new Map();
  const entriesByRefundId = new Map();
  for (const entry of ordinaryUnmatchedEntries) {
    const bankRow = entry.bankRow;
    const account = normalizeCellValue(bankRow[M.uniqueKey.bankAccount]);
    const currency = normalizeCellValue(bankRow[M.uniqueKey.bankCurrency]);
    const relevantRefunds = new Map();
    for (const bankField of M.s1.bankFields) {
      const serial = normalizeCellValue(bankRow[bankField]);
      if (serial === '') continue;
      const candidates = refundsByLookupKey.get(fuzzyLookupKey(account, currency, serial)) || [];
      for (const refundRow of candidates) relevantRefunds.set(refundIdOf(refundRow), refundRow);
    }

    const hits = [];
    const errors = [];
    for (const refundRow of relevantRefunds.values()) {
      try {
        const hit = matchBankPaymentSerialFuzzy(bankRow, refundRow);
        if (!hit) continue;
        hits.push(hit);
        const refundId = refundIdOf(refundRow);
        if (!entriesByRefundId.has(refundId)) entriesByRefundId.set(refundId, new Set());
        entriesByRefundId.get(refundId).add(entry);
      } catch (error) {
        errors.push(error);
        // 金额非法时，账号/币种/流水号三锚点已把该银行行与退款单建立为未决关系。
        // 将其纳入反向关系图，避免另一条金额正常的银行行静默抢走同一退款单。
        const refundId = refundIdOf(refundRow);
        if (!entriesByRefundId.has(refundId)) entriesByRefundId.set(refundId, new Set());
        entriesByRefundId.get(refundId).add(entry);
      }
    }
    hitsByEntry.set(entry, hits);
    errorsByEntry.set(entry, errors);
  }

  const resolvedOutputRows = new Set();
  for (const entry of ordinaryUnmatchedEntries) {
    const errors = errorsByEntry.get(entry) || [];
    if (errors.length > 0) {
      const message = `银行打款流水号模糊匹配金额非法：${errors[0].message || errors[0]}`;
      replaceUnmatchedOutcome(entry.outputRow, RESULT_ERROR, message);
      warn.push({
        rowId: entry.bankRow._rowId,
        code: 'refund-backfill-payment-serial-fuzzy-invalid-amount',
        message
      });
      continue;
    }

    const hits = hitsByEntry.get(entry) || [];
    if (hits.length === 0) continue;
    if (hits.length > 1) {
      const message = `银行打款流水号模糊匹配关联到 ${hits.length} 条退款订单，无法满足严格1:1，请人工介入`;
      replaceUnmatchedOutcome(entry.outputRow, RESULT_ERROR, message);
      warn.push({
        rowId: entry.bankRow._rowId,
        code: 'refund-backfill-payment-serial-fuzzy-multi-match',
        message
      });
      continue;
    }

    const refundId = refundIdOf(hits[0].refundRow);
    const reverseEntries = entriesByRefundId.get(refundId) || new Set();
    if (reverseEntries.size > 1) {
      const message = '银行打款流水号模糊匹配与其他银行行同时关联到同一退款订单，无法满足严格1:1，请人工介入';
      replaceUnmatchedOutcome(entry.outputRow, RESULT_ERROR, message);
      warn.push({
        rowId: entry.bankRow._rowId,
        code: 'refund-backfill-payment-serial-fuzzy-reverse-multi-match',
        message
      });
      continue;
    }

    consumeAndBackfill(entry.bankRow, hits[0], HIT_TYPE_FUZZY, {
      usedBankRowId,
      usedRefundIdx,
      refundIdOf,
      backfillRows,
      hitDepositBizIdSet
    });
    resolvedOutputRows.add(entry.outputRow);
  }

  if (resolvedOutputRows.size > 0) {
    for (let i = unmatchedRows.length - 1; i >= 0; i -= 1) {
      if (resolvedOutputRows.has(unmatchedRows[i])) unmatchedRows.splice(i, 1);
    }
  }
}

// ============================================================================
// 结果分类（PRD §5.2 16 格 + §5.3 三类输出的统一收敛）
//   对一条 bank 行在某策略下的命中集合 hits（已去消费）：
//     hits.length === 0 → 'continue'（未命中，进下一策略）
//     hits.length === 1 → 'backfill'（唯一确定命中，回填）
//     hits.length  > 1  → 'error-manual'（关联到多笔，报错人工介入，命中即停）
//   注：S1~S3 共用本骨架。idCount/refundHit 的多笔报错都收敛为「hits>1」（一条 bank 对多条 refund 命中）。
//   S4 单独处理（日期容差 + 早→晚 1v1，见 runS4）。
// ============================================================================
function resolveHits(hits) {
  if (hits.length === 0) return 'continue';
  if (hits.length === 1) return 'backfill';
  return 'error-manual';
}

// ============================================================================
// 主算法
// ============================================================================
function runRound5RefundOrderBackfill(bankRows, refundOrderRows, depositRows, options = {}) {
  const warn = makeWarningCollector('r5-refund-order-backfill', '中台退款订单回填');
  const backfillRows = [];
  const unmatchedRows = [];
  // OPEN-7（T5b-1）：本批「以入金表为来源、回填成功」的命中 BizId 集合（仅 matchJpmUs 桥接收集，去重）。
  //   纯函数：只从入参 depositRows 命中收集 BizId，不查库。两条 return 路径均返回去重数组（早退路径 → []）。
  const hitDepositBizIdSet = new Set();

  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];
  const safeRefundRows = Array.isArray(refundOrderRows) ? refundOrderRows : [];
  const safeDepositRows = Array.isArray(depositRows) ? depositRows : [];
  const isFundTypeChanged = typeof options.isFundTypeChanged === 'function'
    ? options.isFundTypeChanged
    : () => false;
  const paymentSerialFuzzyEnabled = options.bankPaymentSerialFuzzyMatchEnabled === true;
  const ordinaryUnmatchedEntries = paymentSerialFuzzyEnabled ? [] : null;
  const blockedRefundIds = paymentSerialFuzzyEnabled ? new Set() : null;
  const pushOrdinaryUnmatched = (bankRow) => {
    const outputRow = buildUnmatchedBankRow(bankRow, RESULT_NOTICE, '未能关联到任何退款订单');
    unmatchedRows.push(outputRow);
    if (ordinaryUnmatchedEntries) ordinaryUnmatchedEntries.push({ bankRow, outputRow });
  };

  // v3.0.10 需求2：网关前置过滤——建网关 reconid 集合（网关侧小写 reconciliationid；空键不入，与下方银行空键对称）。
  //   缺省退化：options.gwRows 未传（旧调用方/测试）→ safeGwRows=[] → 集合空 → 道3 永不命中 → 等同无前置过滤（与现状一致）。
  const safeGwRows = Array.isArray(options.gwRows) ? options.gwRows : [];
  const gwReconidSet = new Set(
    safeGwRows
      .map((g) => normalizeCellValue(g && g[GW_RECON_ID_FIELD]))
      .filter((k) => k !== '')
  );

  // 1) 数据筛选（§5.1.2）
  //   refund：状态 === SUBMITTED
  const refundPool = safeRefundRows.filter(
    (r) => normalizeCellValue(r[M.filter.roStatusField]) === M.filter.roSubmitted
  );
  //   bank：FundType === Ach Return 且未被 R4 改写 FundType；且（v3.0.10 需求2）未命中网关 reconid
  const bankPool = safeBankRows.filter((b) => {
    if (normalizeCellValue(b[M.filter.bankFundType]) !== M.filter.achReturn) return false; // 道1：FundType=Ach Return
    if (isFundTypeChanged(b._rowId)) return false;                                          // 道2：未被 R4 改写 FundType
    // 道3（v3.0.10 需求2）：命中网关 reconid → 静默移出退款池（已能与网关对账，不走退款回填）。
    //   银行侧驼峰 ReconciliationId（= M.backfill.fromBankReconId，复用单一真相，不新增别名）；空键不参与命中判定（与网关空键 filter 对称）。
    const bankRecon = normalizeCellValue(b[M.backfill.fromBankReconId]);
    if (bankRecon !== '' && gwReconidSet.has(bankRecon)) return false;
    return true;
  });

  // 空入参防御：任一侧空 → 无可对账，返回空（不抛）
  if (refundPool.length === 0 || bankPool.length === 0) {
    return { backfillRows, unmatchedRows, modifications: [], warnings: warn.list(), hitDepositBizIds: [] };
  }

  // F-PERF（Fix#6 codex 复审）：入金表双 Map 索引在空批早退之后构建——任一侧空时无需给 65 万入金行建索引。
  const depIndex = buildDepIndex(safeDepositRows);

  // 2) 唯一值分组（✅Q1）：键 = 大账号||币种||金额分（金额 NaN → 不入组）
  const keyOf = (account, currency, amountCents) => `${account}||${currency}||${amountCents}`;
  const bankGroups = groupBy(bankPool, (b) => {
    const amt = bankAmountAbs(b);
    if (!Number.isFinite(amt)) return null;
    return keyOf(
      normalizeCellValue(b[M.uniqueKey.bankAccount]),
      normalizeCellValue(b[M.uniqueKey.bankCurrency]),
      Math.round(amt * 100)
    );
  });
  const refundGroups = groupBy(refundPool, (r) => {
    const amt = parseNumber(r[M.uniqueKey.roAmount]);
    if (amt === null || !Number.isFinite(amt)) return null;
    return keyOf(
      normalizeCellValue(r[M.uniqueKey.roAccount]),
      normalizeCellValue(r[M.uniqueKey.roCurrency]),
      Math.round(amt * 100)
    );
  });

  const usedBankRowId = new Set(); // 严格 1v1（与场景2/3 独立）
  const usedRefundIdx = new Set(); // refund order 只回填一次（用 refundPool 内对象引用标识）

  // refund 行唯一标识：优先 _rowId，否则用对象引用映射
  const refundIdSeq = new WeakMap();
  let refundSeq = 0;
  const refundIdOf = (ro) => {
    if (ro && (ro._rowId !== undefined && ro._rowId !== null)) return `id:${ro._rowId}`;
    if (refundIdSeq.has(ro)) return refundIdSeq.get(ro);
    const id = `ref:${refundSeq++}`;
    refundIdSeq.set(ro, id);
    return id;
  };

  // 3) 对每个唯一值分组：基数分类 → S1→S4 命中即停（✅Q3）
  //   🔴 审计完整性不变量（PR#64 Finding 1）：每条筛后 SUBMITTED refund + 每条筛后 Ach Return（未改写）银行行
  //   都必须落 backfill / error / notice 三者之一，绝不静默消失。
  //   v3.0.10 需求3.2：refund-only（无对应银行行）的 refund 不再产 notice 行（完全静默删除，已确认），
  //     不变量收窄为「银行侧全覆盖」——每条筛后 Ach Return（未改写、未被网关前置过滤）银行行仍必落
  //     backfill / error / notice 之一；SUBMITTED refund 侧不再保证全覆盖（refund-only 静默）。
  for (const [key, bankGroup] of bankGroups) {
    const refundGroup = refundGroups.get(key) || [];

    // bank-only 组：有银行 Ach Return 行但该唯一值下无 SUBMITTED refund
    //   → 每条银行行产「未匹配-提示」（PRD §5.1.5 sheet2 放未匹配上的银行对账单数据），不再静默 continue
    if (refundGroup.length === 0) {
      for (const bankRow of bankGroup) {
        pushOrdinaryUnmatched(bankRow);
      }
      continue;
    }

    const cardinality = classifyCardinality(bankGroup.length, refundGroup.length);

    runStrategiesForGroup({
      cardinality,
      bankGroup,
      refundGroup,
      depositRows: safeDepositRows,
      depIndex, // F-PERF：双 Map 索引（二跳路径复用）
      usedBankRowId,
      usedRefundIdx,
      refundIdOf,
      backfillRows,
      unmatchedRows,
      warn,
      hitDepositBizIdSet, // OPEN-7（T5b-1）：透传命中 BizId 收集集合（consumeAndBackfill 收集桥接 BizId）
      blockedRefundIds,
      pushOrdinaryUnmatched
    });
  }

  // 4) v3.0.10 需求3.2：删除原 refund-only 组收尾循环——某唯一值下有 SUBMITTED refund 但无银行 Ach Return 行时，
  //   不再为这些 refund 产「未匹配-提示」notice 行（完全静默，已确认）。审计不变量收窄为「银行侧全覆盖」（见上方注释）。

  if (paymentSerialFuzzyEnabled) {
    runBankPaymentSerialFuzzyFallback({
      ordinaryUnmatchedEntries,
      refundPool,
      usedRefundIdx,
      blockedRefundIds,
      refundIdOf,
      usedBankRowId,
      backfillRows,
      unmatchedRows,
      warn,
      hitDepositBizIdSet
    });
  }

  // OPEN-7（T5b-1）：去重数组冒泡给 orchestrator → T5b-2 在 export 阶段查标记/注入提醒。
  return {
    backfillRows, unmatchedRows, modifications: [], warnings: warn.list(),
    hitDepositBizIds: [...hitDepositBizIdSet]
  };
}

// 对单个唯一值分组跑 S1→S4。
//   🔴 SPEC §7：S1~S3 改为「按策略批量解析」（去顺序依赖，正反向多笔都收敛正确）；S4 用「冻结快照 + minDayDiff」判据。
//   - 仅「某 bank 唯一命中某 refund 且该 refund 也仅被该 bank 命中」才回填（严格 1↔1 互配）。
//   - 任一方向多笔 → 涉事 bank 报错-人工介入、不回填，相关 refund 锁定（Q14 反向多笔 / Q15 锁定退出 S4）。
function runStrategiesForGroup(ctx) {
  const {
    bankGroup, refundGroup, depositRows, depIndex,
    usedBankRowId, usedRefundIdx, refundIdOf,
    backfillRows, unmatchedRows, warn,
    hitDepositBizIdSet, // OPEN-7（T5b-1）：命中 BizId 收集集合，透传给 consumeAndBackfill
    blockedRefundIds,
    pushOrdinaryUnmatched
  } = ctx;

  // bank 行按 BillDate 升序（早→晚；无法解析日期排最后，保持原序稳定）。
  const orderedBank = [...bankGroup].sort((a, b) => {
    const da = toDate(a[M.s4.bankDate]);
    const db = toDate(b[M.s4.bankDate]);
    const ta = da ? da.getTime() : Number.POSITIVE_INFINITY;
    const tb = db ? db.getTime() : Number.POSITIVE_INFINITY;
    return ta - tb;
  });

  // 本组内的 refund 锁定集合（Q15：报错链路卷入的 refund 退出后续策略 + S4，不再被复用）。
  const lockedRefundIdx = new Set();
  // 已 settle（回填 / 报错）的 bank（不再进后续策略 / S4）。
  const settledBankRowId = new Set(usedBankRowId);

  // 本策略对某 refund 「可用」：未被消费(usedRefundIdx) 且 未被锁定(lockedRefundIdx)。
  const isRefundAvailable = (ro) => {
    const id = refundIdOf(ro);
    return !usedRefundIdx.has(id) && !lockedRefundIdx.has(id);
  };

  // —— S1~S3：每个策略批量解析（SPEC §7.2）——
  //   O1：每层带 hitType（精准/模糊命中）；S1~S3 均为精准命中（L1/L2/L4，精准层在模糊层前）。
  //   O1：精准层（L1~L5）全排在模糊层（L6）之前 → 「精准优先」由层序天然保证（命中即停）。
  const strategyChain = [
    { run: (bankRow, cands) => matchS1(bankRow, cands), hitType: HIT_TYPE_PRECISE },                                  // L1 S1
    { run: (bankRow, cands) => matchS2(bankRow, cands, depositRows, depIndex), hitType: HIT_TYPE_PRECISE },           // L2 S2（含 R1/R3）
    { run: (bankRow, cands) => matchMemoContainsDepositRef(bankRow, cands, depositRows, depIndex), hitType: HIT_TYPE_PRECISE }, // L3 S2b（R2）
    { run: (bankRow, cands) => matchS3(bankRow, cands), hitType: HIT_TYPE_PRECISE },                                  // L4 S3
    { run: (bankRow, cands) => matchDraweeNameDate(bankRow, cands, depositRows, depIndex), hitType: HIT_TYPE_PRECISE }, // L5 S3b（R5）
    { run: (bankRow, cands) => matchMemoDateAmount(bankRow, cands, depositRows, depIndex), hitType: HIT_TYPE_FUZZY }    // L6 S3c（R6，模糊）
  ];

  for (const layer of strategyChain) {
    const strat = layer.run;
    // 未 settle 的 bank（保持 BillDate 升序）。
    const unsettledBanks = orderedBank.filter((b) => !settledBankRowId.has(b._rowId));
    if (unsettledBanks.length === 0) break;

    // 同一冻结快照：未消费且未锁定的 refund（批量算命中图前冻结，不边算边消费）。
    const availRefunds = refundGroup.filter((ro) => isRefundAvailable(ro));
    if (availRefunds.length === 0) continue; // 无可用 refund → 进下一策略

    // 1) 批量算命中图：bank → 命中的 refund 候选（含命中详情）。
    //    matchS1/S2/S3 返回 [{refundRow, detail}]，对同一快照执行，互不消费。
    const hitsByBank = new Map();   // bank._rowId → [{refundRow, detail}]
    const hitWinnersByRefund = new Map(); // refundId → Set(bank._rowId)（反向聚合）
    for (const bankRow of unsettledBanks) {
      const hits = strat(bankRow, availRefunds);
      hitsByBank.set(bankRow._rowId, hits);
      for (const h of hits) {
        const rid = refundIdOf(h.refundRow);
        if (!hitWinnersByRefund.has(rid)) hitWinnersByRefund.set(rid, new Set());
        hitWinnersByRefund.get(rid).add(bankRow._rowId);
      }
    }

    // 2) 逐 bank 定性（同一快照下），收集本策略待锁定的 refund。
    const toLockRefunds = new Map(); // refundId → refundRow（避免重复）
    for (const bankRow of unsettledBanks) {
      const hits = hitsByBank.get(bankRow._rowId) || [];
      const deg = hits.length;
      if (deg === 0) continue; // 未命中 → 进下一策略，不动

      if (deg > 1) {
        // 正向多笔：一条 bank 命中多条 refund → 报错（resolveHits 正向分支语义，SPEC 明令保留）。
        pushBankError(
          bankRow, unmatchedRows, warn, 'refund-backfill-multi-match',
          `关联到 ${deg} 条退款订单，无法消歧，请人工介入`,
          `银行行（${bankRow._rowId}）关联到 ${deg} 条退款订单，报错人工介入`
        );
        settledBankRowId.add(bankRow._rowId);
        for (const h of hits) toLockRefunds.set(refundIdOf(h.refundRow), h.refundRow);
        continue;
      }

      // deg === 1：唯一命中 refund r。
      const r = hits[0].refundRow;
      const rid = refundIdOf(r);
      const hitters = hitWinnersByRefund.get(rid);
      if (hitters && hitters.size > 1) {
        // 反向多笔（Q14）：r 被多条 bank 命中 → 本 bank 报错、不回填；r 锁定。
        pushBankError(
          bankRow, unmatchedRows, warn, 'refund-backfill-reverse-multi-match',
          `与其他银行行同时关联到同一退款订单，无法消歧，请人工介入`,
          `银行行（${bankRow._rowId}）与其他行同时命中同一退款订单（反向多笔），报错人工介入`
        );
        settledBankRowId.add(bankRow._rowId);
        toLockRefunds.set(rid, r);
        continue;
      }

      // 严格 1↔1 互配（bank 唯一命中 r 且 r 也仅被该 bank 命中）→ 回填，双向消费。
      consumeAndBackfill(bankRow, hits[0], layer.hitType, { usedBankRowId, usedRefundIdx, refundIdOf, backfillRows, hitDepositBizIdSet });
      settledBankRowId.add(bankRow._rowId);
    }

    // 3) 锁定本策略待锁定 refund（Q15：退出后续策略 + S4）。
    for (const [rid] of toLockRefunds) {
      lockedRefundIdx.add(rid);
      if (blockedRefundIds) blockedRefundIds.add(rid);
    }
  }

  // —— S4：金额币种日期兜底（SPEC §7.3 + R4：冻结快照 + 单向窗判据，去顺序依赖）——
  //   入口冻结快照：本组未消费且未锁定的 refund。
  const refundsForS4 = refundGroup.filter((ro) => isRefundAvailable(ro));
  const s4OrderedBank = orderedBank.filter((b) => !settledBankRowId.has(b._rowId));
  // 本轮 S4 已被消费的 refund（在冻结快照内做 1v1，按 BillDate 早→晚取最近）。
  for (const bankRow of s4OrderedBank) {
    // 仍未被本轮 S4 消费且在窗内（0≤diff≤21）的 refund（dayDiff 升序取最近）。
    const inTol = matchS4(bankRow, refundsForS4.filter((ro) => isRefundAvailable(ro)));
    if (inTol.length > 0) {
      // S4 命中的 hit 无 _depositBizId（非入金表来源）→ consumeAndBackfill 内自然不收集，不污染集合。
      //   O1：S4 = 模糊命中（HIT_TYPE_FUZZY）。
      consumeAndBackfill(bankRow, inTol[0], HIT_TYPE_FUZZY, { usedBankRowId, usedRefundIdx, refundIdOf, backfillRows, hitDepositBizIdSet });
      continue;
    }

    // 窗内无可用 refund：判据 = 该 bank 到【冻结全集 refundsForS4】是否存在窗内候选（0≤diff≤21）。
    //   - 冻结全集空 / 无可解析日期对 → 提示（关联不到，非脏数据）
    //   - 无窗内候选（含 bank 早于全部退款的负 diff = 时序矛盾脏数据）→ 报错（不依赖被抢光顺序）
    //   - 有窗内候选但被抢光 → 提示（多出 bank 抢不到，非脏数据）
    const s4win = classifyS4Window(bankRow, refundsForS4);
    if (refundsForS4.length > 0 && s4win.hasComparablePair && !s4win.hasInWindowCandidate) {
      if (blockedRefundIds) {
        for (const refundRow of refundsForS4) blockedRefundIds.add(refundIdOf(refundRow));
      }
      // 真·时序矛盾/超容差：有可比较日期对但无窗内候选（含 bank 早于全部退款的负 diff）→ 报错人工介入。
      unmatchedRows.push(buildUnmatchedBankRow(
        bankRow, RESULT_ERROR,
        `S4 金额币种已关联但银行账单日期早于退款提交日期或差异 >${M.s4.toleranceDays} 天，请人工介入`
      ));
      warn.push({
        rowId: bankRow._rowId,
        code: 'refund-backfill-date-over-tolerance',
        message: `银行行（${bankRow._rowId}）S4 日期早于退款提交日期或超 ${M.s4.toleranceDays} 天容差，报错人工介入`
      });
    } else if (refundsForS4.length > 0 && !s4win.hasComparablePair) {
      if (blockedRefundIds) {
        for (const refundRow of refundsForS4) blockedRefundIds.add(refundIdOf(refundRow));
      }
      // Fix#5：全无可比较日期对（bank/ro 日期均不可解析）→ 提示而非报错（非脏数据时序矛盾，避免误导文案）。
      unmatchedRows.push(buildUnmatchedBankRow(
        bankRow, RESULT_NOTICE,
        'S4 金额币种已关联但银行账单或退款日期不可解析，未能判定容差，请人工核对'
      ));
    } else {
      // 被抢光（有窗内候选但已被其他 bank 消费）/ 冻结全集空 → 提示。
      pushOrdinaryUnmatched(bankRow);
    }
  }

  // —— v3.0.10 需求3.2：删除原 per-group refund 收尾循环——同组内未消费/未锁定的 refund 不再产「未匹配-提示」notice 行
  //   （完全静默，已确认）。锁定的 refund 仍在报错行体现（不变）；银行侧覆盖由上方 S1~S4 + 各报错/提示分支保证（不变）。
}

// 产 1 条 bank 报错-人工介入行 + 收集 warning
function pushBankError(bankRow, unmatchedRows, warn, code, info, warnMessage) {
  unmatchedRows.push(buildUnmatchedBankRow(bankRow, RESULT_ERROR, info));
  warn.push({ rowId: bankRow._rowId, code, message: warnMessage });
}

// R4：bank 到 refund 集合是否存在「窗内候选」（单向 0 ≤ bank.BillDate − ro.valueDate ≤ toleranceDays）。
//   去顺序依赖（对冻结全集判定，不随被抢光顺序变）。任一无法解析的日期对跳过；无窗内候选 → false。
//   ⚠️ bank.BillDate 早于全部退款（diff 全为负）→ false（= 时序矛盾脏数据，走报错），与旧 minDayDiff（abs）方向不同。
function hasInWindowCandidate(bankRow, refundSet) {
  for (const ro of refundSet) {
    const diff = signedDayDiff(bankRow[M.s4.bankDate], ro[M.s4.roDate]);
    if (diff !== null && diff >= 0 && diff <= M.s4.toleranceDays) return true;
  }
  return false;
}

// R4（Fix#5 codex 复审）：S4 窗判定三态——区分「有可比较日期对但无窗内候选」(真·时序矛盾/超容差→报错)
//   与「全无可比较日期对」(bank/ro 日期均不可解析→提示，非脏数据时序，不误报「日期早于退款提交日期」)。
//   hasComparablePair：存在 ≥1 对 signedDayDiff !== null 的 (bank, ro)；
//   hasInWindowCandidate：存在 diff ∈ [0, toleranceDays] 的候选。
function classifyS4Window(bankRow, refundSet) {
  let hasComparablePair = false;
  let inWindow = false;
  for (const ro of refundSet) {
    const diff = signedDayDiff(bankRow[M.s4.bankDate], ro[M.s4.roDate]);
    if (diff === null) continue;
    hasComparablePair = true;
    if (diff >= 0 && diff <= M.s4.toleranceDays) { inWindow = true; break; }
  }
  return { hasComparablePair, hasInWindowCandidate: inWindow };
}

// 消费 + 产回填行（严格 1v1 双向消费）
//   hitType（O1）：命中所在策略层属性（精准/模糊命中），透传给 buildBackfillRow 写「命中类型」列。
//   OPEN-7（T5b-1）：若 hit 带 `_depositBizId`（仅 matchJpmUs 命中入金表行时有，且非空）→ 收集进
//     ctx.hitDepositBizIdSet（去重 Set，runRound5 维护）+ 透传给 buildBackfillRow 标记该回填行来源桥接 BizId。
//     其他策略层(S1/S4 等)的 hit 无 `_depositBizId` → 跳过 undefined/空，不污染集合（资金红线：来源口径精确）。
function consumeAndBackfill(bankRow, hit, hitType, ctx) {
  const { usedBankRowId, usedRefundIdx, refundIdOf, backfillRows, hitDepositBizIdSet } = ctx;
  usedBankRowId.add(bankRow._rowId);
  usedRefundIdx.add(refundIdOf(hit.refundRow));
  const bridgeBizId = hit && hit._depositBizId;
  if (hitDepositBizIdSet && bridgeBizId !== undefined && bridgeBizId !== null && bridgeBizId !== '') {
    hitDepositBizIdSet.add(bridgeBizId);
  }
  // v3.0.10 需求3.1：透传 hit._matchedColumns 给 buildBackfillRow（透传不过滤，过滤单点收口在 buildBackfillRow）。
  backfillRows.push(buildBackfillRow(hit.refundRow, bankRow, hit.detail, hitType, bridgeBizId, hit && hit._matchedColumns));
}

// v3.0.0 需求3：退款回填「候选预检」只读 helper（与 c3-gateway-recon-join.js 的 countC3BankCandidates 对称）。
//   候选条件 = 银行对账单 FundType 归一化后 === 'Ach Return'（见本文件 §业务语义 / 第6行：退款参与对账的银行侧条件）。
//   纯计数、不读 DB/session（由 main.js 注入 rows）；供运行点 / 导入后提醒做「本批是否有退款候选」门控。
//   本批无候选 → 提醒不弹（避免无退款数据时误打扰）。
function countRefundBankCandidates(bankRows) {
  let n = 0;
  for (const r of bankRows || []) {
    if (normalizeCellValue(r && r['FundType']) === 'Ach Return') n++;
  }
  return n;
}

module.exports = {
  runRound5RefundOrderBackfill,
  // v3.0.0 需求3：退款候选预检只读 helper（main.js refund-candidate-count IPC 调用 + 单测覆盖）
  countRefundBankCandidates,
  // 内部子函数导出便于单测精确覆盖
  bankAmountAbs,
  extractFeature,
  classifyCardinality,
  matchS1,
  matchS2,
  matchS2Mtx,
  matchJpmHk,
  matchJpmUs,
  // R3：CustomerRef 二跳共享函数 + 入金行双键查找（单测精确覆盖）
  matchCustomerRefTwoHop,
  lookupDepositByKeys,
  // F-PERF：入金表双 Map 索引（单测「索引版与线性版一致」覆盖）
  buildDepIndex,
  // R2：S2b 附言包含入金 CustomerRef（单测精确覆盖）
  matchMemoContainsDepositRef,
  matchS3,
  // R5/R6：S3b/S3c 二跳匹配器 + 附言提取 helper（单测精确覆盖）
  matchDraweeNameDate,
  matchMemoDateAmount,
  extractFirstCapture,
  yymmddToDateStr,
  matchS4,
  calculateBankPaymentSerialAmountDifference,
  matchBankPaymentSerialFuzzy,
  runBankPaymentSerialFuzzyFallback,
  // Fix#4/#5（codex 复审）：DTD DMY 明确解析 + S4 窗三态判定（单测精确覆盖）
  parseDtdDateToken,
  classifyS4Window,
  resolveHits,
  detailBankToRo,
  detailBankToDeposit,
  buildBackfillRow,
  // OPEN-7（T5b-1）：跨期重复命中 helper（T5b-2 在 main.js export 阶段 require；纯函数，引擎不读库）
  normalizeBizIdKey,
  buildStaleHitReminder,
  pickStaleHits,
  RESULT_ERROR,
  RESULT_NOTICE,
  // O1/O2：命中类型常量 + S4 固定详情文案（单测精确断言）
  HIT_TYPE_PRECISE,
  HIT_TYPE_FUZZY,
  S4_DETAIL_TEXT,
  BANK_PAYMENT_SERIAL_FUZZY_DETAIL_PREFIX,
  BANK_PAYMENT_SERIAL_FUZZY_AMOUNT_LIMIT
};
