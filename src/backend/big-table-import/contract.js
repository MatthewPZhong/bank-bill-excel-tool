// 通用大表导入引擎 — contract（v3.0.3 块 D · PR-G1）
//
// 职责：
//   1. validateContract(contract)：契约模块 schema 校验（字段齐全 + 类型正确）。
//   2. 🔴 三层白名单防护「第 1 层 · 静态推导校验」（spec §三.1）：valueColumnWhitelist 非 null 时
//      必须 ⊇ requiredColumns（业务声明的必需列集合）——否则 throw 配置错误「拒绝启动」（绝不带病运行）。
//      另做 sanity：whitelist / requiredColumns 的列索引不得越界 expectedHeaders 长度。
//
// 🔴 漏列 = 静默数据错误（资金红线，spec §三 引言）：
//   白名单漏配一列不报错——该列恒空串，若被 mapRow / monthKeyOf 消费即静默空值入库
//   （资金场景 = 金额/币种静默丢失）。本层在引擎启动时（dispatch 前）静态拦截。
//
// ⚠️ requiredColumns 的契约（业务模块必须遵守，文档锁）：
//   requiredColumns 必须涵盖 mapRow / monthKeyOf 实际消费的「全部列索引」。
//   即：凡 mapRow({ values }) 读取 values[i] 的 i、monthKeyOf({ values }) 读取 values[j] 的 j，
//   都必须出现在 requiredColumns 中。它是「业务必需列集合」的单一声明出处——
//   白名单是否覆盖必需列的判定完全依赖它，漏声明 = 防护失效。
//
// 契约模块形态（spec §2.3）：
//   { expectedHeaders: string[], valueColumnWhitelist: number[]|null,
//     validateHeaders(cells)→{ok,error,detailLines}, mapRow({rowR,values,ctx}),
//     insertSql: string, requiredColumns: number[], monthKeyOf({values}) }
//
// 约束：本文件不得 require 任何业务模块，引擎自包含。

// 引擎契约配置错误（区别于运行期数据错误 BigTableImportError）：
//   契约本身配置不合法（漏列/类型错/越界），属「拒绝启动」级——必须在 dispatch 前抛出。
class ContractValidationError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'ContractValidationError';
    this.detailLines = detailLines;
  }
}

// 判定是否为「全为非负整数」的数组。
function isIndexArray(v) {
  return Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0);
}

// ── v3.0.4 PR-B 引擎扩展包（E1-E5）契约可选字段 schema（🔴 铁律：契约不声明 ⇒ 引擎行为零变化）──
//   声明了但类型非法 ⇒ 拒绝启动（绝不带病运行）；未声明（undefined）⇒ 放行（不影响现状，收单契约零改动仍通过）。
//   E1 deleteForOverwrite(deleteKey)=>Array<{sql,params}>  多语句覆盖删除（与单串 deleteSqlForOverwrite 互斥共存、函数式优先）
//   E2 finalizeForCommit({totalImported,sourceFiles})=>Array<{sql,params}>  COMMIT 前事务内收尾
//   E3 rejectEmptyFiles:boolean + formatEmptyFileError(sourceFile)=>string  空文件整批拒绝
//   E4 maxCollectedErrors:number（>0，覆盖默认 100）+ captureRowValues:boolean  错误捕获增强
//   E5 dedupeKeyOf({values})=>string + formatDuplicateError({key})=>string  写侧跨文件去重
function validateExtensionFields(contract) {
  // E1
  if (contract.deleteForOverwrite !== undefined && typeof contract.deleteForOverwrite !== 'function') {
    throw new ContractValidationError('契约无效：deleteForOverwrite 必须是函数（deleteKey）=>Array<{sql,params}>', []);
  }
  // E2
  if (contract.finalizeForCommit !== undefined && typeof contract.finalizeForCommit !== 'function') {
    throw new ContractValidationError('契约无效：finalizeForCommit 必须是函数（{totalImported,sourceFiles}）=>Array<{sql,params}>', []);
  }
  // E3
  if (contract.rejectEmptyFiles !== undefined && typeof contract.rejectEmptyFiles !== 'boolean') {
    throw new ContractValidationError('契约无效：rejectEmptyFiles 必须是布尔值', []);
  }
  if (contract.formatEmptyFileError !== undefined && typeof contract.formatEmptyFileError !== 'function') {
    throw new ContractValidationError('契约无效：formatEmptyFileError 必须是函数（sourceFile）=>string', []);
  }
  // E4
  if (contract.maxCollectedErrors !== undefined
    && (!Number.isInteger(contract.maxCollectedErrors) || contract.maxCollectedErrors <= 0)) {
    throw new ContractValidationError('契约无效：maxCollectedErrors 必须是正整数（覆盖默认 100）', []);
  }
  if (contract.captureRowValues !== undefined && typeof contract.captureRowValues !== 'boolean') {
    throw new ContractValidationError('契约无效：captureRowValues 必须是布尔值', []);
  }
  // E5
  if (contract.dedupeKeyOf !== undefined && typeof contract.dedupeKeyOf !== 'function') {
    throw new ContractValidationError('契约无效：dedupeKeyOf 必须是函数（{values}）=>string', []);
  }
  if (contract.formatDuplicateError !== undefined && typeof contract.formatDuplicateError !== 'function') {
    throw new ContractValidationError('契约无效：formatDuplicateError 必须是函数（{key}）=>string', []);
  }
}

