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

// v3.2.21：错误报告逐行写入明细，明细很多（如逐行列出的跳过行）时不因展开成参数超出调用栈
test('writeErrorReport：15 万行明细照常写出报告', () => {
  const { writeErrorReport } = require('../../../src/backend/logger');
  const root = mkTmpRoot();
  try {
    const detailLines = new Array(150000).fill('第 2 行：Credit Amount 与 Debit Amount 都为空，已跳过');
    const report = writeErrorReport(root, { step: '导入网银明细文件', message: '测试', errorCode: 'TEST', detailLines });
    const lines = fs.readFileSync(report.filePath, 'utf8').split('\n');
    assert.equal(lines.filter((line) => line.startsWith('- 第 2 行')).length, 150000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// v3.2.22 B45（Codex 第五轮）：同一秒、同名的报告不覆盖上一份；写到一半失败时删掉新文件，上一份的字节不变
test('writeErrorReport：同一秒同名时另建 -2 文件；写入失败时不留下半份、上一份报告不变', (t) => {
  const { writeErrorReport } = require('../../../src/backend/logger');
  const root = mkTmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const RealDate = Date;
  const fixed = new RealDate(2026, 10, 23, 10, 20, 30).getTime();
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }
    static now() {
      return fixed;
    }
  };
  t.after(() => { global.Date = RealDate; });
  const payload = { step: '生成网银账单', templateName: '模板A', message: '第一份', errorCode: 'TEST' };
  const first = writeErrorReport(root, payload);
  const firstBytes = fs.readFileSync(first.filePath);
  const second = writeErrorReport(root, { ...payload, message: '第二份' });
  assert.notEqual(second.filePath, first.filePath);
  assert.match(second.fileName, /-2\.txt$/);
  assert.match(fs.readFileSync(second.filePath, 'utf8'), /第二份/);
  assert.deepEqual(fs.readFileSync(first.filePath), firstBytes, '上一份报告不被覆盖');

  const writeFileSync = fs.writeFileSync;
  fs.writeFileSync = (target, ...rest) => {
    if (typeof target === 'number') {
      writeFileSync(target, '半份');
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return writeFileSync(target, ...rest);
  };
  t.after(() => { fs.writeFileSync = writeFileSync; });
  const before = fs.readdirSync(path.dirname(first.filePath)).sort();
  assert.throws(() => writeErrorReport(root, { ...payload, message: '第三份' }), { code: 'ENOSPC' });
  fs.writeFileSync = writeFileSync;
  assert.deepEqual(fs.readdirSync(path.dirname(first.filePath)).sort(), before, '不留下写了一半的新报告');
  assert.deepEqual(fs.readFileSync(first.filePath), firstBytes);
});

// v3.2.22 B45（Codex 第六轮）：关闭时才报告的延迟写入错误同样按写入失败处理：删掉新文件，同一描述符只关闭一次
test('writeErrorReport：关闭报告文件失败时删掉本次新建的文件，不重复关闭', (t) => {
  const { writeErrorReport } = require('../../../src/backend/logger');
  const root = mkTmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const closeSync = fs.closeSync;
  const closed = [];
  fs.closeSync = (fd) => {
    closed.push(fd);
    closeSync(fd);
    throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
  };
  t.after(() => { fs.closeSync = closeSync; });
  assert.throws(() => writeErrorReport(root, { step: '生成网银账单', templateName: '模板A', message: '报告', errorCode: 'TEST' }), { code: 'EIO' });
  fs.closeSync = closeSync;
  assert.equal(closed.length, 1, '同一描述符只关闭一次');
  const reportFiles = fs.readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith('.txt'));
  assert.deepEqual(reportFiles, [], '不留下内容不完整的新报告');
});

// v3.2.22 B45（Codex 第十一轮）：按字节限制文件名的卷（上限 255 个 UTF-8 字节）上，正式名恰在上限时照常写出，临时名不随之超长。
//   macOS 与 Windows 按字符计，这里模拟按字节计的卷
test('writeErrorReport：正式名恰在文件名长度上限（255 字节）时照常写出', (t) => {
  const { writeErrorReport } = require('../../../src/backend/logger');
  const root = mkTmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originals = {};
  for (const method of ['openSync', 'linkSync', 'renameSync']) {
    originals[method] = fs[method];
    fs[method] = (...args) => {
      for (const arg of method === 'openSync' ? [args[0]] : [args[1]]) {
        if (Buffer.byteLength(path.basename(String(arg))) > 255) {
          throw Object.assign(new Error(`ENAMETOOLONG: name too long, ${method}`), { code: 'ENAMETOOLONG' });
        }
      }
      return originals[method](...args);
    };
  }
  t.after(() => Object.assign(fs, originals));
  const RealDate = Date;
  const fixed = new RealDate(2026, 10, 24, 9, 30, 0).getTime();
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }
    static now() {
      return fixed;
    }
  };
  t.after(() => { global.Date = RealDate; });
  const payload = { step: '导入网银明细文件', templateName: '账'.repeat(70), errorCode: 'TEST' };
  const report = writeErrorReport(root, { ...payload, message: '第一份' });
  // 同一秒同名的第二份：追加 -2 后基本名按字节缩短，仍可写出、不覆盖第一份（Codex 第十二轮）
  const second = writeErrorReport(root, { ...payload, message: '第二份' });
  Object.assign(fs, originals);
  global.Date = RealDate;
  assert.equal(Buffer.byteLength(report.fileName), 255);
  assert.ok(Buffer.byteLength(second.fileName) <= 255 && /-2\.txt$/.test(second.fileName), second.fileName);
  assert.deepEqual(fs.readdirSync(path.dirname(report.filePath)).sort(), [report.fileName, second.fileName].sort());
  assert.match(fs.readFileSync(report.filePath, 'utf8'), /第一份/);
  assert.match(fs.readFileSync(second.filePath, 'utf8'), /第二份/);
});

