// v2.1.7 round 2 R5 — F1 默认 AND（仅新建）+ 资金红线三层护栏 smoke
//   spec §8.6 / PRD §十三-R5
//
// 不能直接 require src/renderer-dialogs.js（IIFE 闭包；createDefaultScenarioConfig + pickConditionsLogicChecked 都是模块内部）
// 改用 spec §8.6.2 / §8.6.4 锁定的等价规则单测 + 源码 grep 防 wiring 漏改
//
// 三层护栏（spec §8.6.5，缺一不可）：
//   1. createDefaultScenarioConfig（仅 mode=create）默认 AND
//   2. pickConditionsLogicChecked helper：mode=edit + 老 scenario 无 logic 字段 → OR 选中
//   3. c1-extract-recon-id.js runC1Scenario fallback：undefined → OR（不动；spec §2.2）

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { runC1Scenario } = require('../../src/main-process/scenario-engines/c1-extract-recon-id');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    passed += 1;
  } catch (_e) {
    failed += 1;
    failures.push({ label, actual, expected });
  }
}

function assertTrue(cond, label) {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push({ label, actual: false, expected: true });
  }
}

// spec §8.6.4 等价实现（与 src/renderer-dialogs.js pickConditionsLogicChecked 完全等价）
function pickConditionsLogicChecked(draft) {
  const mode = draft && draft.mode;
  const cfg = (draft && draft.config) || {};
  if (mode === 'create') {
    return cfg.conditionsLogic === 'OR' ? 'OR' : 'AND';
  }
  return cfg.conditionsLogic === 'AND' ? 'AND' : 'OR';
}

// =====================================================================
// R5-A：createDefaultScenarioConfig('extract-recon-id') 返回 conditionsLogic === 'AND'
//   通过 grep 源码字符串验证（IIFE 闭包不能 require）
// =====================================================================
function caseR5A_defaultConfigAnd() {
  const dialogsSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer-dialogs.js'), 'utf-8');
  // 在 createDefaultScenarioConfig 'extract-recon-id' 分支中含 conditionsLogic: 'AND'
  const extractBranch = dialogsSrc.match(/if \(category === 'extract-recon-id'\) \{[\s\S]+?return \{[\s\S]+?\};\s*\}/);
  assertTrue(extractBranch !== null, 'R5-A 找到 createDefaultScenarioConfig extract-recon-id 分支');
  if (extractBranch) {
    assertTrue(/conditionsLogic:\s*'AND'/.test(extractBranch[0]),
      'R5-A 默认 conditionsLogic === "AND"（spec §8.6.2 / 三层护栏第 1 层）');
    // 防回归：不能含 'OR'（除注释外）
    const codeLines = extractBranch[0].split('\n').filter((l) => !l.trim().startsWith('//'));
    const codeText = codeLines.join('\n');
    assertTrue(!/conditionsLogic:\s*'OR'/.test(codeText),
      'R5-A 默认配置不应含 conditionsLogic: "OR"（防回归）');
  }
}

// =====================================================================
// R5-B：pickConditionsLogicChecked({ mode: 'create', config: { conditionsLogic: 'AND' } }) → 'AND'
// =====================================================================
function caseR5B_createWithAnd() {
  assertEq(
    pickConditionsLogicChecked({ mode: 'create', config: { conditionsLogic: 'AND' } }),
    'AND',
    'R5-B mode=create + conditionsLogic=AND → AND 选中'
  );
  // 边界：mode=create 但 config 无字段（不该发生但防御）→ AND fallback
  assertEq(
    pickConditionsLogicChecked({ mode: 'create', config: {} }),
    'AND',
    'R5-B mode=create + config 无 conditionsLogic → AND fallback（spec §8.6.4）'
  );
  // 边界：mode=create + conditionsLogic=OR（用户在新建弹窗里手动切到 OR 后又重新打开？理论不会，但 spec 要求保留）
  assertEq(
    pickConditionsLogicChecked({ mode: 'create', config: { conditionsLogic: 'OR' } }),
    'OR',
    'R5-B mode=create + conditionsLogic=OR → OR 选中（保留用户选择）'
  );
}

