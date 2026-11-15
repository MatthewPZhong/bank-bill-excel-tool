'use strict';

// v3.2.18：链接表按数据日期范围统计 / 删除 + 派生联动的共享实现（🔴🔴 资金红线）。
//   由「链接表管理 → 删除」（linked-table:delete-by-date-range，手工）与链接表过期清理（空闲自动，
//   src/main-process/linked-table-retention/）共用，禁止另写第二份删除或派生逻辑（R-5）。
//   本模块只做“删 + 派生重建 + 清缓存”；调用方负责银行对账锁、ISO 日期与起≤止校验、目标表白名单。
//
//   删除联动（v3.0.5 OPEN-4 / T6b-2 起的口径，原样自 src/main.js handler 抽出）：
//     · gateway-bill  → 删 + 清 processingResult。
//     · fx-settlement → 删 fx 主表（单事务按 transaction_no 联动删 BOC 行）→ rebuildFxBocDerivation 全量重匹配重编号
//                       （无进组步，传空 ctx）→ 清 reconIdFixResult。
//     · bank-deposit  → ADM Recovery Hold gate → 删 bank 主表（返回 deletedBizIds）→ rebuildAdmDerivation（ADM 写边界）
//                       + rebuildBankDepositBocDerivation → 清 processingResult + reconIdFixResult
//                       → clearBankDepositHitMarkersByBizIds（OPEN-7 标记防悬挂）。
//   🔴 事务边界：仓储删除各自单事务删完即提交；rebuild* / 清标记各自开独立事务，本模块不在任何外层事务内。
//   🔴 派生重建沿用导入侧语义：rebuild* 内部 try/catch 隔离，派生失败记 created:false 不向外抛（行已删）；
//      唯一例外是 ADM Recovery Hold/open Intent gate，必须向调用方传播。
const { buildAdmRows } = require('./adm-bank-deposit-builder');
const {
  rematchAllBocGroups,
  buildBocBankRows,
  backfillBocReconLinkIds
} = require('./boc-fx-link-builder');
const {
  rebuildAdmDerivation,
  rebuildBankDepositBocDerivation,
  rebuildFxBocDerivation
} = require('./linked-derive-rebuild');

// 🔴 正向白名单：仅三张前端可管理的累加主表；隐藏派生表（adm-bank-deposit / boc-* ）、整表覆盖的
//   mid-allocation、恒空的 fx-option 一律不允许通过 tableKey 触达（防误删 / 绕过派生重建链）。
const LINKED_DELETE_TABLE_KEYS = Object.freeze(['gateway-bill', 'fx-settlement', 'bank-deposit']);

function isLinkedDeleteTable(tableKey) {
  return LINKED_DELETE_TABLE_KEYS.includes(tableKey);
}

function assertLinkedDeleteTable(tableKey) {
  if (!isLinkedDeleteTable(tableKey)) {
    throw Object.assign(new Error('不支持的删除目标表'), { code: 'LINKED_DELETE_TABLE_UNSUPPORTED' });
  }
}

// 只读：闭区间数据日期范围内的行数（与删除同口径的 WHERE）。
function countLinkedTableRowsByDateRange(database, { tableKey, start, end }) {
  assertLinkedDeleteTable(tableKey);
  if (tableKey === 'fx-settlement') return database.countFxByDateRange(start, end);
  if (tableKey === 'bank-deposit') return database.countBankDepositByDateRange(start, end);
  return database.countGatewayBillByDateRange(start, end);
}

/**
 * 删除闭区间数据日期范围内的链接表行，并按表重建派生、清对账缓存。
 * @param {object} deps
 * @param {object} deps.database AppDatabase
 * @param {Function} deps.appendActivityLogEntry 派生重建日志
 * @param {Function} deps.assertAdmMutationAllowed ADM Recovery Hold gate（bank-deposit 删除前调用，抛错即不删）
 * @param {Function} deps.admMutationBoundary ADM 派生写边界
 * @param {Function} deps.clearProcessingResult 清银行对账 run 结果缓存
 * @param {Function} deps.clearReconIdFixResult 清对账单修复结果缓存
 * @returns {object} 不含 status 的结果（字段与手工删除 IPC 返回一致）
 */
function deleteLinkedTableRowsByDateRange(deps, { tableKey, start, end }) {
  assertLinkedDeleteTable(tableKey);
  const {
    database,
    appendActivityLogEntry,
    assertAdmMutationAllowed,
    admMutationBoundary,
    clearProcessingResult,
    clearReconIdFixResult
  } = deps;

  if (tableKey === 'fx-settlement') {
    // 🔴🔴 删外汇交割表（仓储单事务已按 transaction_no 联动删 BOC 行，返回 bocDeleted/deletedTxnNos）。
    const ret = database.deleteFxByDateRange(start, end);
    // 删除场景无进组步 → 空 ctx，从「读全库 BOC 行重匹配」起（重编号 1..N → 2.4 → 2.5 全量回填）。
    const { bocDerive } = rebuildFxBocDerivation(
      { database, rematchAllBocGroups, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry },
      { scanLogs: [], groupCount: 0, overwriteCount: 0 }
    );
    // 删 fx → BOC 派生重算 → 旧对账单修复结果失效。
    clearReconIdFixResult();
    return {
      deleted: ret.deleted,
      rowCount: ret.rowCount,
      dataDateMin: ret.dataDateMin,
      dataDateMax: ret.dataDateMax,
      bocDeleted: ret.bocDeleted,
      bocDerive
    };
  }

  if (tableKey === 'bank-deposit') {
    // 🔴 ADM Recovery Hold gate 必须早于删除写入。
    assertAdmMutationAllowed();
    const ret = database.deleteBankDepositByDateRange(start, end);
    // 派生重建：ADM（全库 Channel=ADM 候选重建）+ BOC bank（2.4 + 2.5 全量回填）。
    const { admDerive } = rebuildAdmDerivation({
      database,
      buildAdmRows,
      admMutationBoundary
    });
    const { bocBankDerive } = rebuildBankDepositBocDerivation(
      { database, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry }
    );
    // 删 bank-deposit → run 结果（R5 场景4 / 场景2b 数据源）与 JPM 修复结果（ADM 表重建）均失效。
    clearProcessingResult();
    clearReconIdFixResult();
    // OPEN-7：清被删 BizId 的命中标记（DELETE 已隐式清掉，此处为防御性双保险）。
    database.clearBankDepositHitMarkersByBizIds(ret.deletedBizIds);
    return {
      deleted: ret.deleted,
      rowCount: ret.rowCount,
      dataDateMin: ret.dataDateMin,
      dataDateMax: ret.dataDateMax,
      admDerive,
      bocBankDerive
    };
  }

  // gateway-bill：网关数据变更使银行对账 run 结果失效（C3 网关核销 / R5）。
  const ret = database.deleteGatewayBillByDateRange(start, end);
  clearProcessingResult();
  return { deleted: ret.deleted, rowCount: ret.rowCount, dataDateMin: ret.dataDateMin, dataDateMax: ret.dataDateMax };
}

module.exports = {
  LINKED_DELETE_TABLE_KEYS,
  isLinkedDeleteTable,
  countLinkedTableRowsByDateRange,
  deleteLinkedTableRowsByDateRange
};
