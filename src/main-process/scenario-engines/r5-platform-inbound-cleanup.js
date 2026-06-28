// v3.0.8 R5 场景3「中台加款单脏数据处理」引擎（🔴 资金红线）
// PRD §四 需求 3（R3.1~R3.4） / TECH_DESIGN §5.4
// W3（R5s3 脏数据处理两处规则变更，spec: changes/r5s3-channelorderno-fallback-inbound-substring）：
//   ① 两级 fallback 匹配键：ReconId 主、ChannelOrderNo 兜底（D-1 ~ D-3）。
//   ② FundType 子串判定（大小写不敏感）：不含 excludeFundType 子串才剔除（D-2 ~ D-2c）。
//
// 业务语义：
//   网关 TradeType=Inbound-VA 行 ↔ 第四轮（R4）处理过的银行行，严格 1v1。
//   匹配键两级 fallback：网关同一个 `gw.reconciliationid` 值
//     —— 一级优先撞银行 `ReconciliationId`；仅当一级桶「查无此行」（无可用候选）
//        才退到二级撞银行 `ChannelOrderNo`（D-1a）；
//     —— 一级找到候选但 Credit 方向消歧失败（0/≥2 条 Credit）= 数据脏，
//        绝不 fallback（D-3，最关键红线，防撞业务无关行产错误剔除清单）。
//   命中且银行 FundType 不含 excludeFundType 子串（默认不含 'Inbound'，大小写不敏感）
//     → 生成 1 条「中台加款单剔除行」（一般不改银行行）。
//
// 跨表字段（显式映射，绝不假设同名 —— TECH_DESIGN §4）：
//   网关（gateway-bill，小写）：gw.TradeType / gw.reconciliationid / gw.orderid
//     —— 网关侧无独立渠道订单号字段，两级 fallback 都用同一个 gw.reconciliationid 值。
//   银行（bank statement，驼峰）：bank.ReconciliationId / bank.ChannelOrderNo / bank.FundType / bank._rowId
//     以及 C~O 同名列（bank['FundType'] ... bank['Payment Detail']；ChannelOrderNo 仅作匹配键，不进剔除行）
//
// 剔除行结构（buildCleanupRow）：
//   A 加款单号 = 网关 orderid
//   B 附言     = `<银行行当前 FundType>，中台加款单已关闭。`（中文逗号「，」+ 中文句号「。」）
//              —— 用 bank 当前 FundType（编排器保证 R4 已先跑，故为 R4 改写后的当前值）
//   C~O      = 直接拷贝银行行同名字段（CLEANUP_COPY_HEADERS）
//
// ⚠️ 资金红线：附言文案格式、加款单号取值、C~O 字段拷贝任一错位都会导出错误的剔除清单。
//   fallback 误命中 / 触发方向写反（含子串=不产）/ 1v1 跨两级重复消费 = 错误财务清单。
//   本场景一般不改银行行 → modifications 恒为 []。

const {
  makeWarningCollector,
  normalizeCellValue,
  parseNumber
} = require('./engine-utils');

const { CLEANUP_COPY_HEADERS } = require('../../constants/platform-cleanup-template-fields');

// 构造一条剔除行
//   gw  —— 命中的网关行（取 orderid）
//   bank —— 配对的银行行（取当前 FundType 进附言 + 拷贝 C~O）
function buildCleanupRow(gwRow, bankRow) {
  const gw = gwRow || {};
  const bank = bankRow || {};
  const row = {
    '加款单号': normalizeCellValue(gw.orderid),
    // 附言文案严格格式：`<FundType>，中台加款单已关闭。`（中文逗号 + 中文句号）
    '附言': `${normalizeCellValue(bank.FundType)}，中台加款单已关闭。`
  };
  // C~O（13 列）直接拷贝银行行同名字段（保留原始值，不做 normalize —— 与导出口径一致）
  for (const header of CLEANUP_COPY_HEADERS) {
    row[header] = bank[header];
  }
  return row;
}

