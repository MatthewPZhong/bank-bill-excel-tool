// v2.1.0-beta.1 PR-B：单据对账 ReconID 修复模块顶层引擎入口
// spec §五.2
// v2.1.0-beta.3 T9：扩展支持网关对账子模式（gateway-recon-id-fix）
// v2.1.16-beta.5 需求5：网关子模式下按 config.subCategory 分流到 JPM 调拨订单修复引擎（🔴 资金红线）
//
// 不复用 v2.0.0-beta.3 scenario-dispatcher.js（first-match-wins 行级锁与本模块的
// fixedRows / warnings 模型不兼容；本模块单场景独立跑）

const { runC4Scenario } = require('./scenario-engines/c4-recon-id-fix');
const { runJpmDispatchOrderFix } = require('./scenario-engines/jpm-dispatch-order-fix');
const { runBocDispatchOrderFix } = require('./scenario-engines/boc-dispatch-order-fix');

const VALID_CATEGORIES = ['recon-id-fix', 'gateway-recon-id-fix'];

// v2.1.16-beta.5 需求5：加第三参 opts（默认 {}）注入 admRows，兼容旧 2 参调用（R-9）。
//   business / 普通 gateway 路径不读 opts，不受影响。
function runReconIdFix(scenario, sheets, opts = {}) {
  if (!scenario) {
    throw new Error('runReconIdFix: scenario 不能为空');
  }
  if (!VALID_CATEGORIES.includes(scenario.category)) {
    throw new Error(`runReconIdFix: scenario.category 必须是 ${VALID_CATEGORIES.join(' | ')}，当前为 ${scenario.category}`);
  }
  if (!sheets || !Array.isArray(sheets.businessBills) || !Array.isArray(sheets.opponentBills)) {
    throw new Error('runReconIdFix: sheets.businessBills / opponentBills 必须是数组');
  }
  // v2.1.16-beta.5 需求5：JPM 调拨订单修复分流（仅 gateway category ∧ config.subCategory 命中时走新引擎）。
  //   🔴 admRows 由 main.js recon-id-fix:run 注入 database.readAdmBankDepositRows()；引擎原地改后回写。
  if (scenario.category === 'gateway-recon-id-fix'
      && scenario.config && scenario.config.subCategory === 'jpm-dispatch-order-fix') {
    return runJpmDispatchOrderFix({
      sheets,
      admRows: Array.isArray(opts.admRows) ? opts.admRows : [],
      scenario
    });
  }
  // v3.0.4 块 E 需求3：BOC 调拨订单修复分流（仅 gateway category ∧ config.subCategory 命中时走 BOC 引擎）。
  //   🔴 bocLinkRows 由 main.js recon-id-fix:run 注入 database.readBocFxLinkRows()；BOC 引擎只读不回写。
  if (scenario.category === 'gateway-recon-id-fix'
      && scenario.config && scenario.config.subCategory === 'boc-dispatch-order-fix') {
    return runBocDispatchOrderFix({
      sheets,
      bocLinkRows: Array.isArray(opts.bocLinkRows) ? opts.bocLinkRows : [],
      scenario
    });
  }
  // v2.1.0-beta.3 T9：按 scenario.category 推导子模式（business / gateway），传给 C4 引擎
  //   sheets.businessBills 在 gateway 模式下是网关账单，opponentBills 是渠道账单（IO 层负责按 mode 读对应 sheet）
  const subMode = scenario.category === 'gateway-recon-id-fix' ? 'gateway' : 'business';
  return runC4Scenario(scenario, sheets, subMode);
}

module.exports = {
  runReconIdFix
};
