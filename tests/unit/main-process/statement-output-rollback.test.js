'use strict';

// v3.2.22 B45：多模板分组生成的写出记录——原有文件分块原地还原（文件身份不变）、新建文件删除、同一路径只记首次状态；
//   内容未变的文件（如被占用、写出时根本没打开）不写回；写完后被其他程序改动的文件不覆盖、不删除；符号链接与文件夹在写出
//   前拒绝；未能还原时只保留这些文件的备份并写恢复清单；成功提交只清理临时目录。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FileValidationError } = require('../../../src/backend/file-service/common');
const {
  MANIFEST_FILE_NAME,
  RECORD_FILE_NAME,
  createStatementOutputJournal,
  isStatementOutputsRestored
} = require('../../../src/main-process/statement-output-rollback');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-rollback-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staging = path.join(root, 'staging');
  fs.mkdirSync(staging);
  return { root, staging };
}

const writeText = (filePath, text) => () => fs.writeFileSync(filePath, text);
// 未启用开发者模式、也没有建链权限的 Windows 上创建符号链接报 EPERM：返回 false，由用例改用文件夹等其他非普通文件
function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && error && error.code === 'EPERM') return false;
    throw error;
  }
}

test('回滚：原有文件按首次写入前的内容原地还原，新建文件删除，备份目录清理', (t) => {
  const { root, staging } = setup(t);
  const existing = path.join(root, 'seed.json');
  const created = path.join(root, 'detail.xlsx');
  fs.writeFileSync(existing, 'before');
  const ino = fs.statSync(existing).ino;
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(existing, writeText(existing, 'group-1'));
  journal.write(existing, writeText(existing, 'group-2')); // 同批再次写入：仍按首次写入前的内容还原
  journal.write(created, writeText(created, 'new'));
  const outcome = journal.rollback();
  assert.deepEqual([outcome.restored, outcome.failures], [true, []]);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'before');
  assert.equal(fs.statSync(existing).ino, ino, '原地写回，文件身份不变');
  assert.equal(fs.existsSync(created), false);
  assert.deepEqual(fs.readdirSync(staging), []);
});

test('提交：保留新内容，只清理备份目录', (t) => {
  const { root, staging } = setup(t);
  const existing = path.join(root, 'balance.xlsx');
  fs.writeFileSync(existing, 'before');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(existing, writeText(existing, 'after'));
  journal.commit();
  assert.equal(fs.readFileSync(existing, 'utf8'), 'after');
  assert.deepEqual(fs.readdirSync(staging), []);
});

test('写出中途截断后抛错：按备份分块写回原内容（大于一个复制块）', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, '2-BALANCE.xlsx');
  const original = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  fs.writeFileSync(target, original);
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  assert.throws(() => journal.write(target, () => {
    fs.writeFileSync(target, 'partial');
    throw Object.assign(new Error('磁盘已满'), { code: 'ENOSPC' });
  }), /磁盘已满/);
  assert.equal(journal.rollback().restored, true);
  assert.ok(fs.readFileSync(target).equals(original));
});

test('内容与备份一致时不写回：被占用而未写入的原文件不报还原失败', (t) => {
  const { root, staging } = setup(t);
  const locked = path.join(root, 'locked.xlsx');
  fs.writeFileSync(locked, 'before');
  // 模拟 Excel 占用：可读（备份成功），以写方式打开即失败
  const lockingFs = { ...fs, openSync(filePath, flags, ...rest) {
    if (filePath === locked && flags !== 'r') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return fs.openSync(filePath, flags, ...rest);
  } };
  const journal = createStatementOutputJournal({ fsImpl: lockingFs, stagingRoot: staging });
  assert.throws(() => journal.write(locked, () => lockingFs.openSync(locked, 'w')), /EBUSY/);
  const outcome = journal.rollback();
  assert.deepEqual([outcome.restored, outcome.failures], [true, []]);
  assert.equal(fs.readFileSync(locked, 'utf8'), 'before');
});

test('写完后被其他程序替换或修改的文件不覆盖、不删除，按恢复清单交给人工', (t) => {
  const { root, staging } = setup(t);
  const replaced = path.join(root, 'replaced.xlsx');
  const createdThenChanged = path.join(root, 'created.xlsx');
  const normal = path.join(root, 'normal.xlsx');
  fs.writeFileSync(replaced, 'before');
  fs.writeFileSync(normal, 'normal-before');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(replaced, writeText(replaced, 'batch'));
  journal.write(createdThenChanged, writeText(createdThenChanged, 'batch-new'));
  journal.write(normal, writeText(normal, 'normal-batch'));
  // 外部程序：另存替换（新文件改名覆盖）、追加修改
  fs.writeFileSync(`${replaced}.tmp`, 'external');
  fs.renameSync(`${replaced}.tmp`, replaced);
  fs.appendFileSync(createdThenChanged, '-external');
  const outcome = journal.rollback();
  assert.equal(outcome.restored, false);
  assert.deepEqual(outcome.failures.map((item) => [path.basename(item.filePath), item.existed, item.backupName]),
    [['replaced.xlsx', true, '001.bak'], ['created.xlsx', false, null]]);
  assert.equal(fs.readFileSync(replaced, 'utf8'), 'external', '不覆盖外部文件');
  assert.equal(fs.readFileSync(createdThenChanged, 'utf8'), 'batch-new-external', '不删除外部改动过的文件');
  assert.equal(fs.readFileSync(normal, 'utf8'), 'normal-before', '其他文件照常还原');
  // 备份目录只留未还原文件的备份、恢复清单与写出记录
  assert.deepEqual(fs.readdirSync(outcome.backupDirectory).sort(), ['001.bak', MANIFEST_FILE_NAME, RECORD_FILE_NAME].sort());
  assert.equal(fs.readFileSync(path.join(outcome.backupDirectory, '001.bak'), 'utf8'), 'before');
  const manifest = fs.readFileSync(outcome.manifestPath, 'utf8');
  assert.match(manifest, new RegExp(`1\\. ${replaced.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n   原有文件，原内容备份：001\\.bak\\n   原因：写出后已被其他程序修改或替换`));
  assert.match(manifest, /2\. .*created\.xlsx\n {3}本次新建的文件（导入前不存在）/);
});

