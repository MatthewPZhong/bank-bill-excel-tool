// v2.1.9 SR-log-1 Phase 8.8 T32j：logger.js 双写 + JSON Lines 单元测试
//
// 覆盖：
// - getLogFilePath：路径构造 / level 兜底 / 自动 mkdir / 月+日两层归档
// - appendStructuredLog：JSON Lines 格式 / 字段兜底 / details 清洗 / stack 可选
// - appendActivityRecord 扩展：旧路径 + 新结构双写一致性 / 跨月切换
// - 永久保留：跑多次不清理（仅 append）
//
// 用 tmpdir 隔离副作用，每个 test 独立目录

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  appendActivityRecord,
  getLogFilePath,
  appendStructuredLog
} = require('../../../src/backend/logger');

function mkTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// ============================================================================
// getLogFilePath
// ============================================================================

test.describe('getLogFilePath', () => {
  test('路径构造：logs/{YYYY-MM}/{MM-DD}/{level}.log 月+日两层归档', () => {
    const root = mkTmpRoot();
    const date = new Date(2026, 4, 27); // 月份从 0 开始 → 5 月 27 日
    const filePath = getLogFilePath(root, 'error', date);
    const rel = path.relative(root, filePath);
    assert.strictEqual(rel, path.join('logs', '2026-05', '05-27', 'error.log'));
  });

  test('level 兜底：未知 level → info', () => {
    const root = mkTmpRoot();
    const filePath = getLogFilePath(root, 'critical', new Date(2026, 4, 27));
    assert.ok(filePath.endsWith('info.log'), `期望 info.log 兜底，实际 ${filePath}`);
  });

  test('level 大写兼容：ERROR → error', () => {
    const root = mkTmpRoot();
    const filePath = getLogFilePath(root, 'ERROR', new Date(2026, 4, 27));
    assert.ok(filePath.endsWith('error.log'));
  });

  test('自动 mkdirSync recursive：目录不存在自动创建', () => {
    const root = mkTmpRoot();
    const filePath = getLogFilePath(root, 'info', new Date(2026, 4, 27));
    assert.ok(fs.existsSync(path.dirname(filePath)));
  });

  test('跨月切换：5 月 → 6 月生成不同 YYYY-MM 目录', () => {
    const root = mkTmpRoot();
    const may = getLogFilePath(root, 'info', new Date(2026, 4, 31));
    const jun = getLogFilePath(root, 'info', new Date(2026, 5, 1));
    assert.ok(may.includes(path.join('2026-05', '05-31')), `5 月路径错: ${may}`);
    assert.ok(jun.includes(path.join('2026-06', '06-01')), `6 月路径错: ${jun}`);
  });

  test('跨年切换：自动归到下一年目录', () => {
    const root = mkTmpRoot();
    const dec = getLogFilePath(root, 'info', new Date(2026, 11, 31));
    const jan = getLogFilePath(root, 'info', new Date(2027, 0, 1));
    assert.ok(dec.includes(path.join('2026-12', '12-31')));
    assert.ok(jan.includes(path.join('2027-01', '01-01')));
  });
});

// ============================================================================
// appendStructuredLog
// ============================================================================

