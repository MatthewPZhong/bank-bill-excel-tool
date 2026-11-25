// v3.0.12 功能1「异常-人工判断 sheet」检测器（🔴 资金红线·纯只读）
// plan「功能 1」§1.1。
//
// 性质：在 5 轮对账全部跑完后，**只读**地检测「银行对账单 ↔ 网关对账单 / 调拨对账单」出现
//   「多对多」的银行行，汇总供人工复核。现有引擎遇多对多只发一条 multi-bank-match-backfill 警告
//   就静默取 cand[0] 回填（r5-fund-transfer-backfill.js / r5-fund-transfer-recon-backfill.js），
//   人工无从感知；本检测器把涉及的银行行附加到结果文件新 sheet。
//
//   🔴 绝不修改任何 bankRow 字段 / modifications / 回填逻辑 / 行数守恒——只返回命中行的**引用**与说明文本。
//
// 复用既有引擎访问器（禁自写解析/归一化，防字段漂移 —— 跨表字段绝不假设同名）：
//   银行金额 bankAmountWithExtraFee（|Credit-Debit| + signed Extra Fee）/
//   网关金额 gwAmountAbs（|amount|）—— r5-fund-transfer-backfill 已 export；
//   调拨金额 reconAmountAbs（|金额|）—— r5-fund-transfer-recon-backfill 已 export；
//   normalizeCellValue（engine-utils）；dayDiffWithin（engine-date-utils，含同日）。
//
// 跨表字段（显式映射）：
//   银行（驼峰）：bank.MerchantId / bank.Currency / bank.BillDate / bank._rowId
//   网关（小写）：gw.merchantid / gw.currency / gw.Billdate
//     v3.2.22：网关侧先按原 merchantid 检测（R1 / C3 / R4 等按原账号匹配的轮次，口径与改动前一致）；
//     本次 R5s2 走网关来源且有账户映射时（options.accountMappingMap），再对 R5s2 网关池
//     （FundTransfer-in/out 且 reconciliationid 非空）按映射后账号补跑一遍，只报告含「映射命中网关行」的连通分量，
//     note 标「网关（账户映射后）」。调拨侧 big_account 派生时已映射。
//   调拨（RECON 常量）：rc[RECON.bigAccount] / rc[RECON.currency] / rc[RECON.billDate]
//
// 算法（不限 FundType、不分 in/out 方向 —— 用户已确认放宽到全部银行行）：
//   1. 银行池 = 全部 bankRows（取 R5 后最终值）；对手池：网关=全部 gwRows、调拨=全部 reconRows（两类分别跑）。
//   2. 分组键 = 归一化账号 + ' ' + 归一化币种 + ' ' + round(金额*100)（精确到分）。
//      银行金额先计算 |Credit-Debit| + signed Extra Fee，合计后不再取绝对值；空 fee=0。
//   3. 🔴 空值护栏：账号或币种归一化后为空、或金额非有限数（!Number.isFinite）的行**不进池**
//      （否则空账号会被 normalizeCellValue('')==='' 全并成一个巨型假组）。
//   4. 用 Map<key, {banks, cps}> 哈希分组（O(n+m)）；对两侧都非空的 key，在该小组内构二部图
//      （边 = dayDiffWithin(bank.BillDate, 对手日期, tolerance)），求连通分量；
//      连通分量内 银行≥2 且 对手≥2 → 该分量所有银行行命中（1v1 / 1vN / Nv1 不算）。
//   5. 网关、调拨各跑一遍，命中银行行按 _rowId 去重合并；每条命中带 note（中文说明：对手方 + 键 + 银行N×对手M）。
//
// ⚠️ 放宽副作用（接受）：银行基础发生额取绝对值且不分方向，Extra Fee 再保留符号参与合计；
//   相同最终金额的 credit/debit、in/out 对手仍可能并组多标，属「供人工判断」可接受的偏全（plan §1.1）。
//
// 性能（v3.0.12，输出逐字节不变）：detectOneSide 改「银行优先门控」——先只用银行行建组（仅银行行能
//   创建 group）；若无任何组 银行≥2 则直接返回、**完全不遍历对手池**；对手行「探测即丢」（只并入已存在
//   且 银行≥2 的组，否则丢弃不建组）。另对单组 银行×对手 超 MAX_BIPARTITE_EDGES 的极端大组不建二部图，
//   保守整组银行行命中（🔴 宁可过报，绝不静默漏报）。正常规模数据不触阈值 → 与旧实现命中集完全一致。

