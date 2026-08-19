'use strict';

const crypto = require('node:crypto');

const FORBIDDEN_IDENTITY_TYPES = new Set([
  'file-hash',
  'month',
  'renderer-state',
  'sha256',
  'year-month'
]);

function requiredText(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new TypeError(`${label} 不能为空`);
  return text;
}

function normalizeIdentity(identity) {
  if (!identity) return null;
  if (typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('business identity 必须是对象');
  }
  const identityType = requiredText(identity.identityType || identity.type, 'identityType').toLowerCase();
  if (FORBIDDEN_IDENTITY_TYPES.has(identityType)) {
    throw new TypeError(`禁止使用不稳定业务身份：${identityType}`);
  }
  return {
    identityType,
    identityValue: requiredText(identity.identityValue ?? identity.value, 'identityValue')
  };
}

function normalizeIdentities(identities) {
  const source = Array.isArray(identities) ? identities : (identities ? [identities] : []);
  const unique = new Map();
  for (const item of source) {
    const identity = normalizeIdentity(item);
    if (!identity) continue;
    unique.set(`${identity.identityType}\u0000${identity.identityValue}`, identity);
  }
  return [...unique.values()];
}

class BusinessFlowResolver {
  constructor(options = {}) {
    if (!options.archiveService
        || typeof options.archiveService.findFlowAnchor !== 'function'
        || typeof options.archiveService.bindFlowAnchor !== 'function'
        || typeof options.archiveService.persistFlowBindIntent !== 'function'
        || typeof options.archiveService.replayFlowBindIntents !== 'function'
        || typeof options.archiveService.persistTaskFlowBindIntent !== 'function'
        || typeof options.archiveService.replayTaskFlowBindIntents !== 'function') {
      throw new TypeError('BusinessFlowResolver 需要 flow anchor service');
    }
    if (options.createParentRunId !== undefined
        && typeof options.createParentRunId !== 'function') {
      throw new TypeError('createParentRunId 必须是函数');
    }
    this.archiveService = options.archiveService;
    this.createParentRunId = options.createParentRunId || (() => crypto.randomUUID());
  }

  async resolve(payload = {}) {
    const moduleId = requiredText(payload.moduleId, 'moduleId');
    if (typeof payload.startsNewFlow !== 'boolean') {
      throw new TypeError('startsNewFlow 必须显式指定为 boolean');
    }
    const explicitParentRunId = String(payload.explicitParentRunId || '').trim();
    if (payload.startsNewFlow && explicitParentRunId) {
      throw new TypeError('新流程不能同时继承 explicitParentRunId');
    }
    const identity = normalizeIdentity(payload.identity);

    if (payload.startsNewFlow) {
      return {
        parentRunId: requiredText(this.createParentRunId(), 'parentRunId'),
        source: 'new',
        identity
      };
    }

    if (explicitParentRunId) {
      return { parentRunId: explicitParentRunId, source: 'inherited', identity: null };
    }

    if (!identity) {
      const error = new Error('续接业务流程必须提供 explicitParentRunId 或稳定业务身份');
      error.code = 'ARCHIVE_FLOW_IDENTITY_REQUIRED';
      throw error;
    }
    const replayed = await this.archiveService.replayFlowBindIntents({ moduleId, ...identity });
    if (!replayed || replayed.ok === false) {
      const error = new Error(
        replayed && replayed.message
          ? replayed.message
          : '业务身份待绑定记录重放失败'
      );
      error.code = replayed && replayed.code || 'ARCHIVE_FLOW_BIND_REPLAY_FAILED';
      throw error;
    }
    const taskReplayed = await this.archiveService.replayTaskFlowBindIntents({
      moduleId,
      ...identity
    });
    if (!taskReplayed || taskReplayed.ok === false) {
      const error = new Error(
        taskReplayed && taskReplayed.message
          ? taskReplayed.message
          : 'Task Run 业务身份待绑定记录重放失败'
      );
      error.code = taskReplayed && taskReplayed.code || 'ARCHIVE_FLOW_BIND_REPLAY_FAILED';
      throw error;
    }
    const found = await this.archiveService.findFlowAnchor({ moduleId, ...identity });
    if (!found || found.ok === false) {
      const error = new Error(found && found.message ? found.message : '业务身份锚点查询失败');
      error.code = found && found.code || 'ARCHIVE_FLOW_ANCHOR_LOOKUP_FAILED';
      throw error;
    }
    if (!found.anchor) {
      // 历史业务 run 在首次进入 v3.1.9 时还没有 anchor。查询成功即可证明“没有绑定”，
      // 此时建立新 parent，并由 lifecycle 在 started 前立即绑定该稳定 identity。
      return {
        parentRunId: requiredText(this.createParentRunId(), 'parentRunId'),
        source: 'new',
        identity
      };
    }
    return {
      parentRunId: requiredText(found.anchor.parentRunId, 'anchor.parentRunId'),
      source: identity.identityType === 'operation-token' ? 'operation-token' : 'business-run',
      identity
    };
  }

