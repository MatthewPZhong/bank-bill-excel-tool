// v3.0.4 块 E 需求3：BOC 调拨订单修复引擎（渠道账单驱动，8 步状态机）
// v3.0.8 需求5（🔴 资金红线，用户确认业务语义）：修复行 Type 由 2 → 1。
//
// 🔴🔴 资金红线（spec §4 F3 / §7 失败语义）：
//   三方自动匹配「渠道账单(channelName=BOC) ↔ BOC链接表(分组/调拨单号/资金对账不平表链接ID) ↔ 网关账单(OrderId)」，
//   命中后复制网关命中行 N 份写资金对账修复行（Type=1 / Reference=链接ID / Amount=货币1金额）。任一字段映射 /
//   分组聚合 / 1v1 消耗 / OrderId 命中判定错误 → 产出错误修复行，直接污染资金对账结果。
//
// ⚠️⚠️ 失败语义比 JPM「从严」（防后人误对齐 JPM）：
//   - JPM 引擎（jpm-dispatch-order-fix.js）网关多命中时「取第一行 + warn」继续产出（D8 JPM 口径）。
//   - 本 BOC 引擎网关多命中（gw-orderid-multi-match）/ 0 命中 / 组内任一 1v1 失配 / 链接ID 跨多组 /
//     两组共享调拨单号 / 调拨单号不一致或缺失 / 链接ID 为空 —— 一律「整组失败：不产出、不消耗任何已试配渠道行」。
//   - 资金红线宁缺勿错：BOC 修复行复制 N 份的放大效应（一个网关行被复制成多行）使「错配」风险高于 JPM，
//     故本引擎对一切歧义从严判失败。**禁止把本引擎「对齐」成 JPM 的取第一行/继续产出语义。**
//
// 设计契约（务必遵守）：
//   1. 跨表字段名口径不一致 → 全程经 boc-dispatch-order-fields.FIELD_MAP pick，绝不手敲字段名（R-1）。
//   2. channelName 从 scenario.config.channelName 读，常量 BOC_CHANNEL_NAME 兜底（R-10）。
//   3. 纯函数：不读 DB / 不写日志 / 不依赖 Electron；**入参只读**（sheets 三数组与 bocLinkRows 不被修改，
//      单测深快照断言）；链接表只读不回写（无 JPM writeAdmMatchFlags 类比物）；同输入必同输出。
//   4. Type 写 number 1（v3.0.8 需求5；原 D9 为 number 2，业务确认后改 1；writer 原样落数值格）；
//      Amount 取「货币1金额」原值透传不 parseNumber 改写（D10）。
//
// 入参：{ sheets, bocLinkRows, scenario }
//   sheets：{ reconResult, businessBills(=网关账单), opponentBills(=渠道账单), fixTemplate }
//           —— recon-id-fix-io.readReconIdFixFile(filePath,'gateway') 产出，key 沿用 C4 约定。
//   bocLinkRows：database.readBocFxLinkRows() 读出的 BOC链接表行数组（交割表真实表头 + 分组/调拨单号/资金对账不平表链接ID）。
//   scenario：{ id, name, config:{ subCategory, channelName }, ... }。
// 返回：{ fixedRows, warnings, stats }（无 admUpdates —— BOC 不回写链接表）。

const { normalizeCellValue, makeWarningCollector } = require('./engine-utils');
const { FIELD_MAP } = require('../../constants/boc-dispatch-order-fields');
const { BOC_CHANNEL_NAME } = require('../../constants/boc-dispatch-order-fields');
const { buildOutputRow } = require('./c4-recon-id-fix');

