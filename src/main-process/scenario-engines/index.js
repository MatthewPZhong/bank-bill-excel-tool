// v2.0.0-beta.3：场景算法引擎统一入口
// 按 category 分发到 c1/c2/c3 对应的 runner

const { runC1Scenario } = require('./c1-extract-recon-id');
const { runC2Scenario } = require('./c2-offset-bill-mark');
const { runC3Scenario } = require('./c3-gateway-recon-join');

// 统一入口：runScenario(scenario, bankRows, gwRows?)
// 返回 { lockedRowIds: Set, modifications: Array, warnings: Array }
function runScenario(scenario, bankRows, gwRows = null) {
  if (!scenario || !scenario.category) {
    throw new Error('runScenario: scenario 无效，缺少 category');
  }
  switch (scenario.category) {
    case 'extract-recon-id':
      return runC1Scenario(scenario, bankRows);
    case 'offset-bill-mark':
      return runC2Scenario(scenario, bankRows);
    case 'gateway-recon-join':
      return runC3Scenario(scenario, bankRows, gwRows);
    default:
      throw new Error(`runScenario: 未知 category "${scenario.category}"`);
  }
}

module.exports = {
  runScenario,
  runC1Scenario,
  runC2Scenario,
  runC3Scenario
};
