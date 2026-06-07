// v2.1.16-beta.2 R5 场景3「中台加款单脏数据处理」引擎（🔴 资金红线）
// PRD §四 需求 3（R3.1~R3.4） / TECH_DESIGN §5.4
//
// 业务语义：
//   网关 TradeType=Inbound-VA 行 ↔ 第四轮（R4）处理过的银行行，
//   键 `gw.reconciliationid === bank.ReconciliationId`，严格 1v1。
//   命中且银行 FundType != 'Inbound' → 生成 1 条「中台加款单剔除行」（一般不改银行行）。
//
// 跨表字段（显式映射，绝不假设同名 —— TECH_DESIGN §4）：
//   网关（gateway-bill，小写）：gw.TradeType / gw.reconciliationid / gw.orderid
//   银行（bank statement，驼峰）：bank.ReconciliationId / bank.FundType / bank._rowId
//     以及 C~O 同名列（bank['FundType'] ... bank['Payment Detail']）
//
// 剔除行结构（buildCleanupRow）：
//   A 加款单号 = 网关 orderid
//   B 附言     = `<银行行当前 FundType>，中台加款单已关闭。`（中文逗号「，」+ 中文句号「。」）
//              —— 用 bank 当前 FundType（编排器保证 R4 已先跑，故为 R4 改写后的当前值）
//   C~O      = 直接拷贝银行行同名字段（CLEANUP_COPY_HEADERS）
//
// ⚠️ 资金红线：附言文案格式、加款单号取值、C~O 字段拷贝任一错位都会导出错误的剔除清单。
//   本场景一般不改银行行 → modifications 恒为 []。

const {
  makeWarningCollector,
  normalizeCellValue
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
//   options.excludeFundType —— 命中后「不剔除」的银行 FundType（默认 'Inbound'）
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

  // 2. 银行行按 ReconciliationId 建索引（空键跳过，不入索引）
  const bankByReconId = new Map();
  for (const bank of safeBankRows) {
    const key = normalizeCellValue(bank && bank.ReconciliationId);
    if (key === '') continue;
    if (!bankByReconId.has(key)) bankByReconId.set(key, []);
    bankByReconId.get(key).push(bank);
  }

  // 严格 1v1：已被消费的银行行 _rowId
  const usedBankRowId = new Set();

  // 3. 按 gwPool 原顺序遍历，逐条 1v1 配对
  for (const gw of gwPool) {
    const key = normalizeCellValue(gw && gw.reconciliationid);
    if (key === '') continue; // 空 reconid 跳过

    const cand = (bankByReconId.get(key) || []).filter((b) => !usedBankRowId.has(b._rowId));
    if (cand.length === 0) continue; // 无可用候选（含已被前面 gw 抢空）

    if (cand.length > 1) {
      warningCollector.push({
        rowId: null,
        code: 'multi-bank-match-inbound',
        message: `网关 reconciliationid=${key} 在银行对账单中匹配到 ${cand.length} 行可用，取第一条（数据脏）`
      });
    }

    const bankRow = cand[0];
    usedBankRowId.add(bankRow._rowId); // 严格 1v1 单向消费

    // 触发条件：银行 FundType != excludeFundType（默认 != 'Inbound'）才生成剔除行
    if (normalizeCellValue(bankRow.FundType) !== excludeFundType) {
      cleanupRows.push(buildCleanupRow(gw, bankRow));
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
