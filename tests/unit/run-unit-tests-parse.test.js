// v2.1.11 T1：scripts/run-unit-tests.js 的 parseTapSummary 纯函数单测
//   覆盖 3 档：全 pass / 有 fail / 0 测试
//   夹具用真实 node --test 输出片段（Node 默认 spec reporter `ℹ` 前缀 + TAP `#` 前缀两种）
//   spec.md §五 5.1 / tasks.md T04

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  parseTapSummary,
  buildSummaryText,
  buildNodeTestArgs,
  parseShard,
  selectShardFiles,
  LOAD_SENSITIVE_UNIT_FILES,
  HEAVY_UNIT_FILES
} = require('../../scripts/run-unit-tests.js');

const REPO_ROOT = path.join(__dirname, '..', '..');

// 真实 node --test（spec reporter，Node 24 捕获 stdout 时的实际格式）尾部摘要
const SPEC_ALL_PASS = [
  '✔ 某套件 (0.82ms)',
  'ℹ tests 5',
  'ℹ suites 1',
  'ℹ pass 5',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 33.998209',
].join('\n');

const SPEC_WITH_FAIL = [
  '✖ 某失败用例 (1.2ms)',
  'ℹ tests 8',
  'ℹ suites 2',
  'ℹ pass 6',
  'ℹ fail 2',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 120.5',
].join('\n');

const SPEC_ZERO_TESTS = [
  'ℹ tests 0',
  'ℹ suites 0',
  'ℹ pass 0',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 1.23',
].join('\n');

// TAP reporter（--test-reporter=tap）摘要格式，确保解析双格式兼容
const TAP_ALL_PASS = [
  'ok 5 - 最后一个用例',
  '1..5',
  '# tests 5',
  '# suites 1',
  '# pass 5',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 40.1',
].join('\n');

describe('parseTapSummary — 全 pass', () => {
  test('spec reporter：tests=pass、fail=0', () => {
    const r = parseTapSummary(SPEC_ALL_PASS);
    assert.strictEqual(r.tests, 5);
    assert.strictEqual(r.pass, 5);
    assert.strictEqual(r.fail, 0);
    assert.strictEqual(r.duration_ms, 33.998209);
  });

  test('TAP reporter：同样解析出全 pass 计数', () => {
    const r = parseTapSummary(TAP_ALL_PASS);
    assert.strictEqual(r.tests, 5);
    assert.strictEqual(r.pass, 5);
    assert.strictEqual(r.fail, 0);
    assert.strictEqual(r.duration_ms, 40.1);
  });
});

describe('parseTapSummary — 有 fail', () => {
  test('pass < tests，fail > 0', () => {
    const r = parseTapSummary(SPEC_WITH_FAIL);
    assert.strictEqual(r.tests, 8);
    assert.strictEqual(r.pass, 6);
    assert.strictEqual(r.fail, 2);
    assert.strictEqual(r.duration_ms, 120.5);
  });
});

describe('parseTapSummary — 0 测试', () => {
  test('tests=0、pass=0、fail=0', () => {
    const r = parseTapSummary(SPEC_ZERO_TESTS);
    assert.strictEqual(r.tests, 0);
    assert.strictEqual(r.pass, 0);
    assert.strictEqual(r.fail, 0);
    assert.strictEqual(r.duration_ms, 1.23);
  });
});

describe('parseTapSummary — 边界与健壮性', () => {
  test('空字符串 / 非字符串 → 全 null（不抛）', () => {
    for (const v of ['', null, undefined, 42, {}]) {
      const r = parseTapSummary(v);
      assert.deepStrictEqual(r, { tests: null, pass: null, fail: null, duration_ms: null });
    }
  });

  test('无摘要行的普通文本 → 全 null', () => {
    const r = parseTapSummary('随便一段日志\n没有任何计数行\n');
    assert.deepStrictEqual(r, { tests: null, pass: null, fail: null, duration_ms: null });
  });

  test('多段摘要（嵌套/多次出现）→ 取最后一次出现的计数', () => {
    // 模拟子套件中间也打了 `# pass`，最终汇总在末尾 → 应取末尾的总计
    const text = ['# pass 1', '# tests 1', SPEC_WITH_FAIL].join('\n');
    const r = parseTapSummary(text);
    assert.strictEqual(r.pass, 6);
    assert.strictEqual(r.tests, 8);
    assert.strictEqual(r.fail, 2);
  });
});

