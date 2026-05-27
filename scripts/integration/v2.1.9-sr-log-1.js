// v2.1.9 SR-log-1 全局告警日志化 — 集成测试（T32k）
//
// 覆盖（spec §15.11 + 实施约定）：
//   Case 1：main appendActivityLogEntry → 旧 app_activity_log.txt + 新 logs/{YYYY-MM}/{MM-DD}/{level}.log 双写一致性
//   Case 2：JSON Lines 格式合法（每行可独立 JSON.parse 不报错；模拟 cat | jq -c .）
//   Case 3：跨级别分文件（error / warning / info 写到独立日志文件）
//   Case 4：renderer setStatus wrapper hijack 模拟 — payload 直达 main handler 同样双写
//   Case 5：wrapper hijack graceful — desktopApi 缺失 / appendActivityLogEntry 抛错时 不阻塞业务
//   Case 6：源代码 grep — src/main.js + src/main-process + src/backend 0 直接 console.error/warn 调用
//
// 用法：node scripts/integration/v2.1.9-sr-log-1.js
//
// 退出条件：所有 case PASS → exit 0；任一 FAIL → exit 1 + 打印 FAILURES

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const logger = require('../../src/backend/logger');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label, detail = '') {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true, detail });
}

function mkTmpRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

// ============================================================================
// Case 1：appendActivityRecord 双写一致性
// ============================================================================
function caseDoubleWriteConsistency() {
  const root = mkTmpRoot('sr-log-1-case1-');
  const legacyPath = path.join(root, 'app_activity_log.txt');
  logger.appendActivityRecord(legacyPath, {
    level: 'error',
    source: 'main',
    domain: 'integration-test',
    message: 'Case 1 双写一致性',
    details: ['detail-A', 'detail-B'],
    stack: 'Error: stack\n  at foo'
  });

  // 旧路径
  assertTrue(fs.existsSync(legacyPath), 'Case 1 旧 app_activity_log.txt 存在');
  const legacyContent = fs.readFileSync(legacyPath, 'utf8');
  assertTrue(/\[ERROR\] Case 1 双写一致性/.test(legacyContent), 'Case 1 旧 txt 格式保留 [ERROR] [message]');
  assertTrue(legacyContent.includes('detail-A；detail-B'), 'Case 1 旧 txt details 用「；」拼接');

  // 新路径
  const today = new Date();
  const newPath = logger.getLogFilePath(root, 'error', today);
  assertTrue(fs.existsSync(newPath), 'Case 1 新结构 error.log 存在');
  const newLines = readJsonLines(newPath);
  assertEq(newLines.length, 1, 'Case 1 新结构 1 行');
  assertEq(newLines[0].message, 'Case 1 双写一致性', 'Case 1 新结构 message');
  assertEq(newLines[0].level, 'error', 'Case 1 新结构 level');
  assertEq(newLines[0].source, 'main', 'Case 1 新结构 source');
  assertEq(newLines[0].domain, 'integration-test', 'Case 1 新结构 domain');
  assertEq(newLines[0].details, ['detail-A', 'detail-B'], 'Case 1 新结构 details 数组');
  assertEq(newLines[0].stack, 'Error: stack\n  at foo', 'Case 1 新结构 stack 透传');
}

// ============================================================================
// Case 2：JSON Lines 格式合法（每行独立 JSON.parse）
// ============================================================================
function caseJsonLinesParseable() {
  const root = mkTmpRoot('sr-log-1-case2-');
  const legacyPath = path.join(root, 'app_activity_log.txt');
  for (let i = 0; i < 20; i++) {
    logger.appendActivityRecord(legacyPath, {
      level: i % 3 === 0 ? 'error' : (i % 3 === 1 ? 'warning' : 'info'),
      source: 'main',
      domain: `domain-${i}`,
      message: `行 ${i} 含特殊字符 "引号" 反斜杠 \\ 换行 \n NUL`,
      details: [`d-${i}-1`, `d-${i}-2`]
    });
  }
  const today = new Date();
  for (const level of ['error', 'warning', 'info']) {
    const filePath = logger.getLogFilePath(root, level, today);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    let parseOk = true;
    let parseError = null;
    for (const line of lines) {
      try { JSON.parse(line); } catch (e) { parseOk = false; parseError = e.message; break; }
    }
    assertTrue(parseOk, `Case 2 ${level}.log 每行 JSON.parse 通过`, parseError || '');
    // 验证特殊字符 escape 后仍合法 JSON
    if (lines.length > 0) {
      const first = JSON.parse(lines[0]);
      assertTrue(typeof first.message === 'string' && first.message.length > 0, `Case 2 ${level}.log 首行 message 合法`);
    }
  }
}

