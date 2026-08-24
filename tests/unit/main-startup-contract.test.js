'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const espree = require('espree');

const root = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const database = fs.readFileSync(path.join(root, 'src/backend/database.js'), 'utf8');

function parseProductionStartup(source) {
  const ast = espree.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    range: true
  });
  const nodes = [];
  const parents = new Map();
  const visit = (node, parent = null) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent);
      return;
    }
    if (typeof node.type === 'string') {
      nodes.push(node);
      if (parent) parents.set(node, parent);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'range') visit(value, node);
    }
  };
  visit(ast);
  const identifier = (node, name) => node?.type === 'Identifier' && node.name === name;
  const calls = (name) => nodes.filter((node) => node.type === 'CallExpression'
    && identifier(node.callee, name));
  const bindingModulePath = './main-process/background-execution/action-task-binding-registry';
  const bindingImportSource = `const { initializeActionTaskBindingStartup } = require('${bindingModulePath}');`;
  const firstNonDirectiveStatement = ast.body.find((statement) => (
    statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string'
  ));
  const bindingImportStatements = ast.body.filter((statement) => {
    if (statement.type !== 'VariableDeclaration'
        || statement.kind !== 'const'
        || statement.declarations.length !== 1) return false;
    const declaration = statement.declarations[0];
    const property = declaration.id?.type === 'ObjectPattern'
      && declaration.id.properties.length === 1
      ? declaration.id.properties[0]
      : null;
    return property?.type === 'Property'
      && identifier(property.key, 'initializeActionTaskBindingStartup')
      && identifier(property.value, 'initializeActionTaskBindingStartup')
      && declaration.init?.type === 'CallExpression'
      && identifier(declaration.init.callee, 'require')
      && declaration.init.arguments.length === 1
      && declaration.init.arguments[0]?.type === 'Literal'
      && declaration.init.arguments[0].value === bindingModulePath
      && source.slice(statement.range[0], statement.range[1]) === bindingImportSource;
  });
  const bindingImportStatement = bindingImportStatements.length === 1
    ? bindingImportStatements[0]
    : null;
  const startupDeclaration = ast.body.flatMap((statement) => (
    statement.type === 'VariableDeclaration' ? statement.declarations : []
  )).find((declaration) => declaration.id.type === 'ObjectPattern'
    && declaration.id.properties.some((property) => identifier(property.value, 'runActionTaskBindingStartup')));
  const startupCall = startupDeclaration?.init;
  const continuationProperties = startupCall?.arguments?.[1]?.arguments?.[0]?.properties || [];
  const continuations = Object.fromEntries(continuationProperties.map((property) => (
    [property.key.name, property.value.name]
  )));
  const runCalls = calls('runActionTaskBindingStartup');
  const windowCalls = calls('createWindow').filter((call) => call.arguments[0]?.type === 'ObjectExpression'
    && call.arguments[0].properties.some((property) => identifier(property.key, 'instrumentation')
      && property.value.value === 'initial'));
  const usageLoads = nodes.filter((node) => node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression'
    && identifier(node.callee.object, 'usageStatsModule')
    && identifier(node.callee.property, 'loadStats'));
  const readyIf = ast.body.find((statement) => statement.type === 'IfStatement'
    && identifier(statement.test, 'hasSingleInstanceLock'));
  const catchCall = readyIf?.consequent?.type === 'ExpressionStatement'
    ? readyIf.consequent.expression
    : null;
  const thenCall = catchCall?.callee?.type === 'MemberExpression'
    && identifier(catchCall.callee.property, 'catch')
    ? catchCall.callee.object
    : null;
  const successCallback = thenCall?.callee?.type === 'MemberExpression'
    && identifier(thenCall.callee.property, 'then')
    && thenCall.callee.object?.callee?.type === 'MemberExpression'
    && identifier(thenCall.callee.object.callee.object, 'app')
    && identifier(thenCall.callee.object.callee.property, 'whenReady')
    ? thenCall.arguments[0]
    : null;
  if (!bindingImportStatement
      || firstNonDirectiveStatement !== bindingImportStatement
      || startupCall?.callee?.name !== 'initializeActionTaskBindingStartup'
      || runCalls.length !== 1
      || parents.get(runCalls[0])?.type !== 'AwaitExpression'
      || windowCalls.length !== 1
      || usageLoads.length !== 1
      || successCallback?.type !== 'ArrowFunctionExpression'
      || !successCallback.async
      || !(successCallback.range[0] < runCalls[0].range[0]
        && runCalls[0].range[1] < successCallback.range[1])
      || !(successCallback.range[0] < windowCalls[0].range[0]
        && windowCalls[0].range[1] < successCallback.range[1])) {
    throw new Error('production startup AST seam is incomplete');
  }
  return {
    continuations,
    bindingImportStatement,
    runCall: runCalls[0],
    windowCall: windowCalls[0],
    usageLoad: usageLoads[0]
  };
}