test('同一文件经不同路径写入（大小写别名、硬链接）按文件身份合并，只按首份备份还原', (t) => {
  const { root, staging } = setup(t);
  const seed = path.join(root, 'HSBC.json');
  const alias = path.join(root, 'hsbc-alias.json');
  fs.writeFileSync(seed, 'before');
  fs.linkSync(seed, alias); // 可移植地模拟不区分大小写的文件系统上 HSBC.json / hsbc.json 指向同一文件
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(seed, writeText(seed, 'group-1'));
  journal.write(alias, writeText(alias, 'group-2'));
  const outcome = journal.rollback();
  assert.deepEqual([outcome.restored, outcome.failures], [true, []]);
  assert.equal(fs.readFileSync(seed, 'utf8'), 'before', '没有外部写入时还原为批前内容，不误报被其他程序修改');
});

test('同一文件再次写入前核对身份：两次写之间被其他程序改动时不再写入，回滚也不覆盖', (t) => {
  const { root, staging } = setup(t);
  const seed = path.join(root, 'seed.json');
  fs.writeFileSync(seed, 'before');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(seed, writeText(seed, 'group-1'));
  fs.writeFileSync(seed, 'sync-client-content-of-another-size');
  let wrote = false;
  assert.throws(() => journal.write(seed, () => { wrote = true; }), { code: 'STATEMENT_OUTPUT_CHANGED_EXTERNALLY' });
  assert.equal(wrote, false);
  const outcome = journal.rollback();
  assert.equal(outcome.restored, false);
  assert.deepEqual(outcome.failures.map((item) => item.reason), ['写出后已被其他程序修改或替换，未自动处理']);
  assert.equal(fs.readFileSync(seed, 'utf8'), 'sync-client-content-of-another-size');
});

test('写出回调抛错：路径上换成其他程序的文件不覆盖；新建路径上出现的文件无法确认归属不删除；本批写成过的照常处理', (t) => {
  const { root, staging } = setup(t);
  const existing = path.join(root, 'merged.xlsx');
  const created = path.join(root, 'new.xlsx');
  const ownedNew = path.join(root, 'owned.xlsx');
  fs.writeFileSync(existing, 'before');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(ownedNew, writeText(ownedNew, 'batch-1'));
  // 汇总仍在读取输入时，外部程序把另一个文件改名到汇总路径，随后读取失败、本批没有打开输出
  assert.throws(() => journal.write(existing, () => {
    fs.writeFileSync(`${existing}.tmp`, 'external');
    fs.renameSync(`${existing}.tmp`, existing);
    throw new Error('读取输入失败');
  }));
  const outcome = journal.rollback();
  assert.deepEqual(outcome.failures.map((item) => [path.basename(item.filePath), item.reason]),
    [['merged.xlsx', '写出后已被其他程序修改或替换，未自动处理']]);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'external');
  assert.equal(fs.existsSync(ownedNew), false, '本批写成过的新文件照常删除');

  const second = createStatementOutputJournal({ stagingRoot: staging });
  second.write(ownedNew, writeText(ownedNew, 'batch-1'));
  assert.throws(() => second.write(ownedNew, () => { fs.writeFileSync(ownedNew, 'part'); throw new Error('ENOSPC'); }));
  assert.throws(() => second.write(created, () => { fs.writeFileSync(created, 'foreign'); throw new Error('读取输入失败'); }));
  const mixed = second.rollback();
  assert.deepEqual(mixed.failures.map((item) => [path.basename(item.filePath), item.reason]),
    [['new.xlsx', '写出失败时路径上出现的文件，无法确认是否本批写出，未自动删除']]);
  assert.equal(fs.readFileSync(created, 'utf8'), 'foreign');
  assert.equal(fs.existsSync(ownedNew), false, '本批写成后再次写到一半失败的新文件仍按本批的删除');
});

test('恢复清单写不出时以首次写入时记下的写出记录代替', (t) => {
  const { root, staging } = setup(t);
  const replaced = path.join(root, 'replaced.xlsx');
  fs.writeFileSync(replaced, 'before');
  const fullFs = { ...fs, writeFileSync(filePath, ...rest) {
    if (path.basename(String(filePath)).startsWith(MANIFEST_FILE_NAME)) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    return fs.writeFileSync(filePath, ...rest);
  } };
  const journal = createStatementOutputJournal({ fsImpl: fullFs, stagingRoot: staging });
  journal.write(replaced, writeText(replaced, 'batch'));
  fs.writeFileSync(`${replaced}.tmp`, 'external');
  fs.renameSync(`${replaced}.tmp`, replaced);
  const outcome = journal.rollback();
  assert.equal(outcome.manifestPath, path.join(outcome.backupDirectory, RECORD_FILE_NAME));
  assert.match(fs.readFileSync(outcome.manifestPath, 'utf8'), /1\. .*replaced\.xlsx\n {3}写前已有文件，原内容备份：001\.bak/);
  assert.equal(fs.readFileSync(path.join(outcome.backupDirectory, '001.bak'), 'utf8'), 'before');
});

test('路径上是符号链接或文件夹时在写出前拒绝，不跟随链接写入', (t) => {
  const { root, staging } = setup(t);
  const realTarget = path.join(root, 'elsewhere.json');
  const link = path.join(root, 'seed.json');
  const folder = path.join(root, 'folder.xlsx');
  fs.writeFileSync(realTarget, 'outside');
  const linked = trySymlink(realTarget, link);
  fs.mkdirSync(folder);
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  for (const target of linked ? [link, folder] : [folder]) {
    let wrote = false;
    assert.throws(() => journal.write(target, () => { wrote = true; }), (error) => (
      error instanceof FileValidationError && error.code === 'STATEMENT_OUTPUT_TARGET_UNSAFE'
      && error.detailLines[0] === `所在目录：${root}`
    ));
    assert.equal(wrote, false);
  }
  assert.throws(() => journal.checkTarget(folder), { code: 'STATEMENT_OUTPUT_TARGET_UNSAFE' }, '读取前也可单独检查');
  assert.equal(journal.rollback().restored, true);
  assert.equal(fs.readFileSync(realTarget, 'utf8'), 'outside');
});