// 校验契约模块 schema + 三层防护第 1 层（静态推导）。
//   通过 → 返回归一化后的 { expectedHeaders, valueColumnWhitelist(Set|null), requiredColumns(已去重升序),
//          validateHeaders, mapRow, insertSql, monthKeyOf + E1-E5 可选扩展字段（声明时透传，未声明为 undefined）}；
//   不通过 → throw ContractValidationError。
function validateContract(contract) {
  if (!contract || typeof contract !== 'object') {
    throw new ContractValidationError('契约无效：contract 必须是对象', []);
  }

  const detail = [];

  // ── schema：expectedHeaders ──
  if (!Array.isArray(contract.expectedHeaders) || contract.expectedHeaders.length === 0
    || !contract.expectedHeaders.every((h) => typeof h === 'string')) {
    throw new ContractValidationError('契约无效：expectedHeaders 必须是非空字符串数组', []);
  }
  const expectedLen = contract.expectedHeaders.length;

  // ── schema：函数字段 ──
  for (const fn of ['validateHeaders', 'mapRow', 'monthKeyOf']) {
    if (typeof contract[fn] !== 'function') {
      throw new ContractValidationError(`契约无效：${fn} 必须是函数`, []);
    }
  }

  // ── schema：insertSql ──
  if (typeof contract.insertSql !== 'string' || contract.insertSql.trim() === '') {
    throw new ContractValidationError('契约无效：insertSql 必须是非空字符串', []);
  }

  // ── schema：requiredColumns（必须是非负整数数组，可空数组）──
  if (!isIndexArray(contract.requiredColumns)) {
    throw new ContractValidationError('契约无效：requiredColumns 必须是非负整数数组（业务声明的必需列索引）', []);
  }

  // ── schema：valueColumnWhitelist（null 或非负整数数组）──
  const wl = contract.valueColumnWhitelist;
  if (wl !== null && wl !== undefined && !isIndexArray(wl)) {
    throw new ContractValidationError('契约无效：valueColumnWhitelist 必须是 null 或非负整数数组', []);
  }
  const whitelistArr = (wl === null || wl === undefined) ? null : wl;

  // ── sanity：requiredColumns 不得越界 expectedHeaders 长度 ──
  const reqOverflow = contract.requiredColumns.filter((c) => c >= expectedLen);
  if (reqOverflow.length > 0) {
    throw new ContractValidationError(
      `契约无效：requiredColumns 含越界列索引（expectedHeaders 共 ${expectedLen} 列）`,
      reqOverflow.map((c) => `列索引 ${c} 越界（最大 ${expectedLen - 1}）`)
    );
  }

  // ── sanity：whitelist 不得越界 expectedHeaders 长度 ──
  if (whitelistArr !== null) {
    const wlOverflow = whitelistArr.filter((c) => c >= expectedLen);
    if (wlOverflow.length > 0) {
      throw new ContractValidationError(
        `契约无效：valueColumnWhitelist 含越界列索引（expectedHeaders 共 ${expectedLen} 列）`,
        wlOverflow.map((c) => `列索引 ${c} 越界（最大 ${expectedLen - 1}）`)
      );
    }
  }

  // ── 🔴 第 1 层防护：whitelist 非 null 时必须 ⊇ requiredColumns ──
  //   漏配必需列即静默空值入库 → 资金红线，拒绝启动。
  if (whitelistArr !== null) {
    const wlSet = new Set(whitelistArr);
    const missing = contract.requiredColumns.filter((c) => !wlSet.has(c));
    if (missing.length > 0) {
      const missingDetail = missing
        .sort((a, b) => a - b)
        .map((c) => `列索引 ${c}（${contract.expectedHeaders[c]}）未在白名单中`);
      throw new ContractValidationError(
        `契约无效：valueColumnWhitelist 未涵盖全部必需列（缺 ${missing.length} 列）——`
          + '漏配列恒空值入库（资金红线），拒绝启动',
        missingDetail.concat(detail)
      );
    }
  }

  // ── v3.0.4 PR-B：E1-E5 可选扩展字段类型校验（声明了才校验，未声明放行）──
  validateExtensionFields(contract);

  // 归一化：requiredColumns 去重升序；whitelist 转 Set（null 保持 null）。
  const requiredColumns = Array.from(new Set(contract.requiredColumns)).sort((a, b) => a - b);
  const valueColumnWhitelist = whitelistArr === null ? null : new Set(whitelistArr);

  return {
    expectedHeaders: contract.expectedHeaders,
    valueColumnWhitelist,
    requiredColumns,
    validateHeaders: contract.validateHeaders,
    mapRow: contract.mapRow,
    insertSql: contract.insertSql,
    monthKeyOf: contract.monthKeyOf,
    // ── v3.0.4 PR-B 引擎扩展包 E1-E5（透传，未声明为 undefined，引擎按存在性分支）──
    deleteForOverwrite: contract.deleteForOverwrite,        // E1 多语句覆盖删除
    finalizeForCommit: contract.finalizeForCommit,          // E2 事务内收尾
    rejectEmptyFiles: contract.rejectEmptyFiles === true,   // E3 空文件整批拒绝（缺省 false）
    formatEmptyFileError: contract.formatEmptyFileError,    // E3 空文件错误文案
    maxCollectedErrors: contract.maxCollectedErrors,        // E4 错误上限（缺省由引擎用 100）
    captureRowValues: contract.captureRowValues === true,   // E4 错误记录附带 cells（缺省 false）
    dedupeKeyOf: contract.dedupeKeyOf,                       // E5 写侧跨文件去重 key
    formatDuplicateError: contract.formatDuplicateError      // E5 重复行错误文案
  };
}

module.exports = {
  ContractValidationError,
  validateContract
};