const {
  isMappedAccountHit,
  normalizeCellValue,
  resolveMappedAccount
} = require('./engine-utils');
const { dayDiffWithin } = require('./engine-date-utils');
const {
  amountCents,
  bankAmountWithExtraFee,
  collectR5MappedTargetAccounts,
  gwAmountAbs,
  isR5MappedBankRowUnverifiable,
  isR5MappedRowChannelUnverifiable,
  isR5RawAccountTargetAmbiguous,
  mappingTargetFingerprintsOf
} = require('./r5-fund-transfer-backfill');
const { reconAmountAbs } = require('./r5-fund-transfer-recon-backfill');
const { FT_RECON_FIELD_MAP } = require('../../constants/fund-transfer-recon-fields');
const {
  CANONICAL_FUND_TRANSFER_DIRECTIONS,
  normalizeFundTransferDatePolicy
} = require('./fund-transfer-engine-policy');

const RECON = FT_RECON_FIELD_MAP.recon;

// 🔴 大组封顶阈值（性能护栏）：单个同 key 合格组若 银行数×对手数 超过此值，不建二部图（防 O(nb×nc)
//   尖峰卡顿），改为保守把整组银行行全部判命中（资金工具绝不静默封顶/漏报，宁可过报供人工复核）。
const MAX_BIPARTITE_EDGES = 200000;

