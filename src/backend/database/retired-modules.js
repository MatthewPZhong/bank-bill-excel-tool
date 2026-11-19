'use strict';

// v3.2.20 下线的四个模块（月度Pending数据核对、月度银行对账单BU回填校验、业务OP数据核对、收单单据币种校验）。
//   这些 id 同时是主模块 id 与存档 module_id。用户数据保留不动：新版不展示、不改写、不删除这些模块的
//   设置、存档批次与任务记录，回退旧版后由旧版继续使用（spec：changes/v3.2.20/feat/retire-recon-modules/spec.md）。
const RETIRED_MODULE_IDS = Object.freeze([
  'pending-reconciliation', 'bank-bu-recon', 'biz-op-recon', 'acquiring-bill-currency'
]);

function isRetiredModuleId(value) {
  return typeof value === 'string' && RETIRED_MODULE_IDS.includes(value);
}

// SQL 片段：`<列> NOT IN ('pending-reconciliation', ...)`；id 为固定常量，不来自外部输入。
function retiredModuleExclusionSql(column) {
  if (!/^[a-z_]+(?:\.[a-z_]+)?$/.test(column)) throw new TypeError(`列名非法：${column}`);
  return `${column} NOT IN (${RETIRED_MODULE_IDS.map((id) => `'${id}'`).join(', ')})`;
}

module.exports = {
  RETIRED_MODULE_IDS,
  isRetiredModuleId,
  retiredModuleExclusionSql
};
