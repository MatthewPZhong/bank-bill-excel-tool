// 集成测试 runner — 自动发现 scripts/integration/*.js 并逐个运行
//   每个脚本约定：成功 → console 输出含 "==== N/N PASS ===="；失败 → exit 1 + 输出 FAILURES
//   runner 为每个脚本起独立子进程（避免脚本互相污染 module cache / global state）
//
// 用法：node scripts/integration-runner.js
//      npm run test:integration
//
// v3.2.15 B43：CI 分片与并发（本地默认不变：不分片、并发 1，按脚本名串行）
//   INTEGRATION_SHARD=i/n       只跑第 i 片：已知耗时最长的脚本先轮流分到各片，其余按脚本名轮流分配；
//                               分片运行不回写 §七（只有一部分脚本的结果）
//   INTEGRATION_CONCURRENCY=k   同时运行 k 个脚本；独占脚本（Electron 窗口、内存 / 耗时 / 准入断言、
//                               按空闲内存或 CPU 调整行为的路径）先逐个单独运行，其余再并发
//   汇总、退出码与 §七 回写按脚本名排序，不受执行顺序影响
//
// 新加集成测试：直接在 scripts/integration/ 下新建 .js 文件即可，runner 自动抓
//   命名规范：<module>-<feature>.js，按业务模块（避免版本前缀）
//   详见 rules/integration-test-policy.md
//
// v2.1.9 SR-policy-1（spec §12.2 / T32a）：runner 末尾把当前清单 in-place 写回 rules/integration-test-policy.md §七
//   - 全 PASS 才更新（任一 FAIL → 跳过同步以免污染清单）
//   - 只有耗时 / 时间戳变化不回写（避免每次运行都改动已跟踪文件）
//   - 时间戳行 + DO NOT EDIT 注释
//   - 同时把 markdown 表打到 stdout（CI / 本地都能看到）

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const INTEGRATION_DIR = path.join(__dirname, 'integration');
const POLICY_PATH = path.join(__dirname, '..', 'rules', 'integration-test-policy.md');

// 独占运行：起 Electron 窗口（焦点 / 截图）、断言内存峰值 / 耗时 / 准入阈值，或被测路径按空闲内存、CPU 数调整行为的脚本。
//   并发时与其他脚本同时运行会改变这些条件，结果可能不稳定（B43 排查结论见 changes/v3.2.15/chore/ci-parallel-jobs/techdoc.md）。
const EXCLUSIVE_SCRIPT_PATTERN = /^toolbox-|memory|admission|big-table-import|canary|idle-cleanup|concurrency|query-boundary|result-workbook|^renderer-lifecycle$|^packaged-/;

// 分片时先轮流分配的耗时最长脚本（按 Windows CI 实测从长到短），避免集中到同一片；未列出的按脚本名轮流分配。
const HEAVY_SCRIPTS_FIRST = Object.freeze([
  'toolbox-large-split-multi-sheet',
  'toolbox-large-file-stream',
  'toolbox-rows-csv-admission',
  'biz-op-auto-error-report',
  'toolbox-biff8-admission',
  'renderer-lifecycle',
  'toolbox-low-memory-complete',
  'production-memory-qualification',
  'archive-biz-op-auto-report-retention',
  'biz-op-query-boundary',
  'archive-center-default-retention',
  'v2.1.10-a4-phase3',
  'toolbox-multi-sheet-merge'
]);

// 分片参数 "i/n"（1 ≤ i ≤ n）；未设置返回 null。格式不对时抛错，避免静默跑全部或跑空。
function parseShard(value) {
  if (value === undefined || value === null || value === '') return null;
  const match = String(value).trim().match(/^(\d+)\/(\d+)$/);
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || index < 1 || index > total) {
    throw new TypeError(`INTEGRATION_SHARD 须为 i/n 且 1 ≤ i ≤ n，收到：${value}`);
  }
  return { index, total };
}

// 并发数：未设置为 1（串行）；须为正整数。
function parseConcurrency(value) {
  if (value === undefined || value === null || value === '') return 1;
  const concurrency = Number(String(value).trim());
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError(`INTEGRATION_CONCURRENCY 须为正整数，收到：${value}`);
  }
  return concurrency;
}

