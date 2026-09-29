'use strict';
const { scopeContains, factoryCalls, factoryPresent } = require('./contracts');

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateBootstrapComplete, validateAllowlist } = require('./schema');

const POLICY_PATH = 'architecture/boundaries.json';
const ALLOWLIST_PATH = 'architecture/legacy-allowlist.json';
const REPAIRS_PATH = 'architecture/policy-history-repairs.json';
const REPAIR_DIRECTORY = 'architecture/policy-history-repairs/';
const PROTECTED_SETS = new Set(['rules', 'entrypoints', 'requiredConsumers', 'activationEvidence']);
const ALLOWED_SETS = new Set(['allowedLocal', 'allowedExternal', 'allowedSites']);
const INFORMATION_FIELDS = new Set(['id', 'state', 'owner']);

function inputError(message, git = false) {
  const error = new Error(message);
  error.code = 'ARCHITECTURE_HISTORY_INPUT';
  error.exitCode = 2;
  error.gitInput = git;
  return error;
}

function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return JSON.stringify(value);
}

function same(left, right) { return canonical(left) === canonical(right); }
function includesAll(container, required) {
  return Array.isArray(container) && Array.isArray(required) && required.every((item) => container.some((candidate) => same(item, candidate)));
}

function meaningfulReason(value) {
  return typeof value === 'string' && value.trim().length > 0 && !['重构', '历史原因', '修复', '调整'].includes(value.trim());
}

function validPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !/[\0*?\[\]]/.test(value) &&
    !path.posix.isAbsolute(value) && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function checkPolicyHistory({ root, config, allowlist, against = 'HEAD', scan: suppliedScan }) {
  const repository = path.resolve(root);
  const blobCache = new Map();
  const treeCache = new Map();
  const ancestryCache = new Map();
  const diagnostics = [];
  const violations = [];
  const appliedPolicyChanges = new Map();
  const historyRepairsApplied = new Map();
  let currentScan = suppliedScan;

  function git(args, options = {}) {
    try {
      return execFileSync('git', args, { cwd: repository, encoding: options.buffer ? null : 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      throw inputError(`Git 历史不可读取（${args[0]}）：${String(error.stderr || error.message).trim()}`, true);
    }
  }

  function commit(ref) {
    if (typeof ref !== 'string' || !ref.trim() || /^0+$/.test(ref) || ref.includes('\0')) throw inputError('对比提交不能为空或全零 SHA');
    return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  }

  function ancestor(older, newer) {
    const key = `${older}:${newer}`;
    if (!ancestryCache.has(key)) {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
        ancestryCache.set(key, true);
      } catch (error) {
        if (error.status !== 1) throw inputError(`Git 祖先关系不可读取：${older} → ${newer}`, true);
        ancestryCache.set(key, false);
      }
    }
    return ancestryCache.get(key);
  }

  function historicalFile(at, relative) {
    if (!validPath(relative)) throw inputError(`历史材料路径非法：${relative}`);
    const key = `${at}:${relative}`;
    if (!treeCache.has(key)) {
      const listing = git(['ls-tree', '-z', at, '--', relative]);
      const rows = listing.split('\0').filter(Boolean);
      const row = rows.find((item) => item.slice(item.indexOf('\t') + 1) === relative);
      if (!row) treeCache.set(key, null);
      else {
        const [mode, type, blob] = row.slice(0, row.indexOf('\t')).split(' ');
        if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw inputError(`历史材料必须为普通文件：${at}/${relative}`);
        if (!blobCache.has(blob)) blobCache.set(blob, git(['cat-file', 'blob', blob], { buffer: true }));
        treeCache.set(key, { blob, bytes: blobCache.get(blob) });
      }
    }
    return treeCache.get(key);
  }

  function currentFile(relative) {
    if (!validPath(relative)) throw inputError(`当前材料路径非法：${relative}`);
    let absolute = repository;
    try {
      for (const segment of relative.split('/')) {
        absolute = path.join(absolute, segment);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw inputError(`当前材料不得通过 symlink 读取：${relative}`);
      }
      if (!fs.statSync(absolute).isFile()) throw inputError(`当前材料必须为普通文件：${relative}`);
      return { bytes: fs.readFileSync(absolute) };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.exitCode === 2) throw error;
      throw inputError(`当前材料无法读取：${relative}：${error.message}`);
    }
  }

  function parse(bytes, label) {
    try { return JSON.parse(bytes.toString('utf8')); } catch (error) { throw inputError(`JSON 语法损坏：${label}：${error.message}`); }
  }

  function schema(value, relative, label) {
    try { return (relative === POLICY_PATH ? validateBootstrapComplete : validateAllowlist)(value); }
    catch (error) { throw inputError(`配置 schema 无效：${label}：${error.message}`); }
  }

  schema(config, POLICY_PATH, '当前 boundaries');
  schema(allowlist, ALLOWLIST_PATH, '当前 allowlist');
  for (const [relative, provided] of [[POLICY_PATH, config], [ALLOWLIST_PATH, allowlist]]) {
    const file = currentFile(relative);
    if (!file) throw inputError(`当前缺少必需架构配置：${relative}`);
    if (!same(schema(parse(file.bytes, relative), relative, relative), provided)) throw inputError(`当前配置与调用方读取的数据不一致，请重新读取：${relative}`);
  }
  // Windows 的短路径、大小写拼写可能不同，根目录约束比较物理身份。
  const gitRoot = fs.statSync(git(['rev-parse', '--show-toplevel']).trim(), { bigint: true });
  const scanRoot = fs.statSync(repository, { bigint: true });
  if (!gitRoot.isDirectory() || !scanRoot.isDirectory() || gitRoot.dev !== scanRoot.dev || gitRoot.ino !== scanRoot.ino) throw inputError('扫描 root 必须是独立 Git 仓库或 worktree 的根，不能借用父仓库历史');
  if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw inputError('架构历史检查要求完整 Git 历史，shallow 仓库不能作为 bootstrap');
  const head = commit('HEAD');
  const policyComparedWith = commit(against);
  const baseline = commit(config.factBaseline);
  const roots = [...new Set([head, policyComparedWith])].sort();
  if (baseline !== config.factBaseline || allowlist.factBaseline !== baseline) throw inputError('factBaseline 必须为完整提交 SHA，且两个配置必须一致');
  for (const at of roots) if (!ancestor(baseline, at)) throw inputError(`factBaseline ${baseline} 不是历史根 ${at} 的祖先`);
  const missing = git(['rev-list', '--objects', '--missing=print', ...roots, `^${baseline}`]).split('\n').find((line) => line.startsWith('?'));
  if (missing) throw inputError(`Git 历史缺失对象：${missing.slice(1)}`, true);
  const commits = [baseline, ...git(['rev-list', '--reverse', '--topo-order', ...roots, `^${baseline}`]).trim().split('\n').filter(Boolean)];
  const reachable = new Set(commits);
  if (historicalFile(baseline, POLICY_PATH)) throw inputError('固定事实基线已存在 boundaries.json，不能重新声明首次 bootstrap');
  if (!config.bootstrap || config.bootstrap.mode !== 'first-introduction' || config.bootstrap.factBaseline !== baseline) throw inputError('当前配置缺少一致的 first-introduction bootstrap');

  function validateRepairManifest(value) {
    if (!value || Array.isArray(value) || typeof value !== 'object' || value.schemaVersion !== 1 || !Array.isArray(value.repairs) || Object.keys(value).some((key) => !['schemaVersion', 'repairs'].includes(key))) throw inputError('repair manifest 必须符合 schemaVersion:1 / repairs 严格结构');
    const keys = new Set();
    for (const entry of value.repairs) {
      const fields = ['path', 'originalBlob', 'sourceCommits', 'repairedPath', 'repairedSha256', 'reason', 'reviewEvidence'];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== fields.length || fields.some((field) => !(field in entry)) || Object.keys(entry).some((key) => !fields.includes(key))) throw inputError('repair 条目字段不完整或包含未知字段');
      if (![POLICY_PATH, ALLOWLIST_PATH].includes(entry.path) || !/^[0-9a-f]{40,64}$/.test(entry.originalBlob) || !/^[0-9a-f]{64}$/.test(entry.repairedSha256) || entry.repairedPath !== `${REPAIR_DIRECTORY}${entry.originalBlob}.json` || !validPath(entry.reviewEvidence) || !meaningfulReason(entry.reason) || !Array.isArray(entry.sourceCommits) || !entry.sourceCommits.length || entry.sourceCommits.some((source) => !/^[0-9a-f]{40,64}$/.test(source))) throw inputError('repair 条目的 path/blob/hash/sourceCommits/reason/evidence 非法');
      const key = `${entry.path}:${entry.originalBlob}`;
      if (keys.has(key)) throw inputError(`repair 重复绑定：${key}`);
      keys.add(key);
    }
    return value.repairs;
  }

  function validateRepair(entry, at) {
    for (const source of entry.sourceCommits) {
      if (!reachable.has(source) || !(at ? ancestor(source, at) : roots.some((tip) => ancestor(source, tip)))) throw inputError(`repair sourceCommit 当时不可达：${source}`);
      const original = historicalFile(source, entry.path);
      if (!original || original.blob !== entry.originalBlob) throw inputError(`repair 原始 blob 不匹配：${source}/${entry.path}`);
      let malformed = false;
      try { JSON.parse(original.bytes.toString('utf8')); } catch { malformed = true; }
      if (!malformed) throw inputError(`repair 只允许 JSON 语法损坏，不能替代可解析配置：${source}/${entry.path}`);
    }
    const snapshot = at ? historicalFile(at, entry.repairedPath) : currentFile(entry.repairedPath);
    const evidence = at ? historicalFile(at, entry.reviewEvidence) : currentFile(entry.reviewEvidence);
    if (!snapshot || !evidence || !evidence.bytes.toString('utf8').trim()) throw inputError(`repair 缺少重建快照或审查依据：${entry.originalBlob}`);
    const hash = crypto.createHash('sha256').update(snapshot.bytes).digest('hex');
    if (hash !== entry.repairedSha256) throw inputError(`repair 重建 hash 不匹配：${entry.originalBlob}`);
    const rebuilt = schema(parse(snapshot.bytes, entry.repairedPath), entry.path, entry.repairedPath);
    if (rebuilt.factBaseline !== baseline) throw inputError(`repair 不得改变 factBaseline：${entry.originalBlob}`);
    return { entry, rebuilt };
  }

  const historicalBindings = new Map();
  for (const at of commits) {
    let entries;
    try {
      const manifest = historicalFile(at, REPAIRS_PATH);
      if (!manifest) continue;
      entries = validateRepairManifest(parse(manifest.bytes, `${at}/${REPAIRS_PATH}/${manifest.blob}`));
    }
    catch (error) {
      if (error.gitInput) throw error;
      diagnostics.push({ commit: at, path: REPAIRS_PATH, message: error.message });
      continue;
    }
    for (const entry of entries) {
      let binding;
      try { binding = validateRepair(entry, at); }
      catch (error) {
        if (error.gitInput) throw error;
        diagnostics.push({ commit: at, path: REPAIRS_PATH, originalBlob: entry.originalBlob, message: error.message });
        continue;
      }
      const key = `${entry.path}:${entry.originalBlob}`;
      const prior = historicalBindings.get(key);
      if (prior && prior.entry.repairedSha256 !== entry.repairedSha256) throw inputError(`历史 repair 出现两个完整有效但不一致的绑定：${key}`);
      historicalBindings.set(key, binding);
    }
  }

  const currentManifest = currentFile(REPAIRS_PATH);
  const repairs = new Map();
  for (const entry of currentManifest ? validateRepairManifest(parse(currentManifest.bytes, REPAIRS_PATH)) : []) {
    const binding = validateRepair(entry, null);
    repairs.set(`${entry.path}:${entry.originalBlob}`, binding);
  }
  for (const [key, binding] of historicalBindings) {
    if (!repairs.has(key) || repairs.get(key).entry.repairedSha256 !== binding.entry.repairedSha256) throw inputError(`当前必须保留历史完整有效的 repair 绑定：${key}`);
  }

  function historicalConfig(at, relative) {
    const file = historicalFile(at, relative);
    if (!file) return null;
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); }
    catch (error) {
      const binding = repairs.get(`${relative}:${file.blob}`);
      if (!binding) throw inputError(`历史 JSON 语法损坏且无有效 repair：commit=${at} path=${relative} blob=${file.blob}：${error.message}`);
      value = binding.rebuilt;
      const key = `${relative}:${file.blob}`;
      if (!historyRepairsApplied.has(key)) historyRepairsApplied.set(key, { path: relative, originalBlob: file.blob, sourceCommits: [], repairedSha256: binding.entry.repairedSha256, reviewEvidence: binding.entry.reviewEvidence });
      historyRepairsApplied.get(key).sourceCommits.push(at);
    }
    schema(value, relative, `${at}/${relative}/${file.blob}`);
    if (value.factBaseline !== baseline) throw inputError(`历史配置改变了 factBaseline：${at}/${relative}`);
    if (relative === POLICY_PATH && (!value.bootstrap || value.bootstrap.factBaseline !== baseline || value.bootstrap.mode !== 'first-introduction')) throw inputError(`历史配置缺少原 bootstrap：${at}/${relative}`);
    return { commit: at, blob: file.blob, value };
  }

  const snapshots = [];
  const legacySnapshots = [];
  for (const at of commits) {
    const policy = historicalConfig(at, POLICY_PATH);
    const legacy = historicalConfig(at, ALLOWLIST_PATH);
    if (legacy) legacySnapshots.push(legacy);
    if (policy) snapshots.push({ ...policy, legacy });
    else if (snapshots.length) diagnostics.push({ commit: at, path: POLICY_PATH, message: '历史提交缺少配置；当前恢复后仍按此前完整历史底线核对' });
  }
  const snapshotByCommit = new Map(snapshots.map((snapshot) => [snapshot.commit, snapshot]));
  const changes = config.policyChanges || [];

  function changeSource(change) {
    const source = snapshotByCommit.get(change.sourceCommit);
    if (!source) return null;
    if (change.boundaryId === '$allowlist' && change.field === 'exceptions') {
      return source.legacy && { source, blob: source.legacy.blob, holder: { id: '$allowlist', exceptions: source.legacy.value.exceptions } };
    }
    if (change.boundaryId === '$policy' && ['generatedModules', 'dynamicLoads'].includes(change.field)) {
      return { source, blob: source.blob, holder: { id: '$policy', [change.field]: source.value[change.field] } };
    }
    return { source, blob: source.blob, holder: source.value.boundaries.find((item) => item.id === change.boundaryId) };
  }

  for (const change of changes) {
    const source = changeSource(change);
    const boundary = source && source.holder;
    if (!source || source.blob !== change.sourcePolicyBlob || !boundary || !Object.hasOwn(boundary, change.field) || !same(boundary[change.field], change.from)) throw inputError(`policyChanges 原始提交/blob/字段值不匹配：${change.boundaryId}.${change.field}`);
    const evidence = currentFile(change.designDoc);
    if (!evidence || !evidence.bytes.toString('utf8').trim() || !meaningfulReason(change.reason)) throw inputError(`policyChanges 缺少具体原因或当前设计依据：${change.boundaryId}.${change.field}`);
    if (['id', 'state'].includes(change.field)) throw inputError(`policyChanges 不能豁免 active/retired 身份和状态：${change.boundaryId}.${change.field}`);
    if (change.boundaryId === '$allowlist') schema({ ...source.source.legacy.value, exceptions: change.to }, ALLOWLIST_PATH, 'policyChanges.to');
    else {
      const target = structuredClone(source.source.value);
      if (change.boundaryId === '$policy') target[change.field] = change.to;
      else target.boundaries.find((item) => item.id === change.boundaryId)[change.field] = change.to;
      schema(target, POLICY_PATH, 'policyChanges.to');
    }
  }

  function hasMigration(snapshot, oldBoundary, field, current) {
    if (['rules', 'state', 'id', 'governance'].includes(field)) return false;
    if (!currentMigrationValid(oldBoundary, field, current)) return false;
    const candidates = changes.filter((change) => change.boundaryId === oldBoundary.id && change.field === field && preservesCapabilities(change));
    const visited = new Set();
    function walk(at, value, used) {
      for (const change of candidates) {
        const index = changes.indexOf(change);
        if (used.has(index) || !same(change.from, value) || !ancestor(at, change.sourceCommit)) continue;
        const key = `${change.sourceCommit}:${index}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const nextUsed = new Set([...used, index]);
        if (same(change.to, current)) {
          for (const item of nextUsed) appliedPolicyChanges.set(item, changes[item]);
          return true;
        }
        const next = candidates.filter((candidate) => candidate.sourceCommit !== change.sourceCommit && ancestor(change.sourceCommit, candidate.sourceCommit) && same(candidate.from, change.to));
        for (const candidate of next) {
          if (walk(candidate.sourceCommit, change.to, nextUsed)) return true;
        }
      }
      return false;
    }
    return walk(snapshot.commit, oldBoundary[field], new Set());
  }

  function getCurrentScan() {
    if (!currentScan) currentScan = require('./scan').scan(repository, config);
    return currentScan;
  }

  function scopePresent(scope) {
    const analysis = getCurrentScan().analyses.get(scope.path);
    return Boolean(analysis && (scope.functionPath === null || analysis.functionNodes.has(scope.functionPath)));
  }

  function currentMigrationValid(oldBoundary, field, value) {
    if (field === 'factory' && value) {
      const graph = getCurrentScan();
      if (!factoryPresent(graph, value) || !factoryCalls(graph, value).length) return false;
      const old = oldBoundary.factory;
      if (old && old.name !== value.name && factoryCalls(graph, old).length) return false;
      if (old && old.path !== value.path && factoryPresent(graph, old)) return false;
    }
    if (field === 'protectedScopes') {
      if (!value.every(scopePresent)) return false;
      for (const oldScope of oldBoundary.protectedScopes) {
        const stillProtected = value.some((scope) => scopeContains(scope, oldScope));
        // 旧函数/文件仍在时继续保留保护；兼容期可以同时登记旧、新范围。
        if (!stillProtected && scopePresent(oldScope)) return false;
      }
    }
    if (field === 'restrictedApis') {
      for (const oldApi of oldBoundary.restrictedApis) {
        const retained = value.some((api) => api.path === oldApi.path && includesAll(api.operations, oldApi.operations) &&
          (api.exportNames === null || (oldApi.exportNames !== null && includesAll(api.exportNames, oldApi.exportNames))));
        if (!retained && currentFile(oldApi.path)) return false;
      }
      if (!value.every((api) => currentFile(api.path))) return false;
    }
    if (field === 'entrypoints') {
      const now = config.boundaries.find((boundary) => boundary.id === oldBoundary.id);
      const moved = oldBoundary.entrypoints.filter((entry) => !value.includes(entry));
      const replacements = value.filter((entry) => !oldBoundary.entrypoints.includes(entry));
      const graph = getCurrentScan();
      if (!value.every((entry) => graph.files.includes(entry))) return false;
      if (moved.some((entry) => graph.edges.some((edge) => edge.to === entry))) return false;
      for (const entry of moved) {
        const before = oldBoundary.requiredConsumers.filter((consumer) => consumer.to === entry);
        const after = now.requiredConsumers.filter((consumer) => replacements.includes(consumer.to));
        if (!after.length || !before.every((consumer) => after.some((next) => next.from === consumer.from && next.kind === consumer.kind && includesAll(next.importedNames, consumer.importedNames)))) return false;
        if (!after.every((consumer) => graph.edges.some((edge) => edge.from === consumer.from && edge.to === consumer.to && edge.kind === consumer.kind && includesAll(edge.importedNames || [], consumer.importedNames)))) return false;
      }
    }
    return true;
  }

  function preservesCapabilities(change) {
    const { field, from, to } = change;
    if (['entrypoints', 'requiredConsumers', 'activationEvidence', 'protectedScopes', 'globals', 'deprecatedEntrypoints'].includes(field)) {
      if (!Array.isArray(to) || (from.length > 0 && to.length === 0)) return false;
      if (field === 'protectedScopes') {
        if (to.length < from.length) return false;
        if (from.some((scope) => scope.functionPath === null) && !to.some((scope) => scope.functionPath === null)) return false;
        if (from.some((scope) => scope.functionPath !== null && to.some((next) => next.path === scope.path && next.functionPath !== null && next.functionPath.startsWith(`${scope.functionPath}.`)))) return false;
      }
    }
    if (field === 'factory' && from && !to) return false;
    // 删除键会让 rules.js 不再检查该注入对象的方法集合，不是收紧为空集合。
    if (field === 'allowedApiFields' && Object.keys(from).some(name => !Object.hasOwn(to, name))) return false;
    if (field === 'directory' && from && !to) return false;
    if (field === 'restrictedApis') {
      if (!Array.isArray(to) || to.length < from.length) return false;
      if (!from.every((api) => to.some((candidate) => includesAll(candidate.operations, api.operations) &&
        (candidate.exportNames === null || (api.exportNames !== null && includesAll(candidate.exportNames, api.exportNames)))))) return false;
    }
    if (field === 'exceptions') {
      // 显式搬迁沿用原例外身份和禁止能力，不把一份旧豁免复制成多个位置。
      if (!Array.isArray(to) || to.length > from.length) return false;
      if (!to.every((entry) => from.some((prior) => prior.id === entry.id && prior.rule === entry.rule && prior.originalCommit === entry.originalCommit && prior.governance === entry.governance && same(prior.importedNames, entry.importedNames) &&
        (prior.rule !== 'ARCH-CYCLE' || (same(prior.cycleEdges, entry.cycleEdges) && same(prior.edgeKinds, entry.edgeKinds) && prior.evidenceId === entry.evidenceId))))) return false;
    }
    if (field === 'generatedModules' && (!Array.isArray(to) || to.length > from.length)) return false;
    if (field === 'dynamicLoads' && (!Array.isArray(to) || to.length > from.length || !to.every((entry) => from.some((prior) => includesAll(prior.allowedTargets, entry.allowedTargets))))) return false;
    return true;
  }

  function violation(snapshot, boundaryId, field, message) {
    violations.push({ rule: 'ARCH-POLICY-HISTORY', from: POLICY_PATH, to: null, line: null, column: null, boundaryId, field, sourceCommit: snapshot.commit, sourcePolicyBlob: snapshot.blob, message });
  }

  function stronger(field, oldValue, nextValue) {
    if (same(oldValue, nextValue)) return true;
    if (PROTECTED_SETS.has(field)) return includesAll(nextValue, oldValue);
    if (ALLOWED_SETS.has(field)) return includesAll(oldValue, nextValue);
    if (field === 'allowedApiFields') return nextValue && oldValue
      && Object.keys(oldValue).every(name => Object.hasOwn(nextValue, name))
      && Object.entries(nextValue).every(([name, methods]) => includesAll(oldValue[name], methods));
    if (field === 'compositionEntrypoints') return Array.isArray(nextValue) && nextValue.every((site) => oldValue.some((previous) => previous.path === site.path && includesAll(previous.importedNames, site.importedNames) && includesAll(previous.allowedTargets, site.allowedTargets)));
    if (field === 'protectedScopes') return Array.isArray(nextValue) && oldValue.every((scope) => nextValue.some((candidate) => scopeContains(candidate, scope)));
    if (field === 'restrictedApis') return Array.isArray(nextValue) && oldValue.every((api) => nextValue.some((candidate) => candidate.path === api.path && (candidate.exportNames === null || (api.exportNames !== null && includesAll(candidate.exportNames, api.exportNames))) && includesAll(candidate.operations || [], api.operations || [])));
    return false;
  }

  const activeIds = new Set();
  const retiredPaths = new Set();
  for (const snapshot of snapshots) {
    for (const oldBoundary of snapshot.value.boundaries) {
      const current = config.boundaries.find((boundary) => boundary.id === oldBoundary.id);
      for (const retired of oldBoundary.deprecatedEntrypoints || []) {
        if (retired.state !== 'retired') continue;
        retiredPaths.add(retired.path);
        const now = current && (current.deprecatedEntrypoints || []).find((entry) => entry.path === retired.path);
        if (!now || now.state !== 'retired') violation(snapshot, oldBoundary.id, 'deprecatedEntrypoints', `已退役入口不得删除登记或恢复 compat：${retired.path}`);
        else if (!same(now.exportNames, retired.exportNames) || !includesAll(now.replacementPaths, retired.replacementPaths)
          || !includesAll(retired.existingConsumers, now.existingConsumers) || !includesAll(now.retirementEvidence, retired.retirementEvidence)) {
          violation(snapshot, oldBoundary.id, 'deprecatedEntrypoints', `已退役入口的成员、消费者与证据约束不得放宽：${retired.path}`);
        }
      }
      if (oldBoundary.state !== 'active') continue;
      activeIds.add(oldBoundary.id);
      if (!current || current.state !== 'active') {
        violation(snapshot, oldBoundary.id, 'state', `历史已激活边界不得消失或降级：${oldBoundary.id}`);
        continue;
      }
      for (const field of new Set([...Object.keys(oldBoundary), ...Object.keys(current)])) {
        if (INFORMATION_FIELDS.has(field)) continue;
        if (field === 'deprecatedEntrypoints') {
          const previous = oldBoundary[field] || [];
          const now = current[field] || [];
          const valid = previous.every((entry) => now.some((candidate) => candidate.path === entry.path && includesAll(candidate.replacementPaths, entry.replacementPaths) && same(candidate.exportNames, entry.exportNames) && includesAll(entry.existingConsumers, candidate.existingConsumers) && (entry.state !== 'retired' || candidate.state === 'retired') && includesAll(candidate.retirementEvidence, entry.retirementEvidence)));
          if (!valid && !hasMigration(snapshot, oldBoundary, field, now)) violation(snapshot, oldBoundary.id, field, `已激活边界的兼容入口/消费者约束被放宽：${oldBoundary.id}.${field}`);
        } else if (!stronger(field, oldBoundary[field], current[field]) && !hasMigration(snapshot, oldBoundary, field, current[field])) {
          violation(snapshot, oldBoundary.id, field, `已激活边界的保护字段被删除或放宽：${oldBoundary.id}.${field}`);
        }
      }
    }
    for (const field of ['generatedModules', 'dynamicLoads']) {
      const before = snapshot.value[field] || [];
      const after = config[field] || [];
      const constrained = field === 'dynamicLoads' ? after.every((site) => before.some((prior) => prior.from === site.from && prior.functionPath === site.functionPath && prior.evidenceId === site.evidenceId && includesAll(prior.allowedTargets, site.allowedTargets))) : includesAll(before, after);
      if (!constrained && !hasMigration(snapshot, { id: '$policy', [field]: before }, field, after)) violation(snapshot, '$policy', field, `已登记的加载/生成允许集合不得无依据扩大：${field}`);
    }
  }
  for (const snapshot of legacySnapshots) {
    if (!includesAll(snapshot.value.exceptions, allowlist.exceptions) && !hasMigration(snapshot, { id: '$allowlist', exceptions: snapshot.value.exceptions }, 'exceptions', allowlist.exceptions)) violation(snapshot, '$allowlist', 'exceptions', '历史例外不得新增、复活或无精确证据搬迁到新位置');
  }

  const unique = new Map();
  for (const item of violations) unique.set(`${item.boundaryId}:${item.field}:${item.sourceCommit}:${item.message}`, item);
  return {
    violations: [...unique.values()].sort((a, b) => canonical(a).localeCompare(canonical(b))),
    policyComparedWith,
    policyHistory: {
      roots, commitsExamined: commits.length, distinctPolicyBlobs: new Set(snapshots.map((snapshot) => snapshot.blob)).size,
      bootstrapCommit: snapshots.length ? snapshots[0].commit : null,
      historicalActiveIds: [...activeIds].sort(), historicalRetiredEntrypoints: [...retiredPaths].sort(),
      appliedPolicyChanges: [...appliedPolicyChanges.values()].sort((a, b) => canonical(a).localeCompare(canonical(b))),
      historyRepairsApplied: [...historyRepairsApplied.values()].map((entry) => ({ ...entry, sourceCommits: entry.sourceCommits.sort() })).sort((a, b) => a.originalBlob.localeCompare(b.originalBlob)),
      diagnostics: diagnostics.sort((a, b) => canonical(a).localeCompare(canonical(b)))
    }
  };
}

module.exports = { checkPolicyHistory };
