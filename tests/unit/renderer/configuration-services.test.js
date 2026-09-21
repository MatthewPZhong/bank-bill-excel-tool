'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfigurationServices } = require('../../../src/renderer/configuration-services');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
test('配置服务拥有模板与币种深副本；读取方和上游调用方均不能修改服务缓存', async () => {
  const templates = [{ id: 1, name: '模板', headers: ['USD'], config: { nested: ['A'] } }];
  const service = createConfigurationServices({ templatesApi: { list: async () => templates } });
  const currencies = [{ code: 'USD', aliases: ['美元'] }];
  service.acceptBootstrap({ currencyOptions: currencies, accountMappingCount: 4 });
  const returned = await service.refreshTemplates();
  returned[0].config.nested.push('upstream');
  templates[0].headers.push('source');
  currencies[0].aliases.push('changed');
  service.getTemplates()[0].config.nested.push('reader');
  service.getCurrencyOptions()[0].aliases.push('reader');
  assert.deepEqual(service.getTemplates()[0].config, { nested: ['A'] });
  assert.deepEqual(service.getTemplates()[0].headers, ['USD']);
  assert.deepEqual(service.getCurrencyOptions(), [{ code: 'USD', aliases: ['美元'] }]);
  assert.equal(service.getAccountMappingCount(), 4);
});
test('模板读取 A/B/A 逆序交付只接受最后一代并仅通知一次', async () => {
  const held = [deferred(), deferred(), deferred()];
  const service = createConfigurationServices({ templatesApi: { list: () => held.shift().promise } });
  const all = [...held]; const events = [];
  service.subscribe((event) => events.push(event));
  const reads = [service.refreshTemplates(), service.refreshTemplates(), service.refreshTemplates()];
  all[2].resolve([{ id: 3, name: 'A 新代' }]); await reads[2];
  all[1].resolve([{ id: 2, name: 'B 旧代' }]); all[0].resolve([{ id: 1, name: 'A 旧代' }]); await Promise.all(reads);
  assert.deepEqual(service.getTemplates(), [{ id: 3, name: 'A 新代' }]);
  assert.deepEqual(events, [{ resource: 'templates' }]);
  assert.equal(Object.isFrozen(events[0]), true);
});
test('失败或非法模板返回保留最近成功缓存且不广播成功通知', async () => {
  let result = [{ id: 1, name: '成功缓存' }];
  const service = createConfigurationServices({ templatesApi: { list: async () => { if (result instanceof Error) throw result; return result; } } });
  await service.refreshTemplates(); const events = [];
  service.subscribe((event) => events.push(event));
  result = { status: 'failed', message: '失败' }; await assert.rejects(service.refreshTemplates(), /模板列表返回格式无效/);
  result = new Error('网络失败'); await assert.rejects(service.refreshTemplates(), /网络失败/);
  assert.deepEqual(service.getTemplates(), [{ id: 1, name: '成功缓存' }]);
  assert.deepEqual(events, []);
});
test('bootstrap/account mapping/preview 通知准确；取消订阅和 dispose 后旧读不回写', async () => {
  const held = deferred();
  const service = createConfigurationServices({ templatesApi: { list: () => held.promise } });
  const events = []; const unsubscribe = service.subscribe((event) => events.push(event.resource));
  service.acceptBootstrap({ currencyOptions: ['USD'], accountMappingCount: 1 });
  service.acceptAccountMappingCount(2);
  const pending = service.refreshTemplates();
  service.applyPreviewTemplates([{ id: 4, name: '已明确预览' }]);
  held.resolve([{ id: 1, name: '旧读取' }]); await pending;
  assert.deepEqual(service.getTemplates(), [{ id: 4, name: '已明确预览' }]);
  assert.deepEqual(events, ['configuration', 'account-mappings', 'templates']);
  unsubscribe(); unsubscribe(); service.acceptAccountMappingCount(3);
  assert.equal(events.length, 3);
  service.dispose(); service.dispose(); service.acceptAccountMappingCount(9);
  assert.equal(service.getAccountMappingCount(), 3);
});
test('dispose 中的模板读取仍向原调用方结算，不能回填缓存或通知', async () => {
  const held = deferred();
  const service = createConfigurationServices({ templatesApi: { list: () => held.promise } });
  const events = []; service.subscribe((event) => events.push(event));
  const pending = service.refreshTemplates(); service.dispose();
  held.resolve([{ id: 9 }]); assert.deepEqual(await pending, [{ id: 9 }]);
  assert.deepEqual(service.getTemplates(), []); assert.deepEqual(events, []);
});
test('某订阅者异常不阻断其他消费者和模板成功返回', async () => {
  const errors = []; const events = [];
  const service = createConfigurationServices({ templatesApi: { list: async () => [{ id: 1 }] }, reportError: (error) => errors.push(error.message) });
  service.subscribe(() => { throw new Error('视图异常'); });
  service.subscribe((event) => events.push(event.resource));
  assert.deepEqual(await service.refreshTemplates(), [{ id: 1 }]);
  assert.deepEqual(errors, ['视图异常']); assert.deepEqual(events, ['templates']);
});