// R5 场景3 主算法
//   gwRows   —— 网关对账单行（链接表读回，字段为真实小写表头）
//   bankRows —— R4 后的银行对账单行（带 _rowId，FundType 可能已被 R4 改写）
//   options.gwTradeType    —— 参与本场景的网关 TradeType（默认 'Inbound-VA'）
//   options.excludeFundType —— 命中后「不剔除」的银行 FundType 子串（默认 'Inbound'，大小写不敏感）
//                              语义：bank.FundType 含此子串视为入金、不产剔除行；空配置兜底全产（D-2c）
// 返回 { cleanupRows, modifications, warnings }
function runRound5PlatformInboundCleanup(gwRows, bankRows, options = {}) {
  const warningCollector = makeWarningCollector('r5-platform-inbound-cleanup', '中台加款单脏数据处理');
  const cleanupRows = [];

  const gwTradeType = options.gwTradeType !== undefined && options.gwTradeType !== null
    ? options.gwTradeType
    : 'Inbound-VA';
  const excludeFundType = options.excludeFundType !== undefined && options.excludeFundType !== null
    ? options.excludeFundType
    : 'Inbound';

  const safeGwRows = Array.isArray(gwRows) ? gwRows : [];
  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];

  // 1. 网关池：仅 TradeType === gwTradeType 的行参与
  const gwPool = safeGwRows.filter((g) => normalizeCellValue(g && g.TradeType) === gwTradeType);

  // 2. 银行行建双键索引（D-1，两级 fallback）：
  //    一级 ReconciliationId、二级 ChannelOrderNo，各空键跳过、不入索引。
  //    桶 value = bank 对象数组，按 bankRows 插入序（与历史单 Map 口径一致，不引 ordOf）。
  //    同一行两列都有值会同时进两个桶，重复消费由 usedBankRowId 跨两级兜底（见改动2 不变量）。
  const bankByReconId = new Map();
  const bankByChannelOrderNo = new Map();
  for (const bank of safeBankRows) {
    // 需求0(v3.0.11 · 🔴资金红线)：仅「无借方发生额」的银行行可入桶。
    // 口径B：Debit 为 0 或空白均入桶；仅真实非零 Debit 排除（= Credit 消歧 O-1「有值」判定的对称取反）。
    const debitVal = parseNumber(bank && bank['Debit Amount']);
    if (debitVal !== null && debitVal !== 0) continue; // 真实非零借方 → 一级/二级桶都不入
    const rk = normalizeCellValue(bank && bank.ReconciliationId);
    if (rk !== '') {
      if (!bankByReconId.has(rk)) bankByReconId.set(rk, []);
      bankByReconId.get(rk).push(bank);
    }
    const ck = normalizeCellValue(bank && bank.ChannelOrderNo);
    if (ck !== '') {
      if (!bankByChannelOrderNo.has(ck)) bankByChannelOrderNo.set(ck, []);
      bankByChannelOrderNo.get(ck).push(bank);
    }
  }

  // 严格 1v1：已被消费的银行行 _rowId（跨两级 fallback 共享同一个 Set —— D-1c）
  const usedBankRowId = new Set();

  // 候选消歧 helper（原 PR-6 单/多候选 + Credit 方向消歧逻辑原样抽出，🔴 不改任何 O-1/O-4 口径）：
  //   入参 cand —— 调用方已过滤 usedBankRowId 的候选数组。
  //   返回 { row } / { skip:'empty' } / { skip:'no-credit' } / { skip:'multi-credit' }
  //     empty       —— 桶为空 / 候选已被前面 gw 消费空 → 「查无此行」，可触发 fallback（D-1a）
  //     no-credit   —— 找到 ≥2 候选但 0 行 Credit 有值 → 有歧义，绝不 fallback（D-3）
  //     multi-credit—— 找到 ≥2 候选且 ≥2 行 Credit 有值 → 有歧义，绝不 fallback（D-3）
  function pickFromCandidates(cand) {
    if (cand.length === 0) return { skip: 'empty' };
    if (cand.length === 1) return { row: cand[0] }; // O-4：单候选维持现状，不强制 Credit 筛选
    // 多候选 → 方向消歧（O-1：「Credit 有值」= parseNumber 可解析且 ≠ 0）
    const creditCand = cand.filter((b) => {
      const v = parseNumber(b['Credit Amount']);
      return v !== null && v !== 0; // ← O-1 定稿口径：空 / 0 / 0.00 / 不可解析 一律视为无值
    });
    if (creditCand.length === 1) return { row: creditCand[0] }; // R-1：唯一 Credit 行
    if (creditCand.length === 0) return { skip: 'no-credit' };  // O-2/O-3：0 行 Credit 有值
    return { skip: 'multi-credit' };                            // R-2/O-3：≥2 行 Credit 有值
  }

  // 消歧失败警告 push helper（复用同名 code，仅按来源在 message 末尾追加标记 —— D-1b）：
  //   via==='ChannelOrderNo' → 追加「(按 ChannelOrderNo 匹配)」；via==='ReconciliationId' → 保持原文案。
  function pushDisambigWarning(skip, key, cand, via) {
    const suffix = via === 'ChannelOrderNo' ? '（按 ChannelOrderNo 匹配）' : '';
    if (skip === 'no-credit') {
      warningCollector.push({
        rowId: null,
        code: 'no-credit-match',
        severity: 'warning',
        message: `网关 reconciliationid=${key} 的 ${cand.length} 行候选均无 Credit Amount，跳过剔除（数据异常）${suffix}`
      });
    } else {
      // multi-credit
      const creditCand = cand.filter((b) => {
        const v = parseNumber(b['Credit Amount']);
        return v !== null && v !== 0;
      });
      warningCollector.push({
        rowId: null,
        code: 'multi-credit-match',
        severity: 'warning',
        message: `网关 reconciliationid=${key} 命中 ${creditCand.length} 行 Credit Amount 有值，无法唯一定位，跳过剔除（数据异常）${suffix}`
      });
    }
  }

  // 3. 按 gwPool 原顺序遍历，逐条 1v1 配对（两级 fallback：ReconId 主、ChannelOrderNo 兜底）
  for (const gw of gwPool) {
    const key = normalizeCellValue(gw && gw.reconciliationid);
    if (key === '') continue; // 空 reconid 跳过

    // ① 一级 ReconciliationId（候选已过滤已消费行）
    const candR = (bankByReconId.get(key) || []).filter((b) => !usedBankRowId.has(b._rowId));
    const resR = pickFromCandidates(candR);

    let bankRow = null;
    if (resR.row) {
      bankRow = resR.row;
    } else if (resR.skip === 'empty') {
      // ② 仅一级「查无此行」才 fallback 到二级 ChannelOrderNo（D-1a）
      const candC = (bankByChannelOrderNo.get(key) || []).filter((b) => !usedBankRowId.has(b._rowId));
      const resC = pickFromCandidates(candC); // 二级同跑 Credit 方向消歧（D-1b）
      if (resC.row) {
        bankRow = resC.row;
      } else if (resC.skip === 'no-credit' || resC.skip === 'multi-credit') {
        pushDisambigWarning(resC.skip, key, candC, 'ChannelOrderNo'); // 复用同名 code + 来源标记
        continue;
      } else {
        continue; // 两级都 empty → 静默跳过（与历史 empty 行为一致）
      }
    } else {
      // 一级 no-credit / multi-credit → 数据脏、有歧义，绝不 fallback（D-3，🔴 最关键红线）
      pushDisambigWarning(resR.skip, key, candR, 'ReconciliationId');
      continue;
    }

    usedBankRowId.add(bankRow._rowId); // 严格 1v1 单向消费，跨两级共享（D-1c）

    // 触发条件（D-2/D-2a/D-2c，🔴 方向：含子串=不产）：
    //   FundType 含 excludeFundType 子串（大小写不敏感）→ 视为入金、不产剔除行；
    //   excludeFundType 规范化后为空串（ex===''）→ 兜底走「全部命中行都产」分支（防 includes('') 恒真反转）。
    const ft = normalizeCellValue(bankRow.FundType).toLowerCase();
    const ex = normalizeCellValue(excludeFundType).toLowerCase();
    if (ex !== '' && ft.includes(ex)) {
      // 含 excludeFundType 子串 → 入金，不产剔除行（D-2/D-2a）
    } else {
      cleanupRows.push(buildCleanupRow(gw, bankRow)); // 含 ex==='' 兜底全产（D-2c）
    }
  }

  // 本场景一般不改银行行 → modifications 恒为 []
  return {
    cleanupRows,
    modifications: [],
    warnings: warningCollector.list()
  };
}

module.exports = {
  buildCleanupRow,
  runRound5PlatformInboundCleanup
};