test('failBatch：全部还原时原错误打上标记；还原不完整时改报列出恢复清单的业务错误', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'detail.xlsx');
  fs.writeFileSync(target, 'before');
  const restoredJournal = createStatementOutputJournal({ stagingRoot: staging });
  restoredJournal.write(target, writeText(target, 'after'));
  const original = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  const restored = restoredJournal.failBatch(original);
  assert.equal(restored.error, original);
  assert.equal(isStatementOutputsRestored(original), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'before');

  const brokenFs = { ...fs, rmSync(filePath, options) {
    if (filePath === path.join(root, 'new.xlsx')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return fs.rmSync(filePath, options);
  } };
  const created = path.join(root, 'new.xlsx');
  const brokenJournal = createStatementOutputJournal({ fsImpl: brokenFs, stagingRoot: staging });
  brokenJournal.write(created, writeText(created, 'new'));
  const business = new FileValidationError('FILE_READ', '合并失败', { detailLines: ['第 2 个文件表头不一致'] });
  const { error, outcome } = brokenJournal.failBatch(business);
  assert.equal(outcome.restored, false);
  assert.equal(isStatementOutputsRestored(business), false);
  assert.ok(error instanceof FileValidationError);
  assert.equal(error.code, 'STATEMENT_OUTPUT_ROLLBACK_INCOMPLETE');
  assert.equal(error.message, `生成失败，且有 1 处输出未能自动还原，请按恢复清单逐项核对、人工处理后再重新导入（恢复清单：${outcome.manifestPath}）`);
  assert.deepEqual(error.detailLines, [
    '生成失败原因：合并失败',
    '第 2 个文件表头不一致',
    '未能自动还原 1 个文件（原有文件 0 个、本次新建 1 个；其中写出后被其他程序改动 0 个）',
    `恢复清单：${outcome.manifestPath}`
  ]);
  assert.ok(!error.detailLines.some((line) => line.includes('new.xlsx')), '错误明细不含文件路径');
  assert.match(fs.readFileSync(outcome.manifestPath, 'utf8'), /new\.xlsx\n {3}本次新建的文件（导入前不存在）\n {3}原因：系统错误 EPERM/);
});

// ---------- 第三轮审查：写出与还原的文件身份核对 ----------

test('写出期间已知文件被其他程序替换：写后文件编号与写前不同即停止，不认作本批文件，回滚不覆盖', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'detail.xlsx');
  fs.writeFileSync(target, 'before');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  assert.throws(() => journal.write(target, () => {
    fs.writeFileSync(target, 'batch');
    fs.writeFileSync(`${target}.tmp`, 'sync-client');
    fs.renameSync(`${target}.tmp`, target);
  }), { code: 'STATEMENT_OUTPUT_CHANGED_EXTERNALLY' });
  const outcome = journal.rollback();
  assert.deepEqual(outcome.failures.map((item) => item.reason), ['写出后已被其他程序修改或替换，未自动处理']);
  assert.equal(fs.readFileSync(target, 'utf8'), 'sync-client');
});

test('写出回调抛错时原有文件已被移走：不在原路径新建、不报完整还原，保留备份交给人工', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'seed.json');
  fs.writeFileSync(target, 'before');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  assert.throws(() => journal.write(target, () => {
    fs.renameSync(target, path.join(root, 'moved.json'));
    throw new Error('EBUSY');
  }));
  const outcome = journal.rollback();
  assert.equal(outcome.restored, false);
  assert.deepEqual(outcome.failures.map((item) => item.reason), ['原有文件已被其他程序移走或删除，未自动重建']);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(outcome.backupDirectory, outcome.failures[0].backupName), 'utf8'), 'before');
});

test('经硬链接别名写过的路径在回滚前被另存替换：主路径照常还原，别名列入恢复清单，不报完整还原', (t) => {
  const { root, staging } = setup(t);
  const seed = path.join(root, 'HSBC.json');
  const alias = path.join(root, 'hsbc-alias.json');
  fs.writeFileSync(seed, 'before');
  fs.linkSync(seed, alias);
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(seed, writeText(seed, 'group-1'));
  journal.write(alias, writeText(alias, 'group-2'));
  fs.writeFileSync(`${alias}.tmp`, 'sync-client');
  fs.renameSync(`${alias}.tmp`, alias);
  const outcome = journal.rollback();
  assert.equal(outcome.restored, false);
  assert.deepEqual(outcome.failures.map((item) => [path.basename(item.filePath), item.reason]),
    [['hsbc-alias.json', '写出后已被其他程序修改或替换，未自动处理']]);
  assert.equal(fs.readFileSync(seed, 'utf8'), 'before');
  assert.equal(fs.readFileSync(alias, 'utf8'), 'sync-client');
  assert.ok(fs.existsSync(path.join(outcome.backupDirectory, outcome.failures[0].backupName)), '保留备份供人工恢复');
});

test('还原时核对与写回针对同一个文件：比较之后路径被替换，不截断、不覆盖新文件', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'balance.xlsx');
  fs.writeFileSync(target, 'before');
  let swapOnWriteOpen = false;
  const fsImpl = { ...fs, openSync(filePath, flags, ...rest) {
    if (swapOnWriteOpen && flags === 'r+' && path.resolve(filePath) === target) {
      swapOnWriteOpen = false;
      fs.writeFileSync(`${target}.tmp`, 'sync-client');
      fs.renameSync(`${target}.tmp`, target);
    }
    return fs.openSync(filePath, flags, ...rest);
  } };
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  journal.write(target, writeText(target, 'batch'));
  swapOnWriteOpen = true;
  const outcome = journal.rollback();
  assert.equal(outcome.restored, false);
  assert.deepEqual(outcome.failures.map((item) => item.reason), ['写出后已被其他程序修改或替换，未自动处理']);
  assert.equal(fs.readFileSync(target, 'utf8'), 'sync-client');
});

test('文件系统不提供文件编号（ino 为 0）时按路径区分，不把同卷不同文件当成同一个', (t) => {
  const { root, staging } = setup(t);
  const zeroIno = (stat) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0n });
  const fsImpl = {
    ...fs,
    lstatSync: (...args) => { const stat = fs.lstatSync(...args); return stat && args[1] && args[1].bigint ? zeroIno(stat) : stat; },
    fstatSync: (...args) => { const stat = fs.fstatSync(...args); return args[1] && args[1].bigint ? zeroIno(stat) : stat; }
  };
  const first = path.join(root, 'a.xlsx');
  const second = path.join(root, 'b.xlsx');
  fs.writeFileSync(first, 'A-before');
  fs.writeFileSync(second, 'B-before');
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  journal.write(first, writeText(first, 'A-batch'));
  journal.write(second, writeText(second, 'B-batch'));
  const outcome = journal.rollback();
  assert.deepEqual([outcome.restored, outcome.failures], [true, []]);
  assert.deepEqual([fs.readFileSync(first, 'utf8'), fs.readFileSync(second, 'utf8')], ['A-before', 'B-before']);
});

