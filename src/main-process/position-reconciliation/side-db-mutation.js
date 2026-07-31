'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const {
  PositionReconciliationError,
  stableHash,
  text
} = require('./common');
const {
  normalizeSourceSnapshot
} = require('../archive-center/source-snapshot');

const POSITION_DB_IDENTITY_KEY = 'position_database_identity_v1';
const POSITION_DB_GENERATION_KEY = 'position_database_generation_v1';
const POSITION_DB_CHECKPOINT_TOKEN_KEY = 'position_database_checkpoint_token_v1';
const SHA256_RE = /^[a-f0-9]{64}$/;

function checkpointValue(value, label) {
  const normalized = text(value);
  if (!normalized) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      `平盘对账侧库 ${label} 缺失，无法确认主库与侧库属于同一数据代次`
    );
  }
  return normalized;
}

function checkpointGeneration(value) {
  const normalized = text(value);
  if (!/^(0|[1-9]\d*)$/.test(normalized)) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘对账侧库 generation 非法，无法确认主库与侧库属于同一数据代次'
    );
  }
  const generation = Number(normalized);
  if (!Number.isSafeInteger(generation)) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘对账侧库 generation 超出安全范围'
    );
  }
  return generation;
}

function normalizePositionCheckpoint(value, label = 'checkpoint') {
  if (value === null || value === undefined || value === '') return null;
  let payload = value;
  if (typeof value === 'string') {
    try {
      payload = JSON.parse(value);
    } catch (_error) {
      throw new PositionReconciliationError(
        'position-side-db-mismatch',
        `主库中的平盘侧库 ${label} 损坏，请恢复完整软件数据目录`
      );
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      `主库中的平盘侧库 ${label} 格式非法，请恢复完整软件数据目录`
    );
  }
  return {
    identity: checkpointValue(payload.identity, 'identity'),
    generation: checkpointGeneration(payload.generation),
    token: checkpointValue(payload.token, 'checkpoint token')
  };
}

function positionCheckpointsEqual(left, right) {
  return Boolean(left && right)
    && left.identity === right.identity
    && left.generation === right.generation
    && left.token === right.token;
}

function readPositionDatabaseCheckpoint(db) {
  const rows = db.prepare(`
    SELECT key, value
    FROM position_meta
    WHERE key IN (?, ?, ?)
  `).all(
    POSITION_DB_IDENTITY_KEY,
    POSITION_DB_GENERATION_KEY,
    POSITION_DB_CHECKPOINT_TOKEN_KEY
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));
  if (values.size !== 3) return null;
  return normalizePositionCheckpoint({
    identity: values.get(POSITION_DB_IDENTITY_KEY),
    generation: values.get(POSITION_DB_GENERATION_KEY),
    token: values.get(POSITION_DB_CHECKPOINT_TOKEN_KEY)
  });
}

function assertCurrentPositionCheckpointHistory(db, checkpoint) {
  const current = normalizePositionCheckpoint(checkpoint);
  const row = db.prepare(`
    SELECT token
    FROM position_checkpoint_history
    WHERE generation = ?
  `).get(current.generation);
  if (!row || text(row.token) !== current.token) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘对账侧库当前 checkpoint 缺少对应历史记录'
    );
  }
  return current;
}

function assertExpectedCheckpoint(current, expected) {
  if (!positionCheckpointsEqual(current, expected)) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘对账侧库 checkpoint 已变化，已停止本次写入',
      [
        `预期 generation=${expected.generation}`,
        `实际 generation=${current.generation}`
      ]
    );
  }
}

function operationInputKey(role, filePath) {
  return stableHash({
    role: text(role),
    filePath: path.resolve(String(filePath || ''))
  });
}

function normalizeOperationInputEvidence(value, fallbackSourceType = '') {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const role = text(input.role || 'input');
  const rawFilePath = String(input.filePath || '');
  const filePath = path.resolve(rawFilePath);
  const sourceType = text(input.sourceType || fallbackSourceType);
  const originalName = text(input.originalName) || path.basename(filePath);
  const sourceSnapshot = normalizeSourceSnapshot(input.sourceSnapshot);
  const sha256 = text(input.expectedSha256 || input.sha256).toLowerCase();
  const sizeBytes = Number(input.expectedSizeBytes ?? input.sizeBytes);
  if (role !== 'input'
      || !rawFilePath.trim()
      || !sourceType
      || !sourceSnapshot
      || !SHA256_RE.test(sha256)
      || !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 0
      || sourceSnapshot.sizeBytes !== sizeBytes) {
    throw new PositionReconciliationError(
      'position-side-data-invalid',
      '平盘输入缺少完整的文件级提交证据'
    );
  }
  return {
    inputKey: operationInputKey(role, filePath),
    sourceType,
    role,
    filePath,
    originalName,
    sourceSnapshot,
    sha256,
    sizeBytes
  };
}

function operationInputEvidenceHash(value) {
  return stableHash({
    inputKey: value.inputKey,
    sourceType: value.sourceType,
    role: value.role,
    filePath: value.filePath,
    originalName: value.originalName,
    sourceSnapshot: value.sourceSnapshot,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes
  });
}

