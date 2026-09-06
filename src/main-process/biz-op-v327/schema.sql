-- v3.2.7 目录与恢复元数据；与存档主库同连接，默认禁用新区间业务。

CREATE TABLE IF NOT EXISTS biz_op_v327_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  mode TEXT NOT NULL CHECK(mode IN ('DISABLED','MIGRATING','ACTIVE','RECOVERY_HOLD')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  activation_task_id TEXT,
  cleanup_completed_at TEXT,
  activated_at TEXT
);
INSERT OR IGNORE INTO biz_op_v327_control(singleton,schema_version,mode) VALUES(1,1,'DISABLED');

CREATE TABLE IF NOT EXISTS biz_op_v327_version_counters (
  scope TEXT NOT NULL CHECK(scope IN ('OP','FLOW','RESULT')),
  key1 TEXT NOT NULL,
  key2 TEXT NOT NULL DEFAULT '',
  last_version INTEGER NOT NULL CHECK(last_version >= 1),
  PRIMARY KEY(scope,key1,key2),
  CHECK((scope IN ('OP','FLOW') AND key2 = '') OR (scope = 'RESULT' AND key1 < key2))
);

CREATE TABLE IF NOT EXISTS biz_op_v327_prepared_ops (
  task_run_id TEXT PRIMARY KEY REFERENCES archive_task_runs(task_run_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('IMPORT','RUN','DELETE','EXPORT','UPGRADE','RECLAIM')),
  phase TEXT NOT NULL CHECK(phase IN ('PREPARING','SEALED','APPLYING','SETTLING','ABORTING','CLOSED','HOLD')),
  expected_generation INTEGER NOT NULL CHECK(expected_generation >= 0),
  intent_digest TEXT NOT NULL,
  intent_rel_path TEXT NOT NULL,
  delete_mode TEXT CHECK(delete_mode IN ('KEEP_RESULTS','DELETE_ASSOCIATED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS biz_op_v327_datasets (
  dataset_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('OP','FLOW')),
  data_date TEXT NOT NULL,
  public_version INTEGER CHECK(public_version >= 1),
  state TEXT NOT NULL CHECK(state IN ('STAGED','ACTIVE','RETIRED','DELETED')),
  input_fingerprint TEXT NOT NULL,
  source_manifest_digest TEXT NOT NULL,
  payload_manifest_rel_path TEXT,
  payload_manifest_digest TEXT,
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  producer_task_id TEXT NOT NULL,
  activated_at TEXT,
  retired_at TEXT,
  UNIQUE(dataset_id,kind,data_date),
  CHECK(state = 'STAGED' OR public_version IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS biz_op_v327_dataset_version_unique
ON biz_op_v327_datasets(kind,data_date,public_version) WHERE public_version IS NOT NULL;

CREATE TABLE IF NOT EXISTS biz_op_v327_input_heads (
  kind TEXT NOT NULL CHECK(kind IN ('OP','FLOW')),
  data_date TEXT NOT NULL,
  dataset_id TEXT NOT NULL UNIQUE,
  published_generation INTEGER NOT NULL CHECK(published_generation >= 1),
  PRIMARY KEY(kind,data_date),
  FOREIGN KEY(dataset_id,kind,data_date)
    REFERENCES biz_op_v327_datasets(dataset_id,kind,data_date) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS biz_op_v327_dataset_sources (
  dataset_id TEXT NOT NULL REFERENCES biz_op_v327_datasets(dataset_id) ON DELETE RESTRICT,
  artifact_id INTEGER NOT NULL REFERENCES archive_artifacts(id) ON DELETE RESTRICT,
  source_sha256 TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  source_file_order INTEGER NOT NULL CHECK(source_file_order >= 0),
  source_sheet_name TEXT NOT NULL,
  slice_date TEXT NOT NULL,
  normalized_bu TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  PRIMARY KEY(dataset_id,artifact_id)
);

CREATE TABLE IF NOT EXISTS biz_op_v327_runs (
  run_id TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  result_version INTEGER CHECK(result_version >= 1),
  input_fingerprint TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('STAGED','PUBLISHED','DELETED')),
  payload_manifest_rel_path TEXT,
  payload_manifest_digest TEXT,
  full_row_count INTEGER NOT NULL CHECK(full_row_count >= 0),
  diff_row_count INTEGER NOT NULL CHECK(diff_row_count >= 0 AND diff_row_count <= full_row_count),
  producer_task_id TEXT NOT NULL,
  operation_month TEXT,
  published_at TEXT,
  deleted_at TEXT,
  CHECK(start_date < end_date),
  CHECK(state = 'STAGED' OR result_version IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS biz_op_v327_run_version_unique
ON biz_op_v327_runs(start_date,end_date,result_version) WHERE result_version IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS biz_op_v327_run_fingerprint_live_unique
ON biz_op_v327_runs(input_fingerprint) WHERE state = 'PUBLISHED';

CREATE TABLE IF NOT EXISTS biz_op_v327_run_inputs (
  run_id TEXT NOT NULL REFERENCES biz_op_v327_runs(run_id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK(role IN ('START_OP','END_OP','FLOW')),
  data_date TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  input_version INTEGER NOT NULL CHECK(input_version >= 1),
  source_manifest_digest TEXT NOT NULL,
  PRIMARY KEY(run_id,role,data_date)
);

CREATE TABLE IF NOT EXISTS biz_op_v327_run_artifacts (
  run_id TEXT NOT NULL REFERENCES biz_op_v327_runs(run_id) ON DELETE RESTRICT,
  artifact_id INTEGER NOT NULL REFERENCES archive_artifacts(id) ON DELETE RESTRICT,
  source_sha256 TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  PRIMARY KEY(run_id,artifact_id)
);

CREATE TABLE IF NOT EXISTS biz_op_v327_receipts (
  task_run_id TEXT PRIMARY KEY REFERENCES archive_task_runs(task_run_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('IMPORT','RUN','DELETE','UPGRADE')),
  intent_digest TEXT NOT NULL,
  generation_after INTEGER NOT NULL,
  outcome_json TEXT NOT NULL,
  committed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS biz_op_v327_reclaim_queue (
  reclaim_id TEXT PRIMARY KEY,
  owner_task_run_id TEXT NOT NULL,
  payload_kind TEXT NOT NULL CHECK(payload_kind IN ('DATASET','RESULT','DIAGNOSTIC','ABORTED_STAGE','UNUSED_CANDIDATE','LEGACY_SIDE_DB')),
  object_id TEXT NOT NULL,
  receipt_task_run_id TEXT REFERENCES biz_op_v327_receipts(task_run_id) DEFERRABLE INITIALLY DEFERRED,
  manifest_digest TEXT NOT NULL,
  plan_rel_path TEXT NOT NULL,
  authorization_digest TEXT,
  state TEXT NOT NULL CHECK(state IN ('PENDING','RECLAIMING','DONE','HOLD')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK((payload_kind='UNUSED_CANDIDATE') = (receipt_task_run_id IS NOT NULL)),
  UNIQUE(payload_kind,object_id)
);
CREATE INDEX IF NOT EXISTS biz_op_v327_runs_operation_month ON biz_op_v327_runs(operation_month,state,published_at);
CREATE INDEX IF NOT EXISTS biz_op_v327_datasets_date_kind ON biz_op_v327_datasets(data_date,kind,state);
CREATE INDEX IF NOT EXISTS biz_op_v327_run_inputs_dataset ON biz_op_v327_run_inputs(dataset_id,run_id);
CREATE INDEX IF NOT EXISTS biz_op_v327_reclaim_pending ON biz_op_v327_reclaim_queue(state,created_at);


CREATE TABLE IF NOT EXISTS biz_op_v327_read_pins (
  task_run_id TEXT NOT NULL REFERENCES biz_op_v327_prepared_ops(task_run_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK(object_kind IN ('DATASET','RESULT','DIAGNOSTIC')),
  object_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  read_plan_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','RELEASING','RECOVERY_BLOCKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(task_run_id,session_id,object_kind,object_id)
);
CREATE INDEX IF NOT EXISTS biz_op_v327_read_pins_object
ON biz_op_v327_read_pins(object_kind,object_id,state);


CREATE TABLE IF NOT EXISTS biz_op_v327_dispatches (
 task_run_id TEXT NOT NULL REFERENCES biz_op_v327_prepared_ops(task_run_id) ON DELETE RESTRICT,
 session_id TEXT NOT NULL,
 job_id TEXT NOT NULL,
 action_key TEXT NOT NULL,
 task_key TEXT NOT NULL,
 operation_key TEXT NOT NULL,
 worker_instance_id TEXT NOT NULL,
 runtime_instance_id TEXT NOT NULL,
 process_instance_id TEXT NOT NULL,
 owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
 process_exit_evidence_json TEXT,
 dispatch_nonce TEXT NOT NULL,
 carrier_kind TEXT NOT NULL CHECK(carrier_kind='thread-single'),
 plan_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PREPARED','STARTING','STARTED','TERMINAL_PENDING_CLOSURE','CLOSED','RECOVERY_BLOCKED')),
 closure_observation_seq INTEGER NOT NULL DEFAULT 0 CHECK(closure_observation_seq>=0),
 closure_disposition TEXT NOT NULL DEFAULT 'PENDING' CHECK(closure_disposition IN ('NOT_CREATED','EXITED','PENDING','UNKNOWN')),
 closure_evidence_digest TEXT,
 closure_evidence_json TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(task_run_id,session_id,job_id),
 UNIQUE(runtime_instance_id,job_id,worker_instance_id),
 CHECK(state!='CLOSED' OR (closure_disposition IN ('NOT_CREATED','EXITED') AND closure_evidence_digest IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS biz_op_v327_pin_dispatches (
 task_run_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 object_kind TEXT NOT NULL,
 object_id TEXT NOT NULL,
 job_id TEXT NOT NULL,
 PRIMARY KEY(task_run_id,session_id,object_kind,object_id,job_id),
 FOREIGN KEY(task_run_id,session_id,object_kind,object_id)
  REFERENCES biz_op_v327_read_pins(task_run_id,session_id,object_kind,object_id) ON DELETE RESTRICT,
 FOREIGN KEY(task_run_id,session_id,job_id)
  REFERENCES biz_op_v327_dispatches(task_run_id,session_id,job_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS biz_op_v327_settlement_progress (
 task_run_id TEXT PRIMARY KEY REFERENCES biz_op_v327_prepared_ops(task_run_id) ON DELETE RESTRICT,
 action_key TEXT NOT NULL,
 task_key TEXT NOT NULL,
 operation_key TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('module-recovery','publisher-journal')),
 source_ref TEXT NOT NULL UNIQUE,
 intent_digest TEXT NOT NULL,
 input_obligation TEXT NOT NULL DEFAULT 'PENDING' CHECK(input_obligation IN ('PENDING','COMPLETE')),
 business_fact TEXT NOT NULL CHECK(business_fact IN ('UNKNOWN','NOT_COMMITTED','COMMITTED','PUBLICATION_PENDING','PUBLISHED')),
 task_terminal_observed_at TEXT,
 archive_terminal_observed_at TEXT,
 state TEXT NOT NULL CHECK(state IN ('OPEN','RECOVERY_BLOCKED','COMPLETE')),
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS biz_op_v327_diagnostic_reports (
 report_ref TEXT PRIMARY KEY,
 task_run_id TEXT NOT NULL REFERENCES biz_op_v327_prepared_ops(task_run_id) ON DELETE RESTRICT,
 producer_job_id TEXT NOT NULL,
 producer_session_id TEXT NOT NULL,
 manifest_digest TEXT NOT NULL,
 report_rel_path TEXT NOT NULL,
 sample_count INTEGER NOT NULL CHECK(sample_count BETWEEN 0 AND 1000),
 sample_bytes INTEGER NOT NULL CHECK(sample_bytes BETWEEN 0 AND 8388608),
 scan_complete INTEGER NOT NULL CHECK(scan_complete IN (0,1)),
 error_count_exact INTEGER NOT NULL CHECK(error_count_exact IN (0,1)),
 state TEXT NOT NULL CHECK(state IN ('READY','RETIRED','MISSING','DELETED')),
 created_at TEXT NOT NULL,
 CHECK(error_count_exact=0 OR scan_complete=1)
);
CREATE INDEX IF NOT EXISTS biz_op_v327_dispatches_open ON biz_op_v327_dispatches(state,task_run_id);
CREATE INDEX IF NOT EXISTS biz_op_v327_settlement_open ON biz_op_v327_settlement_progress(state,task_run_id);

CREATE TABLE IF NOT EXISTS biz_op_v327_recovery_followups (
 source_kind TEXT NOT NULL,
 source_ref TEXT NOT NULL,
 task_run_id TEXT NOT NULL REFERENCES biz_op_v327_prepared_ops(task_run_id) ON DELETE RESTRICT,
 action_key TEXT NOT NULL,
 operation_key TEXT NOT NULL,
 intent_digest TEXT NOT NULL,
 inspection_evidence_digest TEXT NOT NULL,
 source_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('DISCOVERED','WAITING_CLOSURE','AUTHORIZED','CONTROL_PENDING','COMPLETE','RECOVERY_BLOCKED')),
 finalization_ref TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(source_kind,source_ref)
);
CREATE TABLE IF NOT EXISTS biz_op_v327_abort_finalizations (
 finalization_ref TEXT PRIMARY KEY,
 source_kind TEXT NOT NULL,
 source_ref TEXT NOT NULL,
 task_run_id TEXT NOT NULL REFERENCES biz_op_v327_prepared_ops(task_run_id) ON DELETE RESTRICT,
 action_key TEXT NOT NULL,
 operation_key TEXT NOT NULL,
 intent_digest TEXT NOT NULL,
 inspection_evidence_digest TEXT NOT NULL,
 closure_manifest_digest TEXT NOT NULL,
 terminal_reason TEXT NOT NULL CHECK(terminal_reason IN ('FAILED','CANCELLED')),
 cleanup_plan_digest TEXT NOT NULL,
 cleanup_plan_rel_path TEXT NOT NULL,
 finalized_at TEXT NOT NULL,
 UNIQUE(source_kind,source_ref),
 FOREIGN KEY(source_kind,source_ref) REFERENCES biz_op_v327_recovery_followups(source_kind,source_ref) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS biz_op_v327_abort_finalizations_immutable
BEFORE UPDATE ON biz_op_v327_abort_finalizations
BEGIN SELECT RAISE(ABORT,'abort finalization is immutable'); END;
CREATE INDEX IF NOT EXISTS biz_op_v327_followups_open ON biz_op_v327_recovery_followups(state,task_run_id);

CREATE TABLE IF NOT EXISTS biz_op_v327_diagnostic_lifecycle (
 report_ref TEXT PRIMARY KEY REFERENCES biz_op_v327_diagnostic_reports(report_ref) ON DELETE RESTRICT,
 sealed_manifest_rel_path TEXT NOT NULL,
 retention_until TEXT,
 retired_at TEXT,
 deleted_at TEXT,
 updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS biz_op_v327_diagnostic_pin_admission
BEFORE INSERT ON biz_op_v327_read_pins
WHEN NEW.object_kind='DIAGNOSTIC'
BEGIN
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM biz_op_v327_diagnostic_reports d
    WHERE d.report_ref=NEW.object_id AND d.state='READY'
      AND d.manifest_digest=NEW.manifest_digest
 ) THEN RAISE(ABORT,'report is unavailable or digest mismatched') END;
END;
CREATE TRIGGER IF NOT EXISTS biz_op_v327_diagnostic_pin_identity_immutable
BEFORE UPDATE OF task_run_id,session_id,object_kind,object_id,manifest_digest,read_plan_digest
ON biz_op_v327_read_pins
WHEN OLD.object_kind='DIAGNOSTIC' OR NEW.object_kind='DIAGNOSTIC'
BEGIN SELECT RAISE(ABORT,'report pin identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS biz_op_v327_diagnostic_deleted_guard
BEFORE UPDATE OF state ON biz_op_v327_diagnostic_reports
WHEN NEW.state='DELETED' AND EXISTS (
 SELECT 1 FROM biz_op_v327_read_pins p
 WHERE p.object_kind='DIAGNOSTIC' AND p.object_id=OLD.report_ref
)
BEGIN SELECT RAISE(ABORT,'report still has reader pins'); END;
CREATE TRIGGER IF NOT EXISTS biz_op_v327_diagnostic_delete_guard
BEFORE DELETE ON biz_op_v327_diagnostic_reports
WHEN EXISTS (
 SELECT 1 FROM biz_op_v327_read_pins p
 WHERE p.object_kind='DIAGNOSTIC' AND p.object_id=OLD.report_ref
)
BEGIN SELECT RAISE(ABORT,'report still has reader pins'); END;

CREATE TRIGGER IF NOT EXISTS biz_op_v327_receipt_update_guard
BEFORE UPDATE ON biz_op_v327_receipts
BEGIN SELECT RAISE(ABORT,'business receipt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS biz_op_v327_receipt_delete_guard
BEFORE DELETE ON biz_op_v327_receipts
BEGIN SELECT RAISE(ABORT,'business receipt must be retained'); END;
CREATE TRIGGER IF NOT EXISTS biz_op_v327_finalization_delete_guard
BEFORE DELETE ON biz_op_v327_abort_finalizations
BEGIN SELECT RAISE(ABORT,'abort finalization must be retained'); END;
CREATE INDEX IF NOT EXISTS biz_op_v327_receipt_task ON biz_op_v327_receipts(task_run_id,action);

-- 这里只保存现有 Publisher 的绑定和关闭/恢复观察，提交事实仍来自其 journal。
CREATE TABLE IF NOT EXISTS biz_op_v327_publications (
 task_run_id TEXT PRIMARY KEY REFERENCES biz_op_v327_prepared_ops(task_run_id) ON DELETE RESTRICT,
 binding_rel_path TEXT NOT NULL,
 binding_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('NOT_STARTED','STARTED','CLOSED_UNKNOWN','COMMITTED','NOT_COMMITTED')),
 attempt_nonce TEXT,
 owner_pid INTEGER,
 owner_instance TEXT,
 closure_json TEXT,
 closure_digest TEXT,
 outcome_json TEXT,
 outcome_digest TEXT,
 commit_proof_json TEXT,
 commit_proof_digest TEXT,
 input_consumed INTEGER NOT NULL DEFAULT 0 CHECK(input_consumed IN (0,1)),
 archive_settled INTEGER NOT NULL DEFAULT 0 CHECK(archive_settled IN (0,1)),
 acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)),
 cleanup_completed INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_completed IN (0,1)),
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS biz_op_v327_prepared_phase ON biz_op_v327_prepared_ops(phase,task_run_id);
