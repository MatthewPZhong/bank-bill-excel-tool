// v3.0.9 子任务 T4 单测 —— toolbox-large-split-dispatch（主侧 dispatch）+ 最小真 worker 冒烟。
//
// 覆盖（TechDoc §六 T4 测试要求 + §四 4.3 协议 + §七接缝契约）：
//   A. 桩 worker 协议（注入 fixture worker，验 dispatch 协议处理，不跑真 backend）：
//      - done → resolve(result)（result 原样透传；scanFields / exportFilter 两种 op）
//      - error → reject(deserializeError)：还原 name / message / detailLines（跨进程错误契约）
//      - 非零 exit → reject（worker.on('exit') 兜底）
//      - jobId 过滤：错 jobId 的 done 被忽略，只认匹配 jobId 的 done
//      - progress / log 透传（onProgress / onLog 回调）
//   B. 最小真 worker 冒烟（真 new Worker + 真 backend）：造 2 sheet 小 .xlsx（第二 sheet 重复表头模拟续页），
//      真 dispatchLargeSplit 跑 op='scanFields' → 拿到 valuesByField，证明 worker 拓扑（main→worker→T3→T1）通。
//
// 注：A 组用 __test_only_set_worker_script__ 注入桩 worker（照搬 run-check-multiworker 测试注入范式）；
//   每个 case 后还原默认 worker entry，避免污染 B 组真 worker。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const dispatchMod = require('../../../src/main-process/toolbox-large-split-dispatch');
const { dispatchLargeSplit, __test_only_set_worker_script__, DEFAULT_WORKER_ENTRY } = dispatchMod;

const FIXTURES = path.join(__dirname, '__fixtures__');
const STUB_DONE = path.join(FIXTURES, 'toolbox-split-stub-done.js');
const STUB_ERROR = path.join(FIXTURES, 'toolbox-split-stub-error.js');
const STUB_EXIT = path.join(FIXTURES, 'toolbox-split-stub-exit.js');
const STUB_WRONG_JOBID = path.join(FIXTURES, 'toolbox-split-stub-wrong-jobid.js');

// ─────────────────────────────────────────────────────────────────
// A 组：桩 worker 协议
// ─────────────────────────────────────────────────────────────────
test.describe('T4 toolbox-large-split-dispatch（桩 worker 协议）', () => {
  test.afterEach(() => {
    // 每个 case 后还原默认生产 worker entry（避免污染后续真 worker 冒烟）。
    __test_only_set_worker_script__(null);
  });

  test('A1. done → resolve(result)：scanFields result 原样透传', async () => {
    __test_only_set_worker_script__(STUB_DONE);
    const { promise } = dispatchLargeSplit({ op: 'scanFields', filePath: '/fake/x.xlsx' });
    const result = await promise;
    assert.deepEqual(result, { headers: ['A', 'B'], valuesByField: { A: ['a1', 'a2'], B: ['b1'] } },
      'scanFields 的 done result 应原样 resolve');
  });

  test('A2. done → resolve(result)：exportFilter result 原样透传 + onProgress/onLog 被调用', async () => {
    __test_only_set_worker_script__(STUB_DONE);
    const progressEvents = [];
    const logEntries = [];
    const { promise } = dispatchLargeSplit({
      op: 'exportFilter',
      filePath: '/fake/x.xlsx',
      field: 'A',
      values: ['a1'],
      savePath: '/fake/out.xlsx',
      onProgress: (p) => progressEvents.push(p),
      onLog: (e) => logEntries.push(e)
    });
    const result = await promise;
    assert.deepEqual(result, { matchedCount: 123 }, 'exportFilter 的 done result 应原样 resolve');
    assert.equal(progressEvents.length, 1, 'onProgress 应被调用一次');
    assert.deepEqual(progressEvents[0], { phase: 'scan', pct: 50 }, 'progress payload 透传');
    assert.equal(logEntries.length, 1, 'onLog 应被调用一次');
    assert.equal(logEntries[0].message, 'stub-progress', 'log entry 透传');
  });

  test('A3. error → reject(deserializeError)：还原 name / message / detailLines', async () => {
    __test_only_set_worker_script__(STUB_ERROR);
    const { promise } = dispatchLargeSplit({ op: 'scanFields', filePath: '/fake/x.xlsx' });
    await assert.rejects(promise, (err) => {
      assert.equal(err.name, 'ToolboxSharedStringsTooLargeError', 'error.name 跨进程还原');
      assert.equal(err.message, '文件文本量过大，超出处理能力', 'error.message 跨进程还原');
      assert.ok(Array.isArray(err.detailLines), 'detailLines 应还原为数组');
      assert.equal(err.detailLines.length, 2, 'detailLines 条数还原');
      assert.match(err.detailLines[0], /1\.50 GB/, 'detailLines 内容还原');
      return true;
    });
  });

  test('A4. 非零 exit → reject（worker.on(exit) 兜底，无 done/error 时）', async () => {
    __test_only_set_worker_script__(STUB_EXIT);
    const { promise } = dispatchLargeSplit({ op: 'scanFields', filePath: '/fake/x.xlsx' });
    await assert.rejects(promise, (err) => {
      assert.match(err.message, /异常退出.*code=1/, 'exit 兜底 reject 应反映非零退出码');
      return true;
    });
  });

  test('A5. jobId 过滤：错 jobId 的 done 被忽略，只认匹配 jobId 的 done', async () => {
    __test_only_set_worker_script__(STUB_WRONG_JOBID);
    const { promise } = dispatchLargeSplit({ op: 'exportFilter', filePath: '/fake/x.xlsx', field: 'A', values: ['a'] });
    const result = await promise;
    // 桩 worker 先发 matchedCount:-999（错 jobId，应忽略），再发 matchedCount:7（正确 jobId）。
    assert.deepEqual(result, { matchedCount: 7 }, '应忽略错 jobId 的 done，只 resolve 匹配 jobId 的 result');
  });

  test('A6. 默认 worker entry 指向生产 large-split-worker（注入还原后）', () => {
    __test_only_set_worker_script__(null);
    assert.match(DEFAULT_WORKER_ENTRY, /toolbox-xlsx-stream[\\/]large-split-worker\.js$/,
      'DEFAULT_WORKER_ENTRY 应解析到生产 worker 入口');
    assert.ok(fs.existsSync(DEFAULT_WORKER_ENTRY), 'worker entry 文件应真实存在');
  });
});