// 对手方访问器（显式字段映射；account/currency 走 normalizeCellValue，amount 走引擎金额访问器，date 原值给 dayDiffWithin）。
//   includeCp（可选）：对手行入池过滤，在银行优先门控之后逐行判断（门控短路时完全不遍历对手池）；缺省 = 全部入池。
//   requiredCp（可选）：分量 / 整组内至少一个对手行满足才报告；缺省 = 不限制（原口径）。
const GW_ACCESSORS = {
  label: '网关',
  account: (gw) => gw && gw.merchantid,
  currency: (gw) => gw && gw.currency,
  amount: (gw) => gwAmountAbs(gw),
  date: (gw) => gw && gw.Billdate
};
// v3.2.22（🔴 资金红线·只读）：R5s2 网关来源按映射后账号匹配，补跑一遍审计。只对命中映射的网关行所在分量报告，
//   命中判据与 R5s2 同一个 isMappedAccountHit（原账号是映射键，含 `C → C` 同值映射；含 `_xHHHH_` 写法的账号不参与）：
//   同值映射的组在原口径下可能混入非调拨交易类型的网关行（报告 2×3），补跑只看 R5s2 网关池（2×2），
//   两个结论不重复。完全没命中映射的组已由 GW_ACCESSORS 原口径覆盖，不重复说明。
//   不校验 Channel（R5s2 对映射命中行要求同渠道）：跨渠道映射行只可能多报、不会漏报，按本检测器「宁可过报」口径接受；
//   但 R5s2 一定不回填的行按同一判据剔除，不写成「自动回填仅取其一」：网关侧为需同渠道校验而渠道为空或含 `_xHHHH_`
//   写法的行（isR5MappedRowChannelUnverifiable，已单独告警缺渠道 / 渠道转义）及原值按数值读入、与本方向映射目标对不清的行
//   （isR5RawAccountTargetAmbiguous，含命中映射键的行，已单独告警），银行侧为渠道为空、MerchantId 按数值读入且与
//   映射值对得上（前导 0 已丢或可能已丢失精度）、或被前序场景按链接表原文改写且含 `_xHHHH_` 写法的行
//   （isR5MappedBankRowUnverifiable：逐行判断，映射值指纹只算一次，不遍历网关池——与目标账号不同的银行行所在分组本就没有
//   映射命中行、不会被报告）。网关侧的映射目标账号按 TradeType 分方向收集，首次判断对手行时才收集（银行优先门控短路时仍不
//   遍历网关池）。
function mappedGwAccessorsFor(accountMappingMap, gwRows, isRawRewrittenBankValue) {
  const isMapped = (gw) => isMappedAccountHit(accountMappingMap, gw && gw.merchantid);
  const mappingTargetFingerprints = mappingTargetFingerprintsOf(accountMappingMap);
  let targetsByTradeType = null;
  const targetsOf = (tradeType) => {
    if (targetsByTradeType === null) {
      const poolsByTradeType = new Map();
      for (const gw of gwRows) {
        if (!isR5s2GatewayPoolRow(gw)) continue;
        const key = normalizeCellValue(gw.TradeType);
        if (!poolsByTradeType.has(key)) poolsByTradeType.set(key, []);
        poolsByTradeType.get(key).push(gw);
      }
      targetsByTradeType = new Map();
      for (const [key, pool] of poolsByTradeType) {
        targetsByTradeType.set(key, collectR5MappedTargetAccounts(accountMappingMap, pool));
      }
    }
    return targetsByTradeType.get(tradeType);
  };
  return {
    ...GW_ACCESSORS,
    label: '网关（账户映射后）',
    account: (gw) => resolveMappedAccount(accountMappingMap, gw && gw.merchantid),
    includeCp: (gw) => {
      if (!isR5s2GatewayPoolRow(gw)) return false;
      const targets = targetsOf(normalizeCellValue(gw.TradeType));
      return !isR5MappedRowChannelUnverifiable(accountMappingMap, targets, gw) &&
        !isR5RawAccountTargetAmbiguous(accountMappingMap, targets, gw);
    },
    requiredCp: isMapped,
    excludeBank: (bank) => isR5MappedBankRowUnverifiable(bank, isRawRewrittenBankValue, mappingTargetFingerprints)
  };
}
// R5s2 网关池同口径（r5-fund-transfer-backfill：TradeType 属 FundTransfer-in/out 且 reconciliationid 非空）。
const R5S2_GW_TRADE_TYPES = new Set(CANONICAL_FUND_TRANSFER_DIRECTIONS.map((d) => d.gwTradeType));
function isR5s2GatewayPoolRow(gw) {
  return R5S2_GW_TRADE_TYPES.has(normalizeCellValue(gw && gw.TradeType))
    && normalizeCellValue(gw && gw.reconciliationid) !== '';
}
const RECON_ACCESSORS = {
  label: '调拨',
  account: (rc) => rc && rc[RECON.bigAccount],
  currency: (rc) => rc && rc[RECON.currency],
  amount: (rc) => reconAmountAbs(rc),
  date: (rc) => rc && rc[RECON.billDate]
};

// 路径压缩 + 按引用合并的并查集（仅用于同 key 小组内二部图连通分量，规模小）。
function makeUnionFind(n) {
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  return { find, union };
}

// 命中说明（中文，供人工复核）：对手方 + 分组键（账号/币种/金额）+ 本连通分量 银行N×对手M。
// v3.2.22：说明同时给出分段（noteParts）：账号、币种两段标明取自银行行的哪一列（{ column, value }），其余为文字，供导出逐段
//   编码后拼接（见 exceljs-writer encodeManyToManyNoteParts）；note 为分段拼接后的文字，与改动前逐字一致。
//   同一组 / 连通分量的各银行行共用同一个说明与分段（只读，不按行复制）。
function noteOf(parts) {
  return { note: parts.map((part) => (typeof part === 'string' ? part : part.value)).join(''), noteParts: parts };
}
function noteHit(row, shared) {
  return { row, note: shared.note, noteParts: shared.noteParts };
}
function groupKeyParts(cpLabel, group) {
  return [
    `银行↔${cpLabel}多对多：账号 `, { column: 'MerchantId', value: group.account },
    ' / 币种 ', { column: 'Currency', value: group.currency },
    ` / 金额 ${(group.cents / 100).toFixed(2)}，`
  ];
}
function buildNoteParts(cpLabel, group, nBank, nCp) {
  return [...groupKeyParts(cpLabel, group), `本组银行 ${nBank} 行 × ${cpLabel} ${nCp} 行，自动回填仅取其一，请人工复核`];
}

