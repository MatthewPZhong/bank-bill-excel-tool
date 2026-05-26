// 集成测试 runner — 自动发现 scripts/integration/*.js 并串行跑
//   每个脚本约定：成功 → console 输出含 "==== N/N PASS ===="；失败 → exit 1 + 输出 FAILURES
//   runner 用 child_process.spawnSync 隔离进程跑（避免脚本互相污染 module cache / global state）
//
// 用法：node scripts/integration-runner.js
//      npm run test:integration
//
// 新加集成测试：直接在 scripts/integration/ 下新建 .js 文件即可，runner 自动抓
//   命名规范：<module>-<feature>.js，按业务模块（避免版本前缀）
//   详见 rules/integration-test-policy.md

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INTEGRATION_DIR = path.join(__dirname, 'integration');

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

function runScript(scriptPath) {
  const name = path.basename(scriptPath, '.js');
  process.stdout.write(`\n[integration] ▶ ${name} ... `);
  const start = Date.now();
  const result = spawnSync('node', [scriptPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const elapsedMs = Date.now() - start;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const combined = stdout + stderr;

  // 尝试从输出抽 "N/N PASS" 数字
  const passMatch = combined.match(/(\d+)\/(\d+) PASS/);
  const summary = passMatch ? `${passMatch[1]}/${passMatch[2]}` : '(no count)';

  if (result.status === 0) {
    process.stdout.write(`PASS ${summary} (${elapsedMs}ms)\n`);
    return { name, ok: true, summary, elapsedMs };
  }

  process.stdout.write(`FAIL (${elapsedMs}ms)\n`);
  // SR4 强化：长 stderr / stdout 截最后 30 行（保留最相关的错误信息，避免日志被淹没）
  const MAX_TAIL_LINES = 30;
  const tailLines = (text) => {
    const lines = text.split('\n');
    if (lines.length <= MAX_TAIL_LINES) return text;
    return `... (省略前 ${lines.length - MAX_TAIL_LINES} 行)\n` + lines.slice(-MAX_TAIL_LINES).join('\n');
  };
  console.error('  --- stdout (tail) ---');
  console.error(tailLines(stdout).split('\n').map((l) => '  ' + l).join('\n'));
  if (stderr) {
    console.error('  --- stderr (tail) ---');
    console.error(tailLines(stderr).split('\n').map((l) => '  ' + l).join('\n'));
  }
  return { name, ok: false, summary, elapsedMs, exitCode: result.status };
}

function main() {
  const scripts = findIntegrationScripts();
  if (scripts.length === 0) {
    console.warn('[integration-runner] 未找到任何 scripts/integration/*.js');
    return;
  }

  console.log(`==== integration runner: ${scripts.length} 个脚本 ====`);
  const results = scripts.map(runScript);
  const failures = results.filter((r) => !r.ok);
  const totalElapsed = results.reduce((s, r) => s + r.elapsedMs, 0);

  console.log(`\n==== 汇总（${totalElapsed}ms 总耗时）====`);
  results.forEach((r) => {
    const mark = r.ok ? '✓' : '✗';
    console.log(`  ${mark} ${r.name} ${r.summary} (${r.elapsedMs}ms)`);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} 个集成脚本失败，integration test FAIL`);
    process.exit(1);
  }
  console.log(`\n全部 ${results.length} 个集成脚本通过 ✓`);
}

main();
