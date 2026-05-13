// v2.0.0-beta.4：usage-stats 模块 smoke

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('os');

const {
  STATS_FILENAME,
  FUNCTION_REGISTRY,
  defaultStats,
  parse,
  serialize,
  loadStats,
  saveStats,
  incrementFunction,
  recordSessionStart,
  recordSessionEnd,
  calcModuleSubtotal,
  calcGrandTotal
} = require('../../src/backend/usage-stats');

function runUsageStatsSmokeTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-stats-'));
  let count = 0;
  function check(label, cond, msg) {
    count += 1;
    assert(cond, `${label} ${msg || 'assert failed'}`);
  }

  try {
    // U1：defaultStats 结构正确
    {
      const s = defaultStats();
      check('U1.1', s.appOpenCount === 0, 'appOpenCount 默认 0');
      check('U1.2', s.firstOpenedAt === null, 'firstOpenedAt 默认 null');
      check('U1.3', typeof s.modules === 'object', 'modules 是对象');
      check('U1.4', s.modules['生成网银账单'] !== undefined, '生成网银账单 模块预置');
      check('U1.5', s.modules['银行对账单处理']['场景管理'] === 0, '银行对账单处理/场景管理 默认 0');
    }

    // U2：incrementFunction 累加
    {
      const s = defaultStats();
      incrementFunction(s, '生成网银账单', '导入文件');
      incrementFunction(s, '生成网银账单', '导入文件');
      incrementFunction(s, '银行对账单处理', '开始运行');
      check('U2.1', s.modules['生成网银账单']['导入文件'] === 2, '累加 2 次');
      check('U2.2', s.modules['银行对账单处理']['开始运行'] === 1, '累加 1 次');
    }

    // U3：未注册 module/function 静默忽略
    {
      const s = defaultStats();
      const before = JSON.stringify(s);
      incrementFunction(s, 'NotAModule', '随便');
      incrementFunction(s, '生成网银账单', '不存在的功能');
      check('U3.1', JSON.stringify(s) === before, '未注册不应改变 stats');
    }

    // U4：calcModuleSubtotal / calcGrandTotal
    {
      const s = defaultStats();
      incrementFunction(s, '生成网银账单', '导入文件');
      incrementFunction(s, '生成网银账单', '导入文件');
      incrementFunction(s, '生成网银账单', '导出明细');
      incrementFunction(s, '银行对账单处理', '场景管理');
      incrementFunction(s, '银行对账单处理', '开始运行');
      check('U4.1', calcModuleSubtotal(s.modules['生成网银账单']) === 3, '生成网银账单 小计 3');
      check('U4.2', calcModuleSubtotal(s.modules['银行对账单处理']) === 2, '银行对账单处理 小计 2');
      check('U4.3', calcGrandTotal(s) === 5, '总操作次数 5');
    }

    // U5：serialize 输出格式
    {
      const s = defaultStats();
      s.appOpenCount = 7;
      s.firstOpenedAt = '2026-04-30T10:00:00';
      s.sessionStartedAt = '2026-04-30T18:00:00';
      incrementFunction(s, '生成网银账单', '导入文件');
      const text = serialize(s);
      check('U5.1', text.includes('appOpenCount=7'), 'appOpenCount line');
      check('U5.2', text.includes('firstOpenedAt=2026-04-30T10:00:00'), 'firstOpenedAt line');
      check('U5.3', text.includes('[生成网银账单]'), 'section header');
      check('U5.4', text.includes('导入文件=1'), 'function counter');
      check('U5.5', text.includes('小计=1'), '模块小计');
      check('U5.6', text.includes('总操作次数=1'), '总操作次数');
      check('U5.7', text.endsWith('\n'), '末尾换行');
    }

    // U6：parse round-trip
    {
      const s = defaultStats();
      s.appOpenCount = 42;
      s.firstOpenedAt = '2026-04-30T10:00:00';
      s.lastClosedAt = '2026-04-30T18:30:00';
      incrementFunction(s, '生成网银账单', '导入文件');
      incrementFunction(s, '生成网银账单', '导入文件');
      incrementFunction(s, '银行对账单处理', '开始运行');
      const text = serialize(s);
      const s2 = parse(text);
      check('U6.1', s2.appOpenCount === 42, 'round-trip appOpenCount');
      check('U6.2', s2.firstOpenedAt === '2026-04-30T10:00:00', 'round-trip firstOpenedAt');
      check('U6.3', s2.lastClosedAt === '2026-04-30T18:30:00', 'round-trip lastClosedAt');
      check('U6.4', s2.modules['生成网银账单']['导入文件'] === 2, 'round-trip count');
      check('U6.5', s2.modules['银行对账单处理']['开始运行'] === 1, 'round-trip count 2');
    }

    // U7：parse 异常输入
    {
      check('U7.1', parse('').appOpenCount === 0, '空文本 → default');
      check('U7.2', parse(null).appOpenCount === 0, 'null → default');
      check('U7.3', parse(undefined).appOpenCount === 0, 'undefined → default');
      const garbage = '!!@@##\nrandom text\n=no key\nkey-no-eq';
      check('U7.4', typeof parse(garbage).modules === 'object', '垃圾文本不 throw');
    }

    // U8：loadStats / saveStats round-trip 落盘
    {
      const s = defaultStats();
      incrementFunction(s, '银行对账单处理', '导出文件');
      incrementFunction(s, '银行对账单处理', '导出文件');
      incrementFunction(s, '银行对账单处理', '导出文件');
      saveStats(tmpDir, s);
      const filePath = path.join(tmpDir, STATS_FILENAME);
      check('U8.1', fs.existsSync(filePath), '文件应存在');
      check('U8.2', fs.existsSync(filePath) && path.basename(filePath).startsWith('.'), 'dot prefix 隐藏');
      const reloaded = loadStats(tmpDir);
      check('U8.3', reloaded.modules['银行对账单处理']['导出文件'] === 3, 'reload count');
    }

    // U9：loadStats 文件不存在 → default
    {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-stats-empty-'));
      try {
        const s = loadStats(emptyDir);
        check('U9.1', s.appOpenCount === 0, '不存在文件 → default');
        check('U9.2', typeof s.modules === 'object', '不存在文件 → default modules');
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    }

    // U10：recordSessionStart / recordSessionEnd
    {
      const s = defaultStats();
      check('U10.1', s.appOpenCount === 0, '初始 0');
      recordSessionStart(s);
      check('U10.2', s.appOpenCount === 1, 'recordSessionStart 累加');
      check('U10.3', s.firstOpenedAt !== null, 'firstOpenedAt 写入');
      check('U10.4', s.sessionStartedAt !== null, 'sessionStartedAt 写入');
      const firstAt = s.firstOpenedAt;
      recordSessionStart(s);
      check('U10.5', s.appOpenCount === 2, '第二次启动 appOpenCount=2');
      check('U10.6', s.firstOpenedAt === firstAt, 'firstOpenedAt 不应改变');
      recordSessionEnd(s);
      check('U10.7', s.lastClosedAt !== null, 'lastClosedAt 写入');
    }

    // U11：FUNCTION_REGISTRY frozen
    {
      check('U11', Object.isFrozen(FUNCTION_REGISTRY), 'FUNCTION_REGISTRY 必须 frozen');
    }

    // U11.bbr (PR #43 Codex F1)：月度银行对账单BU回填校验已注册（main.js trackedIpcHandle 用此 moduleKey）
    {
      check('U11.bbr.module', '月度银行对账单BU回填校验' in FUNCTION_REGISTRY, 'BU 回填模块必须在 FUNCTION_REGISTRY 注册');
      const fns = FUNCTION_REGISTRY['月度银行对账单BU回填校验'] || [];
      ['导入文件', '开始运行', '导出差异'].forEach((fn) => {
        check(`U11.bbr.fn[${fn}]`, fns.includes(fn), `${fn} 必须在 BU 回填模块的 FUNCTION_REGISTRY`);
      });
      // 实际计数验证
      const s = defaultStats();
      incrementFunction(s, '月度银行对账单BU回填校验', '开始运行');
      check('U11.bbr.count', s.modules['月度银行对账单BU回填校验']['开始运行'] === 1, 'incrementFunction 必须真正写入计数');
    }

    // U12（PR #34 Codex round 1 P2）：saveStats 写盘失败时 throw（让调用方保留 dirty 重试）
    {
      const s = defaultStats();
      incrementFunction(s, '银行对账单处理', '导出文件');
      // 构造一个无法写入的路径（指向一个已存在的文件，让 mkdirSync 失败）
      // 用 macOS / Linux 通用的"父路径是文件"场景
      const blocker = path.join(tmpDir, 'blocker.txt');
      fs.writeFileSync(blocker, 'x', 'utf8');
      const invalidRoot = path.join(blocker, 'subdir'); // 父路径是文件 → mkdirSync 失败
      let threw = false;
      try {
        saveStats(invalidRoot, s);
      } catch (_err) {
        threw = true;
      }
      check('U12', threw, '写盘失败必须 throw（避免上层 swallow 后丢失 dirty）');
    }

    console.log(`  usage-stats: ${count}/${count} PASS`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { runUsageStatsSmokeTests };

if (require.main === module) {
  runUsageStatsSmokeTests();
}