test('ino 为 0 且卷不区分大小写时，大小写不同的两个路径按同一文件记一份备份，回滚还原批前内容（Codex 第五轮）', (t) => {
  const { root, staging } = setup(t);
  const upper = path.join(root, 'HSBC.json');
  const lower = path.join(root, 'hsbc.json');
  fs.writeFileSync(upper, 'before');
  if (!fs.existsSync(lower)) {
    t.skip('前提不满足：临时卷区分大小写');
    return;
  }
  const zeroIno = (stat) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0n });
  const fsImpl = {
    ...fs,
    lstatSync: (...args) => { const stat = fs.lstatSync(...args); return stat && args[1] && args[1].bigint ? zeroIno(stat) : stat; },
    fstatSync: (...args) => { const stat = fs.fstatSync(...args); return args[1] && args[1].bigint ? zeroIno(stat) : stat; }
  };
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  journal.write(upper, writeText(upper, 'group-1'));
  journal.write(lower, writeText(lower, 'group-2'));
  const outcome = journal.rollback();
  assert.deepEqual([outcome.restored, outcome.failures], [true, []]);
  assert.equal(fs.readFileSync(upper, 'utf8'), 'before', '还原批前内容，不是第一组写后的内容');
});

// ---------- 第四轮审查 ----------

test('主路径在回滚前被另存替换、硬链接别名仍指向原文件：经别名写回原内容，主路径列入恢复清单', (t) => {
  const { root, staging } = setup(t);
  const seed = path.join(root, 'A.json');
  const alias = path.join(root, 'B.json');
  fs.writeFileSync(seed, 'before');
  fs.linkSync(seed, alias);
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(seed, writeText(seed, 'group-1'));
  journal.write(alias, writeText(alias, 'group-2'));
  fs.writeFileSync(`${seed}.tmp`, 'sync-client');
  fs.renameSync(`${seed}.tmp`, seed);
  const outcome = journal.rollback();
  assert.deepEqual(outcome.failures.map((item) => [path.basename(item.filePath), item.reason]),
    [['A.json', '写出后已被其他程序修改或替换，未自动处理']]);
  assert.equal(fs.readFileSync(alias, 'utf8'), 'before', '经别名读到的是批前内容');
  assert.equal(fs.readFileSync(seed, 'utf8'), 'sync-client');
});

test('写回时重新打开备份失败：不截断待还原的文件', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'detail.xlsx');
  fs.writeFileSync(target, 'before');
  let backupOpens = 0;
  const fsImpl = { ...fs, openSync(filePath, flags, ...rest) {
    if (path.basename(String(filePath)).endsWith('.bak') && flags === 'r') {
      backupOpens += 1;
      if (backupOpens === 2) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    }
    return fs.openSync(filePath, flags, ...rest);
  } };
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  journal.write(target, writeText(target, 'batch-content'));
  const outcome = journal.rollback();
  assert.equal(backupOpens, 2, '前置：比较后第二次打开备份失败');
  assert.equal(outcome.restored, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'batch-content', '未被清空');
});

test('写回期间路径被另存替换：不报已还原，保留备份', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'balance.xlsx');
  fs.writeFileSync(target, 'before');
  let swap = false;
  const fsImpl = { ...fs, ftruncateSync(fd, length) {
    fs.ftruncateSync(fd, length);
    if (swap) {
      swap = false;
      fs.writeFileSync(`${target}.tmp`, 'sync-client');
      fs.renameSync(`${target}.tmp`, target);
    }
  } };
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  journal.write(target, writeText(target, 'batch'));
  swap = true;
  const outcome = journal.rollback();
  assert.equal(outcome.restored, false);
  assert.deepEqual(outcome.failures.map((item) => item.reason), ['写出后已被其他程序修改或替换，未自动处理']);
  assert.equal(fs.readFileSync(target, 'utf8'), 'sync-client');
  assert.equal(fs.readFileSync(path.join(outcome.backupDirectory, outcome.failures[0].backupName), 'utf8'), 'before');
});

test('写完后新输出已不在路径上：停止生成，不当作写成', (t) => {
  const { root, staging } = setup(t);
  const created = path.join(root, 'group-2.xlsx');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  assert.throws(() => journal.write(created, () => {
    fs.writeFileSync(created, 'batch');
    fs.renameSync(created, path.join(root, 'moved.xlsx'));
  }), { code: 'STATEMENT_OUTPUT_CHANGED_EXTERNALLY' });
  assert.equal(journal.rollback().restored, true);
});

test('写出记录：别名路径同样登记；登记失败时清掉刚做的备份', (t) => {
  const { root, staging } = setup(t);
  const seed = path.join(root, 'HSBC.json');
  const alias = path.join(root, 'hsbc-alias.json');
  fs.writeFileSync(seed, 'before');
  fs.linkSync(seed, alias);
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(seed, writeText(seed, 'group-1'));
  journal.write(alias, writeText(alias, 'group-2'));
  const [batchDir] = fs.readdirSync(staging);
  assert.match(fs.readFileSync(path.join(staging, batchDir, RECORD_FILE_NAME), 'utf8'), /同一文件的别名路径：.*hsbc-alias\.json（原内容备份：001\.bak）/);
  journal.commit();

  const other = path.join(root, 'other.xlsx');
  fs.writeFileSync(other, 'untouched');
  let failAppend = false;
  const fsImpl = { ...fs, appendFileSync(filePath, ...rest) {
    if (failAppend) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    return fs.appendFileSync(filePath, ...rest);
  } };
  const second = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  second.write(seed, writeText(seed, 'batch'));
  failAppend = true;
  assert.throws(() => second.write(other, writeText(other, 'never')), { code: 'ENOSPC' });
  failAppend = false;
  const [secondDir] = fs.readdirSync(staging);
  assert.deepEqual(fs.readdirSync(path.join(staging, secondDir)).filter((name) => name.endsWith('.bak')), ['001.bak'],
    '登记失败的文件不留备份');
  assert.equal(fs.readFileSync(other, 'utf8'), 'untouched');
  second.rollback();
});

// ---------- 第六轮审查 ----------