function proveRealBindingBootstrapPrefix(source) {
  const startup = parseProductionStartup(source);
  const targetPath = require.resolve(
    path.join(root, 'src/main-process/background-execution/action-task-binding-registry.js')
  );
  const proofFilename = path.join(root, 'src/main.action-task-binding-bootstrap-proof.cjs');
  const proofModule = new Module(proofFilename, module);
  proofModule.filename = proofFilename;
  proofModule.paths = Module._nodeModulePaths(path.dirname(proofFilename));
  const requests = [];
  const resolvedPaths = [];
  let loadedBinding = null;
  const realRequire = proofModule.require.bind(proofModule);
  proofModule.require = (request) => {
    requests.push(request);
    resolvedPaths.push(Module._resolveFilename(request, proofModule));
    loadedBinding = realRequire(request);
    return loadedBinding;
  };
  const originalCacheEntry = require.cache[targetPath];
  delete require.cache[targetPath];
  try {
    const prefix = source.slice(0, startup.bindingImportStatement.range[1]);
    proofModule._compile(
      `${prefix}\nmodule.exports = initializeActionTaskBindingStartup;`,
      proofFilename
    );
    return {
      prefix,
      requests,
      resolvedPaths,
      targetPath,
      exportIdentityMatched: (
        loadedBinding !== null
        && proofModule.exports === loadedBinding.initializeActionTaskBindingStartup
      )
    };
  } finally {
    delete require.cache[targetPath];
    if (originalCacheEntry) require.cache[targetPath] = originalCacheEntry;
  }
}

