// v3.0.0 需求2b 🔴 资金红线：C3 网关「数据就绪判据」改向链接表 gateway-bill rowCount 单测护栏
//
// 背景：C3 网关行数据源 v2.1.16-beta.2 已切到链接表 gateway-bill；本次（PR-3）把 C3 提醒的
//   「就绪判据」从旧 gatewayReconSession（死路径，引擎不再消费）改为查链接表 gateway-bill 的 rowCount。
//   判据严格 rowCount>0 才算就绪；任何异常（IPC reject / 返回非 ok）按「未就绪」处理 → 仍提醒（保守防漏对账）。
//
// 取函数策略：renderer.js 顶层有 performance.now()/window 等浏览器副作用，整文件 require 会立即抛错；
//   故从源码字符串按花括号配对切出 isGatewayBillReady 函数体，用 new Function 实例化并注入 mock
//   window.desktopApi.linkedTable.rowCount，测真实源码行为（不触发顶层副作用）。
//   配套：源码 grep 锁关键不变量（判据严格性 / catch 兜底 / 两处门控 / 文案改向 / 死链保留 / preload+main 链路）。
//   参考 tests/unit/renderer-import-issues-summary.test.js 同款护栏范式。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_PATH = path.join(__dirname, '..', '..', 'src', 'renderer.js');
const PRELOAD_PATH = path.join(__dirname, '..', '..', 'src', 'preload.js');
const MAIN_PATH = path.join(__dirname, '..', '..', 'src', 'main.js');

const source = fs.readFileSync(RENDERER_PATH, 'utf8');
const preloadSource = fs.readFileSync(PRELOAD_PATH, 'utf8');
// main.js 含 NUL 字节 → 用 latin1 读（utf8 会替换为 U+FFFD，破坏 grep）。
const mainSource = fs.readFileSync(MAIN_PATH, 'latin1');

// 从源码切出 `(async )?function ${fnName}(...) { ... }` 整段（花括号配对）。
//   关键：若声明带前导 `async`，必须一并切入，否则 new Function 实例化时函数体内 await 非法。
function extractFunctionSource(src, fnName) {
  const signature = `function ${fnName}(`;
  let start = src.indexOf(signature);
  if (start === -1) throw new Error(`未在 renderer.js 找到 ${fnName} 定义`);
  // 把紧邻在 `function` 前的 `async ` 关键字纳入切片
  const asyncPrefix = 'async ';
  if (src.slice(start - asyncPrefix.length, start) === asyncPrefix) {
    start -= asyncPrefix.length;
  }
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i);
}

