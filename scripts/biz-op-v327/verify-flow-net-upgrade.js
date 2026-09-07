'use strict';

// 两个独立进程分别加载旧代码和当前代码，只使用本脚本新建的临时主库、真实合成原件及原生 worker。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const markerName = 'flow-net-upgrade-fixture.json';

async function child(phase, codeDirectory, runDirectory) {
  const marker = readJson(path.join(runDirectory, markerName));
  assert.equal(marker.owner, 'verify-flow-net-upgrade');
  assert.equal(fs.realpathSync(runDirectory), marker.runDirectory);
  assert.ok(['baseline', 'current'].includes(phase));
  const load = createRequire(path.join(codeDirectory, 'package.json'));
  const { createExportHost, request } = load('./tests/helpers/biz-op-v327-export');
  const { writeXlsx, opRow, flowRow } = load('./tests/helpers/biz-op-v327-xlsx');
  const { compute, readResult } = load('./tests/helpers/biz-op-v327-compute');
  const { RESULT_COLUMNS, RESULT_SCHEMA_VERSION } = load('./src/main-process/biz-op-v327/result-schema');
  const { subtractCanonicalDecimals: subtract } = load('./src/main-process/financial-decimal');
  const XLSX = load('xlsx');
  const cleanups = []; const startedAt = Date.now();
  const f = await createExportHost({ after(fn) { cleanups.push(fn); } }, { root: path.join(runDirectory, 'host'),
    outputRoot: path.join(runDirectory, 'exports'), keep: true });
  const snapshotFile = path.join(runDirectory, 'baseline-snapshot.json');
  const inputHeads = () => f.db.prepare('SELECT * FROM biz_op_v327_input_heads ORDER BY kind,data_date').all().map((row) => ({ ...row }));
  const importCount = () => f.db.prepare("SELECT count(*) AS n FROM archive_task_runs WHERE task_key='bizOpReconV327:import'").get().n;
  function sealedState(runId) {
    const saved = readResult(f, runId);
    const directory = path.posix.dirname(saved.run.payload_manifest_rel_path);
    return JSON.parse(JSON.stringify({ ...saved, fileHashes: Object.fromEntries(['manifest.json', ...saved.manifest.parts.map((part) => part.name)]
      .map((name) => [name, sha256(fs.readFileSync(f.module.payloadStore.resolve(`${directory}/${name}`)))])) }));
  }
  function workbookCells(filePath) {
    const workbook = XLSX.readFile(filePath, { cellStyles: true });
    return workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name]; const bounds = XLSX.utils.decode_range(sheet['!ref']);
      return { name, rows: Array.from({ length: bounds.e.r + 1 }, (_, row) =>
        Array.from({ length: bounds.e.c + 1 }, (_, col) => {
          const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
          return cell ? { t: cell.t, v: cell.v, z: cell.z || 'General', f: cell.f || null } : null;
        })) };
    });
  }
  async function exportBoth(runId, label) {
    const exports = {};
    for (const kind of ['RESULT_FULL', 'RESULT_DIFF']) {
      const result = await request(f, kind, runId, { targetPath: path.join(f.outputRoot, `${label}-${kind}.xlsx`) });
      assert.equal(result.status, 'ok', JSON.stringify(result));
      assert.equal(result.pendingArchiveHandoff, false);
      exports[kind] = { filePath: result.filePath, dataRowCount: result.dataRowCount, noteRowCount: result.noteRowCount,
        workbook: workbookCells(result.filePath) };
    }
    return exports;
  }
  try {
    if (phase === 'baseline') {
      assert.equal(RESULT_SCHEMA_VERSION, 'bizop-result-v1-e03');
      const { cases } = load('./tests/fixtures/biz-op-v327-acceptance-cases.json');
      assert.equal(cases.length, 17);
      const files = [];
      for (const [role, date] of [['startOpRows', '2026-08-08'], ['endOpRows', '2026-08-10']]) {
        const rows = cases.flatMap((item) => item[role].map((value) => {
          const row = opRow({ date, bu: 'BU-A', account: `${item.caseId}:000123`, begin: value.balance,
            amount: '0', incoming: '0', end: value.balance });
          row[2] = value.customer; row[3] = value.entity; row[5] = value.accountType; return row;
        }));
        const file = path.join(f.root, `${role}.xlsx`); files.push(file);
        await writeXlsx(file, { kind: 'OP', rowCount: rows.length, row: (index) => rows[index] });
      }
      const flows = cases.flatMap((item) => item.flowRows.map((value) => flowRow({ date: value.date, bu: 'BU-A',
        account: `${item.caseId}:000123`, direction: value.direction, amount: value.amount, number: '共享单号不去重' })));
      const file = path.join(f.root, 'flows.xlsx'); files.push(file);
      await writeXlsx(file, { rowCount: flows.length, row: (index) => flows[index] });
      assert.equal((await f.run(files)).status, 'ok');
      const result = await compute(f, { startDate: '2026-08-08', endDate: '2026-08-10' });
      assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(result.version, 1);
      const sealed = sealedState(result.runId);
      assert.equal(sealed.rows.length, 17);
      for (const [index, item] of cases.entries()) {
        const expected = [...item.expected19Values]; expected[3] = `${item.caseId}:000123`;
        if (expected[18]) expected[18] = expected[18].replace(`:${item.caseId}`, `:${index + 1}`);
        assert.deepEqual(RESULT_COLUMNS.map((column) => sealed.rows[index][column]), expected, item.caseId);
        assert.equal(Boolean(sealed.rows[index].is_difference), item.expectedInDifference, item.caseId);
      }
      const exports = await exportBoth(result.runId, 'baseline');
      assert.deepEqual(sealedState(result.runId), sealed);
      const record = { codeDirectory, resultSchemaVersion: RESULT_SCHEMA_VERSION,
        computeCodeSha256: sha256(fs.readFileSync(path.join(codeDirectory, 'src/main-process/biz-op-v327/compute-group.js'))),
        fixtureSha256: sha256(fs.readFileSync(path.join(codeDirectory, 'tests/fixtures/biz-op-v327-acceptance-cases.json'))),
        caseIds: cases.map((item) => item.caseId), result, sealed, inputHeads: inputHeads(), importCount: importCount(), exports };
      writeJson(snapshotFile, record);
      process.stdout.write(`旧版 PASS：${sealed.rows.length} 行，${result.diffRowCount} 行差异，FULL/DIFF 已实际导出。\n`);
    } else {
      assert.equal(RESULT_SCHEMA_VERSION, 'bizop-result-v2-net-flow');
      const previous = readJson(snapshotFile);
      assert.deepEqual(sealedState(previous.result.runId), previous.sealed, '重启不能修改旧封存结果');
      assert.deepEqual(inputHeads(), previous.inputHeads, '旧输入无需重新导入');
      assert.equal(importCount(), previous.importCount);
      const retained = await exportBoth(previous.result.runId, 'current-legacy');
      for (const kind of ['RESULT_FULL', 'RESULT_DIFF']) {
        assert.deepEqual(retained[kind].workbook, previous.exports[kind].workbook, `${kind} 历史导出所有页、值、类型和格式保持`);
      }
      const next = await compute(f, { startDate: '2026-08-08', endDate: '2026-08-10' });
      assert.equal(next.status, 'ok', JSON.stringify(next)); assert.equal(next.reused, false);
      assert.notEqual(next.runId, previous.result.runId); assert.equal(next.version, previous.result.version + 1);
      const current = sealedState(next.runId);
      assert.notEqual(current.run.input_fingerprint, previous.sealed.run.input_fingerprint);
      assert.equal(current.rows.length, previous.sealed.rows.length);
      for (const [index, row] of current.rows.entries()) {
        const expected = { ...previous.sealed.rows[index], c13_reverse_flow: subtract('0', previous.sealed.rows[index].c13_reverse_flow) };
        assert.deepEqual(row, expected, `${row.c04_account_no} 除第13列外所有结果列、原因和差异标志保持`);
        assert.equal(row.c13_reverse_flow, subtract(row.c11_flow_in, row.c12_flow_out));
      }
      const updated = await exportBoth(next.runId, 'current-new');
      for (const kind of ['RESULT_FULL', 'RESULT_DIFF']) {
        const oldData = previous.exports[kind].workbook[0]; const newData = updated[kind].workbook[0];
        assert.equal(newData.name, oldData.name);
        assert.equal(oldData.rows[0][13].v, '终止期末＋合计流水');
        const expectedHeaders = structuredClone(oldData.rows[0]); expectedHeaders[13].v = '终止期末－合计流水';
        assert.deepEqual(newData.rows[0], expectedHeaders);
        assert.equal(newData.rows.length, oldData.rows.length);
        for (let index = 1; index < oldData.rows.length; index += 1) {
          const expected = structuredClone(oldData.rows[index]); const flow = expected[12];
          const negated = subtract('0', String(flow.v)); flow.v = flow.t === 'n' ? Number(negated) : negated;
          assert.deepEqual(newData.rows[index], expected, `${kind} 第 ${index} 行仅合计流水反号`);
        }
        assert.equal(updated[kind].dataRowCount, previous.exports[kind].dataRowCount);
      }
      const repeated = await compute(f, { startDate: '2026-08-08', endDate: '2026-08-10' });
      assert.equal(repeated.status, 'ok'); assert.equal(repeated.reused, true);
      assert.equal(repeated.runId, next.runId); assert.equal(repeated.version, next.version);
      assert.equal(repeated.publishedAt, current.run.published_at);
      assert.deepEqual(sealedState(next.runId), current);
      assert.deepEqual(sealedState(previous.result.runId), previous.sealed, '新运行和导出后旧 rows/notes/manifest/分片字节不变');
      assert.deepEqual(inputHeads(), previous.inputHeads); assert.equal(importCount(), previous.importCount);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_runs').get().n, 2);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
      writeJson(path.join(runDirectory, 'validation.json'), { status: 'PASS', generatedAt: new Date().toISOString(),
        baseline: { codeDirectory: previous.codeDirectory, resultSchemaVersion: previous.resultSchemaVersion,
          computeCodeSha256: previous.computeCodeSha256, fixtureSha256: previous.fixtureSha256 },
        current: { codeDirectory, resultSchemaVersion: RESULT_SCHEMA_VERSION,
          computeCodeSha256: sha256(fs.readFileSync(path.join(codeDirectory, 'src/main-process/biz-op-v327/compute-group.js'))) },
        caseIds: previous.caseIds, fullRows: next.fullRowCount, differenceRows: next.diffRowCount,
        legacyRunId: previous.result.runId, newRunId: next.runId, legacyVersion: previous.result.version, newVersion: next.version,
        checks: { baselineApproved19Columns: true, legacyAllWorkbookCellsUnchanged: true, inputHeadsUnchanged: true,
          noReimport: true, newRunUsesNewFingerprint: true, onlyColumn13SignChanged: true, column14And15Unchanged: true,
          conclusionsReasonsAndDifferenceSetUnchanged: true, newHeaderUsesMinus: true, sameNewVersionReused: true,
          oldSealedRowsNotesManifestAndFileHashesUnchanged: true, zeroReadPins: true },
        exports: Object.fromEntries(['RESULT_FULL', 'RESULT_DIFF'].map((kind) => [kind, {
          baseline: previous.exports[kind].filePath, legacyAfterUpgrade: retained[kind].filePath, current: updated[kind].filePath }])),
        fixtureDirectory: runDirectory, elapsedCurrentMs: Date.now() - startedAt,
        runtime: { node: process.versions.node, electron: process.versions.electron || null, platform: process.platform } });
      process.stdout.write(`新版 PASS：${next.fullRowCount} 行仅第13列反号；旧结果完整保留；版本 ${previous.result.version} → ${next.version}；重复运行复用。\n`);
    }
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
}

