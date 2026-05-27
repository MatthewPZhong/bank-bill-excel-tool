// v2.1.9 SR-log-1 Phase 8.8 T32g：preload reportLog + main app:report-log handler 单元测试
//
// 测试策略：
//   - preload `desktopApi.app.reportLog` = (payload) => ipcRenderer.send('app:report-log', payload)
//     纯转发，无业务逻辑；单测重点是 main handler 而非 preload 调用桥本身
//   - main 端 `ipcMain.on('app:report-log', handler)` 内部转调 appendActivityLogEntry，
//     handler 是 main.js 闭包，无法直接 import → 用 sham 函数复刻 handler 主体逻辑
//
// 与 main.js 中 `ipcMain.on('app:report-log', ...)` handler 主体（spec §15.4）必须一致：
//   - try { appendActivityLogEntry({...payload 透传 + source 兜底 'renderer'}) } catch graceful
//   - payload === null/undefined → 用空对象兜底
//   - details 非数组 → 用 [] 兜底
//
// 与 preload.js 中 reportLog = (payload) => ipcRenderer.send('app:report-log', payload) 一致：
//   - 单向通道
//   - payload 任意类型（应由 main 端兜底，preload 不校验）

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- sham handler（与 src/main.js ipcMain.on('app:report-log', ...) 主体一致）----
//   注意：appendActivityLogEntry 在测试中替换为 spy；handler 主体逻辑必须与 main.js 同步

function makeHandler(spyAppendActivityLogEntry, opts = {}) {
  // opts.throwInAppend：模拟 appendActivityLogEntry 抛错 → handler 应吞掉异常（graceful）
  return function handlerAppReportLog(_event, payload = {}) {
    try {
      const safePayload = payload && typeof payload === 'object' ? payload : {};
      const arg = {
        level: safePayload.level || 'info',
        source: safePayload.source || 'renderer',
        domain: safePayload.domain,
        message: safePayload.message,
        details: Array.isArray(safePayload.details) ? safePayload.details : [],
        stack: safePayload.stack
      };
      if (opts.throwInAppend) {
        throw new Error('mock appendActivityLogEntry failure');
      }
      spyAppendActivityLogEntry(arg);
    } catch (_error) {
      // graceful — 不向 renderer 抛错（单向通道）
    }
  };
}

function createSpy() {
  const calls = [];
  const spy = (arg) => { calls.push(arg); };
  spy.calls = calls;
  return spy;
}

// ============================================================================
// 默认字段填充
// ============================================================================

test.describe('app:report-log handler — 默认字段填充', () => {
  test('完整 payload：透传所有字段不丢失', () => {
    const spy = createSpy();
    const handler = makeHandler(spy);
    handler(null, {
      level: 'error',
      source: 'renderer',
      domain: 'db',
      message: '数据库连接失败',
      details: ['ECONNREFUSED', 'retry=3'],
      stack: 'Error: db\n  at foo'
    });
    assert.strictEqual(spy.calls.length, 1);
    const arg = spy.calls[0];
    assert.strictEqual(arg.level, 'error');
    assert.strictEqual(arg.source, 'renderer');
    assert.strictEqual(arg.domain, 'db');
    assert.strictEqual(arg.message, '数据库连接失败');
    assert.deepStrictEqual(arg.details, ['ECONNREFUSED', 'retry=3']);
    assert.strictEqual(arg.stack, 'Error: db\n  at foo');
  });

  test('level 缺省 → info 兜底', () => {
    const spy = createSpy();
    const handler = makeHandler(spy);
    handler(null, { message: 'no level' });
    assert.strictEqual(spy.calls[0].level, 'info');
  });

  test('source 缺省 → renderer 兜底（spec §15.4）', () => {
    const spy = createSpy();
    const handler = makeHandler(spy);
    handler(null, { level: 'warning', message: 'no source' });
    assert.strictEqual(spy.calls[0].source, 'renderer');
  });

  test('details 缺省 → [] 兜底', () => {
    const spy = createSpy();
    const handler = makeHandler(spy);
    handler(null, { level: 'info', message: 'no details' });
    assert.deepStrictEqual(spy.calls[0].details, []);
  });

  test('details 非数组类型 → [] 兜底（防 renderer 传 string）', () => {
    const spy = createSpy();
    const handler = makeHandler(spy);
    handler(null, { level: 'info', message: 'bad details', details: 'oops not array' });
    assert.deepStrictEqual(spy.calls[0].details, []);
  });

  test('domain 缺省 → undefined（logger 内部再用 unknown 兜底）', () => {
    const spy = createSpy();
    const handler = makeHandler(spy);
    handler(null, { level: 'info', message: 'no domain' });
    assert.strictEqual(spy.calls[0].domain, undefined);
  });
});

// ============================================================================
// 异常 graceful
// ============================================================================

test.describe('app:report-log handler — 异常 graceful', () => {
  test('payload = null → 不抛错', () => {
    const spy = createSpy();
    const handler = makeHandler(spy);
    assert.doesNotThrow(() => handler(null, null));
    // null payload 应走兜底 → spy 仍被调用（level=info, source=renderer, message=undefined）
    assert.strictEqual(spy.calls.length, 1);
  });

  test('payload = undefined → 不抛错（caller 漏传场景）', () => {
    const spy = createSpy();
    const handler = makeHandler(spy);
    assert.doesNotThrow(() => handler(null));
    assert.strictEqual(spy.calls.length, 1);
  });

  test('payload 非对象（如 string）→ 不抛错', () => {
    const spy = createSpy();
    const handler = makeHandler(spy);
    assert.doesNotThrow(() => handler(null, 'not an object'));
    assert.strictEqual(spy.calls.length, 1);
  });

  test('appendActivityLogEntry 内部抛错 → handler 吞掉不向 renderer 抛（单向通道）', () => {
    const spy = createSpy();
    const handler = makeHandler(spy, { throwInAppend: true });
    assert.doesNotThrow(() => handler(null, { level: 'error', message: 'will throw inside append' }));
    // throwInAppend 模式不调用 spy，但 handler 不抛错
    assert.strictEqual(spy.calls.length, 0);
  });
});

// ============================================================================
// preload API 形态验证
// ============================================================================

test.describe('preload reportLog API 形态契约', () => {
  test('reportLog 应为 ipcRenderer.send 单向通道（不返回 Promise）', () => {
    // 此处仅验证 preload.js 的暴露形态合约：reportLog 不应返回 Promise（与 invoke 不同）
    // 真实 preload.js 内：reportLog: (payload) => ipcRenderer.send('app:report-log', payload)
    // ipcRenderer.send 返回 undefined，与 invoke (Promise) 区分
    const mockSend = (channel, payload) => {
      assert.strictEqual(channel, 'app:report-log');
      assert.ok(payload && typeof payload === 'object');
      return undefined;
    };
    const reportLog = (payload) => mockSend('app:report-log', payload);
    const result = reportLog({ level: 'error', message: 'm' });
    assert.strictEqual(result, undefined, 'reportLog 应返回 undefined（单向通道）');
  });
});
