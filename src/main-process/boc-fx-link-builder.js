// v3.0.4 块 E（需求2）：BOC 链接表派生纯函数（外汇交割表 → BOC链接表 + BOC调拨银行对账单表）。
//
// 🔴 资金对账敏感（spec §4 F2.3 / R-3）：本模块把外汇交割表按物理行序扫描成「连续段分组」，
//    与中台调拨订单（BOC 渠道）按「到期日 + 货币2金额=收款金额」一对一消耗匹配回填调拨单号，
//    再与 BOC 银行对账单按「交易编号 ↔ 银行单交易编号」回填资金对账不平表链接ID。
//    分组 / 金额匹配 / 转分错误会写错调拨单号 / 链接ID，污染后续 BOC 修复引擎的资金对账输出。
//
// 纯函数（不读 DB / 不碰 FS / 不依赖 Electron）：交割表 objects+rowNumbers、中台行、银行候选行由 main.js 注入；
//    所有日志（warning / info 明细）经返回值 logs 上抛，由 main.js 统一写 appendActivityLogEntry（便于单测）。
//
// 跨表字段名一律经 src/constants/boc-fx-link-fields.js 常量 pick，绝不手敲（三张源表口径不一致，R-1）。
//
// 🔴 转分精确：金额匹配走 toCents（去千分位 → ×100 四舍五入），容差 0；非数值剔候选 / 整组放弃，绝不静默错配。

const { normalizeDateExportValue } = require('../backend/file-service/normalizers');
const { normalizeCellValue, parseNumber } = require('./scenario-engines/engine-utils');
const { FIELD_MAP, BOC_CHANNEL_VALUE, BOC_BANK_FILTER, BOC_PAYMENT_DETAIL_KEYWORD } = require('../constants/boc-fx-link-fields');

// 内部辅助键（落库前由仓储剥到热列，不进 raw_json 业务字段）。
const KEY_TXN_NO = '__txnNo';
const KEY_MATURITY_ISO = '__maturityIso';
const KEY_SOURCE_ROW = '__sourceRow';

// ============================================================================
// 工具函数
// ============================================================================

// 交易编号归一化为纯数字串：
//   纯数字原样（'123'→'123'）；带尾零小数（'123.0' / '926181062.0'）去尾零取整数部分；
//   空 / 含非数字字符（含字母 / 分隔符）/ 科学计数法（'1.2e3'）→ ''。
//   number 入参（如交割表「交易编号」926181062）经 normalizeCellValue 转 String 后同口径处理。
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

// 金额转分：parseNumber 去千分位 → ×100 四舍五入（容差 0）；非数值 → null。
function toCents(value) {
  const n = parseNumber(value);
  if (n === null) return null;
  return Math.round(n * 100);
}

