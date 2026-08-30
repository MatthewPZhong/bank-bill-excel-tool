'use strict';

const { executeImportMonth } = require(
  '../../../src/main-process/bank-bu-worker/import-operation'
);
const { executeRun } = require('../../../src/main-process/bank-bu-worker/run-operation');

function killNow() {
  process.kill(process.pid, 'SIGKILL');
}

async function main() {
  const payload = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
  if (payload.mode === 'import-before-commit') {
    await executeImportMonth(payload.input, {
      operationIdentity: payload.operationIdentity,
      async awaitCritical() { killNow(); }
    });
    throw new Error('import-before-commit kill未生效');
  }
  if (payload.mode === 'run-after-commit') {
    await executeRun(payload.input, {
      operationIdentity: payload.operationIdentity,
      async awaitCritical() {}
    });
    killNow();
    throw new Error('run-after-commit kill未生效');
  }
  throw new Error('未知BankBU E08-A kill probe mode');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