// =====================================================================
// R5-C：pickConditionsLogicChecked({ mode: 'edit', config: { /* 无 conditionsLogic */ } }) → 'OR'
//   ⚠️ 资金红线护栏关键 case（spec §8.6.5）
// =====================================================================
function caseR5C_editOldScenarioFallbackOr() {
  // 老 scenario v2.1.6 / v2.1.7-round1 创建 — DB config 无 conditionsLogic 字段
  const oldScenarioConfig = {
    conditions: [{ field: 'CustomerRef', op: '等于', value: 'X' }],
    extractByFeature: null,
    extractByOtherField: { field: 'CustomerRef' }
    // 注意：故意不含 conditionsLogic
  };
  assertEq(
    pickConditionsLogicChecked({ mode: 'edit', config: oldScenarioConfig }),
    'OR',
    'R5-C ⚠️ 资金红线护栏：mode=edit + 老 scenario 无 conditionsLogic → OR 选中'
  );
  // 同样适用 mode=view
  assertEq(
    pickConditionsLogicChecked({ mode: 'view', config: oldScenarioConfig }),
    'OR',
    'R5-C mode=view + 老 scenario 无 conditionsLogic → OR 选中'
  );
}

// =====================================================================
// R5-D：pickConditionsLogicChecked({ mode: 'edit', config: { conditionsLogic: 'AND' } }) → 'AND'
//   新 scenario（v2.1.7 round 2 后创建）已显式存 'AND'，编辑时用本值
// =====================================================================
function caseR5D_editNewScenarioUseValue() {
  assertEq(
    pickConditionsLogicChecked({ mode: 'edit', config: { conditionsLogic: 'AND' } }),
    'AND',
    'R5-D mode=edit + conditionsLogic=AND → AND 选中（新 scenario 用本值）'
  );
  assertEq(
    pickConditionsLogicChecked({ mode: 'edit', config: { conditionsLogic: 'OR' } }),
    'OR',
    'R5-D mode=edit + conditionsLogic=OR → OR 选中'
  );
  // 防回归：mode=view 同样行为
  assertEq(
    pickConditionsLogicChecked({ mode: 'view', config: { conditionsLogic: 'AND' } }),
    'AND',
    'R5-D mode=view + conditionsLogic=AND → AND 选中'
  );
}

// =====================================================================
// R5-E：runC1Scenario 引擎 fallback — 老 scenario 无 conditionsLogic 字段时仍 OR 行为
//   ⚠️ 资金红线护栏第 3 层（spec §8.6.5 / §2.2 引擎保护）
//   引擎不依赖 dialog；spec §2.2 实现的 fallback 必须保持 OR
// =====================================================================
function caseR5E_engineFallbackOr() {
  // 老 scenario：conditions=[A=X, B=Y]，无 conditionsLogic 字段
  // 行 A=X B=Z → OR 命中（A 匹配）；AND 不命中（B 不匹配）
  const oldScenario = {
    id: 1, name: 'R5-E old', category: 'extract-recon-id',
    config: {
      conditions: [
        { field: 'A', op: '等于', value: 'X' },
        { field: 'B', op: '等于', value: 'Y' }
      ],
      // 注意：故意不含 conditionsLogic
      extractByFeature: null,
      extractByOtherField: { field: 'A' }
    }
  };
  const rows = [{ _rowId: 'r1', A: 'X', B: 'Z', ReconciliationId: '' }];
  runC1Scenario(oldScenario, rows);
  assertEq(
    rows[0].ReconciliationId, 'X',
    'R5-E ⚠️ 资金红线护栏第 3 层：引擎 fallback OR — 老 scenario A=true B=false → 命中（OR 行为，与 v2.1.6 一致）'
  );

  // 防回归：相同 scenario 显式 'AND' 应不命中
  const andScenario = {
    ...oldScenario,
    id: 2,
    config: { ...oldScenario.config, conditionsLogic: 'AND' }
  };
  const rows2 = [{ _rowId: 'r2', A: 'X', B: 'Z', ReconciliationId: '' }];
  runC1Scenario(andScenario, rows2);
  assertEq(
    rows2[0].ReconciliationId, '',
    'R5-E 显式 AND → A=true B=false 不命中（防回归，与 spec §2.2 行为一致）'
  );
}