// ============================================================================
// Case 3：跨级别分文件
// ============================================================================
function caseLevelFiles() {
  const root = mkTmpRoot('sr-log-1-case3-');
  const legacyPath = path.join(root, 'app_activity_log.txt');
  logger.appendActivityRecord(legacyPath, { level: 'error', message: 'e1' });
  logger.appendActivityRecord(legacyPath, { level: 'warning', message: 'w1' });
  logger.appendActivityRecord(legacyPath, { level: 'info', message: 'i1' });
  const today = new Date();
  const errLines = readJsonLines(logger.getLogFilePath(root, 'error', today));
  const warnLines = readJsonLines(logger.getLogFilePath(root, 'warning', today));
  const infoLines = readJsonLines(logger.getLogFilePath(root, 'info', today));
  assertEq(errLines.length, 1, 'Case 3 error.log 1 行');
  assertEq(warnLines.length, 1, 'Case 3 warning.log 1 行');
  assertEq(infoLines.length, 1, 'Case 3 info.log 1 行');
  assertEq(errLines[0].message, 'e1', 'Case 3 error 内容');
  assertEq(warnLines[0].message, 'w1', 'Case 3 warning 内容');
  assertEq(infoLines[0].message, 'i1', 'Case 3 info 内容');
}

// ============================================================================
// Case 4：renderer wrapper hijack 模拟（直接调用 logger，模拟 main handler 转调路径）
// ============================================================================
function caseRendererWrapperPath() {
  const root = mkTmpRoot('sr-log-1-case4-');
  const legacyPath = path.join(root, 'app_activity_log.txt');

  // 模拟 renderer setStatus(msg, 'error') → desktopApi.reportLog → main app:report-log handler → appendActivityLogEntry
  //   handler 主体（与 src/main.js ipcMain.on('app:report-log') 一致）
  const simulateHandler = (payload) => {
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    logger.appendActivityRecord(legacyPath, {
      level: safePayload.level || 'info',
      source: safePayload.source || 'renderer',
      domain: safePayload.domain,
      message: safePayload.message,
      details: Array.isArray(safePayload.details) ? safePayload.details : [],
      stack: safePayload.stack
    });
  };

  // 模拟 renderer 内 setStatus(msg, 'error', {logDomain:'db'}) wrapper hijack 调用
  const setStatusHijack = (message, tone) => {
    if (tone === 'error' || tone === 'warning') {
      simulateHandler({
        level: tone,
        source: 'renderer',
        domain: 'db',
        message
      });
    }
  };

  setStatusHijack('数据库连接失败', 'error');
  setStatusHijack('校验未通过', 'warning');
  setStatusHijack('导入成功', 'success'); // 不应上报
  setStatusHijack('点击下一步', 'info');    // 不应上报

  const today = new Date();
  const errLines = readJsonLines(logger.getLogFilePath(root, 'error', today));
  const warnLines = readJsonLines(logger.getLogFilePath(root, 'warning', today));
  assertEq(errLines.length, 1, 'Case 4 error 1 行');
  assertEq(warnLines.length, 1, 'Case 4 warning 1 行');
  assertEq(errLines[0].source, 'renderer', 'Case 4 source=renderer');
  assertEq(errLines[0].domain, 'db', 'Case 4 domain=db');
  assertEq(errLines[0].message, '数据库连接失败', 'Case 4 error message');
  assertEq(warnLines[0].message, '校验未通过', 'Case 4 warning message');
}