function runBocDispatchOrderFix({ sheets, bocLinkRows, scenario }) {
  const safeSheets = sheets || {};
  const channelRows = Array.isArray(safeSheets.opponentBills) ? safeSheets.opponentBills : []; // 渠道账单
  const gwRows = Array.isArray(safeSheets.businessBills) ? safeSheets.businessBills : []; // 网关账单
  const linkRows = Array.isArray(bocLinkRows) ? bocLinkRows : [];
  const cfg = (scenario && scenario.config) || {};
  // channelName 从 config 读，常量兜底（R-10）；D5：trim 后精确等值、大小写敏感。
  const CHANNEL_NAME = normalizeCellValue(cfg.channelName) !== ''
    ? normalizeCellValue(cfg.channelName)
    : BOC_CHANNEL_NAME;
  const warn = makeWarningCollector(scenario && scenario.id, scenario && scenario.name);

  const stats = {
    channelTotal: channelRows.length,
    channelBocTotal: 0, // 步骤1 过 channelName=BOC 的渠道行数
    channelEmptyReconId: 0, // 步骤3 reconciliationId 空被跳过的 BOC 渠道行数
    channelUnlinked: 0, // 步骤3 reconciliationId 未命中链接表的 BOC 渠道行数（D6 只计数不告警）
    linkRowTotal: linkRows.length,
    linkGroupTotal: 0, // 分组非空的链接表行聚合出的组数
    groupTouched: 0, // 被渠道行命中而进入组级处理的组数
    groupMatched: 0, // 整组匹配成功（产出修复行）的组数
    groupFailed: 0, // 整组失败的组数
    fixedRowCount: 0 // renderer.js:4462 消费，键名必须保留
  };

  // —— 步骤1：渠道账单过滤 channelName=BOC（D5 trim 精确等值）——
  const bocChannels = channelRows.filter(
    (r) => normalizeCellValue(r[FIELD_MAP.chChannelName]) === CHANNEL_NAME
  );
  stats.channelBocTotal = bocChannels.length;
  // 渠道无 BOC 行 → 早返回（warn 带中文 message）。
  if (bocChannels.length === 0) {
    warn.push({ code: 'boc-channel-not-found', channelName: CHANNEL_NAME, message: `渠道账单中没有 channelName=${CHANNEL_NAME} 的行` });
    return { fixedRows: [], warnings: warn.list(), stats };
  }
  // BOC链接表为空 → 早返回。
  if (linkRows.length === 0) {
    warn.push({ code: 'boc-link-table-empty', message: 'BOC链接表为空，无法匹配；请先导入外汇交割表生成链接表' });
    return { fixedRows: [], warnings: warn.list(), stats };
  }

  // —— 步骤2：建索引 ——
  // linkGroups：仅「分组」非空的链接表行，按分组号聚合（Map<groupNo, row[]>，保留原数组对象引用）。
  const linkGroups = new Map();
  for (const lr of linkRows) {
    const g = normalizeCellValue(lr[FIELD_MAP.linkGroup]);
    if (g === '') continue; // 分组空（2.2 已剔除/未成组）→ 不进任何组
    if (!linkGroups.has(g)) linkGroups.set(g, []);
    linkGroups.get(g).push(lr);
  }
  stats.linkGroupTotal = linkGroups.size;

  // linkByReconId：资金对账不平表链接ID → 命中该 ID 的组号集合（D7 跨多组判定）。
  const linkByReconId = new Map();
  for (const [groupNo, rows] of linkGroups.entries()) {
    for (const lr of rows) {
      const rid = normalizeCellValue(lr[FIELD_MAP.linkReconLinkId]);
      if (rid === '') continue; // 链接ID 空：D2 留待组级校验整组失败，不进 reconId 索引
      if (!linkByReconId.has(rid)) linkByReconId.set(rid, new Set());
      linkByReconId.get(rid).add(groupNo);
    }
  }

  // —— 消耗/占用集合 ——（提前到 D7 eager 预扫前声明，预扫直接写 processedGroups）
  const usedChannel = new Set(); // 渠道 BOC 行 1v1 消耗（命中组提交后置入；失败组不消耗）
  const usedAllocation = new Set(); // 已被成功组占用的调拨单号（D8：两组共享 → 第二组失败）
  const processedGroups = new Set(); // 已处理（成功或失败）的组号（避免一组被多渠道行重复处理）
  const fixedRows = [];

  // —— D7 eager 预扫（资金红线·确定性）：任何链接ID 跨多组（size>1）→ 涉及的全部组立即整组判失败 ——
  //   背景（PR #71 self-review CONFIRMED finding）：原惰性检测（仅在步骤3 按渠道行序碰到歧义 ID 时才标记）
  //   依赖渠道行遍历顺序——组1=[链接ID L,M]、组2 含同一 L 时，渠道行序 [M,L] 会让组1 先经 M 提交成功
  //   （产出含歧义 Reference=L 的修复行），随后才发现 L 歧义、只把组2 记失败；行序 [L,M] 则两组都不产出。
  //   同数据换行序产出不同资金修复结果，违反文件头「跨多组一律整组失败：不产出、不消耗」契约。
  //   修法：建完 linkByReconId 后立即对全部歧义 ID 预扫，把涉及的全部组先标记失败（进 processedGroups +
  //   groupTouched/groupFailed 计数 + warn 一次性列出涉及组号），步骤3 不再对这些组做任何提交。
  //   ⇒ ①确定性：同数据任意渠道行序产出完全一致；②歧义 ID 涉及的组绝不产出修复行；③stats 与 warn 文案一致。
  for (const [rid, groupSet] of linkByReconId.entries()) {
    if (groupSet.size <= 1) continue;
    const groupList = [...groupSet].sort();
    for (const gNo of groupList) {
      if (processedGroups.has(gNo)) continue; // 同一组可能被多个歧义 ID 涉及，去重避免重复计数
      processedGroups.add(gNo);
      stats.groupTouched += 1;
      stats.groupFailed += 1;
    }
    warn.push({
      code: 'link-id-ambiguous',
      reconLinkId: rid,
      groups: groupList,
      message: `链接ID「${rid}」跨多个分组（${groupList.join('、')}），数据异常，相关分组全部不修复`
    });
  }

  // channelByReconId：渠道 BOC 行按 reconciliationId 聚合（步骤5 的 1v1 消耗候选池）。
  const channelByReconId = new Map();
  for (const c of bocChannels) {
    const rid = normalizeCellValue(c[FIELD_MAP.chReconId]);
    if (rid === '') continue;
    if (!channelByReconId.has(rid)) channelByReconId.set(rid, []);
    channelByReconId.get(rid).push(c);
  }

  // —— 步骤3：按渠道 BOC 行原序遍历，定位待处理组 ——
  for (const c of bocChannels) {
    const rid = normalizeCellValue(c[FIELD_MAP.chReconId]);
    if (rid === '') {
      stats.channelEmptyReconId += 1; // reconciliationId 空 → 计数跳过
      continue;
    }
    const groupSet = linkByReconId.get(rid);
    if (!groupSet || groupSet.size === 0) {
      stats.channelUnlinked += 1; // 未命中链接表 → 只计数不告警（D6，避免无关行刷屏）
      continue;
    }
    // D7 防御兜底（理论不可达）：歧义 ID 跨多组的全部组已在步骤2 后的 eager 预扫整组判失败并进
    //   processedGroups，故此处 size>1 不应再出现。保留此分支仅为防御——直接跳过、绝不提交（不产出、不消耗）。
    if (groupSet.size > 1) continue;

    const groupNo = [...groupSet][0];
    if (processedGroups.has(groupNo)) continue; // 该组已处理（成功/失败）→ 跳过
    processedGroups.add(groupNo);
    stats.groupTouched += 1;

    const ok = tryCommitGroup(groupNo, linkGroups.get(groupNo) || []);
    if (ok) stats.groupMatched += 1;
    else stats.groupFailed += 1;
  }

  stats.fixedRowCount = fixedRows.length;
  return { fixedRows, warnings: warn.list(), stats };

  // ===== 整组试配（步骤4~7）：成功 → push 修复行 + 消耗渠道行/调拨单号，返回 true；
  //       任一校验失败 → 不产出、不消耗任何已试配渠道行，warn 后返回 false（D3 整组失败粒度）。 =====
  function tryCommitGroup(groupNo, groupRows) {
    // —— 步骤4：组级校验 ——
    // 4a：组内调拨单号须一致且非空。
    const allocs = new Set();
    let anyAllocEmpty = false;
    for (const lr of groupRows) {
      const a = normalizeCellValue(lr[FIELD_MAP.linkAllocationNo]);
      if (a === '') anyAllocEmpty = true;
      else allocs.add(a);
    }
    if (anyAllocEmpty || allocs.size === 0) {
      warn.push({ code: 'group-allocation-missing', group: groupNo, message: `分组「${groupNo}」存在空调拨单号，无法修复` });
      return false;
    }
    if (allocs.size > 1) {
      warn.push({
        code: 'group-allocation-inconsistent',
        group: groupNo,
        allocations: [...allocs].sort(),
        message: `分组「${groupNo}」调拨单号不一致（${[...allocs].sort().join('、')}），无法修复`
      });
      return false;
    }
    const allocationNo = [...allocs][0];
    // 4b（D8 从严）：调拨单号未被其他成功组占用（两组共享 → 第二组失败）。
    if (usedAllocation.has(allocationNo)) {
      warn.push({ code: 'group-allocation-reused', group: groupNo, allocationNo, message: `分组「${groupNo}」的调拨单号「${allocationNo}」已被其他分组占用，本组不修复` });
      return false;
    }

    // —— 步骤5：组内逐行 1v1 试配（每行链接ID 非空 + 在渠道 BOC 行中找到未消耗、未被本组占用的同 reconId 行）——
    const localUsed = new Set(); // 本组内临时占用（失败回滚 → 不写入 usedChannel）
    const pairs = []; // { linkRow, channelRow }（提交时用于消耗 + 取链接ID/金额）
    for (const lr of groupRows) {
      const rid = normalizeCellValue(lr[FIELD_MAP.linkReconLinkId]);
      if (rid === '') {
        // D2：链接ID 为空的链接表行不可匹配 → 整组失败。
        warn.push({ code: 'group-link-id-empty', group: groupNo, message: `分组「${groupNo}」存在空链接ID，无法修复` });
        return false;
      }
      const pool = channelByReconId.get(rid) || [];
      // D1：1v1 消耗 —— 同链接ID 出现 k 次须有 k 条同 reconId 渠道行（按池内顺序取首个未消耗、未本组占用行）。
      const hit = pool.find((cr) => !usedChannel.has(cr) && !localUsed.has(cr));
      if (!hit) {
        warn.push({ code: 'group-partial-match', group: groupNo, reconLinkId: rid, message: `分组「${groupNo}」的链接ID「${rid}」在渠道账单中找不到足够的可匹配行，整组不修复` });
        return false;
      }
      localUsed.add(hit);
      pairs.push({ linkRow: lr, channelRow: hit });
    }

    // —— 步骤6：网关账单 OrderId===调拨单号 须唯一命中（0 / ≥2 命中均整组失败，D4 从严，区别于 JPM 取第一）——
    const gwCand = gwRows.filter((g) => normalizeCellValue(g[FIELD_MAP.gwOrderId]) === allocationNo);
    if (gwCand.length === 0) {
      warn.push({ code: 'gw-orderid-not-found', group: groupNo, allocationNo, message: `网关账单中找不到 OrderId=「${allocationNo}」的行，分组「${groupNo}」不修复` });
      return false;
    }
    if (gwCand.length > 1) {
      // 🔴 从严：JPM 此处取第一行继续；BOC 多命中整组失败（复制 N 份的放大效应使错配风险更高）。
      warn.push({ code: 'gw-orderid-multi-match', group: groupNo, allocationNo, count: gwCand.length, message: `网关账单中 OrderId=「${allocationNo}」命中 ${gwCand.length} 行（应唯一），分组「${groupNo}」不修复` });
      return false;
    }
    const gwHit = gwCand[0];

    // —— 步骤7：提交 —— 网关命中行复制 N 份（N=组行数），每份按对应链接表行注入 Type/Reference/Amount。
    //   buildOutputRow gateway 14 列从 gwHit 同名复制；仅 Type/Reference/Amount 经 overrides 行级注入（F3.3）。
    for (const { linkRow } of pairs) {
      const reference = normalizeCellValue(linkRow[FIELD_MAP.linkReconLinkId]); // Reference = 该链接表行链接ID
      const amount = linkRow[FIELD_MAP.linkCcy1Amount]; // Amount = 「货币1金额」原值透传（D10）
      fixedRows.push(buildOutputRow(gwHit, {
        Type: 1, // number 1（v3.0.8 需求5，原 D9=2，业务确认后改 1；网关源行只有超长列名 Type(0:... 短名取不到，必须 override）
        Reference: reference,
        Amount: amount === null || amount === undefined ? '' : amount
      }, 'gateway'));
    }

    // 提交成功 → 消耗渠道行（1v1）与调拨单号（D8）。
    for (const cr of localUsed) usedChannel.add(cr);
    usedAllocation.add(allocationNo);
    return true;
  }
}

module.exports = {
  runBocDispatchOrderFix
};
