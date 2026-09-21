'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');
const { validateBoundaries, validateAllowlist, validateBootstrapComplete } = require('../../../scripts/architecture/schema');
const baseline = '1'.repeat(40);
function boundary(rule, options = {}) {
  return { id: 'fixture', owner: 'fixture', governance: 'G8', state: 'pending', rules: [rule], entrypoints: [],
    allowedLocal: [], allowedExternal: [], requiredConsumers: [], activationEvidence: [], protectedScopes: [],
    restrictedApis: [], allowedSites: [], compositionEntrypoints: [], globals: [], factory: null, allowedApiFields: {},
    deprecatedEntrypoints: [], directory: null, ...options };
}
function fixture(t, source, boundaries, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-rules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(source)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), value); }
  const config = { schemaVersion: 1, factBaseline: baseline, bootstrap: { factBaseline: baseline, mode: 'first-introduction' }, boundaries,
    generatedModules: [], dynamicLoads: [], policyChanges: [] };
  const allowlist = { schemaVersion: 1, factBaseline: baseline, exceptions: [] };
  const scanned = scan(root, config); mutate({ config, allowlist, scanned, root });
  return { result: evaluateRules(scanned, config, allowlist, { root }), config, allowlist, scanned, root };
}
function denied(result, rule) { assert.ok(result.violations.some(v => v.rule === rule), JSON.stringify(result.violations)); }
function clean(result) { assert.deepEqual(result.violations, []); }
function exception(site, rule) { return { id: 'exact-old-site', rule, from: site.from, evidenceId: site.evidenceId, functionPath: site.functionPath,
  originalCommit: baseline, reason: '固定基线的旧入口等待所属治理切片迁移', governance: 'G3', removeWhen: '迁移后删除此准确条目' }; }

test('active 保护函数更名却不更新登记时不能静默失去扫描范围', t => {
  const b = boundary('ARCH-BIZOP-QUERY', { state: 'active', entrypoints: ['src/query.js'],
    protectedScopes: [{ path: 'src/query.js', functionPath: 'collect' }] });
  const { result } = fixture(t, { 'src/query.js': "function renamed(catalog) { return catalog.db.prepare('SELECT * FROM facts').all(); }" }, [b]);
  denied(result, 'ARCH-STATIC-COVERAGE');
});

test('循环：两文件、自环及换节点均被拒绝，断环通过', t => {
  for (const files of [{ 'src/a.js': "require('./b')", 'src/b.js': "require('./a')" }, { 'src/a.js': "require('./a')" }, { 'src/c.js': "require('./d')", 'src/d.js': "require('./c')" }]) {
    const { result } = fixture(t, files, []); denied(result, 'ARCH-CYCLE'); assert.ok(result.violations[0].dependencyPath.length >= 2);
  }
  clean(fixture(t, { 'src/a.js': "require('./b')", 'src/b.js': '' }, []).result);
});

test('平台核心：纯辅助与 crypto 允许，间接 IO 和 writer 拒绝', t => {
  const b = boundary('ARCH-PLATFORM-CORE', { entrypoints: ['src/core.js'], allowedLocal: ['src/core.js', 'src/helper.js'], allowedExternal: ['node:crypto'] });
  clean(fixture(t, { 'src/core.js': "require('./helper')", 'src/helper.js': "require('crypto')" }, [b]).result);
  for (const dependency of ['node:fs', 'electron', 'node:sqlite', 'node:worker_threads']) {
    const { result } = fixture(t, { 'src/core.js': "require('./helper')", 'src/helper.js': `require('${dependency}')` }, [b]);
    denied(result, 'ARCH-PLATFORM-CORE'); assert.equal(result.violations[0].dependencyPath[1], 'src/helper.js');
  }
});

test('lineage 的整个闭包不接受 row mapper → normalizer → Excel 或 writer', t => {
  const b = boundary('ARCH-PURE-LINEAGE', { entrypoints: ['src/contract.js'], allowedLocal: ['src/contract.js', 'src/definitions.js'], allowedExternal: ['node:crypto'] });
  clean(fixture(t, { 'src/contract.js': "require('./definitions'); require('node:crypto');", 'src/definitions.js': 'exports.version=1;' }, [b]).result);
  const { result } = fixture(t, { 'src/contract.js': "require('./row-mapper')", 'src/row-mapper.js': "require('./normalizers')", 'src/normalizers.js': "require('xlsx')" }, [b]);
  denied(result, 'ARCH-PURE-LINEAGE'); assert.ok(result.violations.some(v => v.dependencyPath.join('/').includes('normalizers.js/xlsx')));
  for (const forbidden of ['fs', 'node:sqlite', 'electron', 'exceljs']) denied(fixture(t, { 'src/contract.js': `require('${forbidden}')` }, [b]).result, 'ARCH-PURE-LINEAGE');
});

