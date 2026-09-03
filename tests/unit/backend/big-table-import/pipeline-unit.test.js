'use strict';
// 大表导入引擎 pipeline 单元测试（v3.0.3 块 D · PR-G2）🔴 资金红线（按文件序单写 = rowid 顺序契约）
//
// 覆盖：
//   - 文件序单写：3 文件乱序完成（人为让文件 2 最慢）→ 断言 writeBatch 调用顺序仍 0→1→2
//   - 内存闸 / maxParallel 边界（mock os.freemem / cpus）
//   - cancel：cancel() → CancelError + worker terminate
//
// ⚠️ 文件序单写测试不依赖真实 xlsx 解析——用一个「假解析子 worker 脚本」（参数化 sleep 制造乱序完成），
//   验证 pipeline 调度层的「乱序完成 → 按 index 顺序 drainWrites」契约本身（与解析正确性正交）。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pipeline = require('../../../../src/backend/big-table-import/pipeline');

// ─────────────────────────────────────────────────────────────────
// computeMaxParallel 边界（纯函数，mock freemem / cpus）
// ─────────────────────────────────────────────────────────────────
test.describe('pipeline.computeMaxParallel 边界', () => {
  test('默认 min(4, cpus-2)，下限 1', () => {
    assert.equal(pipeline.computeMaxParallel({ fileCount: 100, freemem: 8e9, cpuCount: 14 }), 4, '14 核 → min(4,12)=4');
    assert.equal(pipeline.computeMaxParallel({ fileCount: 100, freemem: 8e9, cpuCount: 4 }), 2, '4 核 → min(4,2)=2');
    assert.equal(pipeline.computeMaxParallel({ fileCount: 100, freemem: 8e9, cpuCount: 2 }), 1, '2 核 → min(4,0) clamp 1');
    assert.equal(pipeline.computeMaxParallel({ fileCount: 100, freemem: 8e9, cpuCount: 1 }), 1, '1 核 → clamp 1');
  });

  test('requested 显式覆盖默认', () => {
    assert.equal(pipeline.computeMaxParallel({ requested: 4, fileCount: 100, freemem: 8e9, cpuCount: 14 }), 4);
    assert.equal(pipeline.computeMaxParallel({ requested: 1, fileCount: 100, freemem: 8e9, cpuCount: 14 }), 1);
  });

  test('不超过文件数', () => {
    assert.equal(pipeline.computeMaxParallel({ requested: 4, fileCount: 2, freemem: 8e9, cpuCount: 14 }), 2, '4 worker 但只 2 文件 → 2');
  });

  test('内存闸：freemem < 2GB → 降 1（最低 1），写日志', () => {
    const logs = [];
    const p = pipeline.computeMaxParallel({
      requested: 4, fileCount: 100, freemem: 1e9 /* <2GB */, cpuCount: 14,
      onLog: (e) => logs.push(e)
    });
    assert.equal(p, 3, '内存闸降 1：4 → 3');
    assert.equal(logs.length, 1, '写一条降级日志');
    assert.match(logs[0].message, /并行度降级/, '日志含降级说明');
    assert.equal(logs[0].level, 'warning');
  });

  test('内存闸：已是 1 时不再降（最低 1）', () => {
    const p = pipeline.computeMaxParallel({ requested: 1, fileCount: 100, freemem: 1e9, cpuCount: 14 });
    assert.equal(p, 1, '已 1 时内存闸不触发降级');
  });
});

// ─────────────────────────────────────────────────────────────────
// 文件序单写：用「假解析子 worker」制造乱序完成
// ─────────────────────────────────────────────────────────────────
//
// 假 worker 脚本：收 parse 消息 → 按 fileIndex 取 sleepMap[fileIndex] 毫秒后回 parsed。
//   pipeline.runPipeline 用 path.join(__dirname, 'import-worker.js') 固定真实 worker——
//   故本测试改用「直接驱动 runPipeline + monkeypatch WORKER_SCRIPT_PATH」不可行（const 导出）。
//   改为：构造一个临时 worker 脚本 + 临时复制 pipeline 模块？过重。
//   采用更轻方案：直接单元测「drainWrites 顺序契约」——通过真实 import-worker 跑极小 fixture，
//   但人为让中间文件「行数最多 → 解析最慢」制造完成乱序，断言 writeBatch index 单调递增。
//   （真实 worker 拓扑，沿用 _fixtures 造 xlsx。）

const fx = require('./_fixtures');
const { validateContract } = require('../../../../src/backend/big-table-import/contract');

