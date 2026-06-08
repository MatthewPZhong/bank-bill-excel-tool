// v2.1.16-beta.5 需求5：JPM 调拨订单修复引擎（逻辑B，8 步状态机）
//
// 🔴🔴 资金红线（PRD §5.5 / TECH §四 / §十）：
//   三段自动匹配「渠道账单 ↔ ADM 银行对账单表 ↔ 网关账单」，命中后写资金对账ID（reconciliationId）、
//   网关账单 Reference / Type、ADM 表匹配标志。任一字段映射 / 金额汇总 / 批次 gating 判定错误 →
//   写错资金对账ID 或网关修复行，直接污染资金对账结果。
//
// 设计契约（务必遵守）：
//   1. 跨表字段名大小写不一致 → 全程经 FIELD_MAP 常量 pick，绝不手敲字段名（R-1）。
//      渠道账单 merchantId(小写) / 网关账单 MerchantId(驼峰) / ADM 表 MerchantId(驼峰)；
//      网关账单 Type 列名超长缺右括号 → 用 GATEWAY_BILL_FIELDS[FIELD_MAP.gwTypeIndex] 引用。
//   2. merchantId 从 scenario.config.merchantId 读，不硬编码（R-10）。
//   3. 金额汇总（步骤4）逐笔 Math.round(parseNumber(v)*100) 转分再累加，严禁先浮点累加后 round（R-2）。
//   4. admUpdates 必须是「传入的同一个 admRows 数组」——引擎只对数组里的对象原地改字段，
//      绝不 filter / 重排 / 增删行。最终原样返回 admRows，遵守 PR-1 writeAdmMatchFlags 的
//      「DB id ASC 顺序 ↔ admRows 下标」配对契约（行数/顺序不变，否则按位置写回会错位污染资金数据）。
//      引擎内部按 BillDate/批次号筛选用 filter 产生的「引用视图」（指向原数组里的同一批对象），
//      原地改对象属性会反映回原数组——这是预期；但绝不把 filter 结果当 admUpdates 返回。
//
// 入参：{ sheets, admRows, scenario }
//   sheets：{ reconResult, businessBills(=网关账单), opponentBills(=渠道账单), fixTemplate }
//           —— recon-id-fix-io.readReconIdFixFile(filePath,'gateway') 产出，key 沿用 C4 约定。
//   admRows：database.readAdmBankDepositRows() 读出的 ADM 行数组（13 银行字段 + 6 新字段）。
//   scenario：{ id, name, config:{ subCategory, merchantId }, ... }。
// 返回：{ fixedRows, admUpdates, warnings, stats }

const { normalizeCellValue, parseNumber, makeWarningCollector } = require('./engine-utils');
const { toDate } = require('./engine-date-utils');
const { GATEWAY_BILL_FIELDS } = require('../../constants/gateway-bill-recon-fields');
const { FIELD_MAP } = require('../../constants/adm-bank-deposit-fields');
const { buildOutputRow } = require('./c4-recon-id-fix');

// 网关账单 Type 列名（超长缺右括号；GATEWAY_BILL_FIELDS[8]）——常量引用，禁止手敲（R-1/R-3）。
const GW_TYPE_COL = GATEWAY_BILL_FIELDS[FIELD_MAP.gwTypeIndex];

// 出账日期提取正则（步骤2，决策5 / R-8）：additionInfo 内 ' YY/MM/DD '（空白定界）。
//   空白定界保证 JSON 内金额 2100000.00（无斜杠）不命中；只锚定「(^|空白) 两位/两位/两位 (空白|$)」。
const DATE_IN_ADDITION = /(?:^|\s)(\d{2})\/(\d{2})\/(\d{2})(?:\s|$)/;