async function runChild(phase, codeDirectory, runDirectory) {
  const logPath = path.join(runDirectory, `${phase}.log`); const log = fs.openSync(logPath, 'w');
  try {
    await new Promise((resolve, reject) => {
      const processChild = spawn(process.execPath, [__filename, '--child', phase, codeDirectory, runDirectory],
        { cwd: codeDirectory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', log, log] });
      processChild.once('error', reject);
      processChild.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${phase} 退出 ${code ?? signal}，见 ${logPath}`)));
    });
  } finally { fs.closeSync(log); }
}

async function main() {
  if (process.argv[2] === '--child') return child(process.argv[3], fs.realpathSync(process.argv[4]), fs.realpathSync(process.argv[5]));
  if (!process.argv[2]) throw new Error('用法：node scripts/biz-op-v327/verify-flow-net-upgrade.js <旧版代码目录> [临时证据输出目录]');
  const baselineDirectory = fs.realpathSync(process.argv[2]); const currentDirectory = fs.realpathSync(path.resolve(__dirname, '../..'));
  assert.notEqual(baselineDirectory, currentDirectory, '旧版和当前代码必须来自独立目录');
  const outputDirectory = path.resolve(process.argv[3] || os.tmpdir());
  let ancestor = outputDirectory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolvedOutput = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, outputDirectory));
  const temporaryRoots = [os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])].map((root) => fs.realpathSync(root));
  assert.ok(temporaryRoots.some((root) => resolvedOutput === root
    || resolvedOutput.startsWith(`${root}${path.sep}`)), '证据只允许写入临时目录');
  fs.mkdirSync(resolvedOutput, { recursive: true });
  const runDirectory = fs.mkdtempSync(path.join(resolvedOutput, 'bizop-flow-net-upgrade-'));
  fs.mkdirSync(path.join(runDirectory, 'host')); fs.mkdirSync(path.join(runDirectory, 'exports'));
  writeJson(path.join(runDirectory, markerName), { owner: 'verify-flow-net-upgrade', runDirectory });
  process.stdout.write(`隔离验证目录：${runDirectory}\n`);
  await runChild('baseline', baselineDirectory, runDirectory);
  await runChild('current', currentDirectory, runDirectory);
  process.stdout.write(`PASS：${path.join(runDirectory, 'validation.json')}\n`);
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