// ─────────────────────────────────────────────────────────────────
// B 组：最小真 worker 冒烟（真 new Worker + 真 backend T3/T1）
//   造 2 sheet 小 .xlsx（sheet2 重复 sheet1 表头 → 续页语义），真 dispatch 跑 scanFields。
// ─────────────────────────────────────────────────────────────────
test.describe('T4 toolbox-large-split-dispatch（最小真 worker 冒烟）', () => {
  let tmpdir = null;

  test.before(() => {
    __test_only_set_worker_script__(null); // 确保用生产 worker entry
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbx-split-t4-'));
  });
  test.after(() => {
    if (tmpdir) { try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) {} }
  });

  // 造一个 2 sheet xlsx：表头 [渠道, 币种, 金额]；sheet1 + sheet2（sheet2 首行重复表头 = 续页）。
  async function makeTwoSheetXlsx(filePath) {
    const wb = new ExcelJS.Workbook();
    const headers = ['渠道', '币种', '金额'];
    const ws1 = wb.addWorksheet('S1');
    ws1.addRow(headers);
    ws1.addRow(['ALIPAY', 'CNY', '100']);
    ws1.addRow(['WECHAT', 'USD', '200']);
    ws1.addRow(['ALIPAY', 'CNY', '300']); // 渠道/币种重复，验证去重
    const ws2 = wb.addWorksheet('S2');
    ws2.addRow(headers); // 重复表头（续页）→ 应被跳过，不计入数据/去重
    ws2.addRow(['UNIONPAY', 'HKD', '400']);
    ws2.addRow(['WECHAT', 'USD', '500']); // WECHAT/USD 跨 sheet 重复
    await wb.xlsx.writeFile(filePath);
  }

  test('B1. 真 worker 拓扑跑通 scanFields：拿到正确 headers + valuesByField（多 sheet 续页 + 去重）', async () => {
    const filePath = path.join(tmpdir, 'two-sheet.xlsx');
    await makeTwoSheetXlsx(filePath);

    const { promise } = dispatchLargeSplit({ op: 'scanFields', filePath });
    const result = await promise;

    assert.ok(result && typeof result === 'object', 'scanFields 应返回对象');
    assert.deepEqual(result.headers, ['渠道', '币种', '金额'], 'headers 应为逻辑表头');
    assert.ok(result.valuesByField && typeof result.valuesByField === 'object', 'valuesByField 应为对象');

    // 渠道：ALIPAY / WECHAT / UNIONPAY（首现序、去重；sheet2 重复表头不计入）。
    assert.deepEqual(result.valuesByField['渠道'], ['ALIPAY', 'WECHAT', 'UNIONPAY'],
      '渠道列去重值（跨 sheet 合并 + 首现序）');
    // 币种：CNY / USD / HKD。
    assert.deepEqual(result.valuesByField['币种'], ['CNY', 'USD', 'HKD'], '币种列去重值');

    // 🚩 前端零改动契约：valuesByField 仅 {field:string[]}，不含 truncated / distinctSeen 元数据。
    for (const key of Object.keys(result.valuesByField)) {
      assert.ok(Array.isArray(result.valuesByField[key]), `valuesByField[${key}] 必须是 string[]`);
    }
    assert.deepEqual(Object.keys(result).sort(), ['headers', 'valuesByField'],
      'scanFields result 仅含 headers / valuesByField（无额外元数据字段）');
  });

  test('B2. 真 worker 拓扑跑通 exportFilter：按字段值过滤写出 + matchedCount 正确', async () => {
    const srcPath = path.join(tmpdir, 'two-sheet-src.xlsx');
    await makeTwoSheetXlsx(srcPath);
    const outPath = path.join(tmpdir, 'two-sheet-out.xlsx');

    // 按「渠道 ∈ {WECHAT}」过滤：sheet1 一行（WECHAT/USD/200）+ sheet2 一行（WECHAT/USD/500）= 2 行。
    const { promise } = dispatchLargeSplit({
      op: 'exportFilter',
      filePath: srcPath,
      field: '渠道',
      values: ['WECHAT'],
      savePath: outPath
    });
    const result = await promise;

    assert.deepEqual(Object.keys(result), ['matchedCount'], 'exportFilter result 仅含 matchedCount');
    assert.equal(result.matchedCount, 2, 'WECHAT 命中 2 行（跨 sheet）');
    assert.ok(fs.existsSync(outPath), '应写出过滤后的 xlsx');

    // readback 校验产物（小文件直接 ExcelJS 读）。
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];
    // 表头 1 行 + 命中 2 行 = 3 行。
    assert.equal(ws.rowCount, 3, '产物应有表头 + 2 命中行');
  });
});
