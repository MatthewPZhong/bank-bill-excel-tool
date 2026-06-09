// v2.1.16-beta.4 ③ R5 场景4「中台退款订单回填」引擎（🔴 资金红线）
// PRD-中台退款订单回填-v2.1.16-beta.3 §5.1~§5.5 + §九（12 条已确认决议）
// TECH_DESIGN-中台退款订单回填-v2.1.16-beta.3 §3.2/§3.3
//
// 业务语义：
//   银行 FundType=Ach Return（且 FundType 未被 R4 改写）行 ↔ 中台退款订单 状态=SUBMITTED 行，
//   按「渠道大账号(MerchantId↔银行大账号) + 金额(|Credit-Debit|↔退款金额) + 币种」三元组唯一值分组；
//   同一唯一值下按 4 基数 × 4 策略矩阵（S1 渠道流水号 → S2 附言 MTX → S3 付款人/卡号/虚拟卡号 → S4 金额币种日期）
//   命中即停回填，产出独立的回填模板行集合 + 未匹配/报错行集合（不改 bankRows）。
//
// 跨表字段映射全部走 refund-backfill-fields.js（显式映射，绝不假设同名）。
//
// 纯函数：入参 rows 数组，不读 DB/session（由 main.js 注入）；与场景2/3 独立 usedBankRowId，不串池。
//   签名 runRound5RefundOrderBackfill(bankRows, refundOrderRows, depositRows, options={})
//   返回 { backfillRows, unmatchedRows, modifications:[], warnings }
//     backfillRows  —— sheet1 回填模板行（A~N，含 E 列命中详情 + F~N 银行 9 字段）
//     unmatchedRows —— sheet2 行（含「结果类型」= 报错-人工介入 / 未匹配-提示 + 信息列）
//     modifications —— 恒 []（本引擎不改 bankRows，保留与场景2/3 返回对称性）
//
// ⚠️ 资金红线：列名映射 / 基数判定 / 多笔报错-提示区分 任一错位都会写错回填。

const {
  makeWarningCollector,
  normalizeCellValue,
  parseNumber
} = require('./engine-utils');
const { dayDiffWithin, toDate } = require('./engine-date-utils');
const { buildFeatureRegex } = require('./c1-extract-recon-id');
const {
  REFUND_BACKFILL_FIELD_MAP: M,
  REFUND_BANK_COLUMNS,
  MTX_FEATURE,
  T54SWIC_FEATURE
} = require('../../constants/refund-backfill-fields');

const MS_PER_DAY = 86400000;

// 提取 regex 模板（仅当模板用，每次提取前 new RegExp(source,'g') 重建，避免 lastIndex 副作用 —— 同 C1）
const MTX_RE = buildFeatureRegex(MTX_FEATURE);          // /MTX\d{19}/g
const T54SWIC_RE = buildFeatureRegex(T54SWIC_FEATURE);  // /T54SWIC\d{6}/g

// 结果类型（sheet2「结果类型」列两种值；两类输出禁混）
const RESULT_ERROR = '报错-人工介入';
const RESULT_NOTICE = '未匹配-提示';

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

// —— 命中详情两句式（§5.1.4，✅Q12 文案）——
function detailBankToRo(bankField, bankVal, roField, roVal) {
  return `匹配成功:"银行对账单${bankField}里的${normalizeCellValue(bankVal)}"匹配上了"refund order${roField}的${normalizeCellValue(roVal)}"`;
}
function detailBankToDeposit(bankField, bankVal, depField, depVal) {
  return `匹配成功:"银行对账单${bankField}里的${normalizeCellValue(bankVal)}"匹配上了"银行对账单入金表${depField}的${normalizeCellValue(depVal)}"`;
}

// —— 回填动作（§5.1.3）：1 条命中 refund order + 配对银行行 → 1 行回填模板（含 E 列详情 + F~N 银行 9 字段）——
function buildBackfillRow(refundRow, bankRow, detailText) {
  const row = {
    '退款单号': normalizeCellValue(refundRow[M.backfill.fromRoSerialNo]),
    '状态': M.backfill.statusSuccess,
    '渠道流水号': normalizeCellValue(bankRow[M.backfill.fromBankReconId]),
    '渠道退款时间': bankRow[M.backfill.fromBankBillDate],
    '匹配命中详情': detailText
  };
  // F~N：配对银行行 9 字段原数据（按 REFUND_BANK_COLUMNS 顺序；保留原始值不 normalize，与导出口径一致）
  for (const col of REFUND_BANK_COLUMNS) {
    row[col] = bankRow[col];
  }
  return row;
}

