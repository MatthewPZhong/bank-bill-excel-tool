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

// 校验契约模块 schema + 三层防护第 1 层（静态推导）。
//   通过 → 返回归一化后的 { expectedHeaders, valueColumnWhitelist(Set|null), requiredColumns(已去重升序),
//          validateHeaders, mapRow, insertSql, monthKeyOf }；
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
    monthKeyOf: contract.monthKeyOf
  };
}

module.exports = {
  ContractValidationError,
  validateContract
};
