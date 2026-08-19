'use strict';

const { randomUUID } = require('node:crypto');

const DATASET_IDENTITY_KEYS = Object.freeze([
  'archiveContractVersion',
  'datasetId',
  'datasetVersion',
  'producerTaskRunId'
]);

function freezePendingDatasetIdentityV1(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== DATASET_IDENTITY_KEYS.length
      || DATASET_IDENTITY_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(raw, key))
      || raw.archiveContractVersion !== 1
      || typeof raw.datasetId !== 'string' || !raw.datasetId.trim()
      || typeof raw.producerTaskRunId !== 'string' || !raw.producerTaskRunId.trim()
      || !Number.isSafeInteger(raw.datasetVersion) || raw.datasetVersion < 1) {
    throw new TypeError('Pending 写入必须携带 exact v1 dataset identity');
  }
  return Object.freeze({
    datasetId: raw.datasetId,
    producerTaskRunId: raw.producerTaskRunId,
    datasetVersion: raw.datasetVersion,
    archiveContractVersion: 1
  });
}

function createPendingDatasetSeed(previous, producerTaskRunId, createId = randomUUID) {
  if (typeof producerTaskRunId !== 'string' || !producerTaskRunId.trim()) {
    throw new TypeError('Pending v1 dataset producerTaskRunId 不能为空');
  }
  return Object.freeze({
    datasetId: createId(),
    producerTaskRunId,
    expectedDatasetId: previous ? previous.datasetId : null,
    expectedDatasetVersion: previous ? previous.datasetVersion : 0
  });
}

function freezePendingDatasetSeedV1(raw) {
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
    throw new TypeError('Pending 写入必须携带 exact v1 dataset seed');
  }
  return Object.freeze({
    datasetId: raw.datasetId,
    producerTaskRunId: raw.producerTaskRunId,
    expectedDatasetId: raw.expectedDatasetId,
    expectedDatasetVersion: raw.expectedDatasetVersion
  });
}

function identityFromPendingDatasetSeed(current, seed) {
  const currentId = current ? current.datasetId : null;
  const currentVersion = current ? current.datasetVersion : 0;
  if (currentId !== seed.expectedDatasetId || currentVersion !== seed.expectedDatasetVersion) {
    throw new Error('Pending dataset 已被另一任务覆盖，请重新导入');
  }
  return Object.freeze({
    datasetId: seed.datasetId,
    producerTaskRunId: seed.producerTaskRunId,
    datasetVersion: seed.expectedDatasetVersion + 1,
    archiveContractVersion: 1
  });
}

module.exports = {
  createPendingDatasetSeed,
  freezePendingDatasetIdentityV1,
  freezePendingDatasetSeedV1,
  identityFromPendingDatasetSeed
};