// —— sheet2 行：未匹配的银行行 9 字段 + 结果类型 + 信息列（两类输出同表用「结果类型」列区分）——
function buildUnmatchedBankRow(bankRow, resultType, info) {
  const row = { '结果类型': resultType };
  for (const col of REFUND_BANK_COLUMNS) {
    row[col] = bankRow[col];
  }
  row['报错/提示信息'] = info;
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
        hits.push({ refundRow: ro, detail: detailBankToRo(bankField, bankVal, M.s1.roKey, payNo) });
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
      hits.push({ refundRow: ro, detail: detailBankToRo(M.s2.bankExtract, hitMtx, M.s2.roField, memo) });
    }
  }
  return hits;
}

// S2 JPM-HK：清洗 // → 提 T54SWIC → 仅与 refund「银行打款流水号」单字段等值（✅Q7）
function matchJpmHk(bankRow, refundCands) {
  const clean = (v) => normalizeCellValue(v).split('//').join('');
  const swicList = [];
  for (const field of M.jpm.hkCleanFields) {
    for (const swic of extractFeature(clean(bankRow[field]), T54SWIC_RE)) {
      if (!swicList.includes(swic)) swicList.push(swic);
    }
  }
  if (swicList.length === 0) return [];
  const hits = [];
  for (const ro of refundCands) {
    const payNo = normalizeCellValue(ro[M.jpm.hkRoKey]);
    if (payNo === '') continue;
    const hitSwic = swicList.find((swic) => swic === payNo);
    if (hitSwic) {
      // 命中详情：银行 Extra Information/Payment Detail 提取值 ↔ refund order 银行打款流水号
      hits.push({
        refundRow: ro,
        detail: detailBankToRo(M.jpm.hkCleanFields.join('/'), hitSwic, M.jpm.hkRoKey, payNo)
      });
    }
  }
  return hits;
}

// S2 JPM-US：refund「银行打款流水号」=payNo → 入金表(ReconId OR ChannelOrderNo)==payNo → 取 CustomerRef → 比对 bank CustomerRef（✅Q8）
function matchJpmUs(bankRow, refundCands, depositRows) {
  const bankRef = normalizeCellValue(bankRow[M.jpm.usBankCompare]);
  if (bankRef === '') return [];
  const deps = Array.isArray(depositRows) ? depositRows : [];
  const hits = [];
  for (const ro of refundCands) {
    const payNo = normalizeCellValue(ro[M.jpm.usRoKey]);
    if (payNo === '') continue;
    const dep = deps.find((d) =>
      M.jpm.usDepositKeys.some((k) => {
        const dv = normalizeCellValue(d[k]);
        return dv !== '' && dv === payNo;
      }));
    if (!dep) continue;
    const depRef = normalizeCellValue(dep[M.jpm.usDepositTake]);
    if (depRef !== '' && depRef === bankRef) {
      // 命中详情：银行 CustomerRef ↔ 入金表 CustomerRef（两句式·入金表版）
      hits.push({
        refundRow: ro,
        detail: detailBankToDeposit(M.jpm.usBankCompare, bankRef, M.jpm.usDepositTake, depRef)
      });
    }
  }
  return hits;
}

// S2 综合：Channel=JPM 时先跑 JPM 链（HK/US 按地区），未命中回落常规 MTX；非 JPM 直接常规 MTX
function matchS2(bankRow, refundCands, depositRows) {
  const isJpm = normalizeCellValue(bankRow.Channel) === M.jpm.channelValue;
  if (isJpm) {
    const region = normalizeCellValue(bankRow[M.jpm.regionField]);
    let jpmHits = [];
    if (region === M.jpm.hkRegion) {
      jpmHits = matchJpmHk(bankRow, refundCands);
    } else if (region === M.jpm.usRegion) {
      jpmHits = matchJpmUs(bankRow, refundCands, depositRows);
    }
    if (jpmHits.length > 0) return jpmHits;
    // JPM 链未命中 → 回落常规 MTX 包含匹配
  }
  return matchS2Mtx(bankRow, refundCands);
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
        hits.push({ refundRow: ro, detail: detailBankToRo(pair.bankField, bankVal, pair.roKey, roVal) });
        break; // 同一 refund 按位命中一项即可
      }
    }
  }
  return hits;
}

