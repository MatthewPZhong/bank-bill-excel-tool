// v2.1.0-beta.1 PR-B：单据对账 ReconID 修复模块顶层引擎入口
// spec §五.2
//
// 不复用 v2.0.0-beta.3 scenario-dispatcher.js（first-match-wins 行级锁与本模块的
// fixedRows / warnings 模型不兼容；本模块单场景独立跑）

const { runC4Scenario } = require('./scenario-engines/c4-recon-id-fix');

function runReconIdFix(scenario, sheets) {
  if (!scenario) {
    throw new Error('runReconIdFix: scenario 不能为空');
  }
  if (scenario.category !== 'recon-id-fix') {
    throw new Error(`runReconIdFix: scenario.category 必须是 recon-id-fix，当前为 ${scenario.category}`);
  }
  if (!sheets || !Array.isArray(sheets.businessBills) || !Array.isArray(sheets.opponentBills)) {
    throw new Error('runReconIdFix: sheets.businessBills / opponentBills 必须是数组');
  }
  return runC4Scenario(scenario, sheets);
}

module.exports = {
  runReconIdFix
};