test('modal 所有权：宿主合法，普通 row.remove 合法，精确旧例外不可转移', t => {
  const b = boundary('ARCH-MODAL-OWNER', { entrypoints: ['src/modal-host.js'] });
  clean(fixture(t, { 'src/modal-host.js': "document.getElementById('modalRoot').replaceChildren();", 'src/other.js': 'const row=document.createElement("tr"); row.remove();' }, [b]).result);
  const files = { 'src/old.js': "function close() { const root=document.getElementById('modalRoot'); root.innerHTML=''; }" };
  const first = fixture(t, files, [b], ({ scanned, allowlist }) => allowlist.exceptions.push(exception(scanned.sites.find(s => s.type === 'modal-write'), 'ARCH-MODAL-OWNER')));
  clean(first.result); assert.equal(first.result.matchedExceptions.length, 1);
  const renamed = fixture(t, { 'src/new.js': files['src/old.js'] }, [b], ({ allowlist }) => { allowlist.exceptions = first.allowlist.exceptions; });
  denied(renamed.result, 'ARCH-MODAL-OWNER'); assert.equal(renamed.result.staleExceptions.length, 1);
});

test('Renderer 私有同名 state 合法，跨控制器依赖/直接 desktopApi 失败', t => {
  const b = boundary('ARCH-RENDERER-SCOPE', { entrypoints: ['src/controller.js'], allowedLocal: ['src/controller.js'] });
  clean(fixture(t, { 'src/controller.js': 'function create() { const state={}; const elements={}; return {state,elements}; }' }, [b]).result);
  denied(fixture(t, { 'src/controller.js': "require('./other');", 'src/other.js': '' }, [b]).result, 'ARCH-RENDERER-SCOPE');
  denied(fixture(t, { 'src/controller.js': 'window.desktopApi.import();' }, [b]).result, 'ARCH-RENDERER-SCOPE');
  denied(fixture(t, { 'src/controller.js': 'desktopApi.import();' }, [b]).result, 'ARCH-RENDERER-SCOPE');
  clean(fixture(t, { 'src/controller.js': 'function local(desktopApi) { return desktopApi.read(); }' }, [b]).result);
});

test('受保护治理作用域不能通过 eval 或 Function 隐藏 DB 和恢复调用', t => {
  for (const source of ["function collect(){ eval(code); }", "function collect(){ new Function(code)(); }"]) {
    const b = boundary('ARCH-BIZOP-QUERY', { protectedScopes: [{ path: 'src/query.js', functionPath: 'collect' }] });
    denied(fixture(t, { 'src/query.js': source }, [b]).result, 'ARCH-STATIC-COVERAGE');
  }
});

test('classic 工厂必须真实加载且服务先于消费者', t => {
  const service = boundary('ARCH-RENDERER-SCOPE', { id: 'service', entrypoints: ['src/service.js'], globals: [{ path: 'src/service.js', exportsGlobal: ['service'], consumesGlobals: [] }] });
  const consumer = boundary('ARCH-RENDERER-SCOPE', { id: 'consumer', entrypoints: ['src/controller.js'], allowedLocal: ['src/service.js'], globals: [{ path: 'src/controller.js', exportsGlobal: ['controller'], consumesGlobals: ['service'] }] });
  const source = { 'src/service.js': 'window.service={};', 'src/controller.js': 'window.controller=window.service;' };
  clean(fixture(t, { ...source, 'index.html': '<script src="src/service.js"></script><script src="src/controller.js"></script>' }, [service, consumer]).result);
  denied(fixture(t, { ...source, 'index.html': '<script src="src/controller.js"></script><script src="src/service.js"></script>' }, [service, consumer]).result, 'ARCH-RENDERER-SCOPE');
  denied(fixture(t, source, [service, consumer]).result, 'ARCH-STATIC-COVERAGE');
});

