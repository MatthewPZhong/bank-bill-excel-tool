// v3.0.5 批次4（T6b-1）：链接表派生重建共享编排函数（🔴🔴 资金红线）。
//
// 缘起（spec linked-fx §3.3 删除联动 = 资金红线 R-5）：
//   删除外汇交割表 / 银行对账单表行后，须按「与导入后派生同逻辑」重建派生表（ADM / BOC bank / BOC fx）。
//   该派生逻辑此前【内联】在导入 handler `linked-table:import`（src/main.js）。为给 T6b-2「删除联动复用」做准备，
//   spec §3.1/§3.2 明令「禁止复制粘贴第二份」（防资金口径漂移）→ 抽成共享纯编排函数，导入/删除共用。
//
// 本批（T6b-1）只改导入侧调用（行为字节不变 parity）；删除侧接入在 T6b-2。
//
// 设计：3 个纯编排函数，依赖注入（deps）便于单测——
//   1) rebuildAdmDerivation         —— ADM 银行对账单链接表派生（bank-deposit / mid-allocation 导入共享）。
//   2) rebuildBankDepositBocDerivation —— BOC 调拨银行对账单表派生（2.4）+ 2.5 全量回填（bank-deposit 导入侧）。
//   3) rebuildFxBocDerivation       —— fx 派生的【全量重匹配重编号 + 2.4 + 2.5 + 统计】（不含进组步）。
//
// 🔴 边界约束（与 caller 的分工，务必保持）：
//   · reconIdFixResult=null：留导入 caller（ADM 成功分支），【不进】共享函数（删除场景清缓存口径可能不同）。
//   · processingResult=null：留导入 caller，不进共享函数。
//   · 进组步（scanFxGroups + upsertBocFxLink + getMaxBocFxOrigGroupNo）：导入专属，留 caller；
//     删除场景 BOC 行已被 T6a 联动删、无新行进组 → rebuildFxBocDerivation 从「读全库行重匹配」起。
//   · 各函数内部保留现有 try/catch 隔离语义：派生任一步抛错记 created:false（含 error 文案），【不向外抛】，
//     不阻断导入/删除本身（数据已落库/删除成功）。
//
// deps 注入清单（均为 main.js 现有 require/函数，原样透传）：
//   { database, buildAdmRows, buildBocBankRows, backfillBocReconLinkIds, rematchAllBocGroups, appendActivityLogEntry }

'use strict';

// ============================================================================
// 1) rebuildAdmDerivation —— ADM 银行对账单链接表派生（bank-deposit / mid-allocation 共享）
// ============================================================================
//
// 抽自 src/main.js 内联 ADM 派生块（readLinkedTableRows('mid-allocation') + readBankDepositAdmCandidates
//   + buildAdmRows + replaceAdmBankDeposit + admDerive 产物构造 + try/catch）。
//
// 🔴 不含 reconIdFixResult=null —— 由 caller 在 admDerive.created 成功后执行（保持导入侧 :reconIdFixResult 语义：
//   ADM 抛错时不清缓存）。
//
// 返回 { admDerive }，结构与旧内联 okResult.admDerive 字节一致：
//   成功 → { created:true, total, matched, unmatched:[{code,batchNo,customerRef,billDate,channelOrderNo,conflict?}], midEmpty }
//   失败 → { created:false, error }
function rebuildAdmDerivation(deps) {
  const { database, buildAdmRows } = deps;
  let admDerive;
  try {
    const midRows = database.readLinkedTableRows('mid-allocation');
    // v3.0.0 块 B / PR-3（R-3/O-3）：只读 Channel=ADM 候选子集（json_extract 下推过滤），
    //   不把整表 65 万行读回内存（实测现状尖峰 ~1.2GB）。buildAdmRows 内部 Channel∧FundType
    //   过滤仍为最终权威（SQL 仅过滤 Channel='ADM' 超集，绝不更窄 → 不漏 ADM 行）。
    const bankAdmCandidates = database.readBankDepositAdmCandidates();
    const { admRows, unmatched, midEmpty } = buildAdmRows(bankAdmCandidates, midRows);
    database.replaceAdmBankDeposit(admRows);
    admDerive = {
      created: true,
      total: admRows.length,
      matched: admRows.length - unmatched.length,
      // 仅回传弹框所需字段（批次号/CustomerRef/BillDate/ChannelOrderNo + 错误码 + 冲突明细），
      //   不回传整行（避免 IPC payload 携带 13+6 字段全行；报错框只列定位字段）。
      unmatched: unmatched.map((u) => ({
        code: u.code,
        batchNo: u.row ? u.row['批次号'] : '',
        customerRef: u.row ? u.row.CustomerRef : '',
        billDate: u.row ? u.row.BillDate : '',
        channelOrderNo: u.row ? u.row.ChannelOrderNo : '',
        conflict: Array.isArray(u.conflict) ? u.conflict : undefined
      })),
      midEmpty
    };
  } catch (admErr) {
    // ADM 派生失败不阻断银行对账单表导入本身（已落库成功）；记 admDerive.error 供前端提示。
    admDerive = {
      created: false,
      error: admErr && admErr.message ? admErr.message : String(admErr)
    };
  }
  return { admDerive };
}