test('主路径截断后写回失败、硬链接别名仍指向原文件：经别名写回批前内容，不误判为被其他程序修改，报完整还原', (t) => {
  const { root, staging } = setup(t);
  const seed = path.join(root, 'A.json');
  const alias = path.join(root, 'B.json');
  fs.writeFileSync(seed, 'before');
  fs.linkSync(seed, alias);
  let restoreWrites = 0;
  const fsImpl = { ...fs, writeSync(...args) {
    restoreWrites += 1;
    if (restoreWrites === 1) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    return fs.writeSync(...args);
  } };
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  journal.write(seed, writeText(seed, 'group-1'));
  journal.write(alias, writeText(alias, 'group-2'));
  const outcome = journal.rollback();
  assert.ok(restoreWrites >= 2, '前置：主路径截断后第一次写回失败，别名重试');
  assert.deepEqual([outcome.restored, outcome.failures], [true, []]);
  assert.deepEqual([fs.readFileSync(seed, 'utf8'), fs.readFileSync(alias, 'utf8')], ['before', 'before']);
});

test('主路径打开写回失败一次、经硬链接别名写回：复核主路径已还原，不列入恢复清单', (t) => {
  const { root, staging } = setup(t);
  const seed = path.join(root, 'A.json');
  const alias = path.join(root, 'B.json');
  fs.writeFileSync(seed, 'before');
  fs.linkSync(seed, alias);
  let failedOpen = false;
  const fsImpl = { ...fs, openSync(filePath, flags, ...rest) {
    if (!failedOpen && flags === 'r+' && path.resolve(String(filePath)) === seed) {
      failedOpen = true;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return fs.openSync(filePath, flags, ...rest);
  } };
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  journal.write(seed, writeText(seed, 'group-1'));
  journal.write(alias, writeText(alias, 'group-2'));
  const outcome = journal.rollback();
  assert.equal(failedOpen, true, '前置：主路径以 r+ 打开失败');
  assert.deepEqual([outcome.restored, outcome.failures], [true, []]);
  assert.deepEqual([fs.readFileSync(seed, 'utf8'), fs.readFileSync(alias, 'utf8')], ['before', 'before']);
});

test('文件系统不提供文件编号且原有文件另有硬链接：首次改写前拒绝，不写入', (t) => {
  const { root, staging } = setup(t);
  const zeroIno = (stat) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0n });
  const fsImpl = {
    ...fs,
    lstatSync: (...args) => { const stat = fs.lstatSync(...args); return stat && args[1] && args[1].bigint ? zeroIno(stat) : stat; },
    fstatSync: (...args) => { const stat = fs.fstatSync(...args); return args[1] && args[1].bigint ? zeroIno(stat) : stat; }
  };
  const seed = path.join(root, 'A.json');
  const alias = path.join(root, 'B.json');
  fs.writeFileSync(seed, 'before');
  fs.linkSync(seed, alias);
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  let called = false;
  assert.throws(() => journal.write(seed, () => { called = true; }), (error) => (
    error instanceof FileValidationError && error.code === 'STATEMENT_OUTPUT_TARGET_UNSAFE' && /硬链接/.test(error.message)
      && !error.detailLines.some((line) => line.includes('A.json'))
  ));
  assert.equal(called, false);
  assert.throws(() => journal.checkTarget(alias), { code: 'STATEMENT_OUTPUT_TARGET_UNSAFE' }, '首次读取种子前的检查同样拒绝');
  assert.equal(fs.readFileSync(seed, 'utf8'), 'before');
});

// ---------- 第七轮审查 ----------

test('比较备份时按同一逻辑分块读满：目标短读不误判内容不同，被占用的原文件照常报完整还原', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'detail.xlsx');
  const content = Buffer.alloc(130000, 7);
  fs.writeFileSync(target, content);
  const targetFds = new Set();
  let shortReads = 0;
  const fsImpl = { ...fs,
    openSync(filePath, flags, ...rest) {
      if (path.resolve(String(filePath)) === target && flags === 'r+') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      const fd = fs.openSync(filePath, flags, ...rest);
      if (path.resolve(String(filePath)) === target) targetFds.add(fd);
      return fd;
    },
    closeSync(fd) {
      targetFds.delete(fd);
      return fs.closeSync(fd);
    },
    readSync(fd, buffer, offset, length, position) {
      if (targetFds.has(fd) && length > 65536) {
        shortReads += 1;
        return fs.readSync(fd, buffer, offset, 65536, position);
      }
      return fs.readSync(fd, buffer, offset, length, position);
    }
  };
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  assert.throws(() => journal.write(target, () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }), { code: 'EBUSY' });
  const outcome = journal.rollback();
  assert.ok(shortReads >= 1, '前置：目标文件每次最多读 64 KiB');
  assert.deepEqual([outcome.restored, outcome.failures], [true, []]);
  assert.deepEqual(fs.readFileSync(target), content);
});

test('恢复清单按原因给出处理方式：路径已被替换或已是符号链接时不提示直接覆盖', (t) => {
  const { root, staging } = setup(t);
  const replaced = path.join(root, 'replaced.xlsx');
  const linked = path.join(root, 'linked.xlsx');
  const elsewhere = path.join(root, 'elsewhere.txt');
  fs.writeFileSync(replaced, 'before-1');
  fs.writeFileSync(linked, 'before-2');
  fs.writeFileSync(elsewhere, 'unrelated');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(replaced, writeText(replaced, 'batch-1'));
  journal.write(linked, writeText(linked, 'batch-2'));
  fs.writeFileSync(`${replaced}.tmp`, 'sync-client');
  fs.renameSync(`${replaced}.tmp`, replaced);
  fs.rmSync(linked);
  if (!trySymlink(elsewhere, linked)) fs.mkdirSync(linked);
  const outcome = journal.rollback();
  t.after(() => fs.rmSync(outcome.backupDirectory, { recursive: true, force: true }));
  const manifest = fs.readFileSync(outcome.manifestPath, 'utf8');
  assert.doesNotMatch(manifest, /覆盖原路径即可还原/);
  assert.match(manifest, /replaced\.xlsx\n[^\n]*\n   原因：写出后已被其他程序修改或替换，未自动处理\n   处理方式：路径上的文件已被其他程序改动或替换，先保留现状/);
  assert.match(manifest, /linked\.xlsx\n[^\n]*\n   原因：路径上已不是普通文件，未自动处理\n   处理方式：路径上已是快捷方式（符号链接）或文件夹，不要直接覆盖或删除/);
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'unrelated', '不经链接改写别处的文件');
});

// ---------- 第八轮审查 ----------

const readFailure = () => () => { throw new FileValidationError('FILE_READ', '余额账单模板不可读，请重新确认'); };