test.describe('appendStructuredLog', () => {
  test('JSON Lines 格式：每行一个合法 JSON 对象', () => {
    const root = mkTmpRoot();
    appendStructuredLog(root, { level: 'error', message: 'msg1' }, new Date(2026, 4, 27));
    appendStructuredLog(root, { level: 'error', message: 'msg2' }, new Date(2026, 4, 27));
    const filePath = getLogFilePath(root, 'error', new Date(2026, 4, 27));
    const lines = readJsonLines(filePath);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0].message, 'msg1');
    assert.strictEqual(lines[1].message, 'msg2');
  });

  test('字段 schema 完整：ts / level / source / domain / message / details', () => {
    const root = mkTmpRoot();
    appendStructuredLog(root, {
      level: 'warning',
      source: 'main',
      domain: 'migration',
      message: 'N5 channels',
      details: ['channels.id=1']
    }, new Date(2026, 4, 27));
    const lines = readJsonLines(getLogFilePath(root, 'warning', new Date(2026, 4, 27)));
    assert.strictEqual(lines.length, 1);
    const rec = lines[0];
    assert.ok(typeof rec.ts === 'string' && rec.ts.length > 0, 'ts 应为非空字符串');
    assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, 'ts 应符合 ISO 8601 with TZ');
    assert.strictEqual(rec.level, 'warning');
    assert.strictEqual(rec.source, 'main');
    assert.strictEqual(rec.domain, 'migration');
    assert.strictEqual(rec.message, 'N5 channels');
    assert.deepStrictEqual(rec.details, ['channels.id=1']);
  });

  test('字段兜底：未传 source/domain/details → unknown / []', () => {
    const root = mkTmpRoot();
    appendStructuredLog(root, { level: 'info', message: 'min payload' }, new Date(2026, 4, 27));
    const lines = readJsonLines(getLogFilePath(root, 'info', new Date(2026, 4, 27)));
    assert.strictEqual(lines[0].source, 'unknown');
    assert.strictEqual(lines[0].domain, 'unknown');
    assert.deepStrictEqual(lines[0].details, []);
  });

  test('message 兜底：空 message → "未命名操作"', () => {
    const root = mkTmpRoot();
    appendStructuredLog(root, { level: 'info', message: '' }, new Date(2026, 4, 27));
    const lines = readJsonLines(getLogFilePath(root, 'info', new Date(2026, 4, 27)));
    assert.strictEqual(lines[0].message, '未命名操作');
  });

  test('details 清洗：null / 空字符串过滤 + trim', () => {
    const root = mkTmpRoot();
    appendStructuredLog(root, {
      level: 'error',
      message: 'm',
      details: ['line1', null, '', '  line2  ', '   ']
    }, new Date(2026, 4, 27));
    const lines = readJsonLines(getLogFilePath(root, 'error', new Date(2026, 4, 27)));
    assert.deepStrictEqual(lines[0].details, ['line1', 'line2']);
  });

  test('stack 可选：传入则附加，未传则不出现', () => {
    const root = mkTmpRoot();
    appendStructuredLog(root, { level: 'error', message: 'with stack', stack: 'Error: foo\n  at bar' }, new Date(2026, 4, 27));
    appendStructuredLog(root, { level: 'error', message: 'no stack' }, new Date(2026, 4, 27));
    const lines = readJsonLines(getLogFilePath(root, 'error', new Date(2026, 4, 27)));
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0].stack, 'Error: foo\n  at bar');
    assert.ok(!('stack' in lines[1]), '未传 stack 时不应附 stack 字段');
  });

  test('ts 自定义：传入则使用 caller 提供的 ts', () => {
    const root = mkTmpRoot();
    appendStructuredLog(root, {
      level: 'info',
      message: 'm',
      ts: '2030-01-01T00:00:00.000+08:00'
    }, new Date(2026, 4, 27));
    const lines = readJsonLines(getLogFilePath(root, 'info', new Date(2026, 4, 27)));
    assert.strictEqual(lines[0].ts, '2030-01-01T00:00:00.000+08:00');
  });
});

// ============================================================================
// appendActivityRecord 双写
// ============================================================================

