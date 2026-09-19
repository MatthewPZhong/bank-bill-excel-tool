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

function mountHarness(h = harness()) {
  // 只模拟设置组件需要的节点和事件；保存、订阅与字段合并使用真实组件。
  const nodes = Object.fromEntries(['enabled', 'start', 'end', 'status', 'feedback', 'fields'].map((name) => {
    const listeners = new Map();
    return [name, {
      value: '', checked: false, hidden: false, isConnected: true,
      addEventListener(type, listener) { listeners.set(type, listener); },
      dispatch(type) {
        if (type === 'blur' && h.document.activeElement === this) h.document.activeElement = null;
        return listeners.get(type)?.({ currentTarget: this });
      },
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
  return { ...h, nodes, view };
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
  const { nodes, view } = mountHarness(h);
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
    assert.equal(nodes.fields.disabled, false, '保存期间仍可编辑时间');
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

test('慢保存期间连续编辑两个时间，旧回包不覆盖草稿且后续请求合并最新值', async () => {
  const h = mountHarness();
  h.emit(makeSnapshot(1, 'dark', enabled));
  const { start, end, fields } = h.nodes;
  try {
    start.focus();
    start.value = '01:30';
    start.dispatch('input');
    const saving = start.dispatch('change');
    assert.equal(fields.disabled, false);
    start.value = '19:30';
    start.dispatch('input');
    start.dispatch('change');
    end.focus();
    end.value = '07:00';
    end.dispatch('input');
    end.dispatch('change');
    assert.equal(h.calls.length, 1, '在途请求期间不并发调用 IPC');
    h.pending[0].resolve({ status: 'ok', ...makeSnapshot(2, 'dark', h.calls[0]) });
    await new Promise(setImmediate);
    assert.equal(start.value, '19:30');
    assert.equal(end.value, '07:00');
    assert.equal(h.document.activeElement, end, '旧请求结束不能抢回开始框焦点');
    assert.deepEqual(h.calls[1], { enabled: true, startTime: '19:30', endTime: '07:00' });
    assert.equal(h.controller.getSnapshot().saving, true, '队列完成之前保持关闭保护');
    h.pending[1].resolve({ status: 'ok', ...makeSnapshot(3, 'dark', h.calls[1]) });
    await saving;
    assert.equal(h.calls.length, 2, '合并中间编辑，只保存最新完整时段');
    assert.deepEqual(h.controller.getSnapshot().darkModeSchedule, h.calls[1]);
    assert.equal(h.controller.getSnapshot().saving, false);
  } finally { h.view.destroy(); h.controller.dispose(); }
});

test('保存失败不打断活动时间框，离开后回读已保存时段并可重试', async () => {
  const h = mountHarness();
  h.emit(makeSnapshot(1, 'dark', enabled));
  const { start, feedback } = h.nodes;
  try {
    start.focus();
    start.value = '01:30';
    start.dispatch('input');
    const saving = start.dispatch('change');
    h.pending[0].reject(new Error('数据库不可写'));
    await saving;
    assert.equal(start.value, '01:30', '失败回包不能重写正在编辑的原生分段');
    assert.equal(h.document.activeElement, start);
    assert.equal(feedback.hidden, false);
    assert.match(feedback.textContent, /数据库不可写/);
    assert.deepEqual(h.controller.getSnapshot().darkModeSchedule, enabled);
    assert.equal(h.document.documentElement.dataset.theme, 'dark');
    start.dispatch('blur');
    assert.equal(start.value, '18:30', '失败编辑离开后显示持久配置');
    start.value = '19:30';
    const retry = start.dispatch('change');
    h.pending[1].resolve({ status: 'ok', ...makeSnapshot(2, 'dark', h.calls[1]) });
    await retry;
    assert.equal(h.controller.getSnapshot().darkModeSchedule.startTime, '19:30');
    assert.equal(feedback.hidden, true);
  } finally { h.view.destroy(); h.controller.dispose(); }
});

test('保存回包不能清除更新的非法草稿，排队关闭仍使用已保存时段', async () => {
  const h = mountHarness();
  h.emit(makeSnapshot(1, 'dark', enabled));
  const { start, end, feedback } = h.nodes;
  try {
    start.value = '19:30';
    const saving = start.dispatch('change');
    end.value = '';
    end.dispatch('input');
    end.dispatch('change');
    h.pending[0].resolve({ status: 'ok', ...makeSnapshot(2, 'dark', h.calls[0]) });
    await saving;
    assert.equal(end.value, '', '保留仍未完成的草稿供用户继续输入');
    assert.equal(h.calls.length, 1, '非法草稿不发送请求');
    assert.equal(feedback.hidden, false);

    start.value = '20:30';
    start.dispatch('input');
    // 先补齐草稿，发出一个待完成的时段保存。
    end.value = '07:00';
    const pending = end.dispatch('change');
    h.nodes.enabled.checked = false;
    h.nodes.enabled.dispatch('change');
    assert.equal(h.calls.length, 2);
    h.pending[1].resolve({ status: 'ok', ...makeSnapshot(3, 'dark', h.calls[1]) });
    await new Promise(setImmediate);
    assert.deepEqual(h.calls[2], { ...h.calls[1], enabled: false });
    h.pending[2].resolve({ status: 'ok', ...makeSnapshot(4, 'light', h.calls[2]) });
    await pending;
    assert.equal(h.nodes.enabled.checked, false);
    assert.equal(h.document.documentElement.dataset.theme, 'light');
    assert.equal(feedback.hidden, true);
  } finally { h.view.destroy(); h.controller.dispose(); }
});

test('无效时间草稿不阻止直接关闭，销毁后不发送队列里的后续编辑', async () => {
  const h = mountHarness();
  h.emit(makeSnapshot(1, 'dark', enabled));
  try {
    h.nodes.start.value = '';
    h.nodes.start.dispatch('input');
    await h.nodes.start.dispatch('change');
    assert.equal(h.calls.length, 0);
    h.nodes.enabled.checked = false;
    const saving = h.nodes.enabled.dispatch('change');
    assert.deepEqual(h.calls, [{ ...enabled, enabled: false }]);
    h.nodes.start.value = '19:30';
    h.nodes.start.dispatch('change');
    h.view.destroy();
    h.pending[0].resolve({ status: 'ok', ...makeSnapshot(2, 'light', h.calls[0]) });
    await saving;
    assert.equal(h.calls.length, 1, '销毁面板后不继续保存草稿');
    h.nodes.end.dispatch('change');
    assert.equal(h.calls.length, 1, '已销毁节点上的事件不发起保存');
  } finally { h.view.destroy(); h.controller.dispose(); }
});

for (const closeSucceeds of [true, false]) {
  test(`关闭排队后新时间继续保存，关闭${closeSucceeds ? '成功' : '失败'}不吞后续编辑`, async () => {
    const h = mountHarness();
    h.emit(makeSnapshot(1, 'dark', enabled));
    const { start, end, feedback } = h.nodes;
    try {
      end.value = '07:00';
      const saving = end.dispatch('change');
      h.nodes.enabled.checked = false;
      h.nodes.enabled.dispatch('change');
      start.focus();
      start.value = '20:30';
      start.dispatch('input');
      start.dispatch('change');
      assert.equal(h.calls.length, 1, '时间编辑发生在关闭请求排队期间');
      h.pending[0].resolve({ status: 'ok', ...makeSnapshot(2, 'dark', h.calls[0]) });
      await new Promise(setImmediate);
      assert.deepEqual(h.calls[1], { enabled: false, startTime: '18:30', endTime: '07:00' }, '先用已保存时段关闭');
      h.pending[1].resolve(closeSucceeds
        ? { status: 'ok', ...makeSnapshot(3, 'light', h.calls[1]) }
        : { status: 'failed', message: '关闭设置写入失败' });
      await new Promise(setImmediate);
      const expected = { enabled: !closeSucceeds, startTime: '20:30', endTime: '07:00' };
      assert.deepEqual(h.calls[2], expected, '关闭之后的编辑应有后续请求');
      assert.equal(h.controller.getSnapshot().saving, true, '后续编辑结算前继续阻止关闭弹窗');
      assert.equal(start.value, '20:30');
      h.pending[2].resolve({ status: 'ok', ...makeSnapshot(4, closeSucceeds ? 'light' : 'dark', expected) });
      await saving;
      start.dispatch('blur');
      assert.equal(start.value, '20:30', '保存后失焦不能回退旧值');
      assert.deepEqual(h.controller.getSnapshot().darkModeSchedule, expected);
      assert.equal(h.calls.length, 3, '请求串行并且没有丢失或重复');
      assert.equal(feedback.hidden, closeSucceeds);
      if (!closeSucceeds) assert.match(feedback.textContent, /关闭设置写入失败/, '后续成功保存不能掩盖关闭失败');
    } finally { h.view.destroy(); h.controller.dispose(); }
  });

  test(`关闭后新非法草稿保留且不阻止关闭请求${closeSucceeds ? '成功' : '失败反馈'}`, async () => {
    const h = mountHarness();
    h.emit(makeSnapshot(1, 'dark', enabled));
    const { start, end, feedback } = h.nodes;
    try {
      end.value = '07:00';
      const saving = end.dispatch('change');
      h.nodes.enabled.checked = false;
      h.nodes.enabled.dispatch('change');
      start.focus();
      start.value = '';
      start.dispatch('input');
      start.dispatch('change');
      h.pending[0].resolve({ status: 'ok', ...makeSnapshot(2, 'dark', h.calls[0]) });
      await new Promise(setImmediate);
      assert.deepEqual(h.calls[1], { enabled: false, startTime: '18:30', endTime: '07:00' });
      h.pending[1].resolve(closeSucceeds
        ? { status: 'ok', ...makeSnapshot(3, 'light', h.calls[1]) }
        : { status: 'failed', message: '关闭设置写入失败' });
      await saving;
      assert.equal(h.calls.length, 2, '非法草稿不发送额外请求');
      assert.equal(h.nodes.enabled.checked, !closeSucceeds);
      assert.equal(h.controller.getSnapshot().effectiveTheme, closeSucceeds ? 'light' : 'dark');
      start.dispatch('blur');
      assert.equal(start.value, '', '关闭后新草稿不能被当作旧草稿丢弃');
      assert.equal(feedback.hidden, false);
      assert.match(feedback.textContent, /HH:mm/);
      if (!closeSucceeds) assert.match(feedback.textContent, /关闭设置写入失败/, '校验错误不能覆盖关闭失败原因');
      start.value = '20:30';
      const retry = start.dispatch('change');
      h.pending[2].resolve({ status: 'ok', ...makeSnapshot(4, closeSucceeds ? 'light' : 'dark', h.calls[2]) });
      await retry;
      assert.equal(h.controller.getSnapshot().darkModeSchedule.startTime, '20:30');
      assert.equal(feedback.hidden, true, '用户修正并保存成功后解除旧错误提示');
    } finally { h.view.destroy(); h.controller.dispose(); }
  });
}

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
