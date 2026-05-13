const { createSmokeContext } = require('./smoke/support');
const { runSmokeScenarios } = require('./smoke/scenarios');
const { runScenarioEngineSmokeTests } = require('./smoke/scenario-engines');
const {
  runScenarioDispatcherSmokeTests,
  runExceljsWriterSmokeTests
} = require('./smoke/scenario-dispatcher');
const { runBankStatementIoSmokeTests } = require('./smoke/bank-statement-io');
const { runScenariosRepositorySmokeTests } = require('./smoke/scenarios-repository');
const { runScenarioEndToEndSmokeTests } = require('./smoke/scenario-end-to-end');
const { runErrorCausesSmokeTests } = require('./smoke/error-causes');
const { runUsageStatsSmokeTests } = require('./smoke/usage-stats');
// v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块 — CHECK 约束迁移
const { runMigrationsReconIdFixSmokeTests } = require('./smoke/migrations-recon-id-fix');
// v2.1.0-beta.1 PR-A：scenarios:* IPC 的 C4 增删改查
const { runReconIdFixScenarioIpcSmokeTests } = require('./smoke/recon-id-fix-scenario-ipc');
// v2.1.0-beta.1 PR-B：4 sheet IO + 7+5 规则 + IPC handler 仿真 + 端到端
const { runReconIdFixIoSmokeTests } = require('./smoke/recon-id-fix-io');
const { runReconIdFixEngineSmokeTests } = require('./smoke/recon-id-fix-engine');
const { runReconIdFixIpcHandlersSmokeTests } = require('./smoke/recon-id-fix-ipc-handlers');
const { runReconIdFixEndToEndSmokeTests } = require('./smoke/recon-id-fix-end-to-end');
// v2.1.0-beta.3 T10：网关对账子模式引擎 smoke（基线 6 用例 + PR #39 review 扩展 3 用例 + constants sanity = 10/10）
const { runReconIdFixEngineGatewaySmokeTests } = require('./smoke/recon-id-fix-engine-gateway');
// v2.1.2 T2：月度银行对账单BU回填校验（A-E + F-H + I 覆盖导入回归 + 5 normalize 单测）
const { runBankBuReconSmokeTests } = require('./smoke/bank-bu-recon');

async function run() {
  const context = createSmokeContext();
  runSmokeScenarios(context);
  runScenarioEngineSmokeTests();
  runScenariosRepositorySmokeTests();
  runMigrationsReconIdFixSmokeTests();
  runReconIdFixScenarioIpcSmokeTests();
  // PR-B：单据对账 ReconID 修复模块新增 smoke
  runReconIdFixEngineSmokeTests();
  // v2.1.0-beta.3 T10：网关对账子模式引擎 smoke（基线 6 用例 + PR #39 review 扩展 3 用例 + constants sanity = 10/10）
  runReconIdFixEngineGatewaySmokeTests();
  await runReconIdFixIoSmokeTests();
  await runReconIdFixIpcHandlersSmokeTests();
  await runReconIdFixEndToEndSmokeTests();
  await runScenarioDispatcherSmokeTests();
  await runExceljsWriterSmokeTests();
  await runBankStatementIoSmokeTests();
  await runScenarioEndToEndSmokeTests();
  runErrorCausesSmokeTests();
  runUsageStatsSmokeTests();
  // v2.1.2 T2：月度银行对账单BU回填校验
  await runBankBuReconSmokeTests();
  console.log('smoke test passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