test.describe('appendActivityRecord 写入新结构 JSON Lines（v2.1.12 SR-log-1 删旧 txt 双写后）', () => {
  test('仅写新 JSON Lines，不再创建旧 app_activity_log.txt', () => {
    const root = mkTmpRoot();
    const legacyPath = path.join(root, 'app_activity_log.txt');
    appendActivityRecord(legacyPath, {
      level: 'error',
      message: '测试写入',
      details: ['detail1', 'detail2']
    });

    // v2.1.12 SR-log-1：旧 app_activity_log.txt 不再创建/写入
    assert.ok(!fs.existsSync(legacyPath), '旧 app_activity_log.txt 不应再被创建');

    // 新路径（JSON Lines）
    const today = new Date();
    const newPath = path.join(
      root,
      'logs',
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`,
      `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
      'error.log'
    );
    assert.ok(fs.existsSync(newPath), `新 JSON Lines 路径应存在: ${newPath}`);
    const newLines = readJsonLines(newPath);
    assert.strictEqual(newLines.length, 1);
    assert.strictEqual(newLines[0].message, '测试写入');
    assert.strictEqual(newLines[0].level, 'error');
    assert.deepStrictEqual(newLines[0].details, ['detail1', 'detail2']);
  });

  test('旧 caller 兼容：仅传 level/message/details 不带 source 也能写新结构', () => {
    const root = mkTmpRoot();
    const legacyPath = path.join(root, 'app_activity_log.txt');
    appendActivityRecord(legacyPath, { level: 'info', message: '兼容测试' });
    // v2.1.12 SR-log-1：旧 txt 不再创建
    assert.ok(!fs.existsSync(legacyPath), '旧 app_activity_log.txt 不应再被创建');
    // 新路径用 unknown 兜底
    const today = new Date();
    const newPath = getLogFilePath(root, 'info', today);
    const lines = readJsonLines(newPath);
    assert.strictEqual(lines[0].source, 'unknown');
    assert.strictEqual(lines[0].domain, 'unknown');
  });

  test('新结构写入失败时抛错，交由 caller 兜底（删旧 txt 后不再吞错）', () => {
    // 制造写不进去的 storageRoot：用文件占位 logs 名字位置，appendStructuredLog 内 mkdirSync(logs/...) 抛 ENOTDIR
    const root = mkTmpRoot();
    const legacyPath = path.join(root, 'app_activity_log.txt');
    fs.writeFileSync(path.join(root, 'logs'), 'this-is-a-file-not-a-dir');
    // v2.1.12 SR-log-1：删旧双写后 appendActivityRecord 不再 try-catch 吞错，新结构失败直接抛
    //   → 由 caller（appendActivityLogEntry / appendModuleLog）各自 stderr graceful 兜底
    assert.throws(() => appendActivityRecord(legacyPath, { level: 'error', message: '新结构应失败' }));
    assert.ok(!fs.existsSync(legacyPath), '旧 txt 不应被创建');
  });

  test('永久保留：多次写入 append 累积，不滚动不清理', () => {
    const root = mkTmpRoot();
    const legacyPath = path.join(root, 'app_activity_log.txt');
    for (let i = 0; i < 5; i++) {
      appendActivityRecord(legacyPath, { level: 'info', message: `第 ${i} 条` });
    }
    const today = new Date();
    const newPath = getLogFilePath(root, 'info', today);
    const lines = readJsonLines(newPath);
    assert.strictEqual(lines.length, 5);
    assert.strictEqual(lines[0].message, '第 0 条');
    assert.strictEqual(lines[4].message, '第 4 条');
  });

  test('level 分文件：error / warning / info 写到不同文件', () => {
    const root = mkTmpRoot();
    const legacyPath = path.join(root, 'app_activity_log.txt');
    appendActivityRecord(legacyPath, { level: 'error', message: 'e1' });
    appendActivityRecord(legacyPath, { level: 'warning', message: 'w1' });
    appendActivityRecord(legacyPath, { level: 'info', message: 'i1' });
    const today = new Date();
    assert.strictEqual(readJsonLines(getLogFilePath(root, 'error', today)).length, 1);
    assert.strictEqual(readJsonLines(getLogFilePath(root, 'warning', today)).length, 1);
    assert.strictEqual(readJsonLines(getLogFilePath(root, 'info', today)).length, 1);
  });

  test('source + domain + stack 字段透传', () => {
    const root = mkTmpRoot();
    const legacyPath = path.join(root, 'app_activity_log.txt');
    appendActivityRecord(legacyPath, {
      level: 'error',
      source: 'main',
      domain: 'migration',
      message: 'N5 失败',
      details: ['rollback ok'],
      stack: 'Error: db locked\n  at run'
    });
    const today = new Date();
    const lines = readJsonLines(getLogFilePath(root, 'error', today));
    assert.strictEqual(lines[0].source, 'main');
    assert.strictEqual(lines[0].domain, 'migration');
    assert.strictEqual(lines[0].stack, 'Error: db locked\n  at run');
  });
});