test('XLSX IO 中性层可用 fs/yauzl，反向业务和 main-process 均失败', t => {
  const b = boundary('ARCH-XLSX-INFRA', { entrypoints: ['src/backend/xlsx/reader.js'], directory: 'src/backend/xlsx' });
  clean(fixture(t, { 'src/backend/xlsx/reader.js': "require('node:fs');require('yauzl');" }, [b]).result);
  for (const target of ['src/backend/position/x.js', 'src/backend/toolbox-format/x.js', 'src/main-process/x.js']) {
    const relative = path.posix.relative('src/backend/xlsx', target);
    denied(fixture(t, { 'src/backend/xlsx/reader.js': `require('${relative}')`, [target]: '' }, [b]).result, 'ARCH-XLSX-INFRA');
  }
});

test('XLSX 已有消费者可过，新消费者/退役复活失败，shim 无调用可移除', t => {
  const old = { path: 'src/old.js', replacementPaths: ['src/backend/xlsx/reader.js'], exportNames: ['read'], existingConsumers: [{ from: 'src/consumer.js', kind: 'require', importedNames: ['read'] }], state: 'compat', retirementEvidence: [] };
  const b = boundary('ARCH-XLSX-INFRA', { deprecatedEntrypoints: [old] });
  clean(fixture(t, { 'src/old.js': 'exports.read=()=>{};', 'src/consumer.js': "const {read}=require('./old');" }, [b]).result);
  denied(fixture(t, { 'src/old.js': 'exports.read=()=>{};', 'src/new.js': "const {read}=require('./old');" }, [b]).result, 'ARCH-XLSX-INFRA');
  clean(fixture(t, {}, [{ ...b, deprecatedEntrypoints: [{ ...old, state: 'retired', retirementEvidence: ['evidence.md'] }] }], ({ root }) => fs.writeFileSync(path.join(root, 'evidence.md'), '兼容测试与全仓清点')).result);
});

test('恢复 raw 引入/直调、worker recover 和隐式 prepare 均受控', t => {
  const b = boundary('ARCH-PUBLICATION-RECOVERY-ENTRY', { protectedScopes: [{ path: 'src/dispatch.js', functionPath: null }], restrictedApis: [{ path: 'src/raw.js', exportNames: ['recover'], operations: ['recoverInternal'] }] });
  const { result } = fixture(t, { 'src/raw.js': 'exports.recover=()=>{}; function prepare(){recoverInternal();}', 'src/business.js': "require('./raw').recover();", 'src/dispatch.js': "runWorkerJob('worker', 'recover', {});" }, [b]);
  denied(result, 'ARCH-PUBLICATION-RECOVERY-ENTRY'); assert.ok(result.violations.some(v => v.from === 'src/dispatch.js')); assert.ok(result.violations.some(v => v.from === 'src/raw.js'));
  clean(fixture(t, { 'src/business.js': 'gateway.forOwner("owner").recover();' }, [b]).result);
});

test('私有恢复：同域合法，准确 Main 装配合法，外域直接引用拒绝', t => {
  const target = 'src/main-process/biz-op-v327/recovery-driver.js';
  const b = boundary('ARCH-BIZOP-RECOVERY-PRIVATE', { restrictedApis: [{ path: target, exportNames: ['recover'], operations: [] }], compositionEntrypoints: [{ path: 'src/main.js', importedNames: ['recover'], allowedTargets: [target] }] });
  clean(fixture(t, { [target]: 'exports.recover=()=>{};', 'src/main.js': "const {recover}=require('./main-process/biz-op-v327/recovery-driver');", 'src/main-process/biz-op-v327/use.js': "require('./recovery-driver').recover();" }, [b]).result);
  denied(fixture(t, { [target]: 'exports.recover=()=>{};', 'src/other.js': "require('./main-process/biz-op-v327/recovery-driver').recover();" }, [b]).result, 'ARCH-BIZOP-RECOVERY-PRIVATE');
});

test('通用 task executor 不能经 helper 加载 Position，领域 adapter→owner 合法', t => {
  const b = boundary('ARCH-TASK-ADAPTER', { protectedScopes: [{ path: 'src/executor.js', functionPath: null }], restrictedApis: [{ path: 'src/position.js', exportNames: null, operations: [] }] });
  denied(fixture(t, { 'src/executor.js': "require('./helper')", 'src/helper.js': "require('./position')", 'src/position.js': '' }, [b]).result, 'ARCH-TASK-ADAPTER');
  clean(fixture(t, { 'src/executor.js': 'exports.run=adapter=>adapter.execute();', 'src/adapter.js': "require('./position')", 'src/position.js': '' }, [b]).result);
});

