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
const { sourceSnapshotFromStat, sourceSnapshotMatchesStat } = require('../../src/main-process/archive-center/source-snapshot');
const { assertFilePlanFresh, assertFilePlanInputsFreshAsync, normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
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
  section('function assertToolboxSplitSourceFresh(', 'async function recoverToolboxPublicationsAtStartup('),
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

// 产物校验读取的 end 早于文件句柄 close。替换目录前先等真实关闭：Windows 上未关闭的读取句柄会使重命名提前失败，
//   尚未到达发布器的父目录核对（与 toolbox-row-split-parent-identity.test.js 同一做法）。只在 run / execute 期间跟踪。
const openReadStreams = new Set();
async function withReadStreamTracking(fn) {
  const createReadStream = fs.createReadStream;
  fs.createReadStream = function trackedCreateReadStream(...args) {
    const stream = createReadStream.apply(this, args);
    openReadStreams.add(stream);
    stream.once('close', () => openReadStreams.delete(stream));
    return stream;
  };
  try {
    return await fn();
  } finally {
    fs.createReadStream = createReadStream;
  }
}
function waitForReadStreamsClosed(root) {
  const reads = [...openReadStreams].filter((stream) => !stream.closed && String(stream.path).startsWith(root + path.sep));
  return Promise.all(reads.map((stream) => new Promise((resolve, reject) => {
    const onClose = () => { clearTimeout(timeout); resolve(); };
    const timeout = setTimeout(() => {
      stream.removeListener('close', onClose);
      reject(new Error(`产物读取句柄未及时关闭：${path.basename(String(stream.path))}`));
    }, 5000);
    stream.once('close', onClose);
  })));
}

function loadHandlers(env, overrides = {}) {
  const contracts = new Map();
  const { dispatcher } = createTestPublicationHarness(env.userDataDir);
  const calls = { publication: 0, settle: 0, dialogs: [] };
  const readContext = { sourceFilePath: env.source, dataRowCount: 2,
    snapshot: sourceSnapshotFromStat(fs.statSync(env.source, { bigint: true })) };
  const scope = {
    fs, os, path, randomUUID, pathsAlias: overrides.pathsAlias || pathsAlias, assertFilePlanFresh, assertFilePlanInputsFreshAsync,
    normalizeFilePlanV1: overrides.normalizeFilePlanV1 || normalizeFilePlanV1,
    sourceSnapshotMatchesStat,
    TOOLBOX_GENERATION_ACTIONS,
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
      if (overrides.beforePublish) {
        await waitForReadStreamsClosed(env.root);
        await overrides.beforePublish(options);
      }
      // 与生产入口 publishToolboxPublicationAsync（toolbox-output-publication-dispatch.js）同样的发布选项
      return dispatcher.publish({
        ...options,
        requireArchiveHandoff: true,
        requireValidatedArtifacts: true,
        allowEmptyArchiveInputs: options && options.allowEmptyArchiveInputs === true
      });
    },
    appendActivityLogEntry: () => {},
    toolboxFinalOutputFiles: (files) => files
  };
  Function(...Object.keys(scope), mainFunctions)(...Object.values(scope));
  // prepareOnly：只做 prepare（含契约层冻结），不执行
  const run = (channel, payload, { prepareOnly = false } = {}) => withReadStreamTracking(async () => {
    const contract = contracts.get(channel);
    const prepared = await prepareIpcTaskInvocation(contract, {}, payload === undefined ? [] : [payload]);
    if (!prepared.proceed || prepareOnly) return { prepared, result: prepared.result };
    return { prepared, result: await executePrepared(contract, prepared, calls) };
  });
  return { contracts, calls, run,
    execute: (contract, prepared) => withReadStreamTracking(() => executePrepared(contract, prepared, calls)) };
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

// 受控模拟文件系统给不出可靠的目录身份（target-parent-identity.js：前后两次 lstat 与 realpath 后 stat 的 dev / ino 不一致即
//   identityReliable: false）。times 为需要模拟的采样次数（Infinity 表示一直不可靠），返回 { restore, count }。
//   不依赖本机临时卷的实际能力，按 spec D3 的退回路径核对单独验证
function simulateUnreliableParentIdentity(directory, times = Infinity) {
  const statSync = fs.statSync;
  const state = { count: 0 };
  fs.statSync = function unreliableParentStat(target, options, ...rest) {
    const stat = statSync.call(this, target, options, ...rest);
    if (state.count >= times || !(options && options.bigint) || path.resolve(String(target)) !== directory) return stat;
    state.count += 1;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + 1n });
  };
  return { state, restore: () => { fs.statSync = statSync; } };
}

// 包装真实的 normalizeFilePlanV1：只在含输入的完整计划规范化（先冻结目标之后的第二次）期间执行 during，返回真实结果
//   （仍是 Main 登记过的冻结计划）。用来模拟「只有第二次看到不同的目标」。targetsOnly 为 true 时改为只在首次
//   「只冻结目标」（不含输入）的规范化期间执行。state.frozenTargets 记下首次只冻结目标的真实结果（本次确认时的目标证据）
function duringFullPlanSampling(during, { targetsOnly = false } = {}) {
  const state = { calls: 0, frozenTargets: null };
  const wrapped = (value, ...rest) => {
    const hasOutputs = value && Array.isArray(value.inputs) && Array.isArray(value.outputs) && value.outputs.length > 0;
    const isTargetsOnly = hasOutputs && value.inputs.length === 0;
    const inject = targetsOnly ? isTargetsOnly && state.calls === 0 : hasOutputs && value.inputs.length > 0;
    let after = null;
    if (inject) {
      state.calls += 1;
      after = during();
    }
    let result;
    try {
      result = normalizeFilePlanV1(value, ...rest);
    } finally {
      if (typeof after === 'function') after();
    }
    if (isTargetsOnly && !state.frozenTargets) state.frozenTargets = result;
    return result;
  };
  return { state, normalizeFilePlanV1: wrapped };
}

module.exports = {
  CASES, MULTI_PAYLOAD, caseOverrides, casePayload, duringFullPlanSampling, firstColumn, loadHandlers, setup,
  simulateUnreliableParentIdentity,
  generators: { mergeToolboxFilesToXlsx, exportToolboxFilter, exportToolboxMultiFilters }
};
