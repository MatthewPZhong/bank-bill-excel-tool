'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = '/private/tmp/toolbox-rows-review-w5qxlh5q';
const load = (p) => require(path.join(root, 'src/main-process', p));
const { prepareRows, generateValidateAndPublishRows } = load('toolbox-row-split/service');
const { executeRowsGeneration } = load('toolbox-row-split/executor');
const { buildRowTargets, planRowCounts } = load('toolbox-row-split/contracts');
const { sourceSnapshotFromStat } = load('archive-center/source-snapshot');
const { normalizeFilePlanV1 } = load('archive-center/file-plan');
const { publishToolboxPublicationAsync } = load('toolbox-output-publication-dispatch');
(async () => {
  const dir = fs.realpathSync(fs.mkdtempSync('/private/tmp/rows-overwrite-race-'));
  const source = path.join(dir, 'input.csv');
  fs.writeFileSync(source, 'A\n1\n2\n');
  const targets = buildRowTargets(source, dir, planRowCounts(2, 1));
  fs.writeFileSync(targets[0].filePath, 'confirmed-old');
  let confirmedPaths;
  const prep = await prepareRows({ sourceFilePath: source, splitReadToken: 't', mode: 'rows', rowsPerFile: 1 },
    { sourceFilePath: source, dataRowCount: 2, snapshot: sourceSnapshotFromStat(fs.statSync(source)) }, {
      chooseDirectory: async () => dir,
      confirmOverwrite: async (conflicts) => {
        confirmedPaths = conflicts.map(x => x.filePath);
        // Another process creates the formerly absent second target while the modal is open.
        fs.writeFileSync(targets[1].filePath, 'unconfirmed-new-user-file');
        return true;
      }
    });
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
    inputs: [{ filePath: source, role: 'input', sourceOperation: 'toolbox:split:export' }],
    outputs: prep.targets.map(x => ({ filePath: x.filePath, role: 'output', sourceOperation: 'toolbox:split:export' })) });
  const batchContext = { batchId: 1, batchNumber: 'PROBE', taskRunId: 'probe-run', taskKey: 'toolbox:split:export',
    moduleId: 'toolbox', parentRunId: 'probe-parent', operationKey: 'probe-operation' };
  const userDataDir = path.join(dir, 'user-data'); fs.mkdirSync(userDataDir);
  const privateDirectory = fs.mkdtempSync(path.join(dir, '.private-'));
  const result = await generateValidateAndPublishRows({ counts: prep.counts, filePlan, batchContext, privateDirectory,
    runtime: { async execute(request) { return { outcome: 'completed', terminalSource: 'job:done', result: await executeRowsGeneration(request.input) }; } },
    publisher: artifacts => publishToolboxPublicationAsync({ taskId: 'race-probe', artifacts,
      targets: filePlan.outputs.map(x => ({ targetPath: x.filePath, expectedTargetSnapshot: x.targetSnapshot })),
      userDataDir, batchContext, archiveInputFiles: filePlan.inputs, protectedSourcePaths: [source] }) });
  console.log(JSON.stringify({ dir, confirmedPaths,
    secondWasConfirmed: confirmedPaths.includes(targets[1].filePath),
    secondSnapshotExists: filePlan.outputs[1].targetSnapshot.exists,
    unconfirmedFileReplacedByXlsx: fs.readFileSync(targets[1].filePath).subarray(0, 2).toString() === 'PK',
    publishedCount: result.publication.files.length }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
