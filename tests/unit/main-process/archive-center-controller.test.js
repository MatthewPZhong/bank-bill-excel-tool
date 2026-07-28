'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ARCHIVE_RETENTION_SETTING_KEY,
  ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY,
  createArchiveCenterController
} = require('../../../src/main-process/archive-center/controller');
const {
  createArchiveOutboxStore
} = require('../../../src/main-process/archive-center/outbox-store');

function createHarness(options = {}) {
  const settings = new Map(options.initialSettings || []);
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
      return { ok: true, artifact: artifacts.get(id) };
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
    listUnresolvedSourcePaths() { return []; },
    async getStats() { return { ok: true, stats: { batchCount: batches.length, logicalFileCount: artifacts.size } }; }
  };
  const controller = createArchiveCenterController({
    database,
    service,
    outboxStore: options.outboxStore,
    onOutboxFlushed: options.onOutboxFlushed,
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

test('保留期默认 60 天并支持新增枚举，既有合法值保持兼容', () => {
  const { controller, settings } = createHarness();
  assert.equal(controller.getSettings().settings.retentionDays, 60);
  assert.equal(controller.setRetentionDays(60).status, 'success');
  assert.equal(settings.get(ARCHIVE_RETENTION_SETTING_KEY), '60');
  assert.equal(controller.setRetentionDays(90).status, 'success');
  assert.equal(controller.getSettings().settings.retentionDays, 90);
  assert.equal(controller.setRetentionDays(45).status, 'failed');
  assert.equal(controller.setRetentionDays(null).status, 'success');
  assert.equal(settings.get(ARCHIVE_RETENTION_SETTING_KEY), 'permanent');
});

test('控制器启动时将有效、损坏和空模板排除设置统一归一化为空数组', () => {
  const cases = [
    ['有效设置', '["2"]'],
    ['损坏设置', '{broken-json'],
    ['空设置', '']
  ];
  for (const [label, storedValue] of cases) {
    const { controller, settings } = createHarness({
      initialSettings: [[ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY, storedValue]]
    });
    assert.equal(
      settings.get(ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY),
      '[]',
      label
    );
    assert.deepEqual(controller.getSettings().settings, { retentionDays: 60 }, label);
  }

  const missing = createHarness();
  assert.equal(
    missing.settings.get(ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY),
    '[]',
    '缺失设置'
  );
});

test('模板排除控制器方法与 main/preload IPC 桥接已移除', () => {
  const { controller } = createHarness();
  assert.equal(controller.listTemplatePolicies, undefined);
  assert.equal(controller.setTemplateExcluded, undefined);
  assert.equal(controller.hasExcludedTemplate, undefined);

  const repositoryRoot = path.resolve(__dirname, '../../..');
  const mainSource = fs.readFileSync(path.join(repositoryRoot, 'src/main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(repositoryRoot, 'src/preload.js'), 'utf8');
  for (const source of [mainSource, preloadSource]) {
    assert.doesNotMatch(source, /archive-center:list-template-policies/);
    assert.doesNotMatch(source, /archive-center:set-template-excluded/);
  }
  assert.doesNotMatch(mainSource, /hasExcludedTemplate/);
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

test('存档主库暂不可用时写入 outbox，跨重启重放后解除源文件保护', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-outbox-'));
  const inputPath = path.join(rootDir, 'bank.xlsx');
  const outputPath = path.join(rootDir, 'result.xlsx');
  const releasedPaths = [];
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const { controller, service } = createHarness({
    outboxStore,
    onOutboxFlushed: (paths) => releasedPaths.push(...paths)
  });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const workingCreateBatch = service.createBatch.bind(service);
  service.createBatch = async () => ({ ok: false, message: 'archive database busy' });
  const created = await controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:bank:apply-import',
    metadata: { positionOperationToken: 'operation-1' },
    files: [{ filePath: inputPath, role: 'input' }]
  });
  assert.match(created.batchId, /^outbox:/);
  assert.equal(created.archiveFailed, true);
  assert.equal(created.persistentRetryAvailable, true);

  const appended = await controller.sink.appendFiles({
    batchId: created.batchId,
    sourceOperation: 'position-reconciliation:run:export',
    files: [{ filePath: outputPath, role: 'output' }]
  });
  assert.equal(appended.persistentRetryAvailable, true);
  assert.deepEqual(
    controller.listUnresolvedSourcePaths().sort(),
    [inputPath, outputPath].sort()
  );

  service.createBatch = workingCreateBatch;
  const initialized = await controller.initialize();
  assert.equal(initialized.ok, true);
  assert.deepEqual(outboxStore.list(), []);
  assert.deepEqual(releasedPaths.sort(), [inputPath, outputPath].sort());
});

test('outbox 重放为部分失败正式批次时不得释放失败文件源路径', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-outbox-partial-'));
  const inputPath = path.join(rootDir, 'bank.xlsx');
  const outputPath = path.join(rootDir, 'result.xlsx');
  const releasedPaths = [];
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const { controller, service } = createHarness({
    outboxStore,
    onOutboxFlushed: (paths) => releasedPaths.push(...paths)
  });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  service.createBatch = async () => ({ ok: false, message: 'archive database busy' });
  const created = await controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:bank:apply-import',
    metadata: { positionOperationToken: 'operation-partial' },
    files: [
      { filePath: inputPath, role: 'input' },
      { filePath: outputPath, role: 'output' }
    ]
  });
  assert.match(created.batchId, /^outbox:/);

  service.createBatch = async () => ({
    ok: false,
    batch: {
      id: 1,
      batchNumber: 'POSITION-20260720-001',
      archiveStatus: 'failed',
      failedArtifactCount: 1
    },
    attempted: 2,
    succeeded: 1,
    failed: 1,
    results: [
      { ok: false, status: 'failed', artifact: { id: 1 } },
      { ok: true, status: 'ready', artifact: { id: 2 } }
    ]
  });
  service.listUnresolvedSourcePaths = () => [inputPath];

  const initialized = await controller.initialize();
  assert.equal(initialized.ok, true);
  assert.deepEqual(outboxStore.list(), []);
  assert.deepEqual(releasedPaths, [outputPath]);
  assert.deepEqual(controller.listUnresolvedSourcePaths(), [inputPath]);
});