// 写一个可被 worker require 的临时测试契约模块（≡ 集成脚本契约形态）。
function writeTestContractModule(dir) {
  const p = path.join(dir, 'pipeline-test-contract.js');
  fs.writeFileSync(p, `'use strict';
module.exports = {
  expectedHeaders: ['日期', '主键', '金额'],
  valueColumnWhitelist: null,
  validateHeaders(cells) {
    const ok = cells[0] === '日期' && cells[1] === '主键' && cells[2] === '金额';
    return ok ? { ok: true } : { ok: false, error: '表头不匹配', detailLines: [] };
  },
  mapRow({ values }) {
    const key = String(values[1] || '').trim();
    if (!key) return { error: { reason: '主键为空' } };
    return { params: [values[0], key, values[2]] };
  },
  insertSql: 'INSERT INTO t (d, k, a) VALUES (?, ?, ?)',
  requiredColumns: [0, 1, 2],
  monthKeyOf({ values }) {
    const m = String(values[0] || '').match(/^(\\d{4})[-/](\\d{1,2})/);
    return m ? m[1] + '-' + String(m[2]).padStart(2, '0') : null;
  }
};
`, 'utf8');
  return p;
}

test.describe('pipeline 按文件序单写（真实 worker 拓扑，乱序完成）', () => {
  test.after(() => fx.cleanupTmpDirs());

  test('文件 1（中间）行数最多解析最慢 → writeBatch 仍按 index 0→1→2 顺序', async () => {
    const dir = fx.mkTmpDir('btie-pl-');
    const contractModulePath = writeTestContractModule(dir);

    // 3 文件：文件 0 / 2 各 5 行，文件 1（中间）2000 行（解析显著慢 → 大概率最后完成）。
    const mkRows = (prefix, n) => {
      const rows = [['日期', '主键', '金额']];
      for (let i = 0; i < n; i++) rows.push(['2026-03-01', `${prefix}-${i}`, '10']);
      return rows;
    };
    const files = [
      await fx.writeFixtureExcelJS({ rows: mkRows('F0', 5) }),
      await fx.writeFixtureExcelJS({ rows: mkRows('F1', 2000) }),
      await fx.writeFixtureExcelJS({ rows: mkRows('F2', 5) })
    ];

    const writeOrder = [];
    const importedPerFile = [];
    const controller = pipeline.runPipeline({
      files,
      contractModulePath,
      contractOptions: {},
      useWhitelist: false,
      parallel: 4,   // 全部并行解析 → 完成顺序乱（文件 1 慢）
      writeBatch: (fileIndex, parsed) => {
        writeOrder.push(fileIndex);
        importedPerFile.push(parsed.importedCount);
      }
    });
    const result = await controller.promise;

    // 🔴 核心断言：写入顺序严格 0→1→2（即便文件 1 最后解析完）。
    assert.deepEqual(writeOrder, [0, 1, 2], 'writeBatch 调用顺序严格按文件 index（rowid 顺序契约）');
    assert.deepEqual(importedPerFile, [5, 2000, 5], '各文件行数正确');
    assert.equal(result.totalImported, 2010, 'totalImported 累计');
  });

  test('admission 已冻结的 parallel 不再触发 engine 内第二次内存降级', async () => {
    const dir = fx.mkTmpDir('btie-pl-frozen-');
    const contractModulePath = writeTestContractModule(dir);
    const files = [
      await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'F0', '10']] }),
      await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'F1', '20']] })
    ];
    const originalFreemem = os.freemem;
    os.freemem = () => 1024 * 1024 * 1024;
    try {
      const controller = pipeline.runPipeline({
        files,
        contractModulePath,
        contractOptions: {},
        useWhitelist: false,
        parallel: 2,
        parallelFrozen: true,
        writeBatch: () => {}
      });
      const result = await controller.promise;
      assert.equal(result.maxParallel, 2, '获批 2 个 Parser children 后不在 engine 内再降为 1');
    } finally {
      os.freemem = originalFreemem;
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// cancel：cancel() → CancelError
// ─────────────────────────────────────────────────────────────────
test.describe('pipeline.cancel', () => {
  test.after(() => fx.cleanupTmpDirs());

  test('cancel() → promise reject CancelError', async () => {
    const dir = fx.mkTmpDir('btie-pl-cancel-');
    const contractModulePath = writeTestContractModule(dir);
    // 一个大文件（解析需时间），启动后立即 cancel。
    const rows = [['日期', '主键', '金额']];
    for (let i = 0; i < 5000; i++) rows.push(['2026-03-01', `K${i}`, '10']);
    const files = [await fx.writeFixtureExcelJS({ rows })];

    const controller = pipeline.runPipeline({
      files,
      contractModulePath,
      contractOptions: {},
      useWhitelist: false,
      parallel: 1,
      writeBatch: () => {}
    });
    controller.cancel();   // 立即取消

    let err = null;
    try {
      await controller.promise;
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'cancel 后 promise 应 reject');
    assert.equal(err.name, 'CancelError', '错误为 CancelError');
  });
});
