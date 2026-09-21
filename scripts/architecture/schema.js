'use strict';

// 所有具有规则语义的字段必须同时纳入 policy-history 的强度比较。
const RULES = Object.freeze(['ARCH-CYCLE', 'ARCH-PLATFORM-CORE', 'ARCH-PURE-LINEAGE',
  'ARCH-RENDERER-SCOPE', 'ARCH-MODAL-OWNER', 'ARCH-XLSX-INFRA',
  'ARCH-PUBLICATION-RECOVERY-ENTRY', 'ARCH-BIZOP-RECOVERY-PRIVATE', 'ARCH-TASK-ADAPTER',
  'ARCH-BIZOP-QUERY', 'ARCH-DESCRIPTOR-COMPOSITION', 'ARCH-STATIC-COVERAGE']);
const BOUNDARY_FIELDS = Object.freeze(['id', 'governance', 'owner', 'state', 'rules', 'entrypoints',
  'allowedLocal', 'allowedExternal', 'requiredConsumers', 'activationEvidence', 'protectedScopes',
  'restrictedApis', 'allowedSites', 'compositionEntrypoints', 'globals', 'factory',
  'allowedApiFields', 'deprecatedEntrypoints', 'directory']);
function fail(at, message) { const error = new Error(`${at}: ${message}`); error.code = 'ARCHITECTURE_CONFIG_INVALID'; throw error; }
function object(value, fields, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(at, '必须是对象');
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${at}.${key}`, '未知字段');
}
function string(value, at) { if (typeof value !== 'string' || !value.trim()) fail(at, '必须是非空字符串'); }
function array(value, at, item) {
  if (!Array.isArray(value)) fail(at, '必须是数组');
  value.forEach((v, i) => item(v, `${at}[${i}]`));
  if (new Set(value.map(v => JSON.stringify(v))).size !== value.length) fail(at, '不允许重复项');
}
function path(value, at) {
  string(value, at);
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || /[\\*?\[\]{}\x00]/.test(value)
      || value.split('/').some(p => !p || p === '.' || p === '..')) fail(at, '必须是仓库内精确 POSIX 路径，不允许 glob 或越界');
}
function hash(value, at, length = 40) { if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) fail(at, `必须是 ${length} 位内容指纹`); }
function strings(value, at) { array(value, at, string); }
function paths(value, at) { array(value, at, path); }
function functionPath(value, at) { if (value !== null) string(value, at); }
function rules(value, at) { array(value, at, (v, p) => { if (!RULES.includes(v)) fail(p, '未知规则'); }); }
function scope(value, at) { object(value, ['path', 'functionPath'], at); path(value.path, `${at}.path`); functionPath(value.functionPath, `${at}.functionPath`); }
function site(value, at) {
  object(value, ['rule', 'from', 'functionPath', 'callee', 'evidenceId', 'reason'], at);
  rules([value.rule], `${at}.rule`); path(value.from, `${at}.from`); functionPath(value.functionPath, `${at}.functionPath`);
  string(value.callee, `${at}.callee`); hash(value.evidenceId, `${at}.evidenceId`, 64); string(value.reason, `${at}.reason`);
}
function consumer(value, at) {
  object(value, ['from', 'to', 'kind', 'importedNames'], at); path(value.from, `${at}.from`);
  if (value.to !== undefined) path(value.to, `${at}.to`);
  string(value.kind, `${at}.kind`); strings(value.importedNames, `${at}.importedNames`);
}
function deprecated(value, at) {
  object(value, ['path', 'replacementPaths', 'exportNames', 'existingConsumers', 'state', 'retirementEvidence'], at);
  path(value.path, `${at}.path`); paths(value.replacementPaths, `${at}.replacementPaths`);
  if (!value.replacementPaths.length) fail(at, '必须列明替代入口');
  if (value.exportNames !== null) strings(value.exportNames, `${at}.exportNames`);
  array(value.existingConsumers, `${at}.existingConsumers`, consumer);
  if (!['compat', 'retired'].includes(value.state)) fail(at, '未知兼容状态');
  paths(value.retirementEvidence, `${at}.retirementEvidence`);
  if (value.state === 'retired' && !value.retirementEvidence.length) fail(at, '退役必须具备证据');
}
function boundary(value, at) {
  object(value, BOUNDARY_FIELDS, at);
  for (const key of ['id', 'owner', 'governance']) string(value[key], `${at}.${key}`);
  if (!/^G[1-8]$/.test(value.governance)) fail(at, '未知治理归属');
  if (!['pending', 'partial', 'active'].includes(value.state)) fail(at, '未知边界状态');
  rules(value.rules, `${at}.rules`); if (!value.rules.length) fail(at, '边界至少绑定一条规则');
  for (const key of ['entrypoints', 'allowedLocal', 'activationEvidence']) paths(value[key], `${at}.${key}`);
  strings(value.allowedExternal, `${at}.allowedExternal`);
  if (value.allowedExternal.includes('node:*') && !value.rules.includes('ARCH-XLSX-INFRA')) fail(at, 'node 内置全能力仅用于 XLSX IO 基础层');
  if (value.allowedExternal.some(v => /[*?]/.test(v) && v !== 'node:*')) fail(at, '外部能力不允许任意通配');
  array(value.requiredConsumers, `${at}.requiredConsumers`, consumer);
  array(value.protectedScopes, `${at}.protectedScopes`, scope);
  array(value.restrictedApis, `${at}.restrictedApis`, (v, p) => {
    object(v, ['path', 'exportNames', 'operations'], p); path(v.path, `${p}.path`);
    if (v.exportNames !== null) strings(v.exportNames, `${p}.exportNames`); strings(v.operations, `${p}.operations`);
  });
  array(value.allowedSites, `${at}.allowedSites`, site);
  array(value.compositionEntrypoints, `${at}.compositionEntrypoints`, (v, p) => {
    object(v, ['path', 'importedNames', 'allowedTargets'], p); path(v.path, `${p}.path`);
    strings(v.importedNames, `${p}.importedNames`); paths(v.allowedTargets, `${p}.allowedTargets`);
  });
  array(value.globals, `${at}.globals`, (v, p) => {
    object(v, ['path', 'exportsGlobal', 'consumesGlobals'], p); path(v.path, `${p}.path`);
    strings(v.exportsGlobal, `${p}.exportsGlobal`); strings(v.consumesGlobals, `${p}.consumesGlobals`);
  });
  if (value.factory !== null) {
    object(value.factory, ['path', 'name', 'parameters'], `${at}.factory`);
    path(value.factory.path, `${at}.factory.path`); string(value.factory.name, `${at}.factory.name`);
    strings(value.factory.parameters, `${at}.factory.parameters`);
  }
  object(value.allowedApiFields, ['api', 'panel', 'ui', 'config', 'sharedReconSession', 'scenarioCommands'], `${at}.allowedApiFields`);
  for (const [key, fields] of Object.entries(value.allowedApiFields)) strings(fields, `${at}.allowedApiFields.${key}`);
  array(value.deprecatedEntrypoints, `${at}.deprecatedEntrypoints`, deprecated);
  if (value.directory !== null) path(value.directory, `${at}.directory`);
}
function validateBoundaries(value) {
  object(value, ['schemaVersion', 'factBaseline', 'bootstrap', 'boundaries', 'generatedModules', 'dynamicLoads', 'policyChanges'], 'boundaries');
  if (value.schemaVersion !== 1) fail('boundaries.schemaVersion', '不支持的版本');
  hash(value.factBaseline, 'boundaries.factBaseline');
  object(value.bootstrap, ['factBaseline', 'mode'], 'boundaries.bootstrap');
  if (value.bootstrap.factBaseline !== value.factBaseline || value.bootstrap.mode !== 'first-introduction') fail('boundaries.bootstrap', '首次引入记录不匹配');
  array(value.boundaries, 'boundaries.boundaries', boundary);
  if (new Set(value.boundaries.map(b => b.id)).size !== value.boundaries.length) fail('boundaries', '边界 id 重复');
  array(value.generatedModules, 'boundaries.generatedModules', (v, p) => {
    object(v, ['from', 'specifier', 'target', 'generator'], p); path(v.from, `${p}.from`); string(v.specifier, `${p}.specifier`);
    path(v.target, `${p}.target`); path(v.generator, `${p}.generator`);
  });
  array(value.dynamicLoads, 'boundaries.dynamicLoads', (v, p) => {
    object(v, ['from', 'functionPath', 'evidenceId', 'allowedTargets', 'reason'], p); path(v.from, `${p}.from`);
    functionPath(v.functionPath, `${p}.functionPath`); hash(v.evidenceId, `${p}.evidenceId`, 64);
    strings(v.allowedTargets, `${p}.allowedTargets`); string(v.reason, `${p}.reason`);
    for (const t of v.allowedTargets) if (!t.startsWith('node:') && !/^[a-z][a-z0-9-]*$/.test(t)) path(t, `${p}.allowedTargets`);
    if (!v.allowedTargets.length) fail(p, '动态加载必须列出全部目标');
  });
  array(value.policyChanges, 'boundaries.policyChanges', (v, p) => {
    object(v, ['sourceCommit', 'sourcePolicyBlob', 'boundaryId', 'field', 'from', 'to', 'reason', 'designDoc'], p);
    hash(v.sourceCommit, `${p}.sourceCommit`); hash(v.sourcePolicyBlob, `${p}.sourcePolicyBlob`);
    string(v.boundaryId, `${p}.boundaryId`); string(v.field, `${p}.field`); string(v.reason, `${p}.reason`); path(v.designDoc, `${p}.designDoc`);
    if (!Object.hasOwn(v, 'from') || !Object.hasOwn(v, 'to')) fail(p, '缺少准确迁移值');
  });
  return value;
}
function validateAllowlist(value) {
  object(value, ['schemaVersion', 'factBaseline', 'exceptions'], 'allowlist');
  if (value.schemaVersion !== 1) fail('allowlist.schemaVersion', '不支持的版本');
  hash(value.factBaseline, 'allowlist.factBaseline');
  array(value.exceptions, 'allowlist.exceptions', (v, p) => {
    object(v, ['id', 'rule', 'from', 'to', 'kind', 'importedNames', 'functionPath', 'evidenceId', 'originalCommit', 'reason', 'governance', 'removeWhen', 'cycleEdges', 'edgeKinds'], p);
    for (const k of ['id', 'reason', 'governance', 'removeWhen']) string(v[k], `${p}.${k}`);
    if (v.reason.trim() === '历史原因') fail(p, '必须说明准确历史原因');
    rules([v.rule], `${p}.rule`);
    if (v.rule === 'ARCH-CYCLE') {
      array(v.cycleEdges, `${p}.cycleEdges`, (edge, at) => { object(edge, ['from', 'to', 'kind'], at); path(edge.from, `${at}.from`); path(edge.to, `${at}.to`); string(edge.kind, `${at}.kind`); });
      strings(v.edgeKinds, `${p}.edgeKinds`);
      if (!v.cycleEdges.length || !v.edgeKinds.some(k => ['worker', 'classic-global'].includes(k))) fail(p, '零字面量环基线只允许准确登记既有扩展边 SCC');
      if (JSON.stringify([...new Set(v.cycleEdges.map(e => e.kind))].sort()) !== JSON.stringify([...v.edgeKinds].sort())) fail(p, 'edgeKinds 与完整 SCC 边不符');
    } else if (v.cycleEdges !== undefined || v.edgeKinds !== undefined) fail(p, '循环证据仅用于 ARCH-CYCLE');
    path(v.from, `${p}.from`); hash(v.originalCommit, `${p}.originalCommit`);
    if (v.to !== undefined) { path(v.to, `${p}.to`); string(v.kind, `${p}.kind`); }
    if (v.importedNames !== undefined) strings(v.importedNames, `${p}.importedNames`);
    if (v.evidenceId !== undefined) { hash(v.evidenceId, `${p}.evidenceId`, 64); functionPath(v.functionPath, `${p}.functionPath`); }
    if (v.to === undefined && v.evidenceId === undefined) fail(p, '必须有精确依赖边或 AST 指纹');
  });
  if (new Set(value.exceptions.map(e => e.id)).size !== value.exceptions.length) fail('allowlist', '例外 id 重复');
  return value;
}
const REQUIRED_BOUNDARIES = Object.freeze({
  "production-graph": [
    "ARCH-CYCLE",
    "ARCH-STATIC-COVERAGE"
  ],
  "platform-core": [
    "ARCH-PLATFORM-CORE"
  ],
  "vcc-mapped-lineage": [
    "ARCH-PURE-LINEAGE"
  ],
  "renderer-modal-owner": [
    "ARCH-MODAL-OWNER"
  ],
  "renderer-bank-statement": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-recon-id-fix": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-pre-fund": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-bank-bu": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-duplicate-inbound": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-acquiring": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-vcc-op-calc": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-biz-op-legacy": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-statement": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-new-account": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-pending": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-position": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-vcc-financial-op": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-biz-op-v327": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-dialog-scenarios": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-dialog-configuration": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-services": [
    "ARCH-RENDERER-SCOPE"
  ],
  "shared-xlsx": [
    "ARCH-XLSX-INFRA"
  ],
  "publication-recovery-entry": [
    "ARCH-PUBLICATION-RECOVERY-ENTRY"
  ],
  "bizop-recovery-private": [
    "ARCH-BIZOP-RECOVERY-PRIVATE"
  ],
  "business-task-adapters": [
    "ARCH-TASK-ADAPTER"
  ],
  "bizop-query-q1": [
    "ARCH-BIZOP-QUERY"
  ],
  "bizop-query-q2": [
    "ARCH-BIZOP-QUERY"
  ],
  "bizop-query-q3": [
    "ARCH-BIZOP-QUERY"
  ],
  "descriptor-composition": [
    "ARCH-DESCRIPTOR-COMPOSITION"
  ],
  "renderer-dialog-app-settings": [
    "ARCH-RENDERER-SCOPE"
  ],
  "renderer-dialog-toolbox": [
    "ARCH-RENDERER-SCOPE"
  ]
});
function validateBootstrapComplete(value) {
  validateBoundaries(value);
  for (const [id, requiredRules] of Object.entries(REQUIRED_BOUNDARIES)) {
    const boundary = value.boundaries.find(b => b.id === id);
    if (!boundary || requiredRules.some(rule => !boundary.rules.includes(rule))) fail('boundaries.bootstrap', '缺少完整计划子边界或规则绑定：' + id);
    if (id !== 'production-graph' && !boundary.entrypoints.length) fail('boundaries.bootstrap', '计划边界不得以空入口失效：' + id);
  }
  for (const id of ['production-graph', 'platform-core']) if (value.boundaries.find(b => b.id === id).state !== 'active') fail('boundaries.bootstrap', '立即生效规则不得延后：' + id);
  const core = value.boundaries.find(b => b.id === 'platform-core');
  for (const name of ['resource-governor', 'resource-lease', 'admission-queue']) {
    const file = `src/main-process/background-execution/${name}.js`;
    if (!core.entrypoints.includes(file) || !core.allowedLocal.includes(file)) fail('boundaries.bootstrap', '缺少立即保护的核心入口：' + file);
  }
  return value;
}
module.exports = { RULES, BOUNDARY_FIELDS, REQUIRED_BOUNDARIES, validateBootstrapComplete, validateBoundaries, validateAllowlist };