function recordPositionOperationInputs(
  db,
  operationToken,
  inputEvidence,
  fallbackSourceType = ''
) {
  const token = text(operationToken);
  if (!token) {
    throw new PositionReconciliationError(
      'position-side-data-invalid',
      '平盘文件级提交凭证缺少 operation token'
    );
  }
  const inputs = Array.isArray(inputEvidence) ? inputEvidence : [];
  if (inputs.length === 0) return [];
  const insert = db.prepare(`
    INSERT INTO position_operation_inputs(
      operation_token, input_key, source_type, role, file_path, original_name,
      sha256, size_bytes, source_snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(operation_token, input_key) DO NOTHING
  `);
  const find = db.prepare(`
    SELECT input_key AS inputKey, source_type AS sourceType, role,
           file_path AS filePath, original_name AS originalName,
           sha256, size_bytes AS sizeBytes,
           source_snapshot_json AS sourceSnapshotJson
    FROM position_operation_inputs
    WHERE operation_token = ? AND input_key = ?
  `);
  const recorded = [];
  for (const value of inputs) {
    const normalized = normalizeOperationInputEvidence(value, fallbackSourceType);
    insert.run(
      token,
      normalized.inputKey,
      normalized.sourceType,
      normalized.role,
      normalized.filePath,
      normalized.originalName,
      normalized.sha256,
      normalized.sizeBytes,
      JSON.stringify(normalized.sourceSnapshot)
    );
    const stored = find.get(token, normalized.inputKey);
    if (!stored) {
      throw new PositionReconciliationError(
        'position-side-data-invalid',
        '平盘文件级提交凭证写入失败'
      );
    }
    let storedSnapshot;
    try {
      storedSnapshot = normalizeSourceSnapshot(JSON.parse(stored.sourceSnapshotJson));
    } catch (_error) {
      storedSnapshot = null;
    }
    const storedEvidence = {
      inputKey: text(stored.inputKey),
      sourceType: text(stored.sourceType),
      role: text(stored.role),
      filePath: path.resolve(String(stored.filePath || '')),
      originalName: text(stored.originalName),
      sourceSnapshot: storedSnapshot,
      sha256: text(stored.sha256).toLowerCase(),
      sizeBytes: Number(stored.sizeBytes)
    };
    if (!storedSnapshot
        || operationInputEvidenceHash(storedEvidence) !== operationInputEvidenceHash(normalized)) {
      throw new PositionReconciliationError(
        'position-side-data-invalid',
        '平盘文件级提交凭证与既有记录冲突'
      );
    }
    recorded.push(storedEvidence);
  }
  return recorded;
}

function listPositionCommittedOperationInputs(db, operationToken) {
  const token = text(operationToken);
  if (!token) return [];
  const rows = db.prepare(`
    SELECT operation_token AS operationToken, input_key AS inputKey,
           source_type AS sourceType, role, file_path AS filePath,
           original_name AS originalName, sha256, size_bytes AS sizeBytes,
           source_snapshot_json AS sourceSnapshotJson, committed_at AS committedAt
    FROM position_operation_inputs
    WHERE operation_token = ?
    ORDER BY committed_at, input_key
  `).all(token);
  return rows.map((row) => {
    let sourceSnapshot;
    try {
      sourceSnapshot = normalizeSourceSnapshot(JSON.parse(row.sourceSnapshotJson));
    } catch (_error) {
      sourceSnapshot = null;
    }
    const normalized = normalizeOperationInputEvidence({
      sourceType: row.sourceType,
      role: row.role,
      filePath: row.filePath,
      originalName: row.originalName,
      sourceSnapshot,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes
    });
    if (text(row.inputKey) !== normalized.inputKey) {
      throw new PositionReconciliationError(
        'position-side-data-invalid',
        '平盘文件级提交凭证的 input key 不一致'
      );
    }
    return {
      operationToken: token,
      ...normalized,
      committedAt: text(row.committedAt)
    };
  });
}

function inspectPositionOperationCommitChain(db, {
  baseCheckpoint,
  operationToken
}) {
  const base = normalizePositionCheckpoint(baseCheckpoint, '操作基准 checkpoint');
  const token = text(operationToken);
  if (!base || !token) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘操作恢复缺少基准 checkpoint 或 operation token'
    );
  }
  const current = readPositionDatabaseCheckpoint(db);
  if (!current) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘操作恢复时侧库 checkpoint 缺失'
    );
  }
  assertCurrentPositionCheckpointHistory(db, current);
  if (current.identity !== base.identity || current.generation < base.generation) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘操作恢复时侧库不在预期 checkpoint 链上'
    );
  }
  if (current.generation === base.generation) {
    if (current.token !== base.token) {
      throw new PositionReconciliationError(
        'position-side-db-mismatch',
        '平盘操作恢复时基准 generation 已发生分叉'
      );
    }
    return {
      baseCheckpoint: base,
      currentCheckpoint: current,
      committedMutations: 0,
      committedInputs: listPositionCommittedOperationInputs(db, token)
    };
  }
  const history = db.prepare(`
    SELECT generation, token, parent_token AS parentToken,
           operation_token AS operationToken
    FROM position_checkpoint_history
    WHERE generation BETWEEN ? AND ?
    ORDER BY generation
  `).all(base.generation, current.generation);
  if (history.length !== current.generation - base.generation + 1
      || Number(history[0] && history[0].generation) !== base.generation
      || text(history[0] && history[0].token) !== base.token) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘操作恢复时 checkpoint 历史链不完整'
    );
  }
  let parentToken = base.token;
  for (let index = 1; index < history.length; index += 1) {
    const item = history[index];
    if (Number(item.generation) !== base.generation + index
        || text(item.parentToken) !== parentToken
        || text(item.operationToken) !== token) {
      throw new PositionReconciliationError(
        'position-side-db-mismatch',
        '平盘操作恢复时 checkpoint 历史不属于当前 operation token'
      );
    }
    parentToken = text(item.token);
  }
  if (parentToken !== current.token) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘操作恢复时 checkpoint 历史末端不一致'
    );
  }
  return {
    baseCheckpoint: base,
    currentCheckpoint: current,
    committedMutations: current.generation - base.generation,
    committedInputs: listPositionCommittedOperationInputs(db, token)
  };
}