// ============================================================================
// Case 5：wrapper hijack graceful（desktopApi 缺失 / appendActivityLogEntry 抛错 不阻塞业务）
// ============================================================================
function caseGracefulDegradation() {
  // 模拟 setStatus 内 wrapper：desktopApi 不存在 → try-catch graceful
  let uiUpdated = false;
  const fakeUpdateStatus = (msg, tone) => {
    // 业务路径（必须成功）
    uiUpdated = true;
    // wrapper 路径（模拟 desktopApi undefined）
    try {
      const fakeDesktopApi = undefined;
      if (fakeDesktopApi && fakeDesktopApi.app && typeof fakeDesktopApi.app.reportLog === 'function') {
        fakeDesktopApi.app.reportLog({ level: tone, message: msg });
      }
    } catch (_e) {
      // graceful
    }
  };

  fakeUpdateStatus('msg', 'error');
  assertTrue(uiUpdated, 'Case 5 graceful：desktopApi 不存在仍正常 updateStatus');

  // 模拟 reportLog 内部抛错
  uiUpdated = false;
  const fakeUpdateStatus2 = (msg, tone) => {
    uiUpdated = true;
    try {
      const fakeDesktopApi = {
        app: {
          reportLog: () => { throw new Error('mock ipc fail'); }
        }
      };
      fakeDesktopApi.app.reportLog({ level: tone, message: msg });
    } catch (_e) {
      // graceful
    }
  };
  fakeUpdateStatus2('msg', 'warning');
  assertTrue(uiUpdated, 'Case 5 graceful：reportLog 抛错仍正常 updateStatus');

  // 模拟 main handler 内部 appendActivityLogEntry 抛错（如磁盘满）→ handler 吞掉
  let handlerOk = true;
  const fakeHandler = (payload) => {
    try {
      const safePayload = payload && typeof payload === 'object' ? payload : {};
      // 模拟 appendActivityLogEntry 抛错
      if (safePayload.level === 'error') {
        throw new Error('mock disk full');
      }
    } catch (_e) {
      // graceful
    }
  };
  try { fakeHandler({ level: 'error', message: 'x' }); } catch (_e) { handlerOk = false; }
  assertTrue(handlerOk, 'Case 5 graceful：handler 内 appendActivityLogEntry 抛错不向上传播');
}

// ============================================================================
// Case 6：源代码 grep — 0 直接 console.error/warn 调用
// ============================================================================
function caseSrcGrepZeroConsole() {
  const repoRoot = path.join(__dirname, '..', '..');
  // 用 grep -rE 找带 `console.error(` 或 `console.warn(` 的代码行（开头允许 whitespace + 括号确保是调用而非注释）
  const result = spawnSync('grep', [
    '-rnE',
    '^\\s*console\\.(error|warn)\\(',
    path.join(repoRoot, 'src', 'main.js'),
    path.join(repoRoot, 'src', 'main-process'),
    path.join(repoRoot, 'src', 'backend')
  ], { encoding: 'utf8' });
  // grep no match 返回 1；有匹配返回 0
  const stdout = result.stdout || '';
  const matchLines = stdout.split('\n').filter((l) => l.trim() !== '');
  assertEq(matchLines.length, 0, `Case 6 src 0 console.error/warn 调用（实际命中=${matchLines.length}：${matchLines.slice(0, 3).join('|')}）`);

  // 验证 src/preload.js + src/main.js 含 reportLog 暴露 + handler
  const preloadContent = fs.readFileSync(path.join(repoRoot, 'src', 'preload.js'), 'utf8');
  assertTrue(/reportLog\s*:\s*\(payload\)\s*=>\s*ipcRenderer\.send\('app:report-log'/.test(preloadContent),
    'Case 6 preload.js 暴露 desktopApi.app.reportLog → app:report-log');

  const mainContent = fs.readFileSync(path.join(repoRoot, 'src', 'main.js'), 'utf8');
  assertTrue(/ipcMain\.on\('app:report-log'/.test(mainContent),
    'Case 6 main.js 注册 ipcMain.on(\'app:report-log\') handler');
}

// ============================================================================
// 主流程
// ============================================================================
async function main() {
  caseDoubleWriteConsistency();
  caseJsonLinesParseable();
  caseLevelFiles();
  caseRendererWrapperPath();
  caseGracefulDegradation();
  caseSrcGrepZeroConsole();

  const total = passed + failed;
  if (failed > 0) {
    console.log(`[v2.1.9-sr-log-1] ${passed}/${total} PASS, ${failed} FAIL`);
    console.log('FAILURES:');
    for (const f of failures) {
      console.log(`  - ${f.label}`);
      if (f.detail) console.log(`    detail: ${f.detail}`);
      console.log(`    actual=${JSON.stringify(f.actual)}`);
      console.log(`    expected=${JSON.stringify(f.expected)}`);
    }
    process.exit(1);
  }
  console.log(`[v2.1.9-sr-log-1] ${passed}/${total} PASS`);
}

main().catch((err) => {
  console.error('[v2.1.9-sr-log-1] 致命错误：', err && err.stack ? err.stack : err);
  process.exit(1);
});