// 计算一行的分组键「账号 + 币种 + 金额分」（空值护栏：任一无效返回 null，不进池）。
//   amount 由调用方传入访问器结果；银行/对手两侧共用，护栏口径与原 pushIntoGroups 逐条一致：
//   normalizeCellValue 后 acc/cur 为空、或 !Number.isFinite(amount) → 返回 null。
//   v3.2.22：键改用 JSON 数组编码（账号、币种可含空格等任意字符，空格拼接会把不同账号币种并成一组，误报多对多；
//   账户映射补跑后的账号尤其可能含空格）；金额乘 100 后溢出视同无效（JSON 会把 ±Infinity 都编码成 null）。
function computeKey(account, currency, amount) {
  const acc = normalizeCellValue(account);
  const cur = normalizeCellValue(currency);
  const cents = amountCents(amount); // 与 R5 amountEqual 同一判据：非有限数或精确到分后溢出 → null
  if (acc === '' || cur === '' || cents === null) return null; // 🔴 空值护栏
  return { acc, cur, cents, key: JSON.stringify([acc, cur, cents]) };
}

// 单侧检测：银行行 × 单一对手池 → 命中银行行（{ row, note }）。纯只读。
//   性能（v3.0.12）：银行优先门控 + 探测即丢 + 大组封顶——输出与「先全建组再整组剪枝」逐字节一致。
function detectOneSide(bankRows, cpRows, cpAccessors, datePolicy) {
  const groups = new Map(); // key -> { account, currency, cents, banks:[], cps:[] }

  // 银行 loop：只有银行行能创建 group（账号=MerchantId、币种=Currency、
  //   金额=|Credit-Debit| + signed Extra Fee；非法 fee → NaN → 退出审计池）。
  for (const b of bankRows) {
    // v3.2.22：映射补跑剔除 R5s2 不用于映射回填的银行行（excludeBank，见 mappedGwAccessorsFor）；缺省不剔除（原口径）。
    if (cpAccessors.excludeBank && cpAccessors.excludeBank(b)) continue;
    const k = computeKey(b && b.MerchantId, b && b.Currency, bankAmountWithExtraFee(b));
    if (!k) continue; // 🔴 空值护栏
    let g = groups.get(k.key);
    if (!g) {
      g = { account: k.acc, currency: k.cur, cents: k.cents, banks: [], cps: [] };
      groups.set(k.key, g);
    }
    g.banks.push(b);
  }

  // 🔴 门控短路：没有任何 group 的 银行≥2 → 任何组都不可能命中（连通分量需 银行≥2 且 对手≥2）→
  //   直接返回，**完全不遍历 cpRows**（常见无碰撞场景整段跳过对手池扫描）。
  let anyQualifying = false;
  for (const g of groups.values()) {
    if (g.banks.length >= 2) { anyQualifying = true; break; }
  }
  if (!anyQualifying) return [];

  // 对手 loop（探测即丢）：只 push 进**已存在且 银行≥2** 的 group；否则丢弃、**不为它创建 group**。
  //   等价性：banks<2 的 group 本就会在下方剪枝、无银行的 cp 键本就不产生命中 → 命中集逐字节不变。
  for (const c of cpRows) {
    if (cpAccessors.includeCp && !cpAccessors.includeCp(c)) continue;
    const k = computeKey(cpAccessors.account(c), cpAccessors.currency(c), cpAccessors.amount(c));
    if (!k) continue; // 🔴 空值护栏
    const g = groups.get(k.key);
    if (!g || g.banks.length < 2) continue;
    g.cps.push(c);
  }

  const hits = [];
  for (const g of groups.values()) {
    // 快速剪枝：连通分量要 银行≥2 且 对手≥2，整组任一侧 <2 必不可能命中。
    if (g.banks.length < 2 || g.cps.length < 2) continue;

    const nb = g.banks.length;
    const nc = g.cps.length;

    // v3.2.22：带 requiredCp 的补跑（账户映射后）整组都没有映射命中行 → 不可能有合格分量。
    if (cpAccessors.requiredCp && !g.cps.some(cpAccessors.requiredCp)) continue;

    // 日期策略关闭：同账号/币种/金额的 2×2 组即为完整二部图结论。
    // 不解析任一日期，也不实际构造 N×M 边；空/非法/跨年日期均不额外阻断。
    if (!datePolicy.enabled) {
      const shared = noteOf(buildNoteParts(cpAccessors.label, g, nb, nc));
      for (const bankRow of g.banks) hits.push(noteHit(bankRow, shared));
      continue;
    }

    // 🔴 大组封顶：nb×nc 超阈值则不建二部图（防 O(nb×nc) 尖峰），保守把整组银行行全部判命中。
    //   资金工具绝不静默封顶/漏报——宁可过报：用区别于普通命中的 note（含「规模过大」）把整组银行行写进
    //   「异常-人工判断」sheet，作为**用户可见**的非静默信号（比终端日志更强：用户在结果文件直接看到）。
    //   不在此处打印 raw 终端告警——src/main-process 走结构化 logger、禁直接终端告警（见 SR-log-1）；
    //   且本引擎为纯只读函数，无 logger / app 上下文可注入，故以「命中行 + 显著 note」承担非静默职责。
    if (nb * nc > MAX_BIPARTITE_EDGES) {
      const shared = noteOf(
        [...groupKeyParts(cpAccessors.label, g), `本组规模过大（银行 ${nb} × 对手 ${nc}）未逐对精算，整组列出供人工复核`]
      );
      for (const b of g.banks) hits.push(noteHit(b, shared));
      continue;
    }

    const uf = makeUnionFind(nb + nc);
    // 二部图建边：bank i ↔ cp j 当且仅当日期 ±tolerance（含同日）。bank → 节点 i；cp → 节点 nb+j。
    for (let i = 0; i < nb; i++) {
      const bankDate = g.banks[i] && g.banks[i].BillDate;
      for (let j = 0; j < nc; j++) {
        if (dayDiffWithin(bankDate, cpAccessors.date(g.cps[j]), datePolicy.toleranceDays)) {
          uf.union(i, nb + j);
        }
      }
    }
    // 按连通分量根聚合 银行/对手 索引。
    const comps = new Map(); // root -> { bankIdx:[], cpIdx:[] }
    for (let i = 0; i < nb; i++) {
      const r = uf.find(i);
      if (!comps.has(r)) comps.set(r, { bankIdx: [], cpIdx: [] });
      comps.get(r).bankIdx.push(i);
    }
    for (let j = 0; j < nc; j++) {
      const r = uf.find(nb + j);
      if (!comps.has(r)) comps.set(r, { bankIdx: [], cpIdx: [] });
      comps.get(r).cpIdx.push(j);
    }
    // 连通分量内 银行≥2 且 对手≥2 → 该分量所有银行行命中。
    for (const comp of comps.values()) {
      if (comp.bankIdx.length >= 2 && comp.cpIdx.length >= 2) {
        if (cpAccessors.requiredCp && !comp.cpIdx.some((j) => cpAccessors.requiredCp(g.cps[j]))) continue;
        const shared = noteOf(buildNoteParts(cpAccessors.label, g, comp.bankIdx.length, comp.cpIdx.length));
        for (const bi of comp.bankIdx) {
          hits.push(noteHit(g.banks[bi], shared));
        }
      }
    }
  }
  return hits;
}