// S4：bank BillDate vs refund valueDate，dayDiffWithin ≤ toleranceDays。
//   命中 = 该 bank 行在候选 refund 里找到日期容差内最近的一条（>容差不算命中）。
//   返回 { refundRow, detail, dayDiff } 数组（≤容差的全部候选，按天数差升序；空=无任何日期≤容差）。
function matchS4(bankRow, refundCands) {
  const bankDate = toDate(bankRow[M.s4.bankDate]);
  const hits = [];
  for (const ro of refundCands) {
    if (dayDiffWithin(bankRow[M.s4.bankDate], ro[M.s4.roDate], M.s4.toleranceDays)) {
      const roDate = toDate(ro[M.s4.roDate]);
      const dayDiff = (bankDate && roDate)
        ? Math.abs(Math.round((bankDate.getTime() - roDate.getTime()) / MS_PER_DAY))
        : Number.POSITIVE_INFINITY;
      hits.push({
        refundRow: ro,
        dayDiff,
        detail: detailBankToRo(M.s4.bankDate, bankRow[M.s4.bankDate], M.s4.roDate, ro[M.s4.roDate])
      });
    }
  }
  hits.sort((a, b) => a.dayDiff - b.dayDiff);
  return hits;
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

  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];
  const safeRefundRows = Array.isArray(refundOrderRows) ? refundOrderRows : [];
  const safeDepositRows = Array.isArray(depositRows) ? depositRows : [];
  const isFundTypeChanged = typeof options.isFundTypeChanged === 'function'
    ? options.isFundTypeChanged
    : () => false;

  // 1) 数据筛选（§5.1.2）
  //   refund：状态 === SUBMITTED
  const refundPool = safeRefundRows.filter(
    (r) => normalizeCellValue(r[M.filter.roStatusField]) === M.filter.roSubmitted
  );
  //   bank：FundType === Ach Return 且未被 R4 改写 FundType
  const bankPool = safeBankRows.filter(
    (b) => normalizeCellValue(b[M.filter.bankFundType]) === M.filter.achReturn && !isFundTypeChanged(b._rowId)
  );

  // 空入参防御：任一侧空 → 无可对账，返回空（不抛）
  if (refundPool.length === 0 || bankPool.length === 0) {
    return { backfillRows, unmatchedRows, modifications: [], warnings: warn.list() };
  }

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
  for (const [key, bankGroup] of bankGroups) {
    const refundGroup = refundGroups.get(key) || [];

    // bank-only 组：有银行 Ach Return 行但该唯一值下无 SUBMITTED refund
    //   → 每条银行行产「未匹配-提示」（PRD §5.1.5 sheet2 放未匹配上的银行对账单数据），不再静默 continue
    if (refundGroup.length === 0) {
      for (const bankRow of bankGroup) {
        unmatchedRows.push(buildUnmatchedBankRow(bankRow, RESULT_NOTICE, '未能关联到任何退款订单'));
      }
      continue;
    }

    const cardinality = classifyCardinality(bankGroup.length, refundGroup.length);

    runStrategiesForGroup({
      cardinality,
      bankGroup,
      refundGroup,
      depositRows: safeDepositRows,
      usedBankRowId,
      usedRefundIdx,
      refundIdOf,
      backfillRows,
      unmatchedRows,
      warn
    });
  }

  // 4) refund-only 组收尾（PR#64 Finding 1）：某唯一值下有 SUBMITTED refund 但无银行 Ach Return 行
  //   → 该组从未进入主循环（无对应 bankGroup），其 refund 需在此补「未匹配-提示」。
  //   ⚠️ 只补「从未进入主循环」的 key（!bankGroups.has(key)）；已进入主循环的组里未消费 refund
  //   由 runStrategiesForGroup 内的 per-group 收尾负责，避免重复产行。
  for (const [key, refundGroup] of refundGroups) {
    if (bankGroups.has(key)) continue; // 已由主循环（含其 per-group 收尾）处理
    for (const ro of refundGroup) {
      unmatchedRows.push({
        '结果类型': RESULT_NOTICE,
        '退款单号': normalizeCellValue(ro[M.backfill.fromRoSerialNo]),
        '报错/提示信息': '该退款订单未关联到银行对账单数据，不更新并提示'
      });
    }
  }

  return { backfillRows, unmatchedRows, modifications: [], warnings: warn.list() };
}

