// 跨平台 unit test runner — 替代 package.json `node --test $(find tests/unit -name '*.test.js')`
//   原 shell 命令替换在 Windows cmd.exe 不工作（self-review PR #52 Finding 2）
//   本脚本用 Node 递归枚举 tests/unit/**/*.test.js → spawn `node --test <files>`，三平台共用
//
// v2.1.11 T1：在原"仅透传退出码"基础上增强 —
//   ① 捕获 node --test stdout/stderr（同时实时回显到终端，不影响用户看进度）
//   ② 解析摘要计数（pass/fail/tests/duration_ms）→ 末尾打印 ==== N/N PASS ====（仿 integration-runner）
//   ③ 落盘 logs/unit-tests/unit-<YYYYMMDD-HHmmss>.log（元信息 + 原始输出 + 汇总）
//   ④ 退出码仍透传 node --test（release-check 的 PASS/FAIL 真理来源不变）
//
// 用法：
//   node scripts/run-unit-tests.js            # 跑全部 unit
//   node scripts/run-unit-tests.js --coverage # 加 --experimental-test-coverage
//   UNIT_TEST_CONCURRENCY=2 npm run release-check # 仅限制测试文件并发，默认保持 Node 原值
//
// 退出码：透传 node --test 的退出码（0=全 PASS / 非 0=有 FAIL）

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TESTS_ROOT = path.join(REPO_ROOT, 'tests', 'unit');
const LOG_DIR = path.join(REPO_ROOT, 'logs', 'unit-tests');

function findTestFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out.sort();
}

function buildNodeTestArgs(files, { coverage = false, concurrency } = {}) {
  const args = ['--test'];
  if (concurrency !== undefined) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('测试并发数必须是正整数');
    args.push(`--test-concurrency=${concurrency}`);
  }
  if (coverage) args.push('--experimental-test-coverage');
  args.push(...files.map((file) => path.relative(REPO_ROOT, file)));
  return args;
}

// 纯函数：解析 node --test 摘要行的计数。
//   兼容两种 reporter 输出格式（导出供 unit test 覆盖）：
//     - spec reporter（Node 默认，含非 TTY 捕获时）：`ℹ tests 5` / `ℹ pass 5` / `ℹ fail 0` / `ℹ duration_ms 33.99`
//     - TAP reporter（--test-reporter=tap）：`# tests 5` / `# pass 5` / `# fail 0` / `# duration_ms 33.99`
//   返回 { tests, pass, fail, duration_ms }；无法解析的键为 null。
//   注意：用 lastMatch（取最后一次出现），避免子测试套件中间行（嵌套 TAP）误取首个局部计数。
function parseTapSummary(text) {
  const out = { tests: null, pass: null, fail: null, duration_ms: null };
  if (typeof text !== 'string' || text.length === 0) return out;
  const keys = ['tests', 'pass', 'fail', 'duration_ms'];
  for (const key of keys) {
    // 行首允许：可选的 `ℹ `/`# ` 前缀（spec / TAP），后跟 key + 空白 + 数字（可带小数）
    const re = new RegExp(`^\\s*(?:ℹ|#)\\s*${key}\\s+(\\d+(?:\\.\\d+)?)\\s*$`, 'gm');
    let m;
    let last = null;
    while ((m = re.exec(text)) !== null) {
      last = m[1];
    }
    if (last !== null) {
      out[key] = key === 'duration_ms' ? Number(last) : Number.parseInt(last, 10);
    }
  }
  return out;
}

// 时间戳：YYYYMMDD-HHmmss（本地时间，用 new Date()）
function formatLogTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const da = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const se = pad(date.getSeconds());
  return `${y}${mo}${da}-${h}${mi}${se}`;
}

// 组装末尾汇总文本（终端 + 落盘共用）
function buildSummaryText({ summary, fileCount, elapsedMs }) {
  const total = summary.tests;
  const pass = summary.pass;
  const fail = summary.fail;
  const lines = [];
  // 仿 integration-runner 的 N/N PASS 风格
  const passDisp = pass == null ? '?' : pass;
  const totalDisp = total == null ? '?' : total;
  lines.push(`==== ${passDisp}/${totalDisp} PASS ====`);
  lines.push(
    `unit 文件数：${fileCount}` +
      (fail != null ? ` | 失败用例：${fail}` : '') +
      (summary.duration_ms != null
        ? ` | node --test 耗时：${summary.duration_ms}ms`
        : '') +
      ` | 总耗时：${elapsedMs}ms`
  );
  return lines.join('\n');
}

function main() {
  const files = findTestFiles(TESTS_ROOT);
  if (files.length === 0) {
    console.error(`[run-unit-tests] 未找到任何 *.test.js 文件 in ${TESTS_ROOT}`);
    process.exit(1);
  }

  const coverage = process.argv.includes('--coverage');
  const configuredConcurrency = process.env.UNIT_TEST_CONCURRENCY;
  const args = buildNodeTestArgs(files, { coverage,
    concurrency: configuredConcurrency === undefined ? undefined : Number(configuredConcurrency) });

  const startedAt = new Date();
  const start = Date.now();

  // 用异步 spawn + pipe：既能实时回显（.pipe 到父 stdout/stderr），又能累积 buffer 解析/落盘。
  //   stdio 全 pipe；不引入任何 shell（三平台兼容，沿用原脚本 spawn(process.execPath) 约束）。
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: ['inherit', 'pipe', 'pipe']
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    process.stdout.write(chunk); // 实时回显，用户看得到进度
  });
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
    process.stderr.write(chunk);
  });

  child.on('error', (err) => {
    console.error(`[run-unit-tests] 启动 node --test 失败：${err && err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    const elapsedMs = Date.now() - start;
    const combined = stdoutBuf + stderrBuf;
    const summary = parseTapSummary(combined);
    const summaryText = buildSummaryText({ summary, fileCount: files.length, elapsedMs });

    // 终端末尾汇总
    process.stdout.write('\n' + summaryText + '\n');

    // 落盘日志（best-effort：写盘失败不影响退出码真理来源）
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const ts = formatLogTimestamp(startedAt);
      const logPath = path.join(LOG_DIR, `unit-${ts}.log`);
      const header = [
        '==== unit test run ====',
        `时间：${startedAt.toISOString()}（本地 ${startedAt.toLocaleString()}）`,
        `Node 版本：${process.version}`,
        `平台：${process.platform} ${process.arch}`,
        `命令：node ${args.slice(0, coverage ? 2 : 1).join(' ')} <${files.length} 个测试文件>`,
        `覆盖率模式：${coverage ? '是（--experimental-test-coverage）' : '否'}`,
        `unit 文件数：${files.length}`,
        '',
        '---- 原始输出（stdout + stderr）----',
        '',
      ].join('\n');
      const body = combined.length ? combined : '(无输出)\n';
      const footer = ['', '---- 汇总 ----', summaryText, `退出码：${code ?? 1}`, ''].join('\n');
      fs.writeFileSync(logPath, header + body + footer, 'utf8');
      process.stdout.write(`[run-unit-tests] 日志已落盘：${logPath}\n`);
    } catch (err) {
      console.error(`[run-unit-tests] 日志落盘失败（不影响退出码）：${err && err.message}`);
    }

    // 透传 node --test 退出码（release-check 的 PASS/FAIL 真理来源不变）
    process.exit(code ?? 1);
  });
}

if (require.main === module) {
  main();
}

// 导出可测试纯函数（unit test 用）
module.exports = {
  parseTapSummary,
  formatLogTimestamp,
  buildSummaryText,
  buildNodeTestArgs,
};