// ============================================================================
// 2) rebuildBankDepositBocDerivation —— BOC 调拨银行对账单表派生（2.4）+ 2.5 全量回填
// ============================================================================
//
// 抽自 src/main.js 内联 bank-deposit BOC 派生块（readBankDepositBocCandidates + buildBocBankRows
//   + replaceBocBankDeposit + 有链接行才 2.5 backfill + 统一写 activity log + bocBankDerive 产物 + try/catch）。
//
// 返回 { bocBankDerive }，结构与旧内联 okResult.bocBankDerive 字节一致：
//   成功 → { created:true, bankRowCount, backfilled, unlinkedCount }
//   失败 → { created:false, error }
function rebuildBankDepositBocDerivation(deps) {
  const { database, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry } = deps;
  let bocBankDerive;
  try {
    const bankCandidates = database.readBankDepositBocCandidates();
    const bankBuild = buildBocBankRows(bankCandidates);
    database.replaceBocBankDeposit(bankBuild.rows);

    let backfilledCount = 0;
    let unlinkedCount = 0;
    const allLogs = [];
    if (Array.isArray(bankBuild.logs)) allLogs.push(...bankBuild.logs);
    // 仅当 BOC链接表已有行时补做 2.5 回填（无交割表数据 → 无链接行，跳过回填）。
    const linkWithIds = database.readBocFxLinkRowsWithIds();
    if (Array.isArray(linkWithIds) && linkWithIds.length > 0) {
      const backfill = backfillBocReconLinkIds(linkWithIds, bankBuild.rows);
      if (Array.isArray(backfill.logs)) allLogs.push(...backfill.logs);
      database.writeBocFxLinkReconIds(backfill.rows);
      backfilledCount = backfill.backfilled;
      unlinkedCount = backfill.unlinkedCount;
    }
    for (const lg of allLogs) {
      appendActivityLogEntry({
        level: lg.level || 'info',
        source: 'main',
        domain: 'boc-dispatch-order-fix',
        message: lg.message || '',
        details: Array.isArray(lg.details) ? lg.details : undefined
      });
    }
    bocBankDerive = {
      created: true,
      bankRowCount: bankBuild.rows.length,
      backfilled: backfilledCount,
      unlinkedCount
    };
  } catch (bocBankErr) {
    bocBankDerive = {
      created: false,
      error: bocBankErr && bocBankErr.message ? bocBankErr.message : String(bocBankErr)
    };
  }
  return { bocBankDerive };
}

