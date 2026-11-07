// 跨平台 unit test runner — 替代 package.json `node --test $(find tests/unit -name '*.test.js')`
//   原 shell 命令替换在 Windows cmd.exe 不工作（self-review PR #52 Finding 2）
//   递归枚举 tests/unit/**/*.test.js 统计文件数，由 Node 原生 glob 执行同一范围，避免 Windows 命令行超长
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
//   UNIT_TEST_SHARD=1/6 npm run test:unit       # v3.2.15 B43：只跑第 1/6 片，CI 分多个 job 并行；未设置时跑全部，
//                                                #   本地 release-check 不变。分片按文件：前几片依次单独运行带固定期限的业务OP文件，
//                                                #   其余片按实测耗时从长到短放进当前最轻的片（见 planShard）
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

// v3.2.15 B43：依次单独运行的分片。每组占一片（第 1、2、3 片），组内文件逐个运行（--test-concurrency=1），
//   不与其他测试文件同时运行。
//   - 业务OP文件起真实 Main 子进程，并依赖固定期限：协作取消 5 秒、子进程 30/45 秒、DELETE_ASSOCIATED 恢复 70 秒。
//     同机有其他测试同时运行时，曾多次超时：
//       - Node 原生 3 片时：delete-main、compute-main；
//       - 按耗时均衡时：compute-main CANCEL_TIMEOUT（run 42136603684）、export-main 子进程 45 秒超时（run 42139917224）。
//     每片的测试量与能否通过没有稳定关系，单独运行才能避免。5 秒等期限是产品策略，不为测试放宽。
//   - biz-op-v327.test.js 单文件约 14 分钟（1024/128/32 个真实 Task 来源的扫描用例约 13 分钟），是所在片的下限。
//     node --test 按路径排序启动文件，与其他文件同片时它要等前面的文件让出位置才开始（run 42090975671 该片 36 分钟），
//     所以单独一片。
const SERIAL_UNIT_SHARDS = Object.freeze([
  Object.freeze(['tests/unit/main-process/biz-op-v327.test.js']),
  Object.freeze([
    'tests/unit/main-process/biz-op-v327-archive-owner-backfill.test.js',
    'tests/unit/main-process/biz-op-v327-ipc.test.js'
  ]),
  Object.freeze([
    'tests/unit/main-process/biz-op-v327-export-main.test.js',
    'tests/unit/main-process/biz-op-v327-compute-main.test.js',
    'tests/unit/main-process/biz-op-v327-delete-main.test.js'
  ])
]);
// 各文件的实测分钟数：run 42086209141（5 片全部通过）的顶层用例耗时按源文件汇总，列出不少于 1 分钟的文件。
//   未列出的文件按 DEFAULT_UNIT_FILE_MINUTES（其余 591 个文件的平均值）计。测试增删后耗时有偏差时按新的 CI 实测更新。
const UNIT_FILE_MINUTES = Object.freeze({
  'tests/unit/main-process/biz-op-v327.test.js': 14.4,
  'tests/unit/main-process/biz-op-v327-archive-owner-backfill.test.js': 11.9,
  'tests/unit/scripts/v3-2-4-release-evidence.test.js': 7.9,
  'tests/unit/main-process/biz-op-v327-archive-owner-completion.test.js': 7.4,
  'tests/unit/main-process/biz-op-v327-export-main.test.js': 5.0,
  'tests/unit/main-process/biz-op-v327-compute-main.test.js': 4.7,
  'tests/unit/main-process/biz-op-v327-delete-main.test.js': 4.1,
  'tests/unit/main-process/archive-permanent-delete.test.js': 3.7,
  'tests/unit/main-process/position-reconciliation-service.test.js': 2.9,
  'tests/unit/main-process/vcc-financial-op-result-workbook.test.js': 2.8,
  'tests/unit/main-process/biz-op-v327-ipc.test.js': 2.8,
  'tests/unit/scripts/v3-2-2-release-evidence.test.js': 2.7,
  'tests/unit/scripts/v3-2-3-release-evidence.test.js': 2.7,
  'tests/unit/main-process/biz-op-v327-publication-owner.test.js': 2.7,
  'tests/unit/main-process/biz-op-v327-upgrade.test.js': 2.6,
  'tests/unit/architecture/policy-history.test.js': 2.3,
  'tests/unit/main-process/biz-op-v327-low-memory.test.js': 2.2,
  'tests/unit/backend/vcc-financial-op/result-write.test.js': 2.1,
  'tests/unit/main-process/template-resources-versions.test.js': 2.0,
  'tests/unit/backend/position-reconciliation-import-preflight.test.js': 1.9,
  'tests/unit/backend/acquiring-bill-currency-db/raw-json-retention.test.js': 1.8,
  'tests/unit/backend/vcc-financial-op/destructive-write.test.js': 1.8,
  'tests/unit/main-process/duplicate-inbound-match/paired-parser-e07-c.test.js': 1.7,
  'tests/unit/main-process/biz-op-v327-import-main.test.js': 1.6,
  'tests/unit/main-process/vcc-financial-op-review-ipc.test.js': 1.5,
  'tests/unit/main-process/biz-op-v327-export-sst.test.js': 1.5,
  'tests/unit/main-process/vcc-financial-op-single-writer-e12-a.test.js': 1.4,
  'tests/unit/main-process/recon-id-fix-jpm-durable-e11-b.test.js': 1.4,
  'tests/unit/main-process/vcc-financial-op-review-export.test.js': 1.3,
  'tests/unit/main-process/biz-op-v327-export.test.js': 1.3,
  'tests/unit/main-process/biz-op-v327-startup-resource-recovery.test.js': 1.1,
  'tests/unit/backend/vcc-financial-op/storage-contract-v3.test.js': 1.1,
  'tests/unit/architecture/release-renderer-policy.test.js': 1.1,
  'tests/unit/main-process/archive-position-fileplan-delete.test.js': 1.0
});
const DEFAULT_UNIT_FILE_MINUTES = 0.07;
// Windows CreateProcess 命令行上限 32767 字符；超过时提示增加分片数，不截断文件清单。
const MAX_SHARD_COMMAND_CHARS = 30000;

