// v2.1.16 阶段一 A5：银行对账单「批量导入合并对账」核心纯函数
//
// 🔴 资金红线：本模块抽自 main.js `bank-statement:batch-import` handler 的合并逻辑，
//   行为必须与原 handler 严格一致（开发期用 scripts/tmp-a5-batch-import-check.js 同款断言验证后转正单测）。
//
// 背景（为何要合并 + 全局重编号）：
//   用户拍板「批量导入多份银行对账单 = 合并不覆盖」——多文件追加到同一对账数据集统一跑 5 轮对账。
//   readBankStatement 注入的 _rowId（row_0..row_N）是「文件内」编号，多文件合并必然重复；
//   合并后若不统一重编号，scenario-dispatcher 的 rowLockSet（以 _rowId 为键的 first-match-wins 锁）
//   会把不同文件的同序号行当成同一行 → 漏对 / 误锁（modifiedRows / unmatchedRows filter 全依赖 _rowId）。
//   故合并后必须对全部 rows 统一重编号 _rowId = 'row_' + 全局 index（0-based 跨文件唯一）。
//
// 异构表防护：追加前校验两份银行对账单 headers 完全一致（44 列同结构同顺序），不一致抛 BankStatementMergeError，
//   由 handler 标该文件 invalid 不合并（防异构表混入污染对账数据集）。

// 合并失败（headers 不一致）专用错误类型——handler 据 name 判定后标 invalid（不污染 session）。
class BankStatementMergeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BankStatementMergeError';
  }
}

// 两份银行对账单表头是否完全一致（44 列同结构同顺序）。用于合并前的异构表防护。
//   与原 main.js handler 内 bankStatementHeadersEqual 逐字一致（String() 归一后逐列比对）。
function bankStatementHeadersEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}

// 合并新一份银行对账单的 rows 到已有 rows，并对结果统一重编号 _rowId（全局唯一）。
//
// 入参：
//   existingRows    已合并 rows（本批首个文件时传 null / [] → 视为建首份，不做 headers 校验）
//   newRows         本次读入文件的 rows（readBankStatement 的 result.rows）
//   existingHeaders 已有 session headers（首份时传 null / [] → 跳过校验）
//   newHeaders      本次文件 headers（result.headers）
//
// 返回：{ rows, headers, isAppend }
//   rows     合并后数组（同一数组实例语义上是「existingRows 之后追加 newRows」），已统一重编号 _rowId='row_'+idx
//   headers  合并后 headers（首份 = newHeaders；追加 = 维持 existingHeaders，二者已校验一致）
//   isAppend false=本批首份（建 session）；true=追加合并到已有 rows
//
// 抛错：BankStatementMergeError —— 追加时 newHeaders 与 existingHeaders 不一致（异构表，拒绝合并）。
//
// ⚠️ 注意：本函数会就地改写 rows 元素的 _rowId（与原 handler 一致——原 handler 也是
//   bankStatementSession.rows.forEach 就地写 r._rowId）。caller 持有的 row 对象引用会被更新。
function mergeBankStatementRows(existingRows, newRows, existingHeaders, newHeaders) {
  const safeNewRows = Array.isArray(newRows) ? newRows : [];
  const hasExisting = Array.isArray(existingRows) && existingRows.length > 0;

  let mergedRows;
  let mergedHeaders;
  let isAppend;

  if (!hasExisting) {
    // 本批首份银行对账单：直接以 newRows 建集（不做 headers 校验，与原 handler「第一个建 session」分支一致）。
    mergedRows = safeNewRows.slice();
    mergedHeaders = Array.isArray(newHeaders) ? newHeaders.slice() : [];
    isAppend = false;
  } else {
    // 追加合并：先校验 headers 完全一致（44 列同结构），不一致拒绝（防异构表污染）。
    if (!bankStatementHeadersEqual(existingHeaders, newHeaders)) {
      throw new BankStatementMergeError('表头与已导入银行对账单不一致，无法合并');
    }
    mergedRows = existingRows.concat(safeNewRows);
    mergedHeaders = Array.isArray(existingHeaders) ? existingHeaders.slice() : [];
    isAppend = true;
  }

  // 🔴 合并后统一重编号 _rowId（0-based 跨文件全局唯一）——覆盖 readBankStatement 的文件内 row_idx。
  mergedRows.forEach((row, idx) => {
    if (row && typeof row === 'object') {
      row._rowId = `row_${idx}`;
    }
  });

  return { rows: mergedRows, headers: mergedHeaders, isAppend };
}

module.exports = {
  BankStatementMergeError,
  bankStatementHeadersEqual,
  mergeBankStatementRows
};
