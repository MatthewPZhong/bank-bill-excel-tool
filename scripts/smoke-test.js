const { createSmokeContext } = require('./smoke/support');
const { runSmokeScenarios } = require('./smoke/scenarios');
const { runScenarioEngineSmokeTests } = require('./smoke/scenario-engines');

function run() {
  const context = createSmokeContext();
  runSmokeScenarios(context);
  runScenarioEngineSmokeTests();
  console.log('smoke test passed');
}

run();
