'use strict';

// 设置 → 模板文件「银行对账单（导入识别结构）」当前版本（银行账单处理、前置资金对账等共用）。
//   D17：启用用户版本后同时接受内置 46 列与当前版本；当前版本不可用或读取异常时只认内置 46 列，不中止导入。

async function resolveBankStatementStructure(templateService) {
  try {
    return await templateService.currentInputStructure('bank-statement-input');
  } catch (_error) {
    return { status: 'builtin' };
  }
}

// readBankStatement 的 sourceHeaders：仅当前为可用的用户版本时返回其表头。
function bankStatementSourceHeaders(current) {
  return current && current.status === 'user' && Array.isArray(current.headers) ? current.headers : null;
}

module.exports = { bankStatementSourceHeaders, resolveBankStatementStructure };
