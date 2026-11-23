'use strict';

// v3.2.22 B57 / B58 工具箱发布核对的共用夹具：执行 Main 原始合表 / 按字段拆分的 prepare、execute 与发布 wrapper，
//   文件读写、FilePlan 与发布器为真实实现；系统对话框、后台调度与归档结算为替身（生成走非后台路径）。
//   单测 tests/unit/main-process/toolbox-publication-freshness.test.js 与集成 scripts/integration/toolbox-publication-freshness.js 共用。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const ExcelJS = require('exceljs');
const { sourceSnapshotFromStat } = require('../../src/main-process/archive-center/source-snapshot');
const { assertFilePlanFresh, normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { prepareIpcTaskInvocation } = require('../../src/main-process/archive-center/ipc-task-contract');
const { mergeToolboxFilesToXlsx } = require('../../src/main-process/toolbox-merge-io');
const { exportToolboxFilter, exportToolboxMultiFilters } = require('../../src/main-process/toolbox-format-operations');
const { normalizeMultiSplitGroups } = require('../../src/main-process/toolbox-multi-split');
const { buildMergeFileName, buildSplitFileName } = require('../../src/main-process/toolbox');
const { pathsAlias } = require('../../src/main-process/toolbox-target-identity');
const { TOOLBOX_GENERATION_ACTIONS } = require('../../src/main-process/toolbox-background/generation-contract');
const { createTestPublicationHarness } = require('./publication-authority');

const main = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
function section(startText, endText) {
  const start = main.indexOf(startText);
  const end = main.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, startText);
  return main.slice(start, end);
}
const mainFunctions = [
  section('function toolboxFailureResult(', 'async function acknowledgeToolboxPublicationReceipts'),
  section('function assertToolboxTargetsDoNotAliasSources(', 'let toolboxSplitReadContext'),
  section("trackedIpcHandle('toolbox:merge'", '  // IPC 2 ——'),
  section("trackedIpcHandle('toolbox:split:export'", '\n}\n\n// v2.0.0-beta.4')
].join('\n');

const batchContext = { batchId: 1, batchNumber: 'FRESH-1', taskRunId: 'toolbox-fresh-run',
  taskKey: 'toolbox:split:export', moduleId: 'toolbox', parentRunId: 'toolbox-fresh', operationKey: 'fresh-operation' };
const SOURCE_TEXT = 'Name,Amount\nA,1\nB,2\n';

// registerCleanup：node:test 传 (fn) => t.after(fn)；集成脚本自行收集后清理
function setup(registerCleanup) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-fresh-')));
  registerCleanup(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.csv');
  fs.writeFileSync(source, SOURCE_TEXT);
  const output = path.join(root, 'out');
  const userDataDir = path.join(root, 'user-data');
  fs.mkdirSync(output);
  fs.mkdirSync(userDataDir);
  return { root, source, output, userDataDir };
}

