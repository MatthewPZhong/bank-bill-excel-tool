// v2.1.0-beta.1 PR-B：单据对账 ReconID 修复模块顶层引擎入口
// spec §五.2
// v2.1.0-beta.3 T9：扩展支持网关对账子模式（gateway-recon-id-fix）
//
// 不复用 v2.0.0-beta.3 scenario-dispatcher.js（first-match-wins 行级锁与本模块的
// fixedRows / warnings 模型不兼容；本模块单场景独立跑）

const { runC4Scenario } = require('./scenario-engines/c4-recon-id-fix');

const VALID_CATEGORIES = ['recon-id-fix', 'gateway-recon-id-fix'];

function runReconIdFix(scenario, sheets) {
  if (!scenario) {
    throw new Error('runReconIdFix: scenario 不能为空');
  }
  if (!VALID_CATEGORIES.includes(scenario.category)) {
    throw new Error(`runReconIdFix: scenario.category 必须是 ${VALID_CATEGORIES.join(' | ')}，当前为 ${scenario.category}`);
  }
  if (!sheets || !Array.isArray(sheets.businessBills) || !Array.isArray(sheets.opponentBills)) {
    throw new Error('runReconIdFix: sheets.businessBills / opponentBills 必须是数组');
  }
  // v2.1.0-beta.3 T9：按 scenario.category 推导子模式（business / gateway），传给 C4 引擎
  //   sheets.businessBills 在 gateway 模式下是网关账单，opponentBills 是渠道账单（IO 层负责按 mode 读对应 sheet）
  const subMode = scenario.category === 'gateway-recon-id-fix' ? 'gateway' : 'business';
  return runC4Scenario(scenario, sheets, subMode);
}

module.exports = {
  runReconIdFix
};
