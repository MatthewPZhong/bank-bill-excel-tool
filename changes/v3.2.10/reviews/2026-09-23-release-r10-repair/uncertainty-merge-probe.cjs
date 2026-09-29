'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = process.cwd();
const toolsRoot = process.env.R10_ADJACENT_TOOLS_ROOT || root;
const { scan } = require(path.join(toolsRoot, 'scripts/architecture/scan'));
const { evaluateRules } = require(path.join(toolsRoot, 'scripts/architecture/rules'));
const actual = require(path.join(root, 'architecture/boundaries.json'));
const config = {
  schemaVersion: 1, factBaseline: '1'.repeat(40), bootstrap: { factBaseline: '1'.repeat(40), mode: 'first-introduction' },
  boundaries: [{ ...actual.boundaries.find(item => item.id === 'renderer-bank-statement'), state: 'pending' }],
  generatedModules: [], dynamicLoads: [], policyChanges: [],
};
const prefix = 'function provide(){return {api:{run(){}}};}const old=provide();const current=provide();';
const suffix = 'const alias=list[0].api;alias.outsideScope=window.desktopApi.outsideScope;window.BankStatementController.createBankStatementController({api:current.api});({sameCurrent:alias===current.api,sameOld:alias===old.api});';
const cases = [['logical-merge-of-uncertain-arrays',true,'function make(value){const args=[];args.push(value);return args;}window.choose=false;const list=(window.choose ? [...make(old)] : [...make(current)]) || [];']];
const results = cases.map(([name, unsafe, body]) => {
  const source = prefix + body + suffix;
  let injected;
  const window = { desktopApi: { outsideScope(){return true;} }, BankStatementController: { createBankStatementController(value){injected=value;} } };
  const runtime = vm.runInNewContext(source, { window });
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-adjacent-'));
  let evaluated;
  try {
    fs.mkdirSync(path.join(fixture, 'src'));
    fs.writeFileSync(path.join(fixture, 'src/shell.js'), source);
    evaluated = evaluateRules(scan(fixture, config), config, { schemaVersion:1, factBaseline:config.factBaseline, exceptions:[] }, { root:fixture });
  } finally { fs.rmSync(fixture, { recursive:true, force:true }); }
  const rejected = evaluated.violations.some(item => ['ARCH-RENDERER-SCOPE','ARCH-STATIC-COVERAGE'].includes(item.rule));
  return { name, unsafe, source, runtime: { ...runtime, injectedKeys:Object.keys(injected.api), outsideScope:typeof injected.api.outsideScope === 'function' }, rejected, passed:rejected === unsafe && runtime.sameCurrent === unsafe, violations:evaluated.violations };
});
const files = ['scripts/architecture/renderer-contracts.js','scripts/architecture/scan.js','scripts/architecture/rules.js','scripts/architecture/contracts.js','scripts/architecture/schema.js','architecture/boundaries.json','architecture/legacy-allowlist.json'];
const hashes = Object.fromEntries(files.map(file => [file,crypto.createHash('sha256').update(fs.readFileSync(path.join(file.startsWith('scripts/') ? toolsRoot : root,file))).digest('hex')]));
console.log(JSON.stringify({ generatedAt:new Date().toISOString(), hashes, total:results.length, pass:results.filter(item=>item.passed).length, results },null,2));
