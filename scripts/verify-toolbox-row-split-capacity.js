'use strict';

// 独立验收：只在新建的系统临时目录中读写，真实 Worker + FilePlan + Publisher。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { normalizeFilePlanV1 } = require('../src/main-process/archive-center/file-plan');
const { createBackgroundExecutionRuntime } = require('../src/main-process/background-execution/runtime');
const { publishToolboxPublicationAsync, recoverToolboxPublicationsAsync } = require('../src/main-process/toolbox-output-publication-dispatch');
const { scanToolboxSplitFields } = require('../src/main-process/toolbox-format-operations');
const { planRowCounts, buildRowTargets, publicResult } = require('../src/main-process/toolbox-row-split/contracts');
const { generateValidateAndPublishRows } = require('../src/main-process/toolbox-row-split/service');

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-rows-capacity-')));
  const runtime = createBackgroundExecutionRuntime({ availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3 });
  try {
    for (const count of [1, 8, 9, 999, 1000]) {
      const dir = path.join(root, String(count)); fs.mkdirSync(dir);
      const source = path.join(dir, '流水.csv');
      fs.writeFileSync(source, '序号,编号\n' + Array.from({ length: count }, (_, i) => `${i + 1},ID-${String(i + 1).padStart(6, '0')}\n`).join(''));
      const scan = await scanToolboxSplitFields(source);
      const counts = planRowCounts(scan.dataRowCount, 1);
      const targets = buildRowTargets(source, dir, counts);
      const started = Date.now();
      let peakProcessRss = 0, maxMainDelayMs = 0, lastTick = Date.now();
      const timer = setInterval(() => {
        const now = Date.now(); maxMainDelayMs = Math.max(maxMainDelayMs, now - lastTick - 20);
        lastTick = now; peakProcessRss = Math.max(peakProcessRss, process.memoryUsage().rss);
      }, 20);
      try {
        const planStarted = Date.now();
        const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
          inputs: [{ filePath: source, role: 'input', sourceOperation: 'toolbox:split:export' }],
          outputs: targets.map((target) => ({ filePath: target.filePath, role: 'output', sourceOperation: 'toolbox:split:export' })) });
        const planMs = Date.now() - planStarted;
        process.stdout.write(JSON.stringify({ phase: 'planned', fileCount: count, planMs }) + '\n');
        const privateDirectory = fs.mkdtempSync(path.join(dir, '.generation-'));
        const userDataDir = path.join(dir, 'user-data'); fs.mkdirSync(userDataDir);
        const batchContext = { batchId: count, batchNumber: 'ROWS-' + count, taskRunId: 'rows-run-' + count,
          taskKey: 'toolbox:split:export', moduleId: 'toolbox', parentRunId: 'rows-parent-' + count, operationKey: 'rows-operation-' + count };
        const result = await generateValidateAndPublishRows({ runtime, filePlan, batchContext,
          counts, privateDirectory, metadataDirectory: userDataDir,
          publisher: async (artifacts) => {
            process.stdout.write(JSON.stringify({ phase: 'generated', fileCount: artifacts.length, elapsedMs: Date.now() - started }) + '\n');
            return publishToolboxPublicationAsync({
              taskId: 'rows-publication-' + count, artifacts,
              targets: filePlan.outputs.map((output) => ({ targetPath: output.filePath, expectedTargetSnapshot: output.targetSnapshot })),
              protectedSourcePaths: [source], userDataDir, batchContext, archiveInputFiles: filePlan.inputs
            });
          } });
        assert.equal(result.publication.files.length, count);
        const ids = [];
        for (const [index, file] of result.publication.files.entries()) {
          const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file.filePath);
          assert.equal(book.worksheets.length, 1); assert.equal(book.worksheets[0].rowCount, 2);
          ids.push(Number(book.worksheets[0].getCell('A2').value));
          assert.equal(book.worksheets[0].getCell('B2').value, 'ID-' + String(index + 1).padStart(6, '0'));
        }
        assert.deepEqual(ids, Array.from({ length: count }, (_, index) => index + 1));
        const recovery = await recoverToolboxPublicationsAsync({ userDataDir,
          deferCommittedRecovery: true, acknowledgedCommittedTaskIds: [result.publication.taskId] });
        assert.ok(recovery.recovered.some((item) => item.taskId === result.publication.taskId && item.action === 'commit-cleanup'));
        process.stdout.write(JSON.stringify({ phase: 'verified', fileCount: count, planMs,
          elapsedMs: Date.now() - started, peakProcessRss, maxMainDelayMs,
          publicResultBytes: Buffer.byteLength(JSON.stringify(publicResult(counts, result.publication.files, result.warningSummary))),
          ...result.metrics }) + '\n');
      } finally { clearInterval(timer); }
    }
  } finally {
    await runtime.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