function runPositionSideDbMutation({
  db,
  expectedCheckpoint,
  operationToken,
  inputEvidence = [],
  fallbackSourceType = '',
  requireExternalOperationToken = false,
  mutate
}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('平盘侧库 mutation 缺少 SQLite 连接');
  }
  if (typeof mutate !== 'function') {
    throw new TypeError('平盘侧库 mutation 缺少 mutate 函数');
  }
  const expected = normalizePositionCheckpoint(expectedCheckpoint);
  if (!expected) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘侧库 mutation 缺少预期 checkpoint'
    );
  }
  const suppliedOperationToken = text(operationToken);
  if (requireExternalOperationToken && !suppliedOperationToken) {
    throw new PositionReconciliationError(
      'position-import-intent-not-durable',
      '平盘导入写入缺少外部 operation token'
    );
  }
  const token = suppliedOperationToken || crypto.randomUUID();

  db.exec('BEGIN IMMEDIATE');
  try {
    const currentCheckpoint = readPositionDatabaseCheckpoint(db);
    if (!currentCheckpoint) {
      throw new PositionReconciliationError(
        'position-side-db-mismatch',
        '平盘对账侧库 checkpoint 缺失'
      );
    }
    assertCurrentPositionCheckpointHistory(db, currentCheckpoint);
    assertExpectedCheckpoint(currentCheckpoint, expected);

    const result = mutate({
      db,
      operationToken: token,
      currentCheckpoint
    });
    if (result && typeof result.then === 'function') {
      throw new TypeError('平盘侧库 mutation 必须为同步函数');
    }

    recordPositionOperationInputs(
      db,
      token,
      inputEvidence,
      fallbackSourceType
    );

    const nextGeneration = currentCheckpoint.generation + 1;
    if (!Number.isSafeInteger(nextGeneration)) {
      throw new PositionReconciliationError(
        'position-side-db-mismatch',
        '平盘对账侧库 generation 超出安全范围'
      );
    }
    const nextToken = crypto.randomUUID();
    const generationUpdate = db.prepare(`
      UPDATE position_meta
      SET value = ?
      WHERE key = ? AND value = ?
    `).run(
      String(nextGeneration),
      POSITION_DB_GENERATION_KEY,
      String(currentCheckpoint.generation)
    );
    const tokenUpdate = db.prepare(`
      UPDATE position_meta SET value = ? WHERE key = ? AND value = ?
    `).run(
      nextToken,
      POSITION_DB_CHECKPOINT_TOKEN_KEY,
      currentCheckpoint.token
    );
    const historyInsert = db.prepare(`
      INSERT INTO position_checkpoint_history(
        generation, token, parent_token, operation_token
      )
      VALUES (?, ?, ?, ?)
    `).run(nextGeneration, nextToken, currentCheckpoint.token, token);
    if (Number(generationUpdate.changes) !== 1
        || Number(tokenUpdate.changes) !== 1
        || Number(historyInsert.changes) !== 1) {
      throw new PositionReconciliationError(
        'position-side-db-mismatch',
        '平盘对账侧库 checkpoint 更新失败'
      );
    }
    const nextCheckpoint = {
      identity: currentCheckpoint.identity,
      generation: nextGeneration,
      token: nextToken
    };
    db.exec('COMMIT');
    return { result, nextCheckpoint };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_rollbackError) {
      // 保留原始错误。
    }
    throw error;
  }
}

module.exports = {
  POSITION_DB_IDENTITY_KEY,
  POSITION_DB_GENERATION_KEY,
  POSITION_DB_CHECKPOINT_TOKEN_KEY,
  normalizePositionCheckpoint,
  positionCheckpointsEqual,
  readPositionDatabaseCheckpoint,
  assertCurrentPositionCheckpointHistory,
  normalizeOperationInputEvidence,
  operationInputEvidenceHash,
  recordPositionOperationInputs,
  listPositionCommittedOperationInputs,
  inspectPositionOperationCommitChain,
  runPositionSideDbMutation
};