// 把任意日期输入规范化为 'YYYY-MM-DD'（与 PR-2 linked-table-repository.normalizeDateForRange 同口径：
//   均基于 normalizers.normalizeDateExportValue 的 .date 本地午夜重格式化），确保 ADM 行 BillDate
//   规范化结果与渠道账单出账日期（也走本函数）byte-for-byte 对齐。无效 / 空 → null。
function toIsoDate(value) {
  const d = toDate(value);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 步骤2：从渠道账单 additionInfo 提取出账日期 → 补世纪 20YY → 'YYYY-MM-DD'。
//   提取不到 / 非法日期(13月/32日，toDate 返回 null) → 返回 null（调用端跳过该行 + warn）。
function extractBillDate(additionInfo) {
  const s = String(additionInfo == null ? '' : additionInfo);
  const m = s.match(DATE_IN_ADDITION);
  if (!m) return null;
  const iso = `20${m[1]}-${m[2]}-${m[3]}`; // 补世纪 20YY
  return toIsoDate(iso); // toDate 校验非法日期（如 26/13/40）；无效 → null
}

// 步骤4：整组 Fundtransfer-in金额 逐笔转分累加 === receiveAmount 分值（容差 0）。
//   🔴 严禁先浮点累加后 round——必须逐笔 Math.round(v*100) 转分再累加（仿 r5-* amountEqual 口径）。
//   任一非数值（parseNumber → null）→ 整组不匹配（返回 false）。
function sumEqualsReceive(admGroup, receiveAmount) {
  let cents = 0;
  for (const a of admGroup) {
    const v = parseNumber(a[FIELD_MAP.admFundtransferInAmount]); // 'Fundtransfer-in金额'
    if (v === null) return false; // 任一非数值 → 整组不匹配
    cents += Math.round(v * 100); // 🔴 先 round 再累加
  }
  const recv = parseNumber(receiveAmount);
  return recv !== null && cents === Math.round(recv * 100); // 容差 0
}

// 按 keyFn 分组（保留原数组对象引用），返回 Map<key, row[]>。
function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function runJpmDispatchOrderFix({ sheets, admRows, scenario }) {
  const safeSheets = sheets || {};
  const channelRows = Array.isArray(safeSheets.opponentBills) ? safeSheets.opponentBills : []; // 渠道账单
  const gwRows = Array.isArray(safeSheets.businessBills) ? safeSheets.businessBills : []; // 网关账单
  const rows = Array.isArray(admRows) ? admRows : [];
  const cfg = (scenario && scenario.config) || {};
  const MID = normalizeCellValue(cfg.merchantId); // 商户号从 config 读，不硬编码（R-10）
  const warn = makeWarningCollector(scenario && scenario.id, scenario && scenario.name);

  const stats = {
    channelTotal: channelRows.length,
    channelMatched: 0, // 步骤1 过 merchantId 的渠道行数
    channelHit: 0, // 步骤5 金额汇总命中（消费）的渠道行数
    admChannelMatched: 0, // 是否与渠道账单匹配=1 的 ADM 行数
    readyBatches: 0, // 步骤6 进网关段的批次号数
    gwHit: 0, // 步骤7 命中的网关行数
    admGatewayMatched: 0, // 是否与网关账单匹配=1 的 ADM 行数
    fixedRowCount: 0
  };

  // —— 步骤1：渠道账单过滤 merchantId ——
  const channels = channelRows.filter((r) => normalizeCellValue(r[FIELD_MAP.chMerchantId]) === MID && MID !== '');
  stats.channelMatched = channels.length;
  if (channels.length === 0) {
    // 渠道账单无该商户号 → 引擎 no-op：空 fixedRows + 提示；admUpdates 原样返回（PR-1 契约：同一数组）。
    warn.push({ code: 'channel-merchant-not-found', merchantId: MID });
    return { fixedRows: [], admUpdates: rows, warnings: warn.list(), stats };
  }

  // M9.1 修复（v2.1.16-beta.6 self-review · 🔴 资金红线 · 真幂等可重入）：
  //   入口整批重置 ADM 行三个可写标志为初始态（与 buildAdmRows 初值一致：资金对账ID='' / 两标志数值 0），再全量重算。
  //   根因：步骤3 按「是否与渠道账单匹配==0」筛候选 ADM 行，命中后置 1 + 写资金对账ID，经 main.js writeAdmMatchFlags
  //   持久化回 DB；二次运行（未重导入金表 → ADM 表未重建）时旧标志残留 → 候选被筛空 → stats.channelHit 失真为 0
  //   （导出 fixedRows / 资金对账ID 仍正确，因 readyBatches 仍读到全 1）。重置后每次 run 从干净态全量重算 → stats 准确。
  //   放在 channels.length===0 早返回之后：无商户匹配的 no-op run 不应清掉上一轮已持久化的匹配态。
  for (const a of rows) {
    a[FIELD_MAP.admReconFundId] = '';
    a[FIELD_MAP.admChannelMatched] = 0;
    a[FIELD_MAP.admGatewayMatched] = 0;
  }

  // F3b 修复（self-review）：先统计每个出账日期命中的渠道账单笔数（设计假设「一个出账日期对一笔渠道账单」）。
  //   同一出账日期若有多笔渠道账单，步骤4 整组求和必不平、静默不命中且易误导排查 → 显式 channel-date-collision warn（每日期一次）。
  const billDateChannelCount = new Map();
  for (const c of channels) {
    const bd = extractBillDate(c[FIELD_MAP.chAdditionInfo]);
    if (bd) billDateChannelCount.set(bd, (billDateChannelCount.get(bd) || 0) + 1);
  }
  const warnedDateCollision = new Set();

  // —— 阶段1：渠道账单匹配（步骤2~5）——
  const usedChannel = new Set(); // 渠道账单行 1v1 消费（命中后不再被其他出账日期复用）
  for (const c of channels) {
    if (usedChannel.has(c)) continue;
    // 步骤2：提取出账日期
    const billDate = extractBillDate(c[FIELD_MAP.chAdditionInfo]); // 'additionInfo'
    if (!billDate) {
      warn.push({ code: 'addition-date-not-found', reconId: normalizeCellValue(c[FIELD_MAP.chReconId]) });
      continue;
    }
    if ((billDateChannelCount.get(billDate) || 0) > 1 && !warnedDateCollision.has(billDate)) {
      warn.push({ code: 'channel-date-collision', billDate, count: billDateChannelCount.get(billDate) });
      warnedDateCollision.add(billDate);
    }

    // 步骤3：候选 ADM 行 = BillDate==出账日期（规范化后比，与出账日期同 toIsoDate 口径）∧ 是否与渠道账单匹配==0。
    //   group 是「引用视图」——里面的对象就是 rows 数组里的同一批对象（filter 不复制对象）。
    const group = rows.filter((a) =>
      toIsoDate(a[FIELD_MAP.admBillDate]) === billDate
      && Number(a[FIELD_MAP.admChannelMatched]) === 0);
    if (group.length === 0) {
      warn.push({ code: 'channel-no-adm', billDate, reconId: normalizeCellValue(c[FIELD_MAP.chReconId]) });
      continue;
    }

    // 步骤4：整组 Fundtransfer-in金额 逐笔转分累加 === receiveAmount 分值（容差0）。
    if (!sumEqualsReceive(group, c[FIELD_MAP.chReceiveAmount])) { // 'receiveAmount'
      warn.push({ code: 'channel-amount-mismatch', billDate, reconId: normalizeCellValue(c[FIELD_MAP.chReconId]) });
      continue;
    }

    // 步骤5：命中 → 组内 ADM 行（原数组里的对象）原地赋值 资金对账ID + 是否与渠道账单匹配=1；渠道账单 1v1 消费。
    const reconFundId = normalizeCellValue(c[FIELD_MAP.chReconId]); // 渠道账单 reconciliationId
    for (const a of group) {
      a[FIELD_MAP.admReconFundId] = reconFundId; // '资金对账ID'
      a[FIELD_MAP.admChannelMatched] = 1; // '是否与渠道账单匹配'
    }
    usedChannel.add(c);
    stats.channelHit += 1;
    stats.admChannelMatched += group.length;
  }

  // —— 阶段2：批次 gating（步骤6）——
  //   按批次号 group；批次号非空 ∧ 组内 ADM 行「是否与渠道账单匹配」全为 1 → 才进网关段。
  //   （同一批次号的 ADM 行可能跨多个出账日期，需各自匹配齐 —— 决策7。）
  const byBatch = groupBy(rows, (a) => normalizeCellValue(a[FIELD_MAP.admBatchNo])); // '批次号'
  const readyBatches = [...byBatch.entries()].filter(([bn, batchRows]) =>
    bn !== '' && batchRows.every((a) => Number(a[FIELD_MAP.admChannelMatched]) === 1));
  stats.readyBatches = readyBatches.length;

  // —— 阶段3：网关账单匹配（步骤6/7）——
  const gwUsed = new Set(); // 网关账单行 1v1 消费
  for (const [bn, batchRows] of readyBatches) {
    // F2 修复（self-review）：同一批次号可跨多个出账日期，步骤5 对各出账日期组分别赋「该日期渠道账单 reconId」，
    //   故同批次内「资金对账ID」未必同值 → Reference 改按行级 a[admReconFundId] 取（见下方循环内），不用批级 batchRows[0]。
    // 决策8：Type 按该批次号行数 >1→2、=1→0（Type=2 仅标记「该批次号属多行聚合」，非传统多对1聚合）。
    const type = batchRows.length > 1 ? 2 : 0;
    for (const a of batchRows) {
      const alloc = normalizeCellValue(a[FIELD_MAP.admAllocationNo]); // '调拨号'
      if (alloc === '') continue; // 调拨号为空（中台未匹配）→ 跳过，不进网关匹配
      // 步骤7：OrderId↔调拨号 1v1（网关账单 filter MerchantId===merchantId ∧ OrderId===调拨号 ∧ 未消费）。
      const cand = gwRows.filter((g) =>
        normalizeCellValue(g[FIELD_MAP.gwMerchantId]) === MID // 'MerchantId'
        && normalizeCellValue(g[FIELD_MAP.gwOrderId]) === alloc // 'OrderId'
        && !gwUsed.has(g));
      if (cand.length === 0) {
        warn.push({ code: 'gw-orderid-not-found', batch: bn, allocationNo: alloc });
        continue;
      }
      if (cand.length > 1) {
        // 多匹配 → 取第一 + warn（决策8：1v1，多匹配视为数据异常但不中断）。
        warn.push({ code: 'gw-multi-match', batch: bn, allocationNo: alloc, count: cand.length });
      }
      const g = cand[0];
      g[FIELD_MAP.gwReference] = normalizeCellValue(a[FIELD_MAP.admReconFundId]); // 'Reference' = 该 ADM 行资金对账ID（行级，F2 修复）
      g[GW_TYPE_COL] = type; // Type 超长缺括号列（常量引用）
      gwUsed.add(g);
      a[FIELD_MAP.admGatewayMatched] = 1; // '是否与网关账单匹配'
      stats.gwHit += 1;
      stats.admGatewayMatched += 1;
    }
  }

  // —— 步骤8：收集 fixedRows ——
  //   网关账单中 Reference ∧ Type(GW_TYPE_COL) 均有值的行 → fixedRows（导出用）。
  //   复用 c4 buildOutputRow(g, {}, 'gateway')（14 列 ORDER_REPAIR_FIELDS_GATEWAY）；
  //   ⚠️ buildOutputRow 的 gateway 输出列含 'Type'（短名），它会从 srcRow['Type'] 取值——
  //   而我们写的是 GW_TYPE_COL（超长缺括号名）。故构造 overrides 显式把 Type 短名 + Reference 注入，
  //   保证导出行的 Type/Reference 列取到正确值（不依赖 srcRow 同名短列）。
  const fixedRows = [];
  for (const g of gwRows) {
    const reference = normalizeCellValue(g[FIELD_MAP.gwReference]);
    const typeVal = g[GW_TYPE_COL];
    const typeStr = normalizeCellValue(typeVal);
    if (reference !== '' && typeStr !== '') {
      fixedRows.push(buildOutputRow(g, {
        Type: typeVal,
        Reference: g[FIELD_MAP.gwReference]
      }, 'gateway'));
    }
  }
  stats.fixedRowCount = fixedRows.length;

  // admUpdates = 传入的同一个 admRows 数组（已原地改字段，行数/顺序不变 —— 遵守 PR-1 契约）。
  return { fixedRows, admUpdates: rows, warnings: warn.list(), stats };
}

module.exports = {
  runJpmDispatchOrderFix,
  // 暴露内部工具供单测
  extractBillDate,
  sumEqualsReceive,
  toIsoDate,
  DATE_IN_ADDITION,
  GW_TYPE_COL
};