test('G5 原始 DB alias/SQL 禁止，query facade 与精确预览表命令允许', t => {
  const b = boundary('ARCH-BIZOP-QUERY', { protectedScopes: [{ path: 'src/query.js', functionPath: null }] });
  denied(fixture(t, { 'src/query.js': "function read(catalog){ const {db}=catalog;const handle=db; return handle.prepare('SELECT * FROM facts').get();}" }, [b]).result, 'ARCH-BIZOP-QUERY');
  clean(fixture(t, { 'src/query.js': 'function read(catalog){return catalog.queries.find();}' }, [b]).result);
  const source = { 'src/query.js': "function get(catalog){return catalog.db.prepare('SELECT * FROM biz_op_v327_delete_previews').get();}" };
  clean(fixture(t, source, [b], ({ scanned, config }) => { const site = scanned.sites.find(s => s.type === 'db-operation'); config.boundaries[0].allowedSites = [{ rule: 'ARCH-BIZOP-QUERY', from: site.from, functionPath: site.functionPath, callee: site.callee, evidenceId: site.evidenceId, reason: '预览表自有 command 附属读取' }]; }).result);
});

test('G5 Q1 只先保护跨域 Archive，业务事实读取由 Q2/Q3 接续', t => {
  const b = boundary('ARCH-BIZOP-QUERY', { id: 'bizop-query-q1', protectedScopes: [{ path: 'src/read.js', functionPath: null }] });
  clean(fixture(t, { 'src/read.js': "catalog.db.prepare('SELECT * FROM biz_op_v327_runs');" }, [b]).result);
  denied(fixture(t, { 'src/read.js': "catalog.db.prepare('SELECT * FROM archive_artifacts');" }, [b]).result, 'ARCH-BIZOP-QUERY');
});

test('描述符公共机制拒绝间接领域与 catalog，明确 composition 合法', t => {
  const b = boundary('ARCH-DESCRIPTOR-COMPOSITION', { entrypoints: ['src/runtime.js'], compositionEntrypoints: [{ path: 'src/composition.js', importedNames: ['create'], allowedTargets: ['src/backend/biz-op/module.js'] }] });
  denied(fixture(t, { 'src/runtime.js': "require('./helper')", 'src/helper.js': "require('./backend/biz-op/module')", 'src/backend/biz-op/module.js': '' }, [b]).result, 'ARCH-DESCRIPTOR-COMPOSITION');
  denied(fixture(t, { 'src/runtime.js': "require('./composition')", 'src/composition.js': '' }, [b]).result, 'ARCH-DESCRIPTOR-COMPOSITION');
  clean(fixture(t, { 'src/runtime.js': 'exports.create=descriptors=>descriptors;', 'src/composition.js': "const {create}=require('./backend/biz-op/module')", 'src/backend/biz-op/module.js': 'exports.create=()=>{};' }, [b]).result);
});

test('pending 文件出现即执行；active 必须有入口、消费方和证据', t => {
  const b = boundary('ARCH-PURE-LINEAGE', { entrypoints: ['src/future.js'], allowedLocal: ['src/future.js'] });
  const absent = fixture(t, {}, [b]).result; assert.deepEqual(absent.pendingBoundaries, ['fixture']);
  denied(fixture(t, { 'src/future.js': "require('node:fs')" }, [b]).result, 'ARCH-PURE-LINEAGE');
  denied(fixture(t, {}, [{ ...b, state: 'active' }]).result, 'ARCH-STATIC-COVERAGE');
});

test('schema 拒绝未知字段、缺 owner、glob、循环例外及不完整 bootstrap', t => {
  const value = fixture(t, {}, [boundary('ARCH-CYCLE')]);
  for (const mutate of [c => { c.boundaries[0].unknown = true; }, c => { delete c.boundaries[0].owner; }, c => { c.boundaries[0].entrypoints = ['src/**']; }, c => { c.boundaries[0].allowedApiFields = { anything: [] }; }]) {
    const copy = structuredClone(value.config); mutate(copy); assert.throws(() => validateBoundaries(copy));
  }
  assert.throws(() => validateBootstrapComplete(value.config));
  assert.throws(() => validateAllowlist({ ...value.allowlist, exceptions: [{ ...exception({ from: 'src/a.js', functionPath: null, evidenceId: 'a'.repeat(64) }, 'ARCH-CYCLE') }] }));
});
