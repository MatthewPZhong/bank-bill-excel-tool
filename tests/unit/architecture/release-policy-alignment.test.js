'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');

function recoveryFixture(t, code, permit = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-recovery-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/dispatch.js'), code);
  const boundary = { id: 'recovery', owner: 'fixture', governance: 'G1', state: 'pending',
    rules: ['ARCH-PUBLICATION-RECOVERY-ENTRY'], entrypoints: [], allowedLocal: [], allowedExternal: [],
    requiredConsumers: [], activationEvidence: [], protectedScopes: [{ path: 'src/dispatch.js', functionPath: null }],
    restrictedApis: [{ path: 'src/worker.js', exportNames: null, operations: ['recover', 'execute-recovery'] }],
    allowedSites: [], compositionEntrypoints: [], globals: [], factory: null, allowedApiFields: {},
    deprecatedEntrypoints: [], directory: null };
  const config = { schemaVersion: 1, factBaseline: '1'.repeat(40), bootstrap: { factBaseline: '1'.repeat(40), mode: 'first-introduction' },
    boundaries: [boundary], generatedModules: [], dynamicLoads: [], policyChanges: [] };
  const scanned = scan(root, config);
  if (permit) {
    const site = scanned.sites.find(s => s.type === 'call' && s.callee === 'worker');
    boundary.allowedSites.push({ rule: 'ARCH-PUBLICATION-RECOVERY-ENTRY', from: site.from,
      functionPath: site.functionPath, callee: site.callee, evidenceId: site.evidenceId,
      reason: '只有本 fixture 的准确授权事务位置允许执行恢复。' });
  }
  return { root, config, scanned, boundary, result: evaluateRules(scanned, config,
    { schemaVersion: 1, factBaseline: config.factBaseline, exceptions: [] }, { root }) };
}

test('恢复新命令 execute-recovery 与旧 recover 均不能从未授权路径发送', t => {
  for (const command of ['recover', 'execute-recovery']) {
    for (const code of [`function unauthorized(worker) { worker('${command}', {}); }`,
      `function unauthorized(port) { port.postMessage({ op: '${command}', payload: {} }); }`,
      `function unauthorized(port, flag) { port.postMessage({ op: flag ? '${command}' : 'discover-recovery' }); }`]) {
      const { result } = recoveryFixture(t, code);
      assert.ok(result.violations.some(v => v.rule === 'ARCH-PUBLICATION-RECOVERY-ENTRY'), `${command}: ${code}`);
    }
  }
});

test('精确授权事务允许 execute-recovery；旁边新增调用仍拒绝', t => {
  const exact = recoveryFixture(t, "function authorized(worker) { worker('execute-recovery', {}); }", true);
  assert.deepEqual(exact.result.violations, []);
  const extra = recoveryFixture(t, "function authorized(worker) { worker('execute-recovery', {}); } function bypass(port) { port.postMessage({ operation: 'execute-recovery' }); }", true);
  assert.ok(extra.result.violations.some(v => v.rule === 'ARCH-PUBLICATION-RECOVERY-ENTRY' && v.functionPath === 'bypass'));
});

test('授权位置的源码变化不得继续继承原指纹', t => {
  const exact = recoveryFixture(t, "function authorized(worker) { worker('execute-recovery', {}); }", true);
  fs.writeFileSync(path.join(exact.root, 'src/dispatch.js'), "function authorized(worker) { worker('execute-recovery', { unchecked: true }); }");
  const result = evaluateRules(scan(exact.root, exact.config), exact.config,
    { schemaVersion: 1, factBaseline: exact.config.factBaseline, exceptions: [] }, { root: exact.root });
  assert.ok(result.violations.some(v => v.rule === 'ARCH-PUBLICATION-RECOVERY-ENTRY'));
});

test('发现阶段允许，未知恢复消息仍失败关闭', t => {
  assert.deepEqual(recoveryFixture(t, "function discover(worker) { worker('discover-recovery', {}); }").result.violations, []);
  const unknown = recoveryFixture(t, 'function unknown(port, message) { port.postMessage(message); }');
  assert.ok(unknown.result.violations.some(v => v.rule === 'ARCH-STATIC-COVERAGE'));
});