// ============================================================================
// 3) rebuildFxBocDerivation —— fx 派生【全量重匹配重编号 + 2.4 + 2.5 + 统计】（不含进组步）
// ============================================================================
//
// 抽自 src/main.js 内联 fx 派生块「readBocFxLinkRowsForRematch 之后的全部」：
//   readLinkedTableRows('mid-allocation')（重匹配输入）→ readBocFxLinkRowsForRematch → rematchAllBocGroups
//   → writeBocFxLinkGroupRematch → readBankDepositBocCandidates → buildBocBankRows → replaceBocBankDeposit
//   → readBocFxLinkRowsWithIds → backfillBocReconLinkIds → writeBocFxLinkReconIds → 统一写 activity log → 统计 bocDerive。
//
// 🔴 不含进组步（getMaxBocFxOrigGroupNo + scanFxGroups + upsertBocFxLink）——留 caller（导入专属）。
//   caller 把进组步产物 { scanLogs, groupCount, overwriteCount } 通过 ctx 传入，供 logs 拼接与 bocDerive 统计字节一致。
//
// 参数：
//   deps = { database, rematchAllBocGroups, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry }
//   ctx  = { scanLogs, groupCount, overwriteCount }
//     · scanLogs       —— caller 进组步 scanFxGroups 的 logs（作为 allLogs 起始；导入侧；删除侧传 [] 即可）。
//     · groupCount     —— 本文件新成组数（scan.groupCount），写入 bocDerive.groupCount（导入侧统计口径）。
//     · overwriteCount —— 进组 upsert 同键覆盖数（upsertRet.overwriteCount），写入 bocDerive.overwriteCount。
//
// 返回 { bocDerive }，结构与旧内联 okResult.bocDerive 字节一致：
//   成功 → { created:true, total, groupCount, overwriteCount, step22Removed,
//            step23MatchedGroups, step23UnmatchedGroups, backfilled, unlinkedCount, needBankImport, bankMissingReason }
//   失败 → { created:false, error }
function rebuildFxBocDerivation(deps, ctx = {}) {
  const { database, rematchAllBocGroups, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry } = deps;
  const { scanLogs, groupCount, overwriteCount } = ctx;
  let bocDerive;
  try {
    const allLogs = [];
    // 进组步 scan.logs 由 caller 传入（保持导入侧 allLogs 顺序：scan.logs 在最前）。
    if (Array.isArray(scanLogs)) allLogs.push(...scanLogs);

    // 中台候选（全量重匹配用；无中台数据 → 跳过 2.2/2.3，info log；分组/调拨单号留空，2.4/2.5 照跑）。
    let midRows = [];
    try { midRows = database.readLinkedTableRows('mid-allocation'); }
    catch (midErr) { midRows = []; }

    // 🔴 全量重匹配 + 重编号：读全库 BOC 行（id ASC，注入 __origGroup）→ 按 orig_group_no 重编号 1..N + 重跑 2.2/2.3 → 按 id 回写。
    const allRows = database.readBocFxLinkRowsForRematch();
    if (Array.isArray(midRows) && midRows.length > 0) {
      const rematchRet = rematchAllBocGroups(allRows, midRows);
      if (rematchRet && Array.isArray(rematchRet.logs)) allLogs.push(...rematchRet.logs);
    } else {
      // 无中台数据：仍需重编号（消除空洞 + 反映全库），但 2.2/2.3 空跑（调拨单号留空）。
      const rematchRet = rematchAllBocGroups(allRows, []);
      if (rematchRet && Array.isArray(rematchRet.logs)) allLogs.push(...rematchRet.logs);
      allLogs.push({ level: 'info', message: '[BOC链接表] 链接表库无中台调拨订单数据，跳过 2.2/2.3 调拨单号匹配（调拨单号留空）' });
    }
    // rematchAllBocGroups 原地改 allRows[].row（分组重编号 + 2.2 清空 + 2.3 回填调拨单号）→ 按 id 回写 group_no/allocation_no + raw_json。
    database.writeBocFxLinkGroupRematch(allRows);

    // 2.4：派生 BOC调拨银行对账单表（用库内已有 bank-deposit 的 BOC 候选；无可用数据也重建空表防 stale）。
    const bankCandidates = database.readBankDepositBocCandidates();
    const bankBuild = buildBocBankRows(bankCandidates);
    if (Array.isArray(bankBuild.logs)) allLogs.push(...bankBuild.logs);
    database.replaceBocBankDeposit(bankBuild.rows);

    // 2.5：尽力回填资金对账不平表链接ID（按 id 精确回写；旧值幂等覆盖）。基于重匹配后全库行。
    const linkWithIds = database.readBocFxLinkRowsWithIds();
    const backfill = backfillBocReconLinkIds(linkWithIds, bankBuild.rows);
    if (Array.isArray(backfill.logs)) allLogs.push(...backfill.logs);
    database.writeBocFxLinkReconIds(backfill.rows);

    // 统一写 activity log（info / warning；warning 含明细——前端不显示）。
    for (const lg of allLogs) {
      appendActivityLogEntry({
        level: lg.level || 'info',
        source: 'main',
        domain: 'boc-dispatch-order-fix',
        message: lg.message || '',
        details: Array.isArray(lg.details) ? lg.details : undefined
      });
    }

    // 统计派生指标（基于 rematch 后全库行 allRows[].row：分组重编号 + 2.2 清空命中行「分组」+ 2.3 回填「调拨单号」）。
    //   total = 全库 BOC 行数；groupCount = 本文件新成组数（offset 后，caller 传入）；
    //   step22Removed = 全库被 2.2 单行剔除（分组清空）的行数；
    //   step23MatchedGroups / UnmatchedGroups = 全库 2.3 后「分组非空」组中已回填/未回填调拨单号的组数。
    let step22Removed = 0;
    const remainingGroups = new Set(); // 重匹配后仍「分组非空」的组号
    const matchedGroups = new Set(); // 其中已回填调拨单号的组号
    for (const item of allRows) {
      const r = item && item.row && typeof item.row === 'object' ? item.row : null;
      if (!r) continue;
      const g = r['分组'];
      if (g === undefined || g === null || g === '') { step22Removed += 1; continue; }
      remainingGroups.add(g);
      const alloc = r['调拨单号'];
      if (alloc !== undefined && alloc !== null && alloc !== '') matchedGroups.add(g);
    }
    bocDerive = {
      created: true,
      total: allRows.length,
      groupCount,
      overwriteCount,
      step22Removed,
      step23MatchedGroups: matchedGroups.size,
      step23UnmatchedGroups: remainingGroups.size - matchedGroups.size,
      backfilled: backfill.backfilled,
      unlinkedCount: backfill.unlinkedCount,
      needBankImport: bankBuild.availability !== 'ok',
      bankMissingReason: bankBuild.availability !== 'ok' ? bankBuild.availability : null
    };
  } catch (bocErr) {
    // 派生失败不阻断交割表导入本身（已落库成功）；记 created:false 供前端弹错误框。
    bocDerive = {
      created: false,
      error: bocErr && bocErr.message ? bocErr.message : String(bocErr)
    };
  }
  return { bocDerive };
}

module.exports = {
  rebuildAdmDerivation,
  rebuildBankDepositBocDerivation,
  rebuildFxBocDerivation
};