  async bind(payload = {}) {
    const moduleId = requiredText(payload.moduleId, 'moduleId');
    const parentRunId = requiredText(payload.parentRunId, 'parentRunId');
    const sourceTaskRunId = String(payload.sourceTaskRunId || '').trim();
    const sourceBatchId = payload.sourceBatchId == null ? null : Number(payload.sourceBatchId);
    if ((sourceBatchId === null) === !sourceTaskRunId) {
      throw new TypeError('flow bind owner 必须且只能提供 sourceTaskRunId/sourceBatchId 之一');
    }
    if (sourceBatchId !== null && (!Number.isSafeInteger(sourceBatchId) || sourceBatchId < 1)) {
      throw new TypeError('sourceBatchId 必须是正安全整数或 null');
    }
    const identities = normalizeIdentities(payload.identities);
    const anchors = [];
    for (const identity of identities) {
      const bound = await this.archiveService.bindFlowAnchor({
        moduleId,
        ...identity,
        parentRunId,
        sourceBatchId,
        ...(sourceTaskRunId ? { sourceTaskRunId } : {})
      });
      if (!bound || bound.ok === false || !bound.anchor) {
        throw new Error(bound && bound.message ? bound.message : '业务身份锚点绑定失败');
      }
      anchors.push(bound.anchor);
    }
    return anchors;
  }

  async persistBindIntent(payload = {}) {
    const moduleId = requiredText(payload.moduleId, 'moduleId');
    const parentRunId = requiredText(payload.parentRunId, 'parentRunId');
    const sourceTaskRunId = String(payload.sourceTaskRunId || '').trim();
    const sourceBatchId = payload.sourceBatchId == null ? null : Number(payload.sourceBatchId);
    if ((sourceBatchId === null) === !sourceTaskRunId) {
      throw new TypeError('flow bind intent owner 必须且只能提供 sourceTaskRunId/sourceBatchId 之一');
    }
    if (sourceBatchId !== null && (!Number.isSafeInteger(sourceBatchId) || sourceBatchId < 1)) {
      throw new TypeError('sourceBatchId 必须是正安全整数或 null');
    }
    const identities = normalizeIdentities(payload.identities);
    const intents = [];
    for (const identity of identities) {
      const persist = sourceBatchId === null
        ? this.archiveService.persistTaskFlowBindIntent
        : this.archiveService.persistFlowBindIntent;
      const persisted = await persist.call(this.archiveService, {
        moduleId,
        ...identity,
        parentRunId,
        ...(sourceBatchId === null ? { sourceTaskRunId } : { sourceBatchId })
      });
      if (!persisted || persisted.ok === false) {
        const error = new Error(
          persisted && persisted.message
            ? persisted.message
            : '业务身份待绑定记录持久化失败'
        );
        error.code = persisted && persisted.code || 'ARCHIVE_FLOW_BIND_INTENT_PERSIST_FAILED';
        throw error;
      }
      intents.push(persisted.intent || null);
    }
    return intents;
  }
}

function createBusinessFlowResolver(options) {
  return new BusinessFlowResolver(options);
}

module.exports = {
  BusinessFlowResolver,
  FORBIDDEN_IDENTITY_TYPES,
  createBusinessFlowResolver,
  normalizeIdentities,
  normalizeIdentity
};
