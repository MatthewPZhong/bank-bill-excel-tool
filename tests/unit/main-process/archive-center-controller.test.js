'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ARCHIVE_RETENTION_SETTING_KEY,
  ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY,
  createArchiveCenterController
} = require('../../../src/main-process/archive-center/controller');

function createHarness() {
  const settings = new Map();
  const batches = [];
  const artifacts = new Map();
  const templates = [{ id: 1, name: 'DBS' }, { id: 2, name: 'BOC' }];
  const database = {
    getSetting: (key) => settings.get(key) || null,
    setSetting: (key, value) => settings.set(key, value),
    listTemplates: () => templates
  };
  const repository = {
    getBatch: (id) => batches.find((batch) => batch.id === Number(id)) || null,
    getArtifact: (id) => artifacts.get(Number(id)) || null
  };
  const service = {
    rootDir: '/tmp/archive-center',
    repository,
    async initialize() { return { ok: true, available: true }; },
    async cleanupExpired() { return { ok: true }; },
    async createBatch(payload) {
      const batch = {
        id: batches.length + 1,
        batchNumber: `${payload.moduleCode}-20260720-001`,
        moduleId: payload.moduleId,
        moduleName: payload.moduleName,
        archiveStatus: 'complete',
        failedArtifactCount: 0
      };
      batches.push(batch);
      const results = [];
      for (const file of Array.isArray(payload.files) ? payload.files : []) {
        results.push(await this.attachFile(batch.id, file));
      }
      return { ok: results.every((result) => result.ok), created: true, batch, results };
    },
    async attachFile(batchId, payload) {
      const id = artifacts.size + 1;
      artifacts.set(id, {
        id,
        batchId,
        originalName: payload.originalName,
        direction: payload.direction,
        role: payload.role,
        status: 'ready',
        blob: { sizeBytes: 12 }
      });
      return { ok: true };
    },
    async appendFiles(payload) {
      const results = [];
      for (const file of Array.isArray(payload.files) ? payload.files : []) {
        results.push(await this.attachFile(payload.batchId, file));
      }
      return { ok: results.every((result) => result.ok), results };
    },
    async listBatches() { return { ok: true, batches }; },
    async getBatch(id) {
      const batch = repository.getBatch(id);
      return batch
        ? { ok: true, batch: { ...batch, artifacts: [...artifacts.values()].filter((item) => item.batchId === id) } }
        : { ok: false, message: 'not found' };
    },
    async setLocked(id, locked) { return { ok: true, batch: { ...repository.getBatch(id), locked } }; },
    async deleteBatch() { return { ok: true }; },
    async retryBatch(id) { return { ok: true, batch: repository.getBatch(id) }; },
    async openReadonlyCopy() { return { ok: true }; },
    async saveAs(_id, targetPath) { return { ok: true, filePath: targetPath }; },
    async getStats() { return { ok: true, stats: { batchCount: batches.length, logicalFileCount: artifacts.size } }; }
  };
  const controller = createArchiveCenterController({
    database,
    service,
    showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/saved.xlsx' })
  });
  return { controller, database, service, settings, templates };
}

test('tracker sink 建批次、归档文件并向 UI 映射批次号与文件字段', async () => {
  const { controller } = createHarness();
  const created = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '资金对账数据处理',
    sourceOperation: 'bank-statement:run',
    files: [{ filePath: '/tmp/bank.xlsx', role: 'input' }]
  });

  assert.equal(created.batchNumber, 'BANK-20260720-001');
  assert.equal(created.archiveFailed, false);
  const listed = await controller.listBatches({ date: '2026-07-20', batchId: 'BANK-' });
  assert.equal(listed.batches[0].batchId, 'BANK-20260720-001');
  const detail = await controller.getBatch('BANK-20260720-001');
  assert.equal(detail.batch.files[0].fileName, 'bank.xlsx');
  assert.equal(detail.batch.files[0].direction, '输入');
  assert.equal(detail.batch.files[0].sizeBytes, 12);
});

test('保留期与模板排除持久化，任一参与模板排除即命中', () => {
  const { controller, settings } = createHarness();
  assert.equal(controller.getSettings().settings.retentionDays, 90);
  assert.equal(controller.setRetentionDays(null).status, 'success');
  assert.equal(settings.get(ARCHIVE_RETENTION_SETTING_KEY), 'permanent');

  assert.equal(controller.setTemplateExcluded('2', true).status, 'success');
  assert.equal(controller.hasExcludedTemplate([1, 2]), true);
  assert.equal(settings.get(ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY), '["2"]');
  assert.deepEqual(controller.listTemplatePolicies().policies, [
    { templateId: '1', templateName: 'DBS', excluded: false },
    { templateId: '2', templateName: 'BOC', excluded: true }
  ]);
});

