'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

for (const [group, method, channel, payload] of [
  ['window', 'onMaximizedState', 'window:maximized-state', true],
  ['pending', 'onImportProgress', 'pending:import:progress', { type: 'progress', rowsProcessed: 3 }]
]) {
  test(`${group}.${method} 透传原事件，释放只删除当前订阅且重复释放安全`, () => {
    const emitter = new EventEmitter();
    const surfaces = {};
    let writes = 0;
    emitter.invoke = emitter.send = () => { writes += 1; };
    vm.runInNewContext(fs.readFileSync(require.resolve('../../../src/preload'), 'utf8'), {
      process: { platform: 'darwin', env: {} },
      require(name) {
        assert.equal(name, 'electron');
        return { ipcRenderer: emitter, contextBridge: { exposeInMainWorld: (key, value) => { surfaces[key] = value; } } };
      }
    });
    const first = [], second = [];
    const releaseFirst = surfaces.desktopApi[group][method](value => first.push(value));
    const releaseSecond = surfaces.desktopApi[group][method](value => second.push(value));
    emitter.emit(channel, { sender: 'fixture' }, payload);
    assert.deepEqual(first, [payload]);
    assert.deepEqual(second, [payload]);
    releaseFirst(); releaseFirst();
    assert.equal(emitter.listenerCount(channel), 1);
    emitter.emit(channel, {}, payload);
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
    releaseSecond();
    assert.equal(emitter.listenerCount(channel), 0);
    assert.equal(writes, 0);
  });
}