// 日期归一为 YYYY-MM-DD：复用 normalizeDateExportValue 取 .date（已内部 strip 时间后缀），
//   本地分量格式化（与 linked-table-repository.normalizeDateForRange 同口径）；无法解析 / 空 → ''。
function toIsoDate(value) {
  const result = normalizeDateExportValue(value);
  if (!result || !result.date || Number.isNaN(result.date.getTime())) return '';
  const d = result.date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 提取最长连续 ASCII 数字串（U3 拍板）：并列长度取最先出现的一段，hasMultiple 标记存在并列供 caller 记 log。
//   全角数字不计（仅 0-9）；无数字 → { value:'', hasMultiple:false }。
function extractLongestDigitRun(value) {
  const s = value === null || value === undefined ? '' : String(value);
  const runs = s.match(/\d+/g);
  if (!runs || runs.length === 0) return { value: '', hasMultiple: false };
  let best = runs[0];
  let bestCount = 0;
  for (const r of runs) {
    if (r.length > best.length) best = r;
  }
  for (const r of runs) {
    if (r.length === best.length) bestCount += 1;
  }
  return { value: best, hasMultiple: bestCount > 1 };
}

// ============================================================================
// Step1：物理行序扫描分组（spec §4.1）
// ============================================================================

// scanFxGroups({ objects, rowNumbers })：按物理行序遍历交割表对象行。
//   · 「交易编号」归一化为空（合计 / 页脚 / 非数字行）→ 关当前组，该行不入表；
//   · rowNumbers 断档（前后物理行号差 > 1，即中间有被过滤的全空行）→ 关组；
//   · 连续纯数字段成组，组号 1,2,3… 仅在非空段递增（连续多个分隔不产空组号）。
//   产出行 = 交割表原命名字段（33 个，空表头列已在对象化阶段跳过）+ 分组(组号字符串) +
//            调拨单号='' + 资金对账不平表链接ID='' + 内部辅助键(__txnNo/__maturityIso/__sourceRow)。
//   返回 { rows, groupCount, logs }。
function scanFxGroups({ objects, rowNumbers } = {}) {
  const objs = Array.isArray(objects) ? objects : [];
  const rowNums = Array.isArray(rowNumbers) ? rowNumbers : [];
  const rows = [];
  const logs = [];

  let currentGroup = 0; // 0 = 当前无开放组
  let groupCount = 0;
  let prevRowNum = null;

  for (let i = 0; i < objs.length; i += 1) {
    const obj = objs[i] && typeof objs[i] === 'object' ? objs[i] : {};
    const physicalRow = rowNums[i] === undefined || rowNums[i] === null ? null : Number(rowNums[i]);
    const txnNo = normalizeTransactionNo(obj[FIELD_MAP.fxTransactionNo]);

    // 物理行号断档（中间有全空行被过滤）→ 关当前组
    if (currentGroup !== 0 && prevRowNum !== null && physicalRow !== null && physicalRow - prevRowNum > 1) {
      currentGroup = 0;
    }

    if (txnNo === '') {
      // 非数字行（合计 / 页脚 / 非交易行）：关组、不入表
      currentGroup = 0;
      prevRowNum = physicalRow;
      continue;
    }

    // 纯数字行：若当前无开放组，开新组（组号递增）
    if (currentGroup === 0) {
      groupCount += 1;
      currentGroup = groupCount;
    }

    const row = { ...obj };
    row[FIELD_MAP.linkGroup] = String(currentGroup);
    row[FIELD_MAP.linkAllocationNo] = '';
    row[FIELD_MAP.linkReconLinkId] = '';
    row[KEY_TXN_NO] = txnNo;
    row[KEY_MATURITY_ISO] = toIsoDate(obj[FIELD_MAP.fxMaturityDate]);
    row[KEY_SOURCE_ROW] = physicalRow;
    rows.push(row);

    prevRowNum = physicalRow;
  }

  logs.push({ level: 'info', message: `[BOC链接表] 物理行序扫描完成：${rows.length} 行成组，共 ${groupCount} 组` });
  return { rows, groupCount, logs };
}

// ============================================================================
// Step2.2 + 2.3：中台调拨 BOC 行单行剔除 + 组汇总回填调拨单号（一对一消耗）
// ============================================================================

// matchBocToMidAllocation(bocRows, midRows)：原地改 bocRows 的「分组」/「调拨单号」，返回 { logs }。
//   全部多解记 warning（行序优先取首），不抛错。
function matchBocToMidAllocation(bocRows, midRows) {
  const rows = Array.isArray(bocRows) ? bocRows : [];
  const mids = Array.isArray(midRows) ? midRows : [];
  const logs = [];

  // 候选 = 中台「付款渠道」='BOC' 行，预解析日期 / 金额（解析失败剔候选 + warning）。
  const candidates = [];
  for (let i = 0; i < mids.length; i += 1) {
    const m = mids[i] && typeof mids[i] === 'object' ? mids[i] : {};
    if (normalizeCellValue(m[FIELD_MAP.midPayChannel]) !== BOC_CHANNEL_VALUE) continue;
    const iso = toIsoDate(m[FIELD_MAP.midTransactionTime]);
    const cents = toCents(m[FIELD_MAP.midReceiveAmount]);
    if (iso === '' || cents === null) {
      logs.push({
        level: 'warning',
        message: `[BOC链接表] 中台 BOC 行第 ${i + 1} 条日期或金额解析失败，剔出匹配候选（交易时间=${normalizeCellValue(m[FIELD_MAP.midTransactionTime])} / 收款金额=${normalizeCellValue(m[FIELD_MAP.midReceiveAmount])}）`
      });
      continue;
    }
    candidates.push({
      index: i,
      allocationNo: normalizeCellValue(m[FIELD_MAP.midAllocationNo]),
      iso,
      cents,
      consumed: false
    });
  }

  // —— 2.2：单行剔除 ——
  //   按中台行序遍历候选，找「分组非空 ∧ 到期日=候选日期 ∧ 货币2金额(分)=收款金额(分)」的 BOC 行；
  //   多命中行序优先取首 + log；命中行「分组」清空（该行退出 2.3），该中台行消耗。
  for (const cand of candidates) {
    const hits = [];
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r];
      if (normalizeCellValue(row[FIELD_MAP.linkGroup]) === '') continue;
      if (row[KEY_MATURITY_ISO] !== cand.iso) continue;
      if (toCents(row[FIELD_MAP.fxCcy2Amount]) !== cand.cents) continue;
      hits.push(r);
    }
    if (hits.length === 0) continue;
    if (hits.length > 1) {
      logs.push({
        level: 'warning',
        message: `[BOC链接表] 2.2 中台调拨单号「${cand.allocationNo}」（日期 ${cand.iso} / 金额分 ${cand.cents}）命中 ${hits.length} 条交割行，按物理行序取首`
      });
    }
    const targetRow = rows[hits[0]];
    targetRow[FIELD_MAP.linkGroup] = ''; // 单行剔除：清空分组，退出 2.3
    cand.consumed = true;
  }

  // —— 2.3：组汇总匹配回填 ——
  //   剩余「分组非空」行按组聚合：组汇总货币2金额（组内任一非数值 → 整组放弃 + warning；
  //   到期日不一致 → warning + 取首行 iso）。与未消耗候选（同日期）匹配，命中回填组内所有行调拨单号、一组一单消耗。
  const groups = new Map(); // groupNo → [rowIndex...]
  for (let r = 0; r < rows.length; r += 1) {
    const g = normalizeCellValue(rows[r][FIELD_MAP.linkGroup]);
    if (g === '') continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }

  for (const [groupNo, idxList] of groups) {
    // 组汇总金额（分）；任一非数值 → 整组放弃
    let sumCents = 0;
    let amountBad = false;
    for (const r of idxList) {
      const c = toCents(rows[r][FIELD_MAP.fxCcy2Amount]);
      if (c === null) { amountBad = true; break; }
      sumCents += c;
    }
    if (amountBad) {
      logs.push({ level: 'warning', message: `[BOC链接表] 2.3 分组 ${groupNo} 含非数值货币2金额，整组放弃匹配调拨单号` });
      continue;
    }
    // 组内到期日一致性：取首行 iso，不一致 warning
    const groupIso = rows[idxList[0]][KEY_MATURITY_ISO];
    const inconsistent = idxList.some((r) => rows[r][KEY_MATURITY_ISO] !== groupIso);
    if (inconsistent) {
      logs.push({ level: 'warning', message: `[BOC链接表] 2.3 分组 ${groupNo} 组内到期日不一致，取首行到期日 ${groupIso}` });
    }

    // 与未消耗候选（同日期对齐 + 金额=组汇总）匹配，行序优先
    const matched = [];
    for (const cand of candidates) {
      if (cand.consumed) continue;
      if (cand.iso !== groupIso) continue;
      if (cand.cents !== sumCents) continue;
      matched.push(cand);
    }
    if (matched.length === 0) continue; // 无命中组：调拨单号留空
    if (matched.length > 1) {
      logs.push({
        level: 'warning',
        message: `[BOC链接表] 2.3 分组 ${groupNo}（日期 ${groupIso} / 汇总分 ${sumCents}）命中 ${matched.length} 个中台候选，按物理行序取首`
      });
    }
    const cand = matched[0];
    cand.consumed = true;
    for (const r of idxList) {
      rows[r][FIELD_MAP.linkAllocationNo] = cand.allocationNo;
    }
  }

  return { logs };
}