/**
 * v3.0.12 功能1：检测「银行 ↔ 网关 / 调拨」多对多的银行行（纯只读，不改任何 bankRow / 回填）。
 *
 * @param {Array<Object>} bankRows  R5 后最终态银行行（带 _rowId；不限 FundType）
 * @param {Array<Object>} gwRows    网关对账单行（safeGwRows；不按 TradeType 过滤）
 * @param {Array<Object>} reconRows 调拨对账单派生行（fundTransferReconContext.reconRows；取消路为 [] → 调拨检测 no-op）
 * @param {Object} [options]
 * @param {Object} [options.fundTransferDatePolicy] 主流程解析后的不可变日期策略（{ enabled, toleranceDays }）
 * @param {boolean} [options.dateMatchEnabled] 旧直接调用兼容：是否启用日期
 * @param {number} [options.dateToleranceDays] 日期容差天数（默认 1，含同日 ±1）
 * @param {Map<string,string>} [options.accountMappingMap] v3.2.22 本次 R5s2 网关来源实际使用的账户映射；
 *   仅编排器在 R5s2 走网关来源时传入。非空时对 R5s2 网关池按映射后账号补跑一遍（缺省 / 空 = 不补跑，原口径）
 * @param {(bankRow: Object, column: string) => boolean} [options.isRawRewrittenBankValue] v3.2.22 银行行该列当前值是否为
 *   前序场景按链接表原文改写（编排器提供，与 R5s2 同一口径；只用于映射补跑剔除银行行）
 * @returns {{ reviewRows: Array<{ row: Object, note: string, noteParts: Array<string|{column:string,value:string}> }> }}
 *   reviewRows：命中银行行的**引用** + 中文说明（noteParts 为同一说明的分段，见 noteHit）；按 bankRows 原序稳定排序；
 *   空入参 → { reviewRows: [] }。
 */
