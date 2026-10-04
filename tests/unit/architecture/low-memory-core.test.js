'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');
const repository = path.resolve(__dirname, '../../..');
const actual = JSON.parse(fs.readFileSync(path.join(repository, 'architecture/boundaries.json'), 'utf8'));

test('new memory helpers retain the actual platform boundary against OS, IO, carrier and business dependencies', (t) => {
  const boundary = actual.boundaries.find((item) => item.id === 'platform-core');
  for (const injection of ['', "require('node:os');", "require('node:fs');", "require('node:worker_threads');",
    "require('../biz-op-v327/probe');"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-core-boundary-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const file of boundary.allowedLocal) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(repository, file), path.join(root, file));
    }
    const business = path.join(root, 'src/main-process/biz-op-v327/probe.js');
    fs.mkdirSync(path.dirname(business), { recursive: true });
    fs.writeFileSync(business, 'module.exports = {};\n');
    fs.appendFileSync(path.join(root, 'src/main-process/background-execution/memory-admission.js'), '\n' + injection);
    const config = { ...actual, boundaries: [boundary], dynamicLoads: [], generatedModules: [], policyChanges: [] };
    const result = evaluateRules(scan(root, config), config,
      { schemaVersion: 1, factBaseline: actual.factBaseline, exceptions: [] }, { root });
    if (injection) assert.ok(result.violations.some((item) => item.rule === 'ARCH-PLATFORM-CORE'), injection);
    else assert.deepEqual(result.violations, []);
  }
});