// ============================================================================
// Step2.4：派生 BOC 调拨银行对账单行（availability 三态）
// ============================================================================

// buildBocBankRows(candidates)：candidates = 银行对账单 Channel=BOC 候选行（readBankDepositBocCandidates 产物）。
//   availability：
//     · 候选 0 行              → 'no-boc-rows'（缺数据，需引导导入）
//     · 候选有行但全部无 Payment Detail 自有键（旧 13 字段时代导入）→ 'missing-payment-detail'（需重导）
//     · 否则                    → 'ok'，过滤 地区='CN' ∧ Currency='USD' ∧ Credit Amount 转分=0；
//        Payment Detail 含关键词 → 提取最长数字串赋「银行单交易编号」（含关键词但无数字 → '' + warning；并列 → log）。
//   返回 { availability, rows, logs }。
function buildBocBankRows(candidates) {
  const cands = Array.isArray(candidates) ? candidates : [];
  const logs = [];

  if (cands.length === 0) {
    return { availability: 'no-boc-rows', rows: [], logs };
  }

  // 全部候选行均无 Payment Detail 自有键 → 旧白名单时代落库，无法提取银行单交易编号
  const anyHasPaymentDetailKey = cands.some(
    (c) => c && typeof c === 'object' && Object.prototype.hasOwnProperty.call(c, FIELD_MAP.bankPaymentDetail)
  );
  if (!anyHasPaymentDetailKey) {
    return { availability: 'missing-payment-detail', rows: [], logs };
  }

  const rows = [];
  for (const c of cands) {
    const obj = c && typeof c === 'object' ? c : {};
    // 筛选：地区='CN' ∧ Currency='USD' ∧ Credit Amount 转分=0
    if (normalizeCellValue(obj[FIELD_MAP.bankRegion]) !== BOC_BANK_FILTER.地区) continue;
    if (normalizeCellValue(obj[FIELD_MAP.bankCurrency]) !== BOC_BANK_FILTER.Currency) continue;
    if (toCents(obj[FIELD_MAP.bankCreditAmount]) !== BOC_BANK_FILTER.creditAmountCents) continue;

    const row = { ...obj };
    let bankTxnNo = '';
    const paymentDetail = normalizeCellValue(obj[FIELD_MAP.bankPaymentDetail]);
    if (paymentDetail.indexOf(BOC_PAYMENT_DETAIL_KEYWORD) >= 0) {
      const extracted = extractLongestDigitRun(paymentDetail);
      bankTxnNo = extracted.value;
      if (bankTxnNo === '') {
        logs.push({
          level: 'warning',
          message: `[BOC银行表] Payment Detail 含「${BOC_PAYMENT_DETAIL_KEYWORD}」但无数字串，银行单交易编号留空（ReconciliationId=${normalizeCellValue(obj[FIELD_MAP.bankReconId])}）`
        });
      } else if (extracted.hasMultiple) {
        logs.push({
          level: 'info',
          message: `[BOC银行表] Payment Detail 含多段等长数字串，取最先一段「${bankTxnNo}」（ReconciliationId=${normalizeCellValue(obj[FIELD_MAP.bankReconId])}）`
        });
      }
    }
    row[FIELD_MAP.bankTxnNo] = bankTxnNo;
    rows.push(row);
  }

  return { availability: 'ok', rows, logs };
}

