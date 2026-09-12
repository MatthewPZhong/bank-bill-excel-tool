const test = require('node:test');
const assert = require('node:assert/strict');
const { createController, mountSettings } = require('../../src/renderer-dark-mode');
const { DEFAULT_DARK_MODE_SCHEDULE } = require('../../src/shared/dark-mode-schedule');

const enabled = { ...DEFAULT_DARK_MODE_SCHEDULE, enabled: true };
const makeSnapshot = (revision, theme = 'light', config = DEFAULT_DARK_MODE_SCHEDULE) => ({
  darkModeSchedule: { ...config }, effectiveTheme: theme, themeRevision: revision
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

function harness() {
  const order = [];
  let listener;
  let unsubscribed = 0;
  const calls = [];
  const pending = [];
  const changes = [];
  const document = { documentElement: { dataset: { theme: 'light' }, style: {} } };
  const controller = createController({
    document,
    onChange: (snapshot) => changes.push(snapshot),
    api: {
      onDarkModeScheduleChanged(callback) {
        order.push('subscribe');
        listener = callback;
        return () => { unsubscribed += 1; listener = null; };
      },
      setDarkModeSchedule(config) {
        calls.push(config);
        const request = deferred();
        pending.push(request);
        return request.promise;
      }
    }
  });
  return {
    controller, document, calls, pending, changes, order,
    emit: (snapshot) => listener?.(snapshot),
    unsubscribed: () => unsubscribed
  };
}

test('先订阅事件，新事件先到时较晚的 app:get-info 旧快照不能覆盖主题', async () => {
  const h = harness();
  const getInfo = deferred();
  h.order.push('get-info');
  const load = getInfo.promise.then((snapshot) => h.controller.accept(snapshot));
  h.emit(makeSnapshot(2, 'dark', enabled));
  getInfo.resolve(makeSnapshot(1));
  assert.equal(await load, false);
  assert.deepEqual(h.order, ['subscribe', 'get-info']);
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  assert.equal(h.document.documentElement.style.colorScheme, 'dark');
  assert.equal(h.controller.getSnapshot().themeRevision, 2);
  assert.equal(h.controller.getSnapshot().ready, true);
  assert.equal(h.changes.length, 1);
  h.controller.dispose();
});

test('加载前与非法配置禁止保存，不发出 IPC', async () => {
  const h = harness();
  await assert.rejects(h.controller.save(enabled), /尚未加载/);
  h.emit(makeSnapshot(1));
  await assert.rejects(h.controller.save({ ...enabled, endTime: '18:30' }), /不能相同/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.controller.getSnapshot().saving, false);
  h.controller.dispose();
});

test('保存中防止重复请求，成功后应用完整快照并释放 saving', async () => {
  const h = harness();
  h.emit(makeSnapshot(1));
  const observed = [];
  const cancel = h.controller.subscribe((snapshot) => observed.push(snapshot));
  const operation = h.controller.save(enabled);
  assert.equal(h.controller.getSnapshot().saving, true);
  assert.equal(h.document.documentElement.dataset.theme, 'light');
  await assert.rejects(h.controller.save(enabled), /正在保存/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], enabled);
  h.pending[0].resolve({ status: 'ok', ...makeSnapshot(2, 'dark', enabled) });
  await operation;
  assert.equal(h.controller.getSnapshot().saving, false);
  assert.deepEqual(h.controller.getSnapshot().darkModeSchedule, enabled);
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  assert.equal(observed.at(-1).saving, false);
  cancel();
  const count = observed.length;
  h.emit(makeSnapshot(3));
  assert.equal(observed.length, count);
  h.controller.dispose();
});

test('保存失败与 IPC 拒绝保留原主题和配置，同时允许后续重试', async () => {
  const h = harness();
  h.emit(makeSnapshot(1, 'dark', enabled));
  const before = h.controller.getSnapshot();
  let operation = h.controller.save(DEFAULT_DARK_MODE_SCHEDULE);
  h.pending[0].resolve({ status: 'failed', message: '数据库不可写' });
  await assert.rejects(operation, /数据库不可写/);
  assert.deepEqual(h.controller.getSnapshot(), before);
  operation = h.controller.save(DEFAULT_DARK_MODE_SCHEDULE);
  h.pending[1].reject(new Error('IPC 已断开'));
  await assert.rejects(operation, /IPC 已断开/);
  assert.deepEqual(h.controller.getSnapshot(), before);
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  operation = h.controller.save(DEFAULT_DARK_MODE_SCHEDULE);
  h.pending[2].resolve({ status: 'ok', ...makeSnapshot(2) });
  await operation;
  assert.equal(h.controller.getSnapshot().effectiveTheme, 'light');
  h.controller.dispose();
});

test('保存期间收到较新事件，较旧但合法的保存回包不能反向覆盖', async () => {
  const h = harness();
  h.emit(makeSnapshot(1));
  const operation = h.controller.save(enabled);
  h.emit(makeSnapshot(3, 'dark', enabled));
  h.pending[0].resolve({ status: 'ok', ...makeSnapshot(2, 'light', enabled) });
  await operation;
  assert.equal(h.controller.getSnapshot().themeRevision, 3);
  assert.equal(h.controller.getSnapshot().effectiveTheme, 'dark');
  assert.equal(h.controller.getSnapshot().saving, false);
  h.controller.dispose();
});

test('编辑开始时间期间其他窗口关闭并修改结束时间，提交保留外部修改且不重新启用', async () => {
  const h = harness();
  h.emit(makeSnapshot(1, 'dark', enabled));
  // 只模拟设置组件需要的节点和事件；保存、订阅与字段合并使用真实组件。
  const nodes = Object.fromEntries(['enabled', 'start', 'end', 'status', 'feedback', 'fields'].map((name) => {
    const listeners = new Map();
    return [name, {
      value: '', checked: false, hidden: false, isConnected: true,
      addEventListener(type, listener) { listeners.set(type, listener); },
      dispatch(type) { return listeners.get(type)?.({ currentTarget: this }); },
      focus() { h.document.activeElement = this; }
    }];
  }));
  const host = {
    innerHTML: '', ownerDocument: h.document, isConnected: true,
    querySelector(selector) {
      if (selector === 'fieldset') return nodes.fields;
      const name = selector.match(/^\[data-role="dark-mode-(enabled|start|end|status|feedback)"\]$/)?.[1];
      assert.ok(name, `未模拟的设置节点：${selector}`);
      return nodes[name];
    }
  };
  const view = mountSettings(host, h.controller);
  try {
    nodes.start.focus();
    nodes.start.value = '19:30';
    nodes.start.dispatch('input');
    const external = { enabled: false, startTime: '18:30', endTime: '07:00' };
    h.emit(makeSnapshot(2, 'light', external));

    assert.equal(nodes.start.value, '19:30', '保留当前正在编辑的开始时间');
    assert.equal(nodes.enabled.checked, false, '同步外部关闭操作');
    assert.equal(nodes.end.value, '07:00', '同步外部修改且本地未编辑的结束时间');
    assert.equal(h.calls.length, 0, '外部通知不触发保存');
    assert.equal(h.document.documentElement.dataset.theme, 'light');

    const saving = nodes.start.dispatch('change');
    const expected = { ...external, startTime: '19:30' };
    assert.deepEqual(h.calls, [expected], '只合入本窗口编辑的字段');
    assert.equal(nodes.fields.disabled, true);
    h.pending[0].resolve({ status: 'ok', ...makeSnapshot(3, 'light', expected) });
    await saving;

    assert.deepEqual(h.controller.getSnapshot().darkModeSchedule, expected);
    assert.equal(h.document.documentElement.dataset.theme, 'light', '保存时间不会意外重新启用深色');
    assert.equal(nodes.fields.disabled, false);
    assert.equal(nodes.enabled.checked, false);
    assert.equal(nodes.end.value, '07:00');
  } finally {
    view.destroy();
    h.controller.dispose();
  }
});

test('无效事件快照被拒绝，不能将默认关闭配置与深色状态拼接', () => {
  const h = harness();
  h.emit(makeSnapshot(1));
  const before = h.controller.getSnapshot();
  for (const value of [
    null,
    { ...makeSnapshot(2), themeRevision: NaN },
    { ...makeSnapshot(2), themeRevision: 1.5 },
    { ...makeSnapshot(2), effectiveTheme: 'system' },
    { themeRevision: 2, effectiveTheme: 'dark' },
    { ...makeSnapshot(2, 'dark'), darkModeSchedule: { ...enabled, endTime: '18:30' } }
  ]) {
    assert.equal(h.controller.accept(value), false);
    assert.deepEqual(h.controller.getSnapshot(), before);
  }
  h.controller.dispose();
});

test('status ok 但缺少 revision、主题或合法配置的回包报错并保留当前状态', async () => {
  for (const response of [
    { status: 'ok', effectiveTheme: 'dark', darkModeSchedule: enabled },
    { status: 'ok', ...makeSnapshot(2, 'dark', enabled), themeRevision: NaN },
    { status: 'ok', ...makeSnapshot(2, 'dark', enabled), effectiveTheme: 'system' },
    { status: 'ok', themeRevision: 2, effectiveTheme: 'dark' },
    { status: 'ok', ...makeSnapshot(2, 'dark', { ...enabled, startTime: '24:00' }) }
  ]) {
    const h = harness();
    h.emit(makeSnapshot(1));
    const before = h.controller.getSnapshot();
    const operation = h.controller.save(enabled);
    h.pending[0].resolve(response);
    await assert.rejects(operation, /无效状态/);
    assert.deepEqual(h.controller.getSnapshot(), before);
    h.controller.dispose();
  }
});

test('销毁取消事件订阅和通知，正在保存的回包不再重绘；快照副本不共享配置', async () => {
  const h = harness();
  h.emit(makeSnapshot(1));
  const copy = h.controller.getSnapshot();
  copy.darkModeSchedule.enabled = true;
  assert.equal(h.controller.getSnapshot().darkModeSchedule.enabled, false);
  const observed = [];
  h.controller.subscribe((snapshot) => observed.push(snapshot));
  const operation = h.controller.save(enabled);
  h.controller.dispose();
  assert.equal(h.unsubscribed(), 1);
  const notificationCount = observed.length;
  h.emit(makeSnapshot(2, 'dark', enabled));
  h.pending[0].resolve({ status: 'ok', ...makeSnapshot(2, 'dark', enabled) });
  await operation;
  assert.equal(observed.length, notificationCount);
  assert.equal(h.document.documentElement.dataset.theme, 'light');
  assert.equal(h.controller.accept(makeSnapshot(3, 'dark', enabled)), false);
});