function detectFundTransferManyToMany(bankRows, gwRows, reconRows, options = {}) {
  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];
  const safeGwRows = Array.isArray(gwRows) ? gwRows : [];
  const safeReconRows = Array.isArray(reconRows) ? reconRows : [];
  const datePolicy = normalizeFundTransferDatePolicy(options);

  // 空入参 no-op（无银行行 → 无可标记）。
  if (safeBankRows.length === 0) return { reviewRows: [] };

  const gwHits = safeGwRows.length > 0
    ? detectOneSide(safeBankRows, safeGwRows, GW_ACCESSORS, datePolicy)
    : [];
  const accountMappingMap = options.accountMappingMap;
  const mappedGwHits = safeGwRows.length > 0 && accountMappingMap instanceof Map && accountMappingMap.size > 0
    ? detectOneSide(
      safeBankRows, safeGwRows, mappedGwAccessorsFor(accountMappingMap, safeGwRows, options.isRawRewrittenBankValue), datePolicy
    )
    : [];
  const reconHits =
    safeReconRows.length > 0
      ? detectOneSide(safeBankRows, safeReconRows, RECON_ACCESSORS, datePolicy)
      : [];

  // 网关 + 调拨命中按 _rowId 去重合并 note（同一银行行两侧都命中 → 两条说明拼接）。
  //   _rowId 缺失时回退按对象引用去重（同一 run 内 bankRows 引用稳定）。
  const keyOf = (row) => (row && row._rowId !== undefined && row._rowId !== null ? row._rowId : row);
  const byRow = new Map(); // key -> { row, notes:[], noteParts:[] }
  for (const h of gwHits) appendHit(byRow, keyOf(h.row), h);
  for (const h of mappedGwHits) appendHit(byRow, keyOf(h.row), h);
  for (const h of reconHits) appendHit(byRow, keyOf(h.row), h);

  // 按 bankRows 原序稳定输出（便于 sheet 阅读 + 测试可预期）。
  const reviewRows = [];
  const emitted = new Set();
  for (const b of safeBankRows) {
    const k = keyOf(b);
    if (!byRow.has(k) || emitted.has(k)) continue;
    emitted.add(k);
    const entry = byRow.get(k);
    // 只有一条说明时直接沿用（同组各行共用同一引用）；多条时才拼接。
    if (entry.notes.length === 1) {
      reviewRows.push({ row: entry.row, note: entry.notes[0], noteParts: entry.noteParts[0] });
      continue;
    }
    const noteParts = [];
    entry.noteParts.forEach((parts, index) => {
      if (index > 0) noteParts.push('; ');
      for (const part of parts) noteParts.push(part);
    });
    reviewRows.push({ row: entry.row, note: entry.notes.join('; '), noteParts });
  }
  return { reviewRows };
}

function appendHit(byRow, key, hit) {
  let entry = byRow.get(key);
  if (!entry) {
    entry = { row: hit.row, notes: [], noteParts: [] };
    byRow.set(key, entry);
  }
  if (!entry.notes.includes(hit.note)) {
    entry.notes.push(hit.note);
    entry.noteParts.push(hit.noteParts);
  }
}

module.exports = {
  detectFundTransferManyToMany
};
