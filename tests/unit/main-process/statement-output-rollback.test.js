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
    if (path.basename(String(filePath)) === MANIFEST_FILE_NAME) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    return fs.writeFileSync(filePath, ...rest);
  } };
  const journal = createStatementOutputJournal({ fsImpl: fullFs, stagingRoot: staging });
  journal.write(replaced, writeText(replaced, 'batch'));
  fs.writeFileSync(`${replaced}.tmp`, 'external');
  fs.renameSync(`${replaced}.tmp`, replaced);
  const outcome = journal.rollback();
  assert.equal(outcome.manifestPath, path.join(outcome.backupDirectory, RECORD_FILE_NAME));
  assert.match(fs.readFileSync(outcome.manifestPath, 'utf8'), /1\. .*replaced\.xlsx\n {3}原有文件，原内容备份：001\.bak/);
  assert.equal(fs.readFileSync(path.join(outcome.backupDirectory, '001.bak'), 'utf8'), 'before');
});

test('路径上是符号链接或文件夹时在写出前拒绝，不跟随链接写入', (t) => {
  const { root, staging } = setup(t);
  const realTarget = path.join(root, 'elsewhere.json');
  const link = path.join(root, 'seed.json');
  const folder = path.join(root, 'folder.xlsx');
  fs.writeFileSync(realTarget, 'outside');
  fs.symlinkSync(realTarget, link);
  fs.mkdirSync(folder);
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  for (const target of [link, folder]) {
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
  assert.equal(error.message, `生成失败，且有 1 个已写出的文件未能自动还原，请按恢复清单人工处理后再重新导入（恢复清单：${outcome.manifestPath}）`);
  assert.deepEqual(error.detailLines, [
    '生成失败原因：合并失败',
    '第 2 个文件表头不一致',
    '未能自动还原 1 个文件（原有文件 0 个、本次新建 1 个；其中写出后被其他程序改动 0 个）',
    `恢复清单：${outcome.manifestPath}`
  ]);
  assert.ok(!error.detailLines.some((line) => line.includes('new.xlsx')), '错误明细不含文件路径');
  assert.match(fs.readFileSync(outcome.manifestPath, 'utf8'), /new\.xlsx\n {3}本次新建的文件（导入前不存在）\n {3}原因：系统错误 EPERM/);
});