function loadHandlers(env, overrides = {}) {
  const contracts = new Map();
  const { dispatcher } = createTestPublicationHarness(env.userDataDir);
  const calls = { publication: 0, settle: 0, dialogs: [] };
  const readContext = { sourceFilePath: env.source, dataRowCount: 2,
    snapshot: sourceSnapshotFromStat(fs.statSync(env.source, { bigint: true })) };
  const scope = {
    fs, os, path, randomUUID, pathsAlias, assertFilePlanFresh, normalizeFilePlanV1, TOOLBOX_GENERATION_ACTIONS,
    trackedIpcHandle: (channel, _scope, _name, contract) => { contracts.set(channel, contract); },
    app: { getPath: () => env.userDataDir }, mainWindow: null,
    showImportOpenDialog: overrides.showImportOpenDialog || (async () => ({ canceled: false, filePaths: [env.output] })),
    dialog: {
      showSaveDialog: overrides.showSaveDialog || (async () => ({ canceled: false, filePath: path.join(env.output, 'result.xlsx') })),
      showMessageBox: async (_window, options) => {
        calls.dialogs.push(options);
        return overrides.showMessageBox ? overrides.showMessageBox(options) : { response: 1 };
      }
    },
    statementFileDialogFilters: () => [],
    toolboxBuildMergeFileName: buildMergeFileName, toolboxBuildSplitFileName: buildSplitFileName,
    sanitizeFileName: (value) => String(value),
    toolboxNormalizeMultiSplitGroups: normalizeMultiSplitGroups,
    requireToolboxSplitReadContext: () => readContext,
    clearToolboxSplitReadContext: () => {},
    backgroundExecutionRuntimeManager: { isProductionEnabled: () => false, get: () => null },
    shouldUseLargeChannel: async () => false,
    toolboxMergeFilesToXlsx: overrides.toolboxMergeFilesToXlsx || mergeToolboxFilesToXlsx,
    exportToolboxFilter: overrides.exportToolboxFilter || exportToolboxFilter,
    exportToolboxMultiFilters: overrides.exportToolboxMultiFilters || exportToolboxMultiFilters,
    publishToolboxPublicationAsync: async (options) => {
      calls.publication += 1;
      calls.publicationOptions = options;
      if (overrides.beforePublish) await overrides.beforePublish(options);
      return dispatcher.publish({ ...options, requireArchiveHandoff: true });
    },
    appendActivityLogEntry: () => {},
    toolboxFinalOutputFiles: (files) => files
  };
  Function(...Object.keys(scope), mainFunctions)(...Object.values(scope));
  const run = async (channel, payload) => {
    const contract = contracts.get(channel);
    const prepared = await prepareIpcTaskInvocation(contract, {}, payload === undefined ? [] : [payload]);
    if (!prepared.proceed) return { prepared, result: prepared.result };
    return { prepared, result: await executePrepared(contract, prepared, calls) };
  };
  return { contracts, calls, run, execute: (contract, prepared) => executePrepared(contract, prepared, calls) };
}

function executePrepared(contract, prepared, calls) {
  const filePlan = prepared.filePlan;
  return contract.execute({}, prepared, { batchContext,
    fileEvidence: { filePlan, inputFiles: filePlan.inputs, targetSnapshots: filePlan.outputs.map((item) => item.targetSnapshot) },
    settleArtifacts: async () => { calls.settle += 1; return { durable: true }; } });
}

const MULTI_PAYLOAD = { sourceFilePath: '', splitReadToken: 't', mode: 'multiple',
  groups: [{ fileName: 'A.xlsx', field: 'Name', values: ['A'] }, { fileName: 'B.xlsx', field: 'Name', values: ['B'] }] };

async function firstColumn(filePath) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(filePath);
  return book.worksheets[0].getColumn(1).values.slice(1).map(String);
}

const CASES = {
  merge: { channel: 'toolbox:merge', payload: undefined, targets: ['result.xlsx'] },
  single: { channel: 'toolbox:split:export', payload: { splitReadToken: 't', field: 'Name', values: ['A'] }, targets: ['result.xlsx'] },
  multiple: { channel: 'toolbox:split:export', payload: { ...MULTI_PAYLOAD }, targets: ['A.xlsx', 'B.xlsx'] }
};
function caseOverrides(env, kind, extra = {}) {
  return {
    showImportOpenDialog: async (scopeName) => ({ canceled: false,
      filePaths: [kind === 'merge' && scopeName === 'toolbox' ? env.source : env.output] }),
    ...extra
  };
}
function casePayload(env, kind) {
  const payload = CASES[kind].payload;
  return payload && { ...payload, sourceFilePath: env.source };
}

module.exports = {
  CASES, MULTI_PAYLOAD, caseOverrides, casePayload, firstColumn, loadHandlers, setup,
  generators: { mergeToolboxFilesToXlsx, exportToolboxFilter, exportToolboxMultiFilters }
};