describe('buildSummaryText — N/N PASS 文案', () => {
  test('全 pass：含 ==== 5/5 PASS ====', () => {
    const summary = parseTapSummary(SPEC_ALL_PASS);
    const text = buildSummaryText({ summary, fileCount: 1, elapsedMs: 100 });
    assert.match(text, /==== 5\/5 PASS ====/);
    assert.match(text, /unit 文件数：1/);
  });

  test('有 fail：N/N 反映 pass/total + 失败用例数', () => {
    const summary = parseTapSummary(SPEC_WITH_FAIL);
    const text = buildSummaryText({ summary, fileCount: 2, elapsedMs: 200 });
    assert.match(text, /==== 6\/8 PASS ====/);
    assert.match(text, /失败用例：2/);
  });

  test('解析失败（全 null）→ 用 ? 占位、不抛', () => {
    const text = buildSummaryText({ summary: parseTapSummary(''), fileCount: 0, elapsedMs: 1 });
    assert.match(text, /==== \?\/\? PASS ====/);
  });
});

describe('buildNodeTestArgs — spawn 路径契约', () => {
  test('测试文件转为仓库相对路径，coverage、文件集合与顺序不变', () => {
    const files = [
      path.join(REPO_ROOT, 'tests', 'unit', 'z-last.test.js'),
      path.join(REPO_ROOT, 'tests', 'unit', 'nested', 'a-first.test.js')
    ];

    const args = buildNodeTestArgs(files, { coverage: true });
    const testFileArgs = args.slice(2);

    assert.deepStrictEqual(args.slice(0, 2), ['--test', '--experimental-test-coverage']);
    assert.strictEqual(testFileArgs.length, files.length);
    assert.ok(testFileArgs.every((file) => !path.isAbsolute(file)));
    assert.deepStrictEqual(
      testFileArgs.map((file) => path.resolve(REPO_ROOT, file)),
      files
    );
  });
});

// v3.2.15 B43：CI 把单测分到多个 job 并行（UNIT_TEST_SHARD=i/n）。
describe('parseShard / selectShardFiles', () => {
  test('未设置时跑全部，不加分片参数', () => {
    assert.strictEqual(parseShard(undefined), null);
    assert.strictEqual(parseShard(''), null);
    assert.deepStrictEqual(buildNodeTestArgs([]), ['--test']);
  });

  test('i/n 解析并写进汇总', () => {
    assert.deepStrictEqual(parseShard(' 2/5 '), { index: 2, total: 5 });
    const text = buildSummaryText({ summary: parseTapSummary(''), fileCount: 9, elapsedMs: 1, shard: { index: 2, total: 5 } });
    assert.match(text, /unit 文件数：9（第 2\/5 片）/);
  });

  test('当前全部单测文件按 5 片分配：不重不漏、每片按路径排序，负载敏感文件各在一片', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of require('node:fs').readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
        const relative = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(relative);
        else if (entry.name.endsWith('.test.js')) files.push(relative);
      }
    };
    walk('tests/unit');
    for (const listed of [...LOAD_SENSITIVE_UNIT_FILES, ...HEAVY_UNIT_FILES]) {
      assert.ok(files.includes(listed), `分片清单中的 ${listed} 须是现有单测文件`);
    }
    const shards = Array.from({ length: 5 }, (_value, index) => selectShardFiles(files, { index: index + 1, total: 5 }));
    assert.deepStrictEqual(shards.flat().sort(), [...files].sort());
    shards.forEach((shard) => assert.deepStrictEqual(shard, [...shard].sort()));
    assert.deepStrictEqual(shards.map((shard) => shard.filter((file) => LOAD_SENSITIVE_UNIT_FILES.includes(file)).length), [1, 1, 1, 1, 1]);
    assert.ok(Math.max(...shards.map((shard) => shard.length)) - Math.min(...shards.map((shard) => shard.length)) <= 1, '各片文件数相差不超过 1');
    assert.deepStrictEqual(selectShardFiles(['b.test.js', 'a.test.js'], null), ['a.test.js', 'b.test.js']);
  });

  test('格式不对时报错，不静默跑全部或跑空', () => {
    for (const value of ['0/3', '4/3', '1/0', '3', 'a/b', '1/3/5', '-1/3']) {
      assert.throws(() => parseShard(value), /分片参数须为 i\/n/, value);
    }
  });
});