function isExclusiveScript(name) {
  return EXCLUSIVE_SCRIPT_PATTERN.test(name);
}

// names：脚本名（不含 .js）。返回本片的脚本名，按脚本名排序；各片合起来恰好是全部脚本。
function selectShardScripts(names, shard) {
  const sorted = [...names].sort();
  if (!shard) return sorted;
  const heavy = HEAVY_SCRIPTS_FIRST.filter((name) => sorted.includes(name));
  const order = [...heavy, ...sorted.filter((name) => !heavy.includes(name))];
  return order.filter((_name, position) => position % shard.total === shard.index - 1).sort();
}

// 执行计划：并发 1 时按脚本名串行（与原 runner 一致）；并发大于 1 时先逐个运行独占脚本，其余再按并发数运行。
//   runOne(name) → Promise<result>；返回结果按脚本名排序。
async function runScripts(names, { concurrency = 1, runOne }) {
  const sorted = [...names].sort();
  const results = new Map();
  if (concurrency <= 1) {
    for (const name of sorted) results.set(name, await runOne(name));
  } else {
    const exclusive = sorted.filter(isExclusiveScript);
    const shared = sorted.filter((name) => !isExclusiveScript(name));
    for (const name of exclusive) results.set(name, await runOne(name));
    let next = 0;
    const lane = async () => {
      while (next < shared.length) {
        const name = shared[next];
        next += 1;
        results.set(name, await runOne(name));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, shared.length) }, lane));
  }
  return sorted.map((name) => results.get(name));
}

function findIntegrationScripts() {
  if (!fs.existsSync(INTEGRATION_DIR)) {
    console.error(`[integration-runner] 目录不存在：${INTEGRATION_DIR}`);
    process.exit(1);
  }
  return fs.readdirSync(INTEGRATION_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => path.join(INTEGRATION_DIR, f));
}

function spawnScript(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ status: null, stdout, stderr: stderr + String(error && error.stack || error) }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// serial：串行时先打印脚本名、结束后补结果（与原 runner 输出一致）；并发时开始与结束各打一行，失败输出在结束时整段打印。
async function runScript(scriptPath, { serial = true } = {}) {
  const name = path.basename(scriptPath, '.js');
  if (serial) process.stdout.write(`\n[integration] ▶ ${name} ... `);
  else process.stdout.write(`[integration] ▶ ${name} 开始\n`);
  const start = Date.now();
  const result = await spawnScript(scriptPath);
  const elapsedMs = Date.now() - start;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const combined = stdout + stderr;
  const finished = (text) => (serial ? `${text}\n` : `[integration] ${name} ... ${text}\n`);

  // 尝试从输出抽 "N/N PASS" 数字
  const passMatch = combined.match(/(\d+)\/(\d+) PASS/);
  const summary = passMatch ? `${passMatch[1]}/${passMatch[2]}` : '(no count)';
  // v2.1.9 SR-policy-1：拆出 用例数（pass count）/ 总数（total）用于清单生成
  const passedCount = passMatch ? Number(passMatch[1]) : null;
  const totalCount = passMatch ? Number(passMatch[2]) : null;

  if (result.status === 0) {
    process.stdout.write(finished(`PASS ${summary} (${elapsedMs}ms)`));
    return { name, ok: true, summary, elapsedMs, passedCount, totalCount };
  }

  process.stdout.write(finished(`FAIL (${elapsedMs}ms)`));
  // SR4 强化：长 stderr / stdout 截最后 30 行（保留最相关的错误信息，避免日志被淹没）
  const MAX_TAIL_LINES = 30;
  const tailLines = (text) => {
    const lines = text.split('\n');
    if (lines.length <= MAX_TAIL_LINES) return text;
    return `... (省略前 ${lines.length - MAX_TAIL_LINES} 行)\n` + lines.slice(-MAX_TAIL_LINES).join('\n');
  };
  // 并发时整段一次写出，避免与其他脚本的输出交错。
  const failureLines = ['  --- stdout (tail) ---', tailLines(stdout).split('\n').map((l) => '  ' + l).join('\n')];
  if (stderr) failureLines.push('  --- stderr (tail) ---', tailLines(stderr).split('\n').map((l) => '  ' + l).join('\n'));
  console.error(failureLines.join('\n'));
  return { name, ok: false, summary, elapsedMs, exitCode: result.status, passedCount, totalCount };
}