test('outbox 重放在附件元数据登记前失败时保留任务和源文件', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-outbox-metadata-'));
  const inputPath = path.join(rootDir, 'bank.xlsx');
  const releasedPaths = [];
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const { controller, service } = createHarness({
    outboxStore,
    onOutboxFlushed: (paths) => releasedPaths.push(...paths)
  });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  service.createBatch = async () => ({ ok: false, message: 'archive database busy' });
  const created = await controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:bank:apply-import',
    metadata: { positionOperationToken: 'operation-metadata' },
    files: [{ filePath: inputPath, role: 'input' }]
  });
  assert.match(created.batchId, /^outbox:/);

  service.createBatch = async () => ({
    ok: false,
    batch: {
      id: 1,
      batchNumber: 'POSITION-20260720-001',
      archiveStatus: 'failed',
      failedArtifactCount: 1
    },
    attempted: 1,
    succeeded: 0,
    failed: 1,
    results: [{
      ok: false,
      status: 'failed',
      metadataRecorded: true,
      message: 'artifact insert failed'
    }]
  });
  service.listUnresolvedSourcePaths = () => [];

  const initialized = await controller.initialize();
  assert.equal(initialized.ok, true);
  assert.equal(outboxStore.list().length, 1);
  assert.deepEqual(controller.listUnresolvedSourcePaths(), [inputPath]);
  assert.deepEqual(releasedPaths, []);

  service.createBatch = async () => ({
    ok: true,
    batch: {
      id: 1,
      batchNumber: 'POSITION-20260720-001',
      archiveStatus: 'complete',
      failedArtifactCount: 0
    },
    attempted: 1,
    succeeded: 1,
    failed: 0,
    results: [{ ok: true, status: 'ready', artifact: { id: 7 } }]
  });
  const flushed = await controller.flushOutbox();
  assert.equal(flushed.flushed, 1);
  assert.deepEqual(outboxStore.list(), []);
  assert.deepEqual(releasedPaths, [inputPath]);
});

test('同一平盘恢复操作重复登记时复用 outbox 并补齐新文件', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-intent-'));
  const inputPath = path.join(rootDir, 'input.xlsx');
  const outputPath = path.join(rootDir, 'output.xlsx');
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const { controller } = createHarness({ outboxStore });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const shared = {
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:run:export',
    operationKey: 'position:operation-2:position-reconciliation:run:export'
  };

  const first = controller.persistOperationIntent({
    ...shared,
    files: [{ filePath: inputPath, role: 'input' }]
  });
  const second = controller.persistOperationIntent({
    ...shared,
    files: [{ filePath: outputPath, role: 'output' }]
  });

  assert.equal(second.batchId, first.batchId);
  assert.deepEqual(
    outboxStore.list()[0].payload.files.map((file) => file.filePath).sort(),
    [inputPath, outputPath].sort()
  );
});
