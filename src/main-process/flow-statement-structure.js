'use strict';

// 设置 → 模板文件：「流水对账单」当前导入识别结构（业务 OP 与 VCC OP 发生额计算共用）。
//   用户版本返回 { headers, versionLabel }；内置版本返回 null；用户版本不可用时抛错（导入 / 扫描中止并指向设置）。

async function resolveFlowStatementStructure(templateService) {
  const current = await templateService.currentInputStructure('flow-statement');
  if (current.status === 'unavailable') {
    throw Object.assign(new Error(current.message), { code: 'FLOW_STATEMENT_STRUCTURE_UNAVAILABLE', detailLines: [] });
  }
  return current.status === 'user' ? { headers: [...current.headers], versionLabel: current.label } : null;
}

module.exports = { resolveFlowStatementStructure };