// v2.1.9 SR-policy-1：把 results 组装为 markdown 表（含时间戳 + DO NOT EDIT 注释）
//   format：spec §12.2.1
//   ts：ISO 8601 with +08:00 偏移（中国时区固定显示，便于审计跨时区一致）
function buildPolicyChecklistSection(results, { timestamp = formatChinaTimestamp() } = {}) {
  const lines = [];
  lines.push('## 七、当前集成测试清单（自动同步）');
  lines.push('');
  lines.push(`<!-- auto-generated by scripts/integration-runner.js, last-updated: ${timestamp} -->`);
  lines.push('<!-- DO NOT EDIT MANUALLY — modify scripts/integration/*.js then re-run `npm run test:integration` -->');
  lines.push('');
  lines.push('| 脚本 | 用例数 | 断言数 | 耗时 (ms) |');
  lines.push('|---|---|---|---|');

  let totalCases = 0;
  let totalAsserts = 0;
  let totalMs = 0;
  for (const r of results) {
    const cases = r.passedCount == null ? '-' : r.passedCount;
    // 子断言数无法独立解析（脚本内 assertEq/assertTrue 每次 +1 进 passed，与"用例数"同源）
    //   → 双列同值即可符合 spec §12.2.1 表头要求 + 不丢信息
    const asserts = r.totalCount == null ? '-' : r.totalCount;
    lines.push(`| \`${r.name}.js\` | ${cases} | ${asserts} | ${r.elapsedMs} |`);
    if (typeof r.passedCount === 'number') totalCases += r.passedCount;
    if (typeof r.totalCount === 'number') totalAsserts += r.totalCount;
    totalMs += r.elapsedMs;
  }
  lines.push(`| **合计** | **${totalCases}** | **${totalAsserts}** | **${totalMs}** |`);
  lines.push('');
  lines.push('> 同步策略：runner 末尾全 PASS 时 in-place 替换本章节；只有耗时或时间戳变化时不改写；任一脚本 FAIL → 本章节不更新（避免被损坏数据覆盖）。');
  lines.push('');
  return lines.join('\n');
}

// 抹去 last-updated 时间戳与表格末列耗时，用于判断清单是否有实质变化
//   脚本增删、用例数 / 断言数变化才回写；表头末列不是数字，不受影响
function stripVolatileChecklistFields(section) {
  return section
    .replace(/last-updated: \S+ -->/, 'last-updated: -->')
    .split('\n')
    .map((line) => line.replace(/^(\|.*\|)\s*(?:\*\*)?\d+(?:\*\*)?\s*\|$/, '$1 - |'))
    .join('\n');
}

// v2.1.9 SR-policy-1：ISO 时间戳 + 中国时区固定 +08:00（避免在不同 OS / 不同时区机器跑产生混乱差异）
function formatChinaTimestamp(date = new Date()) {
  // 转换为东八区（UTC + 8h）
  const cnMs = date.getTime() + 8 * 60 * 60 * 1000;
  const d = new Date(cnMs);
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const se = pad(d.getUTCSeconds());
  return `${y}-${mo}-${da}T${h}:${mi}:${se}+08:00`;
}