// 去掉 `//` 行注释（保留代码），用于「不再调死链」类断言——避免命中注释里出现的旧函数名。
//   注：renderer.js 无含 `//` 的字符串字面量与本断言冲突，简单逐行剥离即可。
function stripLineComments(src) {
  return src.split('\n').map((line) => {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

// 实例化 isGatewayBillReady：注入 mock window（含 desktopApi.linkedTable.rowCount）+ console。
//   工厂参数即闭包依赖（window/console），返回该 async 函数实例。
function loadIsGatewayBillReady(rowCountImpl) {
  const fnSource = extractFunctionSource(source, 'isGatewayBillReady');
  const calls = [];
  const win = {
    desktopApi: {
      linkedTable: {
        rowCount: async (tableKey) => {
          calls.push(tableKey);
          return rowCountImpl(tableKey);
        }
      }
    }
  };
  const consoleStub = { warn() {}, error() {}, log() {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function('window', 'console', `${fnSource}\nreturn isGatewayBillReady;`);
  return { fn: factory(win, consoleStub), calls };
}

describe('isGatewayBillReady — 行为（v3.0.0 需求2b：判据改向链接表 gateway-bill rowCount）', () => {
  test('status=ok 且 rowCount>0（5）→ true', async () => {
    const { fn, calls } = loadIsGatewayBillReady(() => ({ status: 'ok', rowCount: 5 }));
    assert.strictEqual(await fn(), true);
    // 🔴 必须查链接表 key 'gateway-bill'（不是旧 session / 其它 tableKey）
    assert.deepStrictEqual(calls, ['gateway-bill']);
  });

  test('status=ok 但 rowCount=0 → false（链接表空 = 未就绪 = 仍提醒）', async () => {
    const { fn } = loadIsGatewayBillReady(() => ({ status: 'ok', rowCount: 0 }));
    assert.strictEqual(await fn(), false);
  });

  test('rowCount 缺失 / null / NaN / 字符串 "5" → 一律 false（Number.isFinite 严格）', async () => {
    const bad = [
      { status: 'ok' },                       // 缺失
      { status: 'ok', rowCount: null },       // null
      { status: 'ok', rowCount: NaN },        // NaN
      { status: 'ok', rowCount: '5' },        // 字符串（isFinite 拒绝，不做隐式转换）
      { status: 'ok', rowCount: undefined }
    ];
    for (const r of bad) {
      const { fn } = loadIsGatewayBillReady(() => r);
      assert.strictEqual(await fn(), false, `${JSON.stringify(r)} 应判未就绪`);
    }
  });

  test('status=failed（即便带 rowCount>0）→ false（非 ok 一律未就绪）', async () => {
    const { fn } = loadIsGatewayBillReady(() => ({ status: 'failed', rowCount: 9 }));
    assert.strictEqual(await fn(), false);
  });

  test('返回 null / undefined / 空对象 → false（短路保护）', async () => {
    for (const r of [null, undefined, {}]) {
      const { fn } = loadIsGatewayBillReady(() => r);
      assert.strictEqual(await fn(), false, `${JSON.stringify(r)} 应判未就绪`);
    }
  });

  test('IPC reject（throw）→ catch 返回 false（保守防漏对账）', async () => {
    const { fn } = loadIsGatewayBillReady(() => { throw new Error('ipc boom'); });
    assert.strictEqual(await fn(), false);
  });
});

// ---- 源码 grep 护栏：锁关键不变量 ----

describe('isGatewayBillReady — 源码护栏（判据严格性 / catch 兜底 / 旧 session 死路径已弃用）', () => {
  test('① C3 就绪门控不再依赖旧 gatewayReconSession（无 `if (state.gatewayReconSession) return`）', () => {
    assert.ok(!/if\s*\(\s*state\.gatewayReconSession\s*\)\s*return/.test(source),
      'C3 提醒就绪判据不得再读 state.gatewayReconSession（已改向链接表 rowCount）');
  });

  test('② isGatewayBillReady 存在且查链接表 gateway-bill', () => {
    assert.ok(/async\s+function\s+isGatewayBillReady\s*\(/.test(source),
      '应存在 async function isGatewayBillReady');
    assert.ok(source.includes("window.desktopApi.linkedTable.rowCount('gateway-bill')"),
      'isGatewayBillReady 应查 linkedTable.rowCount("gateway-bill")');
  });

  test('③ 判据严格：status===ok && Number.isFinite(r.rowCount) && r.rowCount > 0', () => {
    assert.ok(source.includes("r.status === 'ok' && Number.isFinite(r.rowCount) && r.rowCount > 0"),
      '就绪判据应为 status===ok && Number.isFinite(r.rowCount) && r.rowCount > 0（严格 >0）');
  });

  test('④ 异常按未就绪：catch 内 return false', () => {
    const fnSrc = extractFunctionSource(source, 'isGatewayBillReady');
    assert.ok(/catch\s*\([^)]*\)\s*\{[\s\S]*return\s+false;[\s\S]*\}/.test(fnSrc),
      'isGatewayBillReady catch 分支应 return false');
  });

  test('⑤ 两处门控均经 isGatewayBillReady()（import 提醒 return / 运行点提醒 return false）', () => {
    assert.ok(source.includes('if (await isGatewayBillReady()) return;'),
      'maybePromptGatewayReconImport 应有 if (await isGatewayBillReady()) return;');
    assert.ok(source.includes('if (await isGatewayBillReady()) return false;'),
      'shouldPromptGatewayReconAtRun 应有 if (await isGatewayBillReady()) return false;');
  });

  test('⑥ c3CandidateCount 数据侧预检保留（两处门控都仍判候选行）', () => {
    const occ = (source.match(/c3CandidateCount\(\)/g) || []).length;
    assert.ok(occ >= 2, `c3CandidateCount() 预检应在两处门控保留（实得 ${occ} 处）`);
  });
});

describe('C3 提醒文案改向链接表（v3.0.0 需求2b）', () => {
  const importFn = extractFunctionSource(source, 'maybePromptGatewayReconImport');
  const runFn = extractFunctionSource(source, 'shouldPromptGatewayReconAtRun');
  // v3.0.0 需求3：C3 运行点提醒逻辑已从 handleBankStatementRun 抽到 proceedToGwCheck（链式编排：退款→proceedToGwCheck→C3）。
  //   运行点 C3 文案 / onConfirm 链路现位于 proceedToGwCheck 内，切该函数断言。
  const runHandlerFn = extractFunctionSource(source, 'proceedToGwCheck');

  test('⑦ 新文案存在：import 提醒指向「链接表管理」导入网关对账单', () => {
    assert.ok(importFn.includes('请在「链接表管理」导入网关对账单'),
      'import 提醒应改向「链接表管理」导入网关对账单');
  });

  test('⑦ 新文案存在：运行点提醒指向「网关对账单（链接表）」', () => {
    assert.ok(runHandlerFn.includes('未导入网关对账单（链接表）'),
      '运行点提醒应改向「未导入网关对账单（链接表）」');
  });

  test('⑦ 旧文案「资金对账不平结果表」已从 C3 两处提醒移除', () => {
    // 注：renderer.js 仍有「导入不平表」按钮 alert 用到该词（非 C3 提醒），故只在 C3 两段函数体内断言移除。
    assert.ok(!importFn.includes('资金对账不平结果表'),
      'maybePromptGatewayReconImport 文案不得再含旧词「资金对账不平结果表」');
    assert.ok(!runHandlerFn.includes('资金对账不平结果表'),
      'C3 运行点提醒文案不得再含旧词「资金对账不平结果表」');
    // 防回归：避免占位变量未消费的 lint 噪音
    assert.ok(typeof runFn === 'string' && runFn.includes('isGatewayBillReady'));
  });
});

describe('C3 导入动作改调链接表（v3.0.0 需求2b：onConfirm 链路）', () => {
  const importFn = extractFunctionSource(source, 'maybePromptGatewayReconImport');
  // v3.0.0 需求3：运行点 C3 逻辑已抽到 proceedToGwCheck（详见上方文案断言块说明）。
  const runHandlerFn = extractFunctionSource(source, 'proceedToGwCheck');

  test('⑧ 两处 onConfirm 均调 linkedTable.import() 且其后 await refreshBankStatementStatus()', () => {
    for (const [label, fnSrc] of [['import 提醒', importFn], ['运行点提醒', runHandlerFn]]) {
      const idxImport = fnSrc.indexOf('window.desktopApi.linkedTable.import()');
      assert.ok(idxImport !== -1, `${label} onConfirm 应调 window.desktopApi.linkedTable.import()`);
      const after = fnSrc.slice(idxImport);
      assert.ok(/linkedTable\.import\(\);\s*await\s+refreshBankStatementStatus\(\);/.test(after),
        `${label}：linkedTable.import() 之后应紧跟 await refreshBankStatementStatus()`);
    }
  });

  test('⑧ onConfirm 不再调死链 handleBankStatementImportGatewayRecon（剥离注释后判，注释里提名不算）', () => {
    // 函数体注释里写了「不再调死链 handleBankStatementImportGatewayRecon」属说明文字，先剥离再断言代码不调用。
    const importCode = stripLineComments(importFn);
    const runCode = stripLineComments(runHandlerFn);
    assert.ok(!importCode.includes('handleBankStatementImportGatewayRecon'),
      'maybePromptGatewayReconImport 代码不得再调 handleBankStatementImportGatewayRecon');
    assert.ok(!runCode.includes('handleBankStatementImportGatewayRecon'),
      'proceedToGwCheck（运行点 C3 提醒）代码不得再调 handleBankStatementImportGatewayRecon');
  });
});

describe('死链保留（v3.0.0 需求2b：本次仅改判据/文案，死路径整体留待后续清理）', () => {
  test('⑨ renderer.js 仍保留死函数 handleBankStatementImportGatewayRecon 定义', () => {
    assert.ok(/async\s+function\s+handleBankStatementImportGatewayRecon\s*\(/.test(source),
      'handleBankStatementImportGatewayRecon 定义应保留（死链，未删）');
  });

  test('⑨ main.js 仍保留死链 gateway-recon:import handler 与 gatewayReconSession 变量', () => {
    assert.ok(mainSource.includes("gateway-recon:import"),
      'main.js 应保留 gateway-recon:import handler（死链）');
    assert.ok(/let\s+gatewayReconSession\s*=\s*null/.test(mainSource),
      'main.js 应保留 let gatewayReconSession = null（死链）');
  });
});

describe('preload + main 链路（v3.0.0 需求2b：linked-table:row-count）', () => {
  test('⑩ preload 暴露 linkedTable.rowCount → invoke("linked-table:row-count", tableKey)', () => {
    assert.ok(/rowCount:\s*\(tableKey\)\s*=>\s*ipcRenderer\.invoke\('linked-table:row-count',\s*tableKey\)/.test(preloadSource),
      'preload 应暴露 rowCount: (tableKey) => ipcRenderer.invoke("linked-table:row-count", tableKey)');
  });

  test('⑩ main.js linked-table:row-count handler 调 getLinkedTableMeta', () => {
    assert.ok(mainSource.includes("ipcMain.handle('linked-table:row-count'"),
      "main.js 应注册 ipcMain.handle('linked-table:row-count', ...)");
    assert.ok(mainSource.includes('database.getLinkedTableMeta(tableKey)'),
      'row-count handler 应调 database.getLinkedTableMeta(tableKey)');
  });

  test('⑩ main.js row-count handler 未初始化 / 异常 → 返回 status: failed', () => {
    // 切出 handler 段（从 'linked-table:row-count' 起到下一个 ipcMain.handle 之前）做局部断言
    const start = mainSource.indexOf("ipcMain.handle('linked-table:row-count'");
    assert.ok(start !== -1, '应找到 row-count handler');
    const nextHandle = mainSource.indexOf('ipcMain.handle(', start + 10);
    const handlerSrc = mainSource.slice(start, nextHandle === -1 ? start + 800 : nextHandle);
    assert.ok(/if\s*\(!database\s*\|\|\s*!database\.db\)\s*return\s*\{\s*status:\s*'failed'/.test(handlerSrc),
      '未初始化（!database || !database.db）应 return { status: "failed" }');
    assert.ok(/catch\s*\([^)]*\)\s*\{[\s\S]*status:\s*'failed'/.test(handlerSrc),
      'catch 分支应 return { status: "failed" }');
  });
});
