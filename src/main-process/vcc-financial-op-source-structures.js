'use strict';

// 设置 → 模板文件：VCC 财务OP 5 张原表的当前导入识别结构，选文件预检时解析一次并冻结进导入计划。
//   只返回启用了用户版本的原表 { [sourceType]: { headers, versionLabel } }（都为内置时返回 null）；
//   用户版本不可用时抛错（预检失败并指向设置），不静默改用内置结构。

const { INPUT_STRUCTURES } = require('./template-resources/input-structures');

async function resolveVccSourceStructures(templateService) {
  const structures = {};
  for (const [resourceId, spec] of Object.entries(INPUT_STRUCTURES)) {
    if (spec.group !== 'vcc-sources') continue;
    const current = await templateService.currentInputStructure(resourceId);
    if (current.status === 'unavailable') {
      throw Object.assign(new Error(current.message), { code: 'vcc-source-structure-unavailable', detailLines: [] });
    }
    if (current.status === 'user') structures[spec.moduleKey] = { headers: [...current.headers], versionLabel: current.label };
  }
  return Object.keys(structures).length ? structures : null;
}

module.exports = { resolveVccSourceStructures };