// =====================================================================
// R5-WIRING：源码 wiring 防漏改断言（三层护栏验证）
// =====================================================================
function caseR5_wiringGrep() {
  const dialogsSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer-dialogs.js'), 'utf-8');
  const engineSrc = fs.readFileSync(path.join(__dirname, '../../src/main-process/scenario-engines/c1-extract-recon-id.js'), 'utf-8');

  // 1. dialog 含 pickConditionsLogicChecked 函数定义
  assertTrue(/function pickConditionsLogicChecked\(draft\)/.test(dialogsSrc),
    'R5-W-1 dialog 含 pickConditionsLogicChecked 函数定义');

  // 2. dialog C1 工厂内调用 pickConditionsLogicChecked(draft)
  assertTrue(/const checkedLogic = pickConditionsLogicChecked\(draft\)/.test(dialogsSrc),
    'R5-W-2 dialog C1 工厂调用 pickConditionsLogicChecked(draft) 决定 radio 选中');

  // 3. dialog HTML 用 checkedLogic === 'AND' / 'OR' 决定 radio checked（不再直接读 config.conditionsLogic）
  assertTrue(/checkedLogic === 'AND' \? 'checked' : ''/.test(dialogsSrc),
    'R5-W-3 dialog radio AND checked 由 checkedLogic 决定');
  assertTrue(/checkedLogic === 'OR' \? 'checked' : ''/.test(dialogsSrc),
    'R5-W-3 dialog radio OR checked 由 checkedLogic 决定');

  // 4. dialog HTML 含 conditionsLogic radio 容器（B1 round 3 后 .scenario-config-logic-stack
  //    → .scenario-config-logic-inline 移回"条件"row 内部；spec §9.2.2）
  assertTrue(/scenario-config-logic-(stack|inline)/.test(dialogsSrc),
    'R5-W-4 dialog HTML 含 conditionsLogic radio 容器（stack 独立 row 或 inline 内嵌"条件"row）');

  // 5. dialog HTML AND 在 OR 之前（纵向 AND 在上 OR 在下；B1 后仍保持）
  const containerMatch = dialogsSrc.match(/scenario-config-logic-(stack|inline)[^]*?<\/div>/);
  assertTrue(containerMatch !== null, 'R5-W-5 找到 conditionsLogic radio 容器块');
  if (containerMatch) {
    const andIdx = containerMatch[0].indexOf('value="AND"');
    const orIdx = containerMatch[0].indexOf('value="OR"');
    assertTrue(andIdx > 0 && orIdx > 0 && andIdx < orIdx,
      'R5-W-5 AND radio 在 OR radio 之前（纵向 AND 在上 OR 在下，spec §8.6.3）');
  }

  // 6. 引擎 fallback 不动（资金红线护栏第 3 层，spec §2.2 实现保持）
  assertTrue(/conditionsLogic\s*===\s*'AND'\s*\)\s*\?\s*'AND'\s*:\s*'OR'/.test(engineSrc),
    'R5-W-6 ⚠️ 资金红线护栏第 3 层：引擎 fallback (logic === "AND" ? "AND" : "OR") 不动');
}

function runScenarioC1DefaultsSmokeTests() {
  caseR5A_defaultConfigAnd();
  caseR5B_createWithAnd();
  caseR5C_editOldScenarioFallbackOr();
  caseR5D_editNewScenarioUseValue();
  caseR5E_engineFallbackOr();
  caseR5_wiringGrep();

  const total = passed + failed;
  if (failed === 0) {
    console.log(`[scenario-c1-defaults] ${passed}/${total} smoke tests passed`);
  } else {
    console.error(`[scenario-c1-defaults] ${passed}/${total} smoke tests passed, ${failed} failed:`);
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    throw new Error('scenario-c1-defaults smoke test failed');
  }
}

module.exports = { runScenarioC1DefaultsSmokeTests };