test('单个文件归档失败保留批次并返回可见告警，不抛业务异常', async () => {
  const { controller, service } = createHarness();
  service.attachFile = async () => ({ ok: false, code: 'ARCHIVE_ENOSPC', message: '磁盘空间不足' });
  const result = await controller.sink.createBatch({
    moduleId: 'statement-generator',
    moduleCode: 'STATEMENT',
    moduleName: '网银账单生成',
    sourceOperation: 'file:import',
    files: [{ filePath: '/tmp/source.xlsx', role: 'input' }]
  });

  assert.ok(result.batchId);
  assert.equal(result.archiveFailed, true);
  assert.match(result.warning.message, /1 个文件/);
  assert.equal(result.warning.failures[0].originalName, 'source.xlsx');
});

test('另存为取消不写文件，成功时使用原文件名作为默认名', async () => {
  const { controller, service } = createHarness();
  const created = await controller.sink.createBatch({
    moduleId: 'new-account',
    moduleCode: 'NEW',
    moduleName: '新开账户余额账单生成',
    sourceOperation: 'new-account:generate',
    files: [{ filePath: '/tmp/result.xlsx', role: 'output' }]
  });
  const detail = await controller.getBatch(created.batchNumber);
  const fileRefId = detail.batch.files[0].fileRefId;

  controller.showSaveDialog = async (options) => {
    assert.equal(options.defaultPath, 'result.xlsx');
    return { canceled: true };
  };
  assert.equal((await controller.saveAs(fileRefId)).status, 'cancelled');

  controller.showSaveDialog = async () => ({ canceled: false, filePath: '/tmp/copy.xlsx' });
  service.saveAs = async (_id, targetPath) => ({ ok: true, filePath: targetPath });
  assert.equal((await controller.saveAs(fileRefId)).filePath, '/tmp/copy.xlsx');
});

test('模板排除设置损坏时按隐私优先排除全部模板', () => {
  const { database, service, settings, templates } = createHarness();
  settings.set(ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY, '{broken-json');
  const controller = createArchiveCenterController({ database, service });

  templates.push({ id: 3, name: 'JPM' });

  assert.equal(controller.hasExcludedTemplate([1]), true);
  assert.equal(controller.hasExcludedTemplate([2]), true);
  assert.equal(controller.hasExcludedTemplate([3]), true);
  assert.equal(controller.hasExcludedTemplate([]), true);
  assert.equal(controller.getSettings().settings.templatePolicyRecovered, true);
  assert.deepEqual(
    controller.listTemplatePolicies().policies.map((policy) => policy.excluded),
    [true, true, true]
  );

  assert.equal(controller.setTemplateExcluded('1', false).status, 'success');
  assert.deepEqual(controller.listTemplatePolicies().policies.map((policy) => policy.excluded), [false, true, true]);
});

test('模板排除设置虽为合法 JSON 但含非法 ID 类型时仍按损坏处理', () => {
  const { database, service, settings } = createHarness();
  settings.set(ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY, '[{"id":1}]');
  const controller = createArchiveCenterController({ database, service });

  assert.equal(controller.getSettings().settings.templatePolicyRecovered, true);
  assert.deepEqual(
    controller.listTemplatePolicies().policies.map((policy) => policy.excluded),
    [true, true]
  );
});

test('批次元数据已删除但物理清理失败时保留部分成功语义', async () => {
  const { controller, service } = createHarness();
  const created = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '资金对账数据处理',
    sourceOperation: 'bank-statement:run',
    files: [{ filePath: '/tmp/bank.xlsx', role: 'input' }]
  });
  service.deleteBatch = async () => ({
    ok: false,
    metadataDeleted: true,
    failures: [{ code: 'ARCHIVE_EBUSY' }]
  });

  const result = await controller.deleteBatch(created.batchNumber);
  assert.equal(result.status, 'partial');
  assert.equal(result.ok, false);
  assert.equal(result.metadataDeleted, true);
  assert.match(result.message, /批次记录已删除/);
});

test('业务完成后源文件已变化的批次要求重新执行业务，不提供无效重试', async () => {
  const { controller, service } = createHarness();
  service.listBatches = async () => ({
    ok: true,
    batches: [{
      id: 9,
      batchNumber: 'BANK-20260720-009',
      moduleId: 'bank-statement',
      moduleName: '资金对账数据处理',
      failedArtifactCount: 1,
      lastErrorCode: 'ARCHIVE_SOURCE_CHANGED',
      lastErrorMessage: '源文件已变化'
    }]
  });

  const listed = await controller.listBatches({});
  assert.equal(listed.batches[0].canRetry, false);
  assert.equal(listed.batches[0].requiresBusinessRerun, true);
});