// v3.2.22 B45（Codex 第十轮）：写到一半失败、删除又因占用失败时，留下的只是不带 .txt 的临时文件，不是外观正常的残缺报告
test('writeErrorReport：写入失败且删除失败时不留下正式名称的残缺报告；成功时不留临时文件', (t) => {
  const { writeErrorReport } = require('../../../src/backend/logger');
  const root = mkTmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = { step: '生成网银账单', templateName: '模板A', message: '报告', errorCode: 'TEST' };
  const ok = writeErrorReport(root, payload);
  assert.deepEqual(fs.readdirSync(path.dirname(ok.filePath)), [ok.fileName], '成功时只有正式报告');
  fs.rmSync(ok.filePath);

  const writeFileSync = fs.writeFileSync;
  const rmSync = fs.rmSync;
  fs.writeFileSync = (target, ...rest) => {
    if (typeof target === 'number') {
      writeFileSync(target, '半份');
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return writeFileSync(target, ...rest);
  };
  fs.rmSync = (target, ...rest) => {
    if (String(target).startsWith(root)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return rmSync(target, ...rest);
  };
  t.after(() => { fs.writeFileSync = writeFileSync; fs.rmSync = rmSync; });
  assert.throws(() => writeErrorReport(root, payload), { code: 'ENOSPC' });
  fs.writeFileSync = writeFileSync;
  fs.rmSync = rmSync;
  const names = fs.readdirSync(path.dirname(ok.filePath));
  assert.deepEqual(names.filter((name) => name.endsWith('.txt')), [], '不留下正式名称的残缺报告');
  assert.equal(names.length, 1, '只留下删不掉的临时文件');
});

// v3.2.22 B45（Codex 第十三轮）：硬链接发布后，临时名与正式报告指向同一份完整内容：删除临时名短暂占用时重试；
//   重试后仍删不掉时报告照常发布、写告警日志，下次写报错文件时再删
test('writeErrorReport：发布后删除临时名遇到短暂占用时重试，仍失败时记为待清理并在下次写报告时删除', (t) => {
  const { writeErrorReport, getLogFilePath } = require('../../../src/backend/logger');
  const root = mkTmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = { step: '生成网银账单', templateName: '模板A', message: '报告', errorCode: 'TEST' };
  const rmSync = fs.rmSync;
  let failures = 0;
  let busyPartials = 0;
  fs.rmSync = (target, ...rest) => {
    if (path.basename(String(target)).endsWith('.partial') && busyPartials < failures) {
      busyPartials += 1;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return rmSync(target, ...rest);
  };
  t.after(() => { fs.rmSync = rmSync; });

  failures = 1;
  const first = writeErrorReport(root, payload);
  const dir = path.dirname(first.filePath);
  assert.deepEqual(fs.readdirSync(dir), [first.fileName], '第一次删除被占用：重试后只留正式报告');
  assert.equal(first.pendingCleanupFiles, undefined);

  busyPartials = 0;
  failures = 100;
  const second = writeErrorReport(root, { ...payload, message: '第二份' });
  const leftover = fs.readdirSync(dir).filter((name) => name.endsWith('.partial'));
  assert.equal(leftover.length, 1, '重试后仍删不掉：留下临时名');
  assert.match(fs.readFileSync(second.filePath, 'utf8'), /第二份/, '报告照常发布');
  assert.deepEqual(second.pendingCleanupFiles, [path.join(dir, leftover[0])]);
  const warnings = fs.readFileSync(getLogFilePath(root, 'warning', new Date()), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(warnings.at(-1).details, [path.relative(root, path.join(dir, leftover[0]))], '告警日志记下待清理位置');

  failures = 0;
  const third = writeErrorReport(root, { ...payload, message: '第三份' });
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.partial')), [], '下次写报告时删除待清理的临时名');
  assert.equal(third.pendingCleanupFiles, undefined);
});
