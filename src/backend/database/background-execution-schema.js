'use strict';

let savepointSequence = 0;

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('background execution schema 需要 DatabaseSync');
  }
}

function withMigrationTransaction(db, work) {
  const nested = db.isTransaction === true;
  const savepoint = `background_execution_schema_${++savepointSequence}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    try {
      if (nested) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else {
        db.exec('ROLLBACK');
      }
    } catch (_rollbackError) {
      // 保留原始 migration 错误。
    }
    throw error;
  }
}

function ensureBackgroundExecutionRecoveryControlSchema(db) {
  assertDatabase(db);
  return withMigrationTransaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS background_execution_critical_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_version INTEGER NOT NULL,
        intent_id TEXT NOT NULL UNIQUE,
        action_key TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        task_run_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        coordination_kind TEXT NOT NULL CHECK (
          coordination_kind IN ('worker-critical', 'main-owned-settlement')
        ),
        state TEXT NOT NULL CHECK (
          state IN ('prepared', 'acked', 'committed', 'recovered', 'closed')
        ),
        conflict_scope_key TEXT NOT NULL,
        inspector_key TEXT NOT NULL,
        evidence_version INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        receipt_ref_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        retention_until TEXT,
        UNIQUE(action_key, operation_key, task_run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_bg_exec_intent_state
        ON background_execution_critical_intents(state, updated_at);

      CREATE INDEX IF NOT EXISTS idx_bg_exec_intent_scope
        ON background_execution_critical_intents(conflict_scope_key, state);

      CREATE TABLE IF NOT EXISTS background_execution_recovery_holds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hold_id TEXT NOT NULL UNIQUE,
        source_kind TEXT NOT NULL CHECK (
          source_kind IN (
            'critical-intent', 'publisher-journal',
            'target-post-image', 'existing-protocol',
            'module-recovery', 'manual'
          )
        ),
        source_ref TEXT NOT NULL,
        intent_id TEXT,
        action_key TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        task_run_id TEXT NOT NULL,
        conflict_scope_key TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
        resolution TEXT CHECK (
          resolution IS NULL OR resolution IN (
            'committed', 'not-committed', 'compensated', 'manual-override'
          )
        ),
        safe_summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK (
          (source_kind IN ('critical-intent', 'target-post-image') AND intent_id IS NOT NULL)
          OR (source_kind NOT IN ('critical-intent', 'target-post-image') AND intent_id IS NULL)
        ),
        UNIQUE(source_kind, source_ref),
        FOREIGN KEY(intent_id)
          REFERENCES background_execution_critical_intents(intent_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_bg_exec_active_hold_scope
        ON background_execution_recovery_holds(conflict_scope_key)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS background_execution_batch_recovery_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL,
        task_run_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('interrupted', 'recovering', 'resolved')
        ),
        final_outcome TEXT CHECK (
          final_outcome IS NULL OR final_outcome IN ('succeeded', 'failed')
        ),
        recovery_attempt_id TEXT,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(batch_id, task_run_id),
        FOREIGN KEY(batch_id) REFERENCES archive_batches(id),
        FOREIGN KEY(task_run_id) REFERENCES archive_task_runs(task_run_id)
      );

      CREATE TABLE IF NOT EXISTS background_execution_recovery_observation_attempts (
        observation_scope_key TEXT NOT NULL,
        observation_attempt_id INTEGER NOT NULL CHECK (
          observation_attempt_id >= 1
          AND observation_attempt_id <= 9007199254740991
        ),
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'inspection-completed',
            'inspection-failed-transient',
            'settlement-resumed',
            'settlement-failed-transient'
          )
        ),
        action_key TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        task_run_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        batch_id INTEGER,
        intent_id TEXT,
        hold_id TEXT,
        recovery_attempt_id TEXT,
        request_key TEXT UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'committed')),
        prepared_at TEXT NOT NULL,
        committed_at TEXT,
        PRIMARY KEY(observation_scope_key, observation_attempt_id),
        UNIQUE(observation_scope_key, observation_attempt_id, request_key),
        CHECK (
          status = 'prepared'
          OR (status = 'committed' AND request_key IS NOT NULL AND committed_at IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS background_execution_recovery_request_owners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_key TEXT NOT NULL UNIQUE,
        writer TEXT NOT NULL CHECK (
          writer IN ('transitionWithRecoveryEvent', 'appendObservationEvent')
        ),
        event_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL CHECK (
          length(request_hash) = 64
          AND request_hash NOT GLOB '*[^0-9a-f]*'
        ),
        request_jcs TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'committed')),
        created_at TEXT NOT NULL,
        committed_at TEXT,
        UNIQUE(request_key, writer, event_id, request_hash, created_at)
      );

      CREATE TABLE IF NOT EXISTS background_execution_recovery_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_key TEXT NOT NULL UNIQUE,
        writer TEXT NOT NULL CHECK (
          writer IN ('transitionWithRecoveryEvent', 'appendObservationEvent')
        ),
        event_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL CHECK (
          length(request_hash) = 64
          AND request_hash NOT GLOB '*[^0-9a-f]*'
        ),
        action_key TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        task_run_id TEXT NOT NULL,
        source_kind TEXT,
        source_ref TEXT,
        batch_id INTEGER,
        intent_id TEXT,
        hold_id TEXT,
        recovery_attempt_id TEXT,
        observation_scope_key TEXT,
        observation_attempt_id INTEGER,
        event_type TEXT NOT NULL,
        previous_state TEXT,
        next_state TEXT,
        safe_payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (
          event_type NOT IN (
            'inspection-completed',
            'inspection-failed-transient',
            'settlement-resumed',
            'settlement-failed-transient'
          )
          OR (previous_state IS NULL AND next_state IS NULL)
        ),
        CHECK (
          (source_kind IS NULL AND source_ref IS NULL)
          OR (source_kind IS NOT NULL AND source_ref IS NOT NULL)
        ),
        CHECK (
          source_kind IS NULL OR source_kind IN (
            'critical-intent', 'publisher-journal',
            'target-post-image', 'existing-protocol',
            'module-recovery', 'manual'
          )
        ),
        CHECK (
          (writer = 'transitionWithRecoveryEvent'
            AND observation_scope_key IS NULL
            AND observation_attempt_id IS NULL)
          OR (writer = 'appendObservationEvent'
            AND observation_scope_key IS NOT NULL
            AND observation_attempt_id >= 1
            AND observation_attempt_id <= 9007199254740991)
        ),
        FOREIGN KEY(request_key, writer, event_id, request_hash, created_at)
          REFERENCES background_execution_recovery_request_owners(
            request_key, writer, event_id, request_hash, created_at
          ),
        FOREIGN KEY(observation_scope_key, observation_attempt_id, request_key)
          REFERENCES background_execution_recovery_observation_attempts(
            observation_scope_key, observation_attempt_id, request_key
          )
      );

      CREATE INDEX IF NOT EXISTS idx_bg_exec_recovery_events_task
        ON background_execution_recovery_events(task_run_id, id);

      CREATE INDEX IF NOT EXISTS idx_bg_exec_recovery_events_operation
        ON background_execution_recovery_events(action_key, operation_key, id);

    `);
  });
}

module.exports = {
  ensureBackgroundExecutionRecoveryControlSchema
};