// ============================================================================
// Step2.5：回填资金对账不平表链接ID（按 id 配对，幂等全量重算）
// ============================================================================

// backfillBocReconLinkIds(rowsWithIds, bankRows)：
//   rowsWithIds = [{ id, row }]（readBocFxLinkRowsWithIds 产物，row 为 raw_json 还原的链接表行）；
//   bankRows = buildBocBankRows 产物（含「银行单交易编号」）。
//   建 bank_txn_no → ReconciliationId 索引（重复键留 id 最小行 + warning；bankRows 无 id 用数组序代理 id 最小=最先）；
//   逐链接行以归一化交易编号查表，命中 → 「资金对账不平表链接ID」=该行 ReconciliationId，未命中 → ''（幂等覆盖旧值）。
//   返回 { rows: [{ id, row }], backfilled, unlinkedCount, logs }（logs 含 unlinked 行号 / 交易编号明细供 caller 写 warning log）。
function backfillBocReconLinkIds(rowsWithIds, bankRows) {
  const list = Array.isArray(rowsWithIds) ? rowsWithIds : [];
  const banks = Array.isArray(bankRows) ? bankRows : [];
  const logs = [];

  // bank_txn_no → ReconciliationId（首次出现保留；重复键 warning）
  const bankIndex = new Map();
  for (const b of banks) {
    const obj = b && typeof b === 'object' ? b : {};
    const key = normalizeTransactionNo(obj[FIELD_MAP.bankTxnNo]);
    if (key === '') continue;
    if (bankIndex.has(key)) {
      logs.push({ level: 'warning', message: `[BOC链接表] 2.5 银行单交易编号「${key}」重复，保留最先一条 ReconciliationId` });
      continue;
    }
    bankIndex.set(key, normalizeCellValue(obj[FIELD_MAP.bankReconId]));
  }

  let backfilled = 0;
  let unlinkedCount = 0;
  const unlinkedDetail = [];
  const outRows = [];

  for (const item of list) {
    const id = item && item.id !== undefined ? item.id : null;
    const row = item && item.row && typeof item.row === 'object' ? { ...item.row } : {};
    const txnNo = normalizeTransactionNo(row[FIELD_MAP.fxTransactionNo]);
    const reconId = txnNo === '' ? '' : (bankIndex.get(txnNo) || '');
    row[FIELD_MAP.linkReconLinkId] = reconId; // 幂等覆盖（命中 / 未命中均重写）
    if (reconId !== '') {
      backfilled += 1;
    } else {
      unlinkedCount += 1;
      unlinkedDetail.push(`id=${id}/交易编号=${txnNo || '(空)'}`);
    }
    outRows.push({ id, row });
  }

  if (unlinkedCount > 0) {
    logs.push({
      level: 'warning',
      message: `[BOC链接表] 2.5 资金对账不平表链接ID 有 ${unlinkedCount} 行未命中（前端不显示，仅记日志）`,
      details: unlinkedDetail
    });
  }

  return { rows: outRows, backfilled, unlinkedCount, logs };
}

module.exports = {
  scanFxGroups,
  matchBocToMidAllocation,
  buildBocBankRows,
  backfillBocReconLinkIds,
  // 工具导出供单测细粒度断言
  normalizeTransactionNo,
  toCents,
  toIsoDate,
  extractLongestDigitRun,
  // 内部辅助键名（仓储落库剥列时引用）
  KEY_TXN_NO,
  KEY_MATURITY_ISO,
  KEY_SOURCE_ROW
};
