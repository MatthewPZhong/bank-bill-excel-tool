'use strict';

const { randomUUID } = require('node:crypto');

function normalizedBuFor(kind, buName) {
  return kind === 'flow' ? '' : String(buName == null ? '' : buName).trim().toLowerCase();
}

function mapHead(row) {
  if (!row) return null;
  return {
    datasetKind: row.dataset_kind,
    dataDate: row.data_date,
    normalizedBu: row.normalized_bu,
    datasetId: row.dataset_id,
    producerTaskRunId: row.producer_task_run_id || null,
    datasetVersion: Number(row.dataset_version),
    archiveContractVersion: Number(row.archive_contract_version),
    updatedAt: row.updated_at
  };
}

function getHead(db, kind, dataDate, buName = '') {
  return mapHead(db.prepare(`
    SELECT * FROM biz_op_recon_dataset_heads
    WHERE dataset_kind = ? AND data_date = ? AND normalized_bu = ?
  `).get(kind, dataDate, normalizedBuFor(kind, buName)));
}

function nextDatasetIdentity(previous, producerTaskRunId, createId = randomUUID) {
  if (typeof producerTaskRunId !== 'string' || !producerTaskRunId.trim()) {
    throw new TypeError('Biz OP v1 dataset producerTaskRunId 不能为空');
  }
  return Object.freeze({
    datasetId: createId(),
    producerTaskRunId,
    datasetVersion: previous ? previous.datasetVersion + 1 : 1,
    archiveContractVersion: 1
  });
}

function freezeDatasetSeedV1(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== 2
      || typeof raw.datasetId !== 'string' || !raw.datasetId.trim()
      || typeof raw.producerTaskRunId !== 'string' || !raw.producerTaskRunId.trim()) {
    throw new TypeError('Biz OP import worker 缺少 exact v1 dataset seed');
  }
  return Object.freeze({
    datasetId: raw.datasetId,
    producerTaskRunId: raw.producerTaskRunId
  });
}

function freezeFlowDatasetSeedV1(raw) {
  const expectedMissing = raw && raw.expectedDatasetId === null
    && raw.expectedDatasetVersion === 0;
  const expectedPresent = raw && typeof raw.expectedDatasetId === 'string'
    && raw.expectedDatasetId.trim()
    && Number.isSafeInteger(raw.expectedDatasetVersion)
    && raw.expectedDatasetVersion >= 0;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== 4
      || typeof raw.datasetId !== 'string' || !raw.datasetId.trim()
      || typeof raw.producerTaskRunId !== 'string' || !raw.producerTaskRunId.trim()
      || (!expectedMissing && !expectedPresent)) {
    throw new TypeError('Biz OP flow import worker 缺少 exact v1 dataset seed');
  }
  return Object.freeze({
    datasetId: raw.datasetId,
    producerTaskRunId: raw.producerTaskRunId,
    expectedDatasetId: raw.expectedDatasetId,
    expectedDatasetVersion: raw.expectedDatasetVersion
  });
}

function assertExpectedHead(current, seed) {
  const currentId = current ? current.datasetId : null;
  const currentVersion = current ? current.datasetVersion : 0;
  if (currentId !== seed.expectedDatasetId || currentVersion !== seed.expectedDatasetVersion) {
    throw new Error('Biz OP dataset 已被另一任务覆盖，请重新导入');
  }
}

function freezeDatasetIdentityV1(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== 4
      || raw.archiveContractVersion !== 1
      || typeof raw.datasetId !== 'string' || !raw.datasetId.trim()
      || typeof raw.producerTaskRunId !== 'string' || !raw.producerTaskRunId.trim()
      || !Number.isSafeInteger(raw.datasetVersion) || raw.datasetVersion < 1) {
    throw new TypeError('Biz OP import worker 缺少 exact v1 dataset identity');
  }
  return Object.freeze({
    datasetId: raw.datasetId,
    producerTaskRunId: raw.producerTaskRunId,
    datasetVersion: raw.datasetVersion,
    archiveContractVersion: 1
  });
}

function writeHead(db, { kind, dataDate, buName = '', identity }) {
  db.prepare(`
    INSERT INTO biz_op_recon_dataset_heads (
      dataset_kind, data_date, normalized_bu, dataset_id,
      producer_task_run_id, dataset_version, archive_contract_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dataset_kind, data_date, normalized_bu) DO UPDATE SET
      dataset_id = excluded.dataset_id,
      producer_task_run_id = excluded.producer_task_run_id,
      dataset_version = excluded.dataset_version,
      archive_contract_version = excluded.archive_contract_version,
      updated_at = excluded.updated_at
  `).run(
    kind,
    dataDate,
    normalizedBuFor(kind, buName),
    identity.datasetId,
    identity.producerTaskRunId,
    identity.datasetVersion,
    identity.archiveContractVersion,
    new Date().toISOString()
  );
  return getHead(db, kind, dataDate, buName);
}

module.exports = {
  assertExpectedHead,
  getHead,
  freezeDatasetIdentityV1,
  freezeDatasetSeedV1,
  freezeFlowDatasetSeedV1,
  nextDatasetIdentity,
  normalizedBuFor,
  writeHead
};
