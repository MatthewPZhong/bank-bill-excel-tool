// v3.0.9 子任务 T4 单测 —— large-split-worker 的 sharedStrings 护栏（§三② / TechDoc §六 T4 红线）。
//
// 覆盖：
//   - assertSharedStringsUnderLimit：sharedStrings 解压尺寸 ≥ 阈值 → 抛 ToolboxSharedStringsTooLargeError
//     （依赖注入 mock 的 collectEntrySizes 返回超阈值 Map）；
//   - 恰好低于阈值 / 缺 sharedStrings entry / collectEntrySizes 抛异常（fail-open）→ 不抛（放行）；
//   - 错误对象契约：name 固定 ToolboxSharedStringsTooLargeError、message「文件文本量过大，超出处理能力」、
//     detailLines 非空（供上层归一 failed）。
//
// 注：在主线程 require worker 文件（isMainThread=true → worker 块不执行），仅取其顶层导出的纯函数 /
//   错误类 / 阈值常量（这正是把护栏逻辑提到模块顶层的目的：可被主线程单测 mock 验证）。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../../../../src/backend/toolbox-xlsx-stream/large-split-worker');
const {
  assertSharedStringsUnderLimit,
  isExplainedError,
  SHARED_STRINGS_UNCOMPRESSED_LIMIT,
  SHARED_STRINGS_ENTRY,
  ToolboxSharedStringsTooLargeError,
  ToolboxWorkerMemoryLimitError
} = worker;

// 构造一个 mock collectEntrySizes，返回带指定 sharedStrings 尺寸的 Map。
function mockSizes(sstSize, extra = {}) {
  return async () => {
    const m = new Map();
    if (sstSize !== undefined) m.set(SHARED_STRINGS_ENTRY, sstSize);
    m.set('xl/worksheets/sheet1.xml', extra.sheet1 != null ? extra.sheet1 : 1000);
    return m;
  };
}

test.describe('T4 large-split-worker · sharedStrings 护栏', () => {
  test('阈值常量为 ~1.2GB（1288490188）', () => {
    assert.equal(SHARED_STRINGS_UNCOMPRESSED_LIMIT, 1288490188, 'SHARED_STRINGS_UNCOMPRESSED_LIMIT = 1.2GB');
  });

  test('sharedStrings ≥ 阈值 → 抛 ToolboxSharedStringsTooLargeError（name/message/detailLines 契约）', async () => {
    const collectEntrySizes = mockSizes(SHARED_STRINGS_UNCOMPRESSED_LIMIT); // 恰好等于阈值（≥ 触发）
    await assert.rejects(
      assertSharedStringsUnderLimit('/fake/big.xlsx', { collectEntrySizes }),
      (err) => {
        assert.ok(err instanceof ToolboxSharedStringsTooLargeError, '应为 ToolboxSharedStringsTooLargeError 实例');
        assert.equal(err.name, 'ToolboxSharedStringsTooLargeError', 'name 固定（上层按 name 归一）');
        assert.equal(err.message, '文件文本量过大，超出处理能力', 'message 为可解释文案');
        assert.ok(Array.isArray(err.detailLines) && err.detailLines.length > 0, 'detailLines 非空');
        return true;
      }
    );
  });

  test('sharedStrings 远超阈值（2GB）→ 抛错', async () => {
    const collectEntrySizes = mockSizes(2 * 1024 * 1024 * 1024);
    await assert.rejects(
      assertSharedStringsUnderLimit('/fake/huge.xlsx', { collectEntrySizes }),
      ToolboxSharedStringsTooLargeError
    );
  });

  test('sharedStrings 恰好低于阈值 → 不抛（放行）', async () => {
    const collectEntrySizes = mockSizes(SHARED_STRINGS_UNCOMPRESSED_LIMIT - 1);
    await assert.doesNotReject(
      assertSharedStringsUnderLimit('/fake/ok.xlsx', { collectEntrySizes }),
      'sharedStrings < 阈值应放行'
    );
  });

  test('无 sharedStrings entry（纯 inlineStr）→ 不抛（放行）', async () => {
    const collectEntrySizes = mockSizes(undefined); // 不放 sharedStrings 进 Map
    await assert.doesNotReject(
      assertSharedStringsUnderLimit('/fake/inline.xlsx', { collectEntrySizes }),
      '缺 sharedStrings entry 应放行（get 返回 undefined）'
    );
  });

  test('collectEntrySizes 抛异常 → fail-open 放行（护栏不引入新误伤面）', async () => {
    const collectEntrySizes = async () => { throw new Error('zip 打不开'); };
    await assert.doesNotReject(
      assertSharedStringsUnderLimit('/fake/corrupt.xlsx', { collectEntrySizes }),
      'collectEntrySizes 异常应 fail-open 放行（让下游按原方式报原错）'
    );
  });

  test('collectEntrySizes 返回非 Map（异常形态）→ 不抛（放行）', async () => {
    const collectEntrySizes = async () => null;
    await assert.doesNotReject(
      assertSharedStringsUnderLimit('/fake/weird.xlsx', { collectEntrySizes }),
      '非 Map 返回应放行'
    );
  });
});

test.describe('T4 large-split-worker · 错误类 / 工具函数契约', () => {
  test('ToolboxWorkerMemoryLimitError：name 固定 + message 可解释 + detailLines 非空', () => {
    const err = new ToolboxWorkerMemoryLimitError(3.5 * 1024 * 1024 * 1024);
    assert.equal(err.name, 'ToolboxWorkerMemoryLimitError', 'name 固定');
    assert.equal(err.message, '文件数据量过大，超出处理能力', 'message 可解释');
    assert.ok(Array.isArray(err.detailLines) && err.detailLines.length > 0, 'detailLines 非空');
    assert.match(err.detailLines[0], /3\.50 GB/, 'detailLines 含内存占用估值');
  });

  test('isExplainedError：带 detailLines 的错误视为可解释（不被 heap 兜底覆盖）', () => {
    assert.equal(isExplainedError(new ToolboxSharedStringsTooLargeError(1.5 * 1024 ** 3)), true,
      '护栏错误是可解释错误');
    assert.equal(isExplainedError(new Error('普通错误')), false, '无 detailLines 的普通错误不算可解释');
    assert.equal(isExplainedError(null), false, 'null 不算可解释');
    assert.equal(isExplainedError({}), false, '无 detailLines 的对象不算可解释');
  });

  test('worker 入口在主线程 require 时不挂监听（仅导出元信息）', () => {
    assert.equal(typeof worker.__workerScriptPath, 'string', '导出 worker 脚本路径');
    assert.match(worker.__workerScriptPath, /large-split-worker\.js$/, '__workerScriptPath 指向自身');
  });
});