// 对单个唯一值分组跑 S1→S4。
//   🔴 SPEC §7：S1~S3 改为「按策略批量解析」（去顺序依赖，正反向多笔都收敛正确）；S4 用「冻结快照 + minDayDiff」判据。
//   - 仅「某 bank 唯一命中某 refund 且该 refund 也仅被该 bank 命中」才回填（严格 1↔1 互配）。
//   - 任一方向多笔 → 涉事 bank 报错-人工介入、不回填，相关 refund 锁定（Q14 反向多笔 / Q15 锁定退出 S4）。
function runStrategiesForGroup(ctx) {
  const {
    bankGroup, refundGroup, depositRows,
    usedBankRowId, usedRefundIdx, refundIdOf,
    backfillRows, unmatchedRows, warn
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
  const strategyChain = [
    (bankRow, cands) => matchS1(bankRow, cands),
    (bankRow, cands) => matchS2(bankRow, cands, depositRows),
    (bankRow, cands) => matchS3(bankRow, cands)
  ];

  for (const strat of strategyChain) {
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
      consumeAndBackfill(bankRow, hits[0], { usedBankRowId, usedRefundIdx, refundIdOf, backfillRows });
      settledBankRowId.add(bankRow._rowId);
    }

    // 3) 锁定本策略待锁定 refund（Q15：退出后续策略 + S4）。
    for (const [rid] of toLockRefunds) lockedRefundIdx.add(rid);
  }

  // —— S4：金额币种日期兜底（SPEC §7.3：冻结快照 + minDayDiff 判据，去顺序依赖）——
  //   入口冻结快照：本组未消费且未锁定的 refund。
  const refundsForS4 = refundGroup.filter((ro) => isRefundAvailable(ro));
  const s4OrderedBank = orderedBank.filter((b) => !settledBankRowId.has(b._rowId));
  // 本轮 S4 已被消费的 refund（在冻结快照内做 1v1，按 BillDate 早→晚取最近）。
  for (const bankRow of s4OrderedBank) {
    // 仍未被本轮 S4 消费且在容差内的 refund（dayDiff 升序取最近）。
    const inTol = matchS4(bankRow, refundsForS4.filter((ro) => isRefundAvailable(ro)));
    if (inTol.length > 0) {
      consumeAndBackfill(bankRow, inTol[0], { usedBankRowId, usedRefundIdx, refundIdOf, backfillRows });
      continue;
    }

    // 容差内无 refund：判据 = 该 bank 到【冻结全集 refundsForS4】的 minDayDiff 是否 >10。
    //   - 冻结全集空 → 提示（关联不到，非脏数据）
    //   - minDayDiff >10 → 报错（日期超容差，Q13；不依赖被抢光顺序）
    //   - minDayDiff ≤10 但已被抢光 → 提示（多出 bank 抢不到，非脏数据）
    const minDiff = minDayDiffToSet(bankRow, refundsForS4);
    if (refundsForS4.length > 0 && Number.isFinite(minDiff) && minDiff > M.s4.toleranceDays) {
      unmatchedRows.push(buildUnmatchedBankRow(
        bankRow, RESULT_ERROR,
        `S4 金额币种已关联但 BillDate 与 valueDate 差异 >${M.s4.toleranceDays} 天，请人工介入`
      ));
      warn.push({
        rowId: bankRow._rowId,
        code: 'refund-backfill-date-over-tolerance',
        message: `银行行（${bankRow._rowId}）S4 日期超 ${M.s4.toleranceDays} 天容差，报错人工介入`
      });
    } else {
      unmatchedRows.push(buildUnmatchedBankRow(
        bankRow, RESULT_NOTICE, '未能关联到任何退款订单'
      ));
    }
  }

  // —— 收尾：未消费且未锁定的 refund order → 不更新并提示（锁定的 refund 已在报错行体现，不再重复产提示）——
  for (const ro of refundGroup) {
    const id = refundIdOf(ro);
    if (usedRefundIdx.has(id) || lockedRefundIdx.has(id)) continue;
    unmatchedRows.push({
      '结果类型': RESULT_NOTICE,
      '退款单号': normalizeCellValue(ro[M.backfill.fromRoSerialNo]),
      '报错/提示信息': '该退款订单未关联到银行对账单数据，不更新并提示'
    });
  }
}

// 产 1 条 bank 报错-人工介入行 + 收集 warning
function pushBankError(bankRow, unmatchedRows, warn, code, info, warnMessage) {
  unmatchedRows.push(buildUnmatchedBankRow(bankRow, RESULT_ERROR, info));
  warn.push({ rowId: bankRow._rowId, code, message: warnMessage });
}

// bank 到 refund 集合的最小日期差（天）；集合空 / 无法解析 → Infinity
function minDayDiffToSet(bankRow, refundSet) {
  const bankDate = toDate(bankRow[M.s4.bankDate]);
  if (!bankDate) return Number.POSITIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  for (const ro of refundSet) {
    const roDate = toDate(ro[M.s4.roDate]);
    if (!roDate) continue;
    const diff = Math.abs(Math.round((bankDate.getTime() - roDate.getTime()) / MS_PER_DAY));
    if (diff < min) min = diff;
  }
  return min;
}

// 消费 + 产回填行（严格 1v1 双向消费）
function consumeAndBackfill(bankRow, hit, ctx) {
  const { usedBankRowId, usedRefundIdx, refundIdOf, backfillRows } = ctx;
  usedBankRowId.add(bankRow._rowId);
  usedRefundIdx.add(refundIdOf(hit.refundRow));
  backfillRows.push(buildBackfillRow(hit.refundRow, bankRow, hit.detail));
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
  matchS3,
  matchS4,
  resolveHits,
  detailBankToRo,
  detailBankToDeposit,
  buildBackfillRow,
  RESULT_ERROR,
  RESULT_NOTICE
};