test('写出前读取失败（FILE_READ）且文件未变：撤销本次写入登记，回滚不读取也不改写该文件', (t) => {
  const { root, staging } = setup(t);
  const balance = path.join(root, 'balance.xlsx');
  const fresh = path.join(root, 'fresh.xlsx');
  const detail = path.join(root, 'detail.xlsx');
  fs.writeFileSync(balance, 'before');
  fs.writeFileSync(detail, 'detail-before');
  let balanceReadable = true;
  const fsImpl = { ...fs, openSync(filePath, ...rest) {
    if (!balanceReadable && path.resolve(String(filePath)) === balance) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return fs.openSync(filePath, ...rest);
  } };
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  assert.throws(() => journal.write(balance, readFailure()), { code: 'FILE_READ' });
  assert.throws(() => journal.write(fresh, readFailure()), { code: 'FILE_READ' });
  journal.write(detail, writeText(detail, 'detail-after'));
  const [batchDir] = fs.readdirSync(staging);
  assert.deepEqual(fs.readdirSync(path.join(staging, batchDir)).filter((name) => name.endsWith('.bak')), ['003.bak'], '撤销登记的备份已删除，序号不复用');
  // 回滚前：原有文件被其他程序原地更新、新路径上出现其他程序的文件；回滚时该原有文件读取报 EIO
  fs.writeFileSync(balance, 'external-update');
  fs.writeFileSync(fresh, 'external-new');
  balanceReadable = false;
  const outcome = journal.rollback();
  balanceReadable = true;
  assert.deepEqual([outcome.restored, outcome.failures], [true, []]);
  assert.deepEqual([balance, fresh, detail].map((filePath) => fs.readFileSync(filePath, 'utf8')), ['external-update', 'external-new', 'detail-before']);
});

test('此前写成过的文件再次写出前读取失败：回到上次写后的状态，之后被原地更新时按写后被改动留给人工', (t) => {
  const { root, staging } = setup(t);
  const seed = path.join(root, 'HSBC.json');
  fs.writeFileSync(seed, 'before');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(seed, writeText(seed, 'record-1'));
  assert.throws(() => journal.write(seed, readFailure()), { code: 'FILE_READ' });
  fs.writeFileSync(seed, 'external-update-xx');
  const outcome = journal.rollback();
  t.after(() => fs.rmSync(outcome.backupDirectory, { recursive: true, force: true }));
  assert.equal(outcome.restored, false);
  assert.deepEqual(outcome.failures.map((item) => item.reason), ['写出后已被其他程序修改或替换，未自动处理']);
  assert.equal(fs.readFileSync(seed, 'utf8'), 'external-update-xx', '不覆盖其他程序的更新');
});

test('写出回调改动了文件后才报 FILE_READ：仍按写到一半处理并还原', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'balance.xlsx');
  fs.writeFileSync(target, 'before');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  assert.throws(() => journal.write(target, () => {
    fs.writeFileSync(target, 'partial-content');
    return readFailure()();
  }), { code: 'FILE_READ' });
  assert.equal(journal.rollback().restored, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'before');
});

test('恢复清单写不出时：写出记录说明不是失败清单、「写前不存在」不代表由本批创建，报错消息与正式清单区分', (t) => {
  const { root, staging } = setup(t);
  const first = path.join(root, 'first.xlsx');
  const second = path.join(root, 'second.xlsx');
  const fullFs = { ...fs, writeFileSync(filePath, ...rest) {
    if (path.basename(String(filePath)).startsWith(MANIFEST_FILE_NAME)) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    return fs.writeFileSync(filePath, ...rest);
  } };
  const journal = createStatementOutputJournal({ fsImpl: fullFs, stagingRoot: staging });
  journal.write(first, writeText(first, 'one'));
  assert.throws(() => journal.write(second, () => {
    fs.writeFileSync(second, 'partial');
    throw Object.assign(new Error('EIO'), { code: 'EIO' });
  }), { code: 'EIO' });
  const { error, outcome } = journal.failBatch(Object.assign(new Error('EIO'), { code: 'EIO' }));
  t.after(() => fs.rmSync(outcome.backupDirectory, { recursive: true, force: true }));
  const record = fs.readFileSync(outcome.manifestPath, 'utf8');
  assert.match(record, /本文件不是失败清单/);
  assert.match(record, /first\.xlsx\n {3}写前不存在（不代表路径上现在的文件由本批创建）/);
  assert.match(error.message, /恢复清单未能写出，请按写出记录逐个核对（记录列出本批全部写入尝试，不是失败清单）：/);
});

test('提交或全部还原后删除批次目录：短暂占用时重试，仍失败时返回目录位置留痕', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'detail.xlsx');
  fs.writeFileSync(target, 'before');
  // 模拟被扫描程序短暂占用：不重试时报 EBUSY
  const transientFs = { ...fs, rmSync(filePath, options) {
    if (!(options && options.maxRetries > 0)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return fs.rmSync(filePath, options);
  } };
  const committed = createStatementOutputJournal({ fsImpl: transientFs, stagingRoot: staging });
  committed.write(target, writeText(target, 'after'));
  assert.deepEqual(committed.commit(), { cleanupFailedDirectory: null });
  assert.deepEqual(fs.readdirSync(staging), [], '备份与写出记录已删除');
  const busyFs = { ...fs, rmSync(filePath, options) {
    if (options && options.recursive) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return fs.rmSync(filePath, options);
  } };
  for (const finish of ['commit', 'rollback']) {
    const journal = createStatementOutputJournal({ fsImpl: busyFs, stagingRoot: staging });
    journal.write(target, writeText(target, 'again'));
    const [directory] = fs.readdirSync(staging);
    const result = journal[finish]();
    assert.equal(result.cleanupFailedDirectory, path.join(staging, directory), finish);
    fs.rmSync(path.join(staging, directory), { recursive: true, force: true });
  }
});

// ---------- 第九轮审查 ----------

