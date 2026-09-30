'use strict';

const { createHash } = require('node:crypto');
const { createMemoryAdmissionPolicy } = require('../background-execution/memory-admission');
const { validateExecutionMemoryConfig } = require('../background-execution/execution-memory-config');
const { createMemorySampler } = require('../background-execution/memory-telemetry');
const { ACTIONS } = require('../biz-op-v327/contracts');
const qualification = require('./memory-qualification.json');
const { inventoryForGovernor, captureLegacyMemoryContinuation, isLegacyMemoryContinuationBlocking } = require('../memory-activity');
const { sourceIdentity, qualifiedProfile } = require('./memory-evidence');

const MiB = 1024 ** 2;
const TARGET_ACTIONS = new Set(['toolbox:split:prepare', 'toolbox:split-rows', 'publication:shared-io', ...Object.keys(ACTIONS)]);
const IO_OWNERS = ['biz-op-v327:publisher:', 'biz-op-v327:archive-output:', 'biz-op-v327:auto-report-verify:',
  'biz-op-v327:delete-preservation:', 'biz-op-v327:raw-source:', 'biz-op-v327:shared-publication-observation'];
const PHASES = Object.freeze({
  'split-prepare': [768, 256, 2],
  'rows-generation': [768, 384, 2],
  'rows-io': [256, 128, 1],
  'publication-io': [256, 128, 1],
  'bizop-import': [768, 384, 2],
  'bizop-compute': [768, 384, 3],
  'bizop-export': [768, 384, 2],
  'bizop-io': [256, 128, 2],
  'bizop-maintenance': [384, 128, 2]
});

function phaseFor(request) {
  if (!TARGET_ACTIONS.has(request.actionKey)) return null;
  if (request.actionKey === 'toolbox:split:prepare') return 'split-prepare';
  if (request.actionKey === 'toolbox:split-rows') return request.ownerKey.startsWith('toolbox:rows-validate:') ? 'rows-io' : 'rows-generation';
  if (request.actionKey === 'publication:shared-io') return 'publication-io';
  if (IO_OWNERS.some((prefix) => request.ownerKey.startsWith(prefix))) return 'bizop-io';
  if (request.actionKey === 'biz-op-v327:import-candidate') return 'bizop-import';
  if (request.actionKey === 'biz-op-v327:run-candidate') return 'bizop-compute';
  if (request.actionKey.startsWith('biz-op-v327:export-')) return 'bizop-export';
  return 'bizop-maintenance';
}

// 候选是技术实验配置。发布资格由独立 manifest 授予，不把实验数值当成实测最低配置。
function profile(phaseKey, mode, evidenceId = null) {
  if (!Object.hasOwn(PHASES, phaseKey) || !['normal', 'low'].includes(mode)) throw new TypeError('内存阶段无效');
  const [normal, low, connections] = PHASES[phaseKey];
  const bytes = (mode === 'normal' ? normal : low) * MiB;
  const config = {
    version: 1, profileId: `${phaseKey}-${mode}-v1`, phaseKey, phaseMemoryBytes: bytes,
    systemReserveBytes: (mode === 'normal' ? 192 : 128) * MiB,
    sstMemoryBytes: 8 * MiB, sstCacheBytes: 4 * MiB, styleCacheBytes: 8 * MiB,
    sqliteAggregateCacheBytes: (mode === 'normal' ? 24 : 12) * MiB, maxOpenConnections: connections,
    maxInFlightBytes: 4 * MiB, maxSingleRecordBytes: 2 * MiB,
    workerLimits: { maxOldGenerationSizeMb: Math.floor(bytes / MiB * 0.6), maxYoungGenerationSizeMb: 8 },
    validatedEvidenceId: evidenceId
  };
  const policyDigest = createHash('sha256').update(JSON.stringify({ ...config, validatedEvidenceId: null })).digest('hex');
  return validateExecutionMemoryConfig({ ...config, policyDigest });
}

function createRegisteredMemoryPolicy({ compatibilityMemoryBytes, sampleMemory, evidenceFor, inventory }) {
  const registered = new Map();
  const evidence = new Set();
  for (const phaseKey of Object.keys(PHASES)) {
    const candidates = [];
    for (const mode of ['normal', 'low']) {
      const proposed = profile(phaseKey, mode);
      const evidenceId = evidenceFor(proposed, mode);
      if (!evidenceId) continue;
      const config = profile(phaseKey, mode, evidenceId);
      evidence.add(`${config.profileId}:${config.policyDigest}:${evidenceId}`);
      candidates.push({ mode, config });
    }
    if (candidates.length) registered.set(phaseKey, candidates);
  }
  return createMemoryAdmissionPolicy({ compatibilityMemoryBytes, sampleMemory,
    resolveRequest(request) {
      if (request.kind === 'phase' && request.actionKey === 'publication:legacy-observation' &&
          request.ownerKey === 'biz-op-v327:shared-publication-observation' &&
          request.operationKey === 'biz-op-v327:shared-publication-observation') {
        return { migrated: false, heavy: true, maxGrowthBytes: null,
          continuation: captureLegacyMemoryContinuation() };
      }
      const phaseKey = phaseFor(request);
      if (!phaseKey) return null;
      // 目标 job 的零资源 base 尚未创建载体，不与自己的 phase 形成重型互斥。
      if (request.kind === 'base') return { migrated: false, heavy: false, maxGrowthBytes: 0 };
      const candidates = request.kind === 'phase' && registered.get(phaseKey);
      if (!candidates) return null;
      return { migrated: true, heavy: true,
        maxGrowthBytes: Math.max(...candidates.map((item) => item.config.phaseMemoryBytes)), candidates };
    },
    isEvidenceValid: (config) => evidence.has(`${config.profileId}:${config.policyDigest}:${config.validatedEvidenceId}`),
    externalPressure: inventory,
    isContinuationBlocking: isLegacyMemoryContinuationBlocking
  });
}

function createProductionMemoryPolicy({ compatibilityMemoryBytes, getGovernor }) {
  // 未闭合的 inventory/Windows 容量记录不能激活生产。该文件由版本评审后冻结，
  // 没有 Renderer、环境变量或 runtime options 的放行开关。
  let identity = null;
  try { if (qualification.status === 'qualified') identity = sourceIdentity(); }
  catch (_error) { /* 缺少或损坏构建证据时保留兼容准入，不中断应用启动。 */ }
  return createRegisteredMemoryPolicy({ compatibilityMemoryBytes, sampleMemory: createMemorySampler(),
    evidenceFor(config) {
      return identity ? qualifiedProfile(qualification, config, identity) : null;
    },
    inventory: () => inventoryForGovernor(getGovernor)
  });
}

// 只能装配到显式 non-production runtime 的 Governor；测试通过不改变 production manifest。
function createExperimentalMemoryPolicy({ compatibilityMemoryBytes = 0, sampleMemory,
  inventory = () => ({ inventoryComplete: true, blockers: [] }), modes = ['normal', 'low'] }) {
  if (!Array.isArray(modes) || modes.length === 0 || modes.some((mode) => !['normal', 'low'].includes(mode))) throw new TypeError('实验模式无效');
  return createRegisteredMemoryPolicy({ compatibilityMemoryBytes, sampleMemory, inventory,
    evidenceFor: (_config, mode) => modes.includes(mode) ? 'non-production-capacity-experiment' : null });
}

module.exports = { PHASES, profile, phaseFor, createProductionMemoryPolicy, createExperimentalMemoryPolicy };