function unitFileMinutes(file) {
  return UNIT_FILE_MINUTES[file] ?? DEFAULT_UNIT_FILE_MINUTES;
}

// files：仓库相对路径（/ 分隔）。返回本片文件（按路径排序）及是否依次单独运行；各片合起来恰好是全部文件。
//   1. 现有文件涉及的 SERIAL_UNIT_SHARDS 各组依次占前几片，组内文件逐个运行；
//   2. 其余文件按实测分钟数从长到短（同耗时按路径），每个放进其余片中当前估算分钟数最少的一片（同为最少时取序号小的）。
//   片数不够时报错，不把单独运行的文件和其他文件混在一片。
function planShard(files, shard) {
  const sorted = [...files].sort();
  if (!shard) return { files: sorted, serial: false };
  const present = new Set(sorted);
  const groups = SERIAL_UNIT_SHARDS.map((group) => group.filter((file) => present.has(file))).filter((group) => group.length > 0);
  if (groups.length >= shard.total) {
    throw new RangeError(`单独运行的文件需要 ${groups.length} 片，另需至少 1 片运行其余文件；当前共 ${shard.total} 片`);
  }
  if (shard.index <= groups.length) return { files: [...groups[shard.index - 1]].sort(), serial: true };
  const grouped = new Set(groups.flat());
  const byMinutesDesc = (a, b) => unitFileMinutes(b) - unitFileMinutes(a) || (a < b ? -1 : a > b ? 1 : 0);
  const rest = Array.from({ length: shard.total - groups.length }, () => ({ files: [], minutes: 0 }));
  for (const file of sorted.filter((item) => !grouped.has(item)).sort(byMinutesDesc)) {
    const target = rest.reduce((best, item) => (item.minutes < best.minutes ? item : best));
    target.files.push(file);
    target.minutes += unitFileMinutes(file);
  }
  return { files: rest[shard.index - groups.length - 1].files.sort(), serial: false };
}

function selectShardFiles(files, shard) {
  return planShard(files, shard).files;
}

// 分片参数 "i/n"（1 ≤ i ≤ n）；未设置返回 null。格式不对时抛错，避免静默跑全部或跑空。
function parseShard(value) {
  if (value === undefined || value === null || value === '') return null;
  const match = String(value).trim().match(/^(\d+)\/(\d+)$/);
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || index < 1 || index > total) {
    throw new TypeError(`分片参数须为 i/n 且 1 ≤ i ≤ n，收到：${value}`);
  }
  return { index, total };
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
function buildSummaryText({ summary, fileCount, elapsedMs, shard = null }) {
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
      (shard ? `（第 ${shard.index}/${shard.total} 片）` : '') +
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
  const shard = parseShard(process.env.UNIT_TEST_SHARD);
  const concurrency = configuredConcurrency === undefined ? undefined : Number(configuredConcurrency);
  let args;
  if (shard) {
    // 分片：传本片的文件清单（仓库相对路径，不经 shell）。
    const relativeFiles = files.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
    const plan = planShard(relativeFiles, shard);
    args = buildNodeTestArgs(plan.files.map((file) => path.join(REPO_ROOT, file)), { coverage, concurrency: plan.serial ? 1 : concurrency });
    const commandChars = args.reduce((sum, arg) => sum + arg.length + 1, process.execPath.length);
    if (commandChars > MAX_SHARD_COMMAND_CHARS) {
      throw new RangeError(`第 ${shard.index}/${shard.total} 片的命令行约 ${commandChars} 字符，超过 ${MAX_SHARD_COMMAND_CHARS}，请增加分片数`);
    }
  } else {
    args = buildNodeTestArgs([], { coverage, concurrency });
    // 直接交给 Node 匹配，不经 shell 展开；文件数量增长不会撑大 CreateProcess 的命令行。
    args.push('tests/unit/**/*.test.js');
  }
  const shardFileCount = shard ? args.filter((arg) => arg.endsWith('.test.js')).length : null;

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
    const summaryText = buildSummaryText({ summary, fileCount: shard ? shardFileCount : files.length, elapsedMs, shard });

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
        `命令：node ${args.filter((arg) => arg.startsWith('--')).join(' ')} <${shard ? shardFileCount : files.length} 个测试文件>`,
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
  SERIAL_UNIT_SHARDS,
  UNIT_FILE_MINUTES,
  unitFileMinutes,
  parseShard,
  planShard,
  selectShardFiles,
  parseTapSummary,
  formatLogTimestamp,
  buildSummaryText,
  buildNodeTestArgs,
};
