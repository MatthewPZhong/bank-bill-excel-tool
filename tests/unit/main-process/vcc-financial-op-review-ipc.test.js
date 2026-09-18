'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const XLSX = require('xlsx');
const { createReviewFixture } = require('../../helpers/vcc-review-export');
const { createVccFinancialOpService } = require('../../../src/main-process/vcc-financial-op-service');
const { createReviewExportHandler } = require('../../../src/main-process/vcc-financial-op-review-ipc');

function setup(f, overrides = {}) {
  const output = path.join(f.dir, 'out', '结果.xlsx'); fs.mkdirSync(path.dirname(output));
  const service = createVccFinancialOpService({ database: { db: f.db, dbPath: f.dbPath }, assetsDir: f.assetsDir,
    appVersion: '3.2.9', archiveServiceProvider: () => ({ rootDir: f.archiveRoot }), ...overrides });
  const state = { options: null, progress: [], onProgress: null, choose: null };
  const handler = createReviewExportHandler({ getService: () => service, getWindow: () => null,
    documentsPath: path.dirname(output), tempRoot: path.join(f.dir, 'tasks'), protectedRoots: [f.archiveRoot],
    dialog: { async showSaveDialog(_window, options) { state.options = options;
      assert.equal(service._taskStateForTests().active, false, '另存为期间不占用任务');
      return state.choose ? state.choose() : { filePath: output, canceled: false }; } } });
  const event = { sender: { isDestroyed: () => false, send(_channel, progress) {
    state.progress.push(progress); state.onProgress?.(progress);
  } } };
  return { service, state, output, handler: (request = f.request) => handler(event, request) };
}
function forbidDml(db) {
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER test_no_write_${name}_${op} BEFORE ${op} ON ${name} BEGIN SELECT RAISE(ABORT, 'export attempted business DML'); END`);
  }
}

test('IPC handler → Service → 两阶段真实 Worker → 原子保存；无业务 DML、不创建正式批次', async (t) => {
  const f = await createReviewFixture(t); const s = setup(f); forbidDml(f.db);
  const old = Buffer.from('original target'); fs.writeFileSync(s.output, old);
  const response = await s.handler();
  assert.equal(response.status, 'success', JSON.stringify(response)); assert.equal(response.subjectCount, 2);
  assert.equal(response.sheetCount, 15); assert.equal(response.filePath, fs.realpathSync(s.output));
  assert.equal(path.basename(s.state.options.defaultPath), '2026-06_VCC财务OP校验待确认表.xlsx');
  assert.ok(s.state.options.properties.includes('showOverwriteConfirmation'));
  assert.deepEqual([...new Set(s.state.progress.map((p) => p.phase))], ['preparing-result','extracting-sources','writing','validating','publishing']);
  assert.equal(s.state.progress.at(-1).cancellable, false);
  assert.deepEqual(fs.readdirSync(path.dirname(s.output)), ['结果.xlsx']);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'tasks')), []);
  assert.equal(s.service._taskStateForTests().active, false);
  assert.equal(f.db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id=?').get(f.run.id).status, 'calculated');
});

test('主体与系统 OP 显示值按导入合同核验，真实 IPC 导出保留原始值和格式', async (t) => {
  for (const item of [
    { name: '数值主体的前导零', subjects: ['000123'], formattedSubject: true },
    { name: 'CNH 与 CNY 是两个独立主体', subjects: ['CNH', 'CNY'] },
    { name: '部门和币种使用显示值', subjects: ['甲'], formattedCoordinates: true }
  ]) await t.test(item.name, async (t) => {
    const f = await createReviewFixture(t, { subjects: item.subjects, beforeImport(filePath) {
      const book = XLSX.readFile(filePath), sheet = book.Sheets['系统 OP'];
      for (let row = 2; row <= item.subjects.length * 9 + 1; row++) {
        if (item.formattedSubject) sheet['B' + row] = { t: 'n', v: 123, z: '000000' };
        if (item.formattedCoordinates) {
          sheet['C' + row] = { t: 'n', v: 1, z: '"VCC"' };
          sheet['D' + row] = { t: 'n', v: 1, z: '"' + sheet['D' + row].v + '"' };
        }
      }
      XLSX.writeFile(book, filePath);
    } });
    assert.ok(f.imported.records.every((record) => record.status === 'success'));
    const snapshots = f.db.prepare('SELECT * FROM vcc_fin_op_system_snapshots').all();
    const before = f.db.prepare('SELECT total_changes() n').get().n;
    const s = setup(f); forbidDml(f.db);
    try {
      const result = await s.handler(); assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(result.subjectCount, item.subjects.length); assert.equal(result.sourceRowCount, 7 * item.subjects.length);
      const book = XLSX.readFile(s.output, { cellNF: true });
      assert.deepEqual(item.subjects.map((_subject, index) => book.Sheets['待确认表']['A' + (index * 11 + 1)].v), item.subjects);
      const pages = book.SheetNames.slice(1).map((name) => book.Sheets[name]).filter((sheet) => sheet.E1?.v === 'OP发生额');
      assert.equal(pages.length, 2 * item.subjects.length);
      for (const page of pages) {
        if (item.formattedSubject) assert.deepEqual([page.B2.t, page.B2.v, page.B2.z, page.B2.w], ['n', 123, '000000', '000123']);
        else assert.ok(item.subjects.includes(page.B2.v));
        if (item.formattedCoordinates) {
          assert.deepEqual([page.C2.t, page.C2.v, page.C2.w], ['n', 1, 'VCC']);
          assert.equal(page.D2.t, 'n'); assert.equal(page.D2.v, 1); assert.ok(['EUR', 'USD'].includes(page.D2.w));
        }
      }
      assert.deepEqual(f.db.prepare('SELECT * FROM vcc_fin_op_system_snapshots').all(), snapshots);
      assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
      assert.equal(f.db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id=?').get(f.run.id).status, 'calculated');
    } finally { await s.service.terminate(); }
  });
});

test('格式化主体可导出仍须核对原始数值，错误审计不能替换既有目标', async (t) => {
  const f = await createReviewFixture(t, { subjects: ['000123'], beforeImport(filePath) {
    const book = XLSX.readFile(filePath);
    for (let row = 2; row <= 10; row++) book.Sheets['系统 OP']['B' + row] = { t: 'n', v: 123, z: '000000' };
    XLSX.writeFile(book, filePath);
  } });
  const snapshot = f.db.prepare('SELECT * FROM vcc_fin_op_system_snapshots').get();
  const audit = JSON.parse(snapshot.raw_json); audit.rows[0].rawValues[1] = 999;
  f.db.prepare('UPDATE vcc_fin_op_system_snapshots SET raw_json=? WHERE id=?').run(JSON.stringify(audit), snapshot.id);
  const s = setup(f); forbidDml(f.db); fs.writeFileSync(s.output, 'previous target');
  try {
    const result = await s.handler(); assert.equal(result.code, 'vcc-review-validation-failed');
    assert.match(result.message, /原始列 2 不符/);
    assert.equal(fs.readFileSync(s.output, 'utf8'), 'previous target');
  } finally { await s.service.terminate(); }
});

test('取消另存为不启动 Worker；保存期间修改结果会拦截旧 revision', async (t) => {
  const f = await createReviewFixture(t); let workers = 0;
  const s = setup(f, { reviewWorkerFactory(...args) { workers++; return new Worker(...args); } });
  s.state.choose = () => ({ canceled: true }); assert.deepEqual(await s.handler(), { status: 'cancelled' }); assert.equal(workers, 0);
  s.state.choose = () => {
    f.db.prepare('UPDATE vcc_fin_op_runs SET result_revision=result_revision+1 WHERE id=?').run(f.run.id);
    return { filePath: s.output };
  };
  assert.equal((await s.handler()).code, 'result-revision-changed'); assert.equal(workers, 0);
  assert.equal(fs.existsSync(s.output), false);
});

test('Worker 后结果过期或目标发生变化，不替换目标', async (t) => {
  for (const mode of ['revision', 'input', 'target']) {
    const f = await createReviewFixture(t); const s = setup(f); fs.writeFileSync(s.output, 'old'); let changed = false;
    s.state.onProgress = (p) => {
      if (changed || p.phase !== 'writing') return; changed = true;
      if (mode === 'revision') f.db.prepare('UPDATE vcc_fin_op_runs SET result_revision=result_revision+1 WHERE id=?').run(f.run.id);
      else if (mode === 'input') f.db.prepare("UPDATE vcc_fin_op_datasets SET revision=revision+1 WHERE target_month='2026-06'").run();
      else fs.writeFileSync(s.output, 'third-party edit');
    };
    const response = await s.handler();
    assert.equal(response.status, 'error');
    assert.equal(response.code, { revision: 'result-revision-changed', input: 'state-changed', target: 'vcc-review-target-changed' }[mode]);
    assert.equal(fs.readFileSync(s.output, 'utf8'), mode === 'target' ? 'third-party edit' : 'old');
    assert.deepEqual(fs.readdirSync(path.dirname(s.output)), ['结果.xlsx']);
  }
});

test('取消、强制退出及服务关闭均等待 Worker 退出和清理，不执行导入恢复', async (t) => {
  for (const force of [false, true]) {
    const f = await createReviewFixture(t);
    const s = setup(f, force ? { cancelTimeoutMs: 5, reviewWorkerFactory() {
      return new Worker("require('node:worker_threads').parentPort.on('message', () => {});", { eval: true });
    } } : {});
    forbidDml(f.db); let cancellation;
    s.state.onProgress = (p) => {
      if (!cancellation && p.phase === 'preparing-result') cancellation = new Promise((resolve, reject) => setImmediate(() => {
        s.service.cancelActiveTask(() => { throw new Error('must not call archive lifecycle'); }).then(resolve, reject);
      }));
    };
    assert.equal((await s.handler()).status, 'cancelled');
    assert.equal((await cancellation).status, 'cancelled');
    assert.equal(s.service._taskStateForTests().active, false);
    assert.equal(fs.existsSync(s.output), false);
    assert.deepEqual(fs.readdirSync(path.join(f.dir, 'tasks')), []);
  }
});

test('拒绝原始输入、受管目录和任意 renderer 输出路径', async (t) => {
  const f = await createReviewFixture(t); const s = setup(f);
  assert.equal((await s.handler({ ...f.request, outputPath: s.output })).code, 'vcc-review-request-invalid');
  for (const filePath of [f.filePath, path.join(f.archiveRoot, '不能覆盖.xlsx')]) {
    s.state.choose = () => ({ filePath });
    assert.equal((await s.handler()).code, 'vcc-review-target-protected');
  }
});

test('取消后的清理失败必须显示错误与残留路径，不能返回已取消掩盖残留文件', async (t) => {
  const f = await createReviewFixture(t);
  const s = setup(f, { cancelTimeoutMs: 5, reviewWorkerFactory() {
    return new Worker("require('node:worker_threads').parentPort.on('message', () => {});", { eval: true });
  } });
  forbidDml(f.db);
  const remove = fs.rmSync;
  const mockedRemove = t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.dirname(target) === path.join(f.dir, 'tasks')) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
    return remove(target, options);
  });
  let cancellation;
  s.state.onProgress = (p) => {
    if (p.phase === 'preparing-result') cancellation = new Promise((resolve, reject) => setImmediate(() => {
      s.service.cancelActiveTask().then(resolve, reject);
    }));
  };
  const response = await s.handler();
  assert.equal(response.status, 'error'); assert.equal(response.code, 'vcc-review-cleanup-failed');
  assert.equal((await cancellation).code, 'vcc-review-cleanup-failed');
  assert.equal(response.recoveryPaths.length, 1); assert.ok(fs.existsSync(response.recoveryPaths[0]));
  assert.ok(response.detailLines.some((line) => line.includes('injected EACCES')));
  assert.equal(s.service._taskStateForTests().active, false); assert.equal(fs.existsSync(s.output), false);
  mockedRemove.mock.restore(); remove(response.recoveryPaths[0], { recursive: true, force: true });
});
