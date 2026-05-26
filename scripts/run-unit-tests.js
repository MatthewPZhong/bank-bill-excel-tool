// 跨平台 unit test runner — 替代 package.json `node --test $(find tests/unit -name '*.test.js')`
//   原 shell 命令替换在 Windows cmd.exe 不工作（self-review PR #52 Finding 2）
//   本脚本用 Node 递归枚举 tests/unit/**/*.test.js → spawn `node --test <files>`，三平台共用
//
// 用法：
//   node scripts/run-unit-tests.js            # 跑全部 unit
//   node scripts/run-unit-tests.js --coverage # 加 --experimental-test-coverage
//
// 退出码：透传 node --test 的退出码（0=全 PASS / 非 0=有 FAIL）

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TESTS_ROOT = path.join(__dirname, '..', 'tests', 'unit');

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

function main() {
  const files = findTestFiles(TESTS_ROOT);
  if (files.length === 0) {
    console.error(`[run-unit-tests] 未找到任何 *.test.js 文件 in ${TESTS_ROOT}`);
    process.exit(1);
  }

  const coverage = process.argv.includes('--coverage');
  const args = ['--test'];
  if (coverage) args.push('--experimental-test-coverage');
  args.push(...files);

  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  // 透传 node --test 退出码（非 0 即 fail）
  process.exit(result.status ?? 1);
}

main();