test('主路径写回后关闭描述符报 EIO：经别名复核内容一致，两条路径都按已还原处理', (t) => {
  const { root, staging } = setup(t);
  const seed = path.join(root, 'HSBC.json');
  const alias = path.join(root, 'hsbc-alias.json');
  fs.writeFileSync(seed, 'before');
  fs.linkSync(seed, alias);
  const writable = new Set();
  let failClose = false;
  const fsImpl = { ...fs,
    openSync(filePath, flags, ...rest) {
      const fd = fs.openSync(filePath, flags, ...rest);
      if (flags === 'r+' && path.resolve(String(filePath)) === seed) writable.add(fd);
      return fd;
    },
    closeSync(fd) {
      fs.closeSync(fd);
      if (failClose && writable.delete(fd)) {
        failClose = false;
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
    }
  };
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  journal.write(seed, writeText(seed, 'group-1'));
  journal.write(alias, writeText(alias, 'group-2'));
  failClose = true;
  const outcome = journal.rollback();
  assert.equal(failClose, false, '前置：主路径写回后关闭描述符报 EIO');
  assert.deepEqual([outcome.restored, outcome.failures], [true, []]);
  assert.deepEqual([fs.readFileSync(seed, 'utf8'), fs.readFileSync(alias, 'utf8')], ['before', 'before']);
});

test('恢复清单写到一半失败：不留下残缺的正式清单，以写出记录代替', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'detail.xlsx');
  fs.writeFileSync(target, 'before');
  const partialFs = { ...fs, writeFileSync(filePath, data, ...rest) {
    if (path.basename(String(filePath)).startsWith(MANIFEST_FILE_NAME)) {
      fs.writeFileSync(filePath, String(data).split('\n')[0], ...rest);
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    }
    return fs.writeFileSync(filePath, data, ...rest);
  } };
  const journal = createStatementOutputJournal({ fsImpl: partialFs, stagingRoot: staging });
  journal.write(target, writeText(target, 'after'));
  fs.appendFileSync(target, '-external');
  const outcome = journal.rollback();
  t.after(() => fs.rmSync(outcome.backupDirectory, { recursive: true, force: true }));
  assert.equal(outcome.manifestPath, path.join(outcome.backupDirectory, RECORD_FILE_NAME));
  assert.deepEqual(fs.readdirSync(outcome.backupDirectory).sort(), ['001.bak', RECORD_FILE_NAME].sort());
});

test('写前不存在、写出回调抛错后路径上出现的文件：清单与摘要标为归属待核对，不计入本次新建', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'new.xlsx');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  assert.throws(() => journal.write(target, () => {
    fs.writeFileSync(target, 'partial');
    throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  }), { code: 'ENOSPC' });
  const { error, outcome } = journal.failBatch(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
  t.after(() => fs.rmSync(outcome.backupDirectory, { recursive: true, force: true }));
  assert.ok(error.detailLines.includes('未能自动还原 1 个文件（原有文件 0 个、本次新建 0 个、写前不存在且归属待核对 1 个；其中写出后被其他程序改动 0 个）'),
    JSON.stringify(error.detailLines));
  const manifest = fs.readFileSync(outcome.manifestPath, 'utf8');
  assert.match(manifest, /new\.xlsx\n {3}写前不存在，路径上现在的文件归属待核对（不一定由本批创建）/);
  assert.doesNotMatch(manifest, /本次新建的文件/);
});

test('部分回滚时已还原文件的备份重试后仍未能删除：恢复清单单列，与需人工还原的文件分开', (t) => {
  const { root, staging } = setup(t);
  const restoredTarget = path.join(root, 'a.xlsx');
  const keptTarget = path.join(root, 'b.xlsx');
  fs.writeFileSync(restoredTarget, 'before-a');
  fs.writeFileSync(keptTarget, 'before-b');
  let busyBackup = null;
  let busyAttempts = 0;
  const fsImpl = { ...fs, rmSync(filePath, options) {
    // 短暂占用：第一次删除报 EBUSY，之后成功（Codex 第十二轮：须确实重试）
    if (busyBackup && path.basename(String(filePath)) === busyBackup && (busyAttempts += 1) === 1) {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    }
    if (busyBackup === 'always' && /\.bak$/.test(String(filePath))) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return fs.rmSync(filePath, options);
  } };
  for (const mode of ['001.bak', 'always']) {
    fs.writeFileSync(restoredTarget, 'before-a');
    fs.writeFileSync(keptTarget, 'before-b');
    busyBackup = mode;
    busyAttempts = 0;
    const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
    journal.write(restoredTarget, writeText(restoredTarget, 'after-a'));
    journal.write(keptTarget, writeText(keptTarget, 'after-b'));
    fs.appendFileSync(keptTarget, '-external');
    const outcome = journal.rollback();
    busyBackup = null;
    const manifest = fs.readFileSync(outcome.manifestPath, 'utf8');
    assert.deepEqual([fs.readFileSync(restoredTarget, 'utf8'), outcome.failures.map((item) => path.basename(item.filePath))], ['before-a', ['b.xlsx']]);
    if (mode === 'always') {
      assert.match(manifest, /以下备份对应的文件已自动还原，备份未能删除，不需人工还原，可直接删除：001\.bak/);
    } else {
      assert.doesNotMatch(manifest, /备份未能删除/, '短暂占用时重试后删除');
      assert.deepEqual(fs.readdirSync(outcome.backupDirectory).filter((name) => name.endsWith('.bak')), ['002.bak']);
    }
    fs.rmSync(outcome.backupDirectory, { recursive: true, force: true });
  }
});

// v3.2.22 B45（Codex 第十轮）：写前不存在、写出回调抛错、回滚时又无法检查该路径（EIO）：没有本批写成的证据，不计为「本次新建」
test('写前不存在且本批未写成、回滚时检查路径报 EIO：按归属待核对处理，不给出删除指引，保留错误码', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'new.xlsx');
  let failLstat = false;
  const fsImpl = { ...fs, lstatSync(filePath, options) {
    if (failLstat && path.resolve(String(filePath)) === target) throw Object.assign(new Error('EIO: i/o error, lstat'), { code: 'EIO' });
    return fs.lstatSync(filePath, options);
  } };
  const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
  assert.throws(() => journal.write(target, () => {
    throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  }), { code: 'ENOSPC' });
  failLstat = true;
  const { error, outcome } = journal.failBatch(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
  failLstat = false;
  t.after(() => fs.rmSync(outcome.backupDirectory, { recursive: true, force: true }));
  assert.deepEqual(outcome.failures.map((item) => [item.reason, item.createdByBatch]), [['系统错误 EIO', false]]);
  assert.ok(error.detailLines.includes('未能自动还原 1 个文件（原有文件 0 个、本次新建 0 个、写前不存在且归属待核对 1 个；其中写出后被其他程序改动 0 个）'),
    JSON.stringify(error.detailLines));
  const manifest = fs.readFileSync(outcome.manifestPath, 'utf8');
  assert.match(manifest, /归属待核对/);
  assert.doesNotMatch(manifest, /本次新建的文件|确认路径上仍是本次写出的文件后删除/);
});

