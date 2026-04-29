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

async function run() {
  const context = createSmokeContext();
  runSmokeScenarios(context);
  runScenarioEngineSmokeTests();
  runScenariosRepositorySmokeTests();
  await runScenarioDispatcherSmokeTests();
  await runExceljsWriterSmokeTests();
  await runBankStatementIoSmokeTests();
  await runScenarioEndToEndSmokeTests();
  console.log('smoke test passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