// v2.1.9 SR-policy-1：in-place 替换 rules/integration-test-policy.md 的 §七 章节
//   定位：从 `## 七、` 开头 → 下一个 `## ` 之前（或文件末）
//   失败容忍：替换失败仅 console.warn，不阻塞 runner exit code
function syncPolicyChecklist(results, { policyPath = POLICY_PATH, now = new Date() } = {}) {
  if (!fs.existsSync(policyPath)) {
    console.warn(`[SR-policy-1] policy 文件不存在，跳过同步：${policyPath}`);
    return { synced: false, reason: 'policy-not-exist' };
  }

  let original;
  try {
    original = fs.readFileSync(policyPath, 'utf8');
  } catch (err) {
    console.warn(`[SR-policy-1] 读取 policy 失败，跳过同步：${err && err.message}`);
    return { synced: false, reason: 'read-failed', error: err && err.message };
  }

  const newSection = buildPolicyChecklistSection(results, { timestamp: formatChinaTimestamp(now) });

  // 定位 §七 章节：从 `## 七、` 开始到下一个 `## ` 章节标题（不含）或文件末
  //   注意：必须用非贪婪 + lookahead 到 `\n## `（避免误吃掉后续章节）
  const sectionRegex = /## 七、[\s\S]*?(?=\n## |$(?![\s\S]))/;
  const existingMatch = original.match(sectionRegex);
  if (!existingMatch) {
    // 既有文件无 §七 → 不创造新章节（避免误位置）；仅警告
    console.warn(`[SR-policy-1] policy 文件无 §七 章节，跳过同步`);
    return { synced: false, reason: 'no-section-seven' };
  }

  if (stripVolatileChecklistFields(existingMatch[0]) === stripVolatileChecklistFields(newSection)) {
    // 仅耗时 / 时间戳不同 → 无写入需要（节省 git diff 噪音）
    return { synced: false, reason: 'no-change', section: newSection };
  }
  const updated = original.replace(sectionRegex, newSection);

  try {
    fs.writeFileSync(policyPath, updated, 'utf8');
    console.log(`\n[SR-policy-1] rules/integration-test-policy.md §七 已自动同步`);
  } catch (err) {
    console.warn(`[SR-policy-1] 写入 policy 失败，跳过同步：${err && err.message}`);
    return { synced: false, reason: 'write-failed', error: err && err.message };
  }

  return { synced: true, section: newSection };
}

async function main() {
  const shard = parseShard(process.env.INTEGRATION_SHARD);
  const concurrency = parseConcurrency(process.env.INTEGRATION_CONCURRENCY);
  const scripts = findIntegrationScripts();
  if (scripts.length === 0) {
    console.warn('[integration-runner] 未找到任何 scripts/integration/*.js');
    return;
  }
  const pathByName = new Map(scripts.map((scriptPath) => [path.basename(scriptPath, '.js'), scriptPath]));
  const selected = selectShardScripts([...pathByName.keys()], shard);

  const mode = [
    shard ? `第 ${shard.index}/${shard.total} 片 ${selected.length}/${scripts.length} 个脚本` : `${scripts.length} 个脚本`,
    concurrency > 1 ? `并发 ${concurrency}（独占 ${selected.filter(isExclusiveScript).length} 个先单独运行）` : '串行'
  ].join('，');
  console.log(`==== integration runner: ${mode} ====`);
  const startedAt = Date.now();
  const results = await runScripts(selected, {
    concurrency,
    runOne: (name) => runScript(pathByName.get(name), { serial: concurrency <= 1 })
  });
  const failures = results.filter((r) => !r.ok);
  const totalElapsed = results.reduce((s, r) => s + r.elapsedMs, 0);

  console.log(`\n==== 汇总（${totalElapsed}ms 总耗时${concurrency > 1 ? `，并发实际用时 ${Date.now() - startedAt}ms` : ''}）====`);
  results.forEach((r) => {
    const mark = r.ok ? '✓' : '✗';
    console.log(`  ${mark} ${r.name} ${r.summary} (${r.elapsedMs}ms)`);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} 个集成脚本失败，integration test FAIL`);
    // FAIL 不同步 — 避免不完整数据覆盖既有清单
    process.exit(1);
  }

  // v2.1.9 SR-policy-1：全 PASS → in-place 同步清单 + stdout 打印；分片只有部分脚本，不回写。
  if (shard) {
    console.log(`\n[SR-policy-1] 分片运行（第 ${shard.index}/${shard.total} 片），不回写 rules/integration-test-policy.md §七`);
  } else {
    const syncResult = syncPolicyChecklist(results);
    console.log('\n=== 当前清单 ===\n' + (syncResult.section || buildPolicyChecklistSection(results)));
  }

  console.log(`\n全部 ${results.length} 个集成脚本通过 ✓`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[integration-runner] ${error && error.stack ? error.stack : error}`);
    process.exit(1);
  });
}

// v2.1.9 SR-policy-1：导出可测试函数（unit test 用）
module.exports = {
  buildPolicyChecklistSection,
  syncPolicyChecklist,
  formatChinaTimestamp,
  // v3.2.15 B43：分片、并发与独占
  HEAVY_SCRIPTS_FIRST,
  isExclusiveScript,
  parseConcurrency,
  parseShard,
  runScripts,
  selectShardScripts,
};