// v3.2.22 B45（Codex 第十轮）：备份被删除或移走、目标仍在：不报「原有文件被移走」、不指引用不存在的备份重建
test('原有文件的备份不可用、目标仍是本批写出的内容：单独标注，不提示寻找原文件', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'detail.xlsx');
  fs.writeFileSync(target, 'before');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(target, writeText(target, 'after'));
  const backupDirectory = path.join(staging, fs.readdirSync(staging)[0]);
  fs.rmSync(path.join(backupDirectory, '001.bak'));
  const outcome = journal.rollback();
  t.after(() => fs.rmSync(outcome.backupDirectory, { recursive: true, force: true }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'after', '目标不改动');
  assert.deepEqual(outcome.failures.map((item) => item.reason), ['原内容备份已不可用（被删除、移走或大小与备份时不符），路径上仍是本批写出的内容，未自动处理']);
  const manifest = fs.readFileSync(outcome.manifestPath, 'utf8');
  assert.match(manifest, /原内容备份已不可用，无法据此还原；路径上仍是本批写出的内容/);
  assert.doesNotMatch(manifest, /移走或删除|用本目录的备份 001\.bak 覆盖/);
});

// v3.2.22 B45（Codex 第十一轮）：备份仍在但被截短：不截断目标、不报已还原，保留备份目录交给人工；回滚前核对通过后才被截短时，
//   写回前核对已打开的备份同样拦下
for (const when of ['before-rollback', 'after-check']) {
  test(`原有文件的备份被截短（${when === 'before-rollback' ? '回滚前' : '核对之后、写回之前'}）：不清空目标，不报已还原`, (t) => {
    const { root, staging } = setup(t);
    const target = path.join(root, 'seed.json');
    fs.writeFileSync(target, 'before-seed');
    let backupPath = null;
    let staleBackupStat = null;
    const fsImpl = { ...fs, lstatSync(filePath, options) {
      if (staleBackupStat && path.resolve(String(filePath)) === backupPath) return staleBackupStat;
      return fs.lstatSync(filePath, options);
    } };
    const journal = createStatementOutputJournal({ fsImpl, stagingRoot: staging });
    journal.write(target, writeText(target, 'after-seed'));
    backupPath = path.join(staging, fs.readdirSync(staging)[0], '001.bak');
    if (when === 'after-check') staleBackupStat = fs.lstatSync(backupPath, { bigint: true });
    fs.truncateSync(backupPath, 0);
    const outcome = journal.rollback();
    t.after(() => outcome.backupDirectory && fs.rmSync(outcome.backupDirectory, { recursive: true, force: true }));
    assert.equal(outcome.restored, false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'after-seed', '目标不被清空');
    assert.deepEqual(outcome.failures.map((item) => item.reason), ['原内容备份已不可用（被删除、移走或大小与备份时不符），路径上仍是本批写出的内容，未自动处理']);
    assert.equal(fs.existsSync(outcome.backupDirectory), true, '保留备份目录');
  });
}

// 备份被截短后恰好与目标内容相同（本批写成空文件、备份截为 0 字节）：比较内容一致也不报已还原（Codex 第十一轮）
test('备份被截短后与目标内容恰好相同：不按内容一致报已还原', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'seed.json');
  fs.writeFileSync(target, 'before-seed');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(target, writeText(target, ''));
  fs.truncateSync(path.join(staging, fs.readdirSync(staging)[0], '001.bak'), 0);
  const outcome = journal.rollback();
  t.after(() => outcome.backupDirectory && fs.rmSync(outcome.backupDirectory, { recursive: true, force: true }));
  assert.equal(outcome.restored, false);
  assert.deepEqual(outcome.failures.map((item) => item.reason), ['原内容备份已不可用（被删除、移走或大小与备份时不符），路径上仍是本批写出的内容，未自动处理']);
});

// v3.2.22 B45（Codex 第十二轮）：同一文件经两个硬链接写入，主路径与别名都先核对备份：备份截短后与别名上的空文件内容恰好相同，
//   也不经别名认作已还原、不撤销主路径的失败记录
test('经硬链接别名写过的文件、备份被截短：别名路径同样不认作已还原', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'seed.json');
  const alias = path.join(root, 'seed-alias.json');
  fs.writeFileSync(target, 'before-seed');
  fs.linkSync(target, alias);
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.write(target, writeText(target, 'after-seed'));
  assert.throws(() => journal.write(alias, () => {
    fs.truncateSync(alias, 0);
    throw Object.assign(new Error('EIO'), { code: 'EIO' });
  }), { code: 'EIO' });
  fs.truncateSync(path.join(staging, fs.readdirSync(staging)[0], '001.bak'), 0);
  const outcome = journal.rollback();
  t.after(() => outcome.backupDirectory && fs.rmSync(outcome.backupDirectory, { recursive: true, force: true }));
  assert.equal(outcome.restored, false);
  assert.equal(fs.existsSync(outcome.backupDirectory), true, '保留备份目录');
  assert.ok(outcome.failures.length >= 1);
  assert.ok(outcome.failures.every((item) => item.reason === '原内容备份已不可用（被删除、移走或大小与备份时不符），路径上仍是本批写出的内容，未自动处理'),
    JSON.stringify(outcome.failures));
});

// v3.2.22 B45（Codex 第十四轮）：写前不存在的路径首次写出即失败、留下半份文件：清单标「归属待核对」，界面消息只给数量与清单位置，
//   不称其为本批已写出的文件
test('首次写出即失败留下半份文件：界面消息不推断归属，只给未能还原的数量与恢复清单', (t) => {
  const { root, staging } = setup(t);
  const target = path.join(root, 'fresh.xlsx');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  assert.throws(() => journal.write(target, () => {
    fs.writeFileSync(target, 'half');
    throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  }), { code: 'ENOSPC' });
  const { error, outcome } = journal.failBatch(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
  t.after(() => outcome.backupDirectory && fs.rmSync(outcome.backupDirectory, { recursive: true, force: true }));
  assert.equal(error.code, 'STATEMENT_OUTPUT_ROLLBACK_INCOMPLETE');
  assert.equal(error.message, `生成失败，且有 1 处输出未能自动还原，请按恢复清单逐项核对、人工处理后再重新导入（恢复清单：${outcome.manifestPath}）`);
  assert.doesNotMatch(error.message, /已写出/);
  assert.match(error.detailLines.join('\n'), /本次新建 0 个、写前不存在且归属待核对 1 个/);
});