test('真实 startup seam 完成 DB→IPC 后才建窗并等待 ready-to-show', () => {
  const startup = parseProductionStartup(main);
  assert.deepEqual(startup.continuations, {
    initializeDatabase: 'initializeApplication',
    registerIpc: 'registerAllIpcHandlers'
  });
  assert.ok(startup.runCall.range[0] < startup.windowCall.range[0]);
  const commentOnlyMutant = main.replace(
    'await runActionTaskBindingStartup();',
    'await Promise.resolve();\n      // await initializeApplication(); registerAllIpcHandlers();'
  );
  assert.throws(
    () => parseProductionStartup(commentOnlyMutant),
    /production startup AST seam is incomplete/
  );
  const readyChain = main.slice(main.indexOf('if (hasSingleInstanceLock) app.whenReady()'));
  const totalStartIndex = readyChain.indexOf("finishStartupTotal = startStartupPhase('startup-total'");
  const appMarkIndex = readyChain.indexOf('markStartupMetric(STARTUP_METRIC_MARKS.appReady)');
  assert.ok(totalStartIndex >= 0 && totalStartIndex < appMarkIndex);

  const createSource = main.slice(
    main.indexOf('function createWindow(options = {})'),
    main.indexOf('function buildTemplateSummary', main.indexOf('function createWindow(options = {})'))
  );
  assert.match(createSource, /new BrowserWindow\(windowOptions\)/);
  assert.match(createSource, /waitForWindowReady\(\{[\s\S]*?mainWindow\.loadFile/);
  assert.match(createSource, /resolveReady\(mainWindow\)/);
  assert.match(createSource, /instrumentation\.startPhase\('window-ready'/);
  assert.match(createSource, /options\.instrumentation === 'initial'/);
  const readySuccess = createSource.slice(createSource.indexOf('readiness.then'));
  assert.ok(readySuccess.indexOf('showReadyWindow') >= 0);
  assert.ok(readySuccess.indexOf('settled = true') > readySuccess.indexOf('showReadyWindow'));
});

test('binding exact require 是首个可执行 statement，真实 loader 执行完整允许前缀', () => {
  const startup = parseProductionStartup(main);
  assert.equal(startup.bindingImportStatement.range[0], 0);
  const proof = proveRealBindingBootstrapPrefix(main);
  assert.deepEqual(proof.requests, [
    './main-process/background-execution/action-task-binding-registry'
  ]);
  assert.deepEqual(proof.resolvedPaths, [proof.targetPath]);
  assert.equal(proof.exportIdentityMatched, true);
  assert.equal(
    proof.prefix,
    main.slice(0, startup.bindingImportStatement.range[1])
  );

  const bindingImport = main.slice(
    startup.bindingImportStatement.range[0],
    startup.bindingImportStatement.range[1]
  );
  const mutants = {
    'helper-mediated-wrapper-alias': main.replace(
      bindingImport,
      `const selectBindingLoader = (loader) => loader;\nconst selectedBindingLoader = selectBindingLoader(require);\n${bindingImport.replace('require(', 'selectedBindingLoader(')}`
    ),
    'preceding-module-side-effect': main.replace(
      bindingImport,
      `require('./main-process/startup-window');\n${bindingImport}`
    ),
    'reviewer-equivalent-inline-loader-wrapper': main.replace(
      bindingImport,
      `const originalBindingRequire = require;\nrequire = ((loader) => loader)((request) => originalBindingRequire(request));\n${bindingImport}`
    )
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    assert.throws(
      () => parseProductionStartup(mutant),
      /production startup AST seam is incomplete/,
      name
    );
  }
});

test('失败销毁隐藏窗口后只走 native failure，activate/second-instance 不旁路屏障', () => {
  assert.match(main, /function handleStartupFailure\(error\) \{[\s\S]*?mainWindow\.destroy\(\)[\s\S]*?dialog\.showErrorBox/);
  assert.match(main, /function handleStartupFailure\(error\) \{[\s\S]*?try \{[\s\S]*?getActivityLogFallbackFilePath\(\)[\s\S]*?initializeActivityLog\(\)[\s\S]*?\} catch/);
  assert.match(main, /app\.on\('activate',[\s\S]*?if \(applicationStartupComplete && BrowserWindow\.getAllWindows\(\)\.length === 0\)/);
  assert.match(main, /app\.on\('second-instance',[\s\S]*?if \(!applicationStartupComplete \|\| !mainWindowReady\) return/);
  assert.match(main, /app\.on\('second-instance',[\s\S]*?if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) return/);
  assert.match(main, /finishStartupTotal\('success'\);[\s\S]*?reportStartupMetrics\(\)/);
});

test('startup-total 覆盖 usage 尝试，但 usage 初始化仍 warning + default 非阻塞降级', () => {
  const startup = parseProductionStartup(main);
  const readyChain = main.slice(main.indexOf('if (hasSingleInstanceLock) app.whenReady()'));
  const totalIndex = readyChain.indexOf("startStartupPhase('startup-total'");
  const usageTryIndex = readyChain.indexOf('usageStats = usageStatsModule.loadStats');
  assert.ok(totalIndex >= 0 && usageTryIndex > totalIndex);
  assert.ok(startup.usageLoad.range[0] < startup.runCall.range[0]);
  assert.match(readyChain, /message: '\[usage-stats\] init failed'[\s\S]*?usageStats = usageStatsModule\.defaultStats\(\);[\s\S]*?await runActionTaskBindingStartup\(\)/);
});

test('两阶段 init API 与 loading 合同已从产品全链删除', () => {
  const productSource = [main, preload, renderer].join('\n');
  for (const retired of [
    'DEFERRED_WINDOW_STARTUP',
    'initPending',
    'app:init-progress',
    'app:init-done',
    'onInitProgress',
    'onInitDone'
  ]) assert.doesNotMatch(productSource, new RegExp(retired.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('SQLite 使用 exact optimize 且产品数据库初始化无无参数 ANALYZE', () => {
  assert.match(database, /this\.db\.exec\('PRAGMA optimize=0x10002;'\)/);
  assert.doesNotMatch(database, /ANALYZE\s*;/);
  assert.doesNotMatch(database, /-wal['"`][\s\S]*?(unlink|rmSync|rm\()/);
});

test('主初始化不重复执行 VCC gate，Archive post-outbox hook 是唯一启动入口', () => {
  const initialization = main.slice(
    main.indexOf('async function initializeApplication()'),
    main.indexOf('if (hasSingleInstanceLock) app.whenReady()')
  );
  assert.doesNotMatch(initialization, /syncImportArchiveLineage\(/);
  assert.equal((main.match(/postOutboxStartupHooks:\s*\[\{/g) || []).length, 1);
});
