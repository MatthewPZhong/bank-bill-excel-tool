'use strict';

const { fail } = require('./contracts');
const { RULE_VERSION } = require('./import-adapter');

// 沿用历史 SQLite 列键；c13 的合计口径由封存计算版本确定，不能仅凭旧列名解释数值。
const RESULT_COLUMNS = Object.freeze(['c01_bu', 'c02_entity', 'c03_customer_no', 'c04_account_no', 'c05_account_type', 'c06_currency',
  'c07_start_date', 'c08_start_balance', 'c09_end_date', 'c10_end_balance', 'c11_flow_in', 'c12_flow_out', 'c13_reverse_flow',
  'c14_reverse_end', 'c15_difference', 'c16_account_presence', 'c17_multiple_op', 'c18_conclusion', 'c19_summary']);
const NOTE_COLUMNS = Object.freeze(['note_ordinal', 'record_type', 'owner_id', 'output_kind', 'sheet_name', 'sheet_row',
  'result_row_ordinal', 'key_bu', 'key_account', 'key_currency', 'source_role', 'field_key', 'source_artifact_id',
  'source_dataset_id', 'source_date', 'source_version', 'source_sheet', 'source_row', 'value_type', 'value_part', 'part_index', 'part_count']);
const INTEGER_NOTE_FIELDS = new Set(['note_ordinal', 'sheet_row', 'result_row_ordinal', 'source_artifact_id', 'source_version', 'source_row', 'part_index', 'part_count']);
const LEGACY_RESULT_SCHEMA_VERSION = 'bizop-result-v1-e03';
const RESULT_SCHEMA_VERSION = 'bizop-result-v2-net-flow';
const COMPUTE_RULE_VERSION = 'bizop-interval-v2-net-flow';
function resultContractFor(catalog) {
  if (catalog?.ruleVersion === RULE_VERSION) {
    if (catalog.resultSchemaVersion === LEGACY_RESULT_SCHEMA_VERSION && catalog.computeRuleVersion === undefined) {
      return { columnSchemaVersion: 1, computeRuleVersion: RULE_VERSION };
    }
    if (catalog.resultSchemaVersion === RESULT_SCHEMA_VERSION && catalog.computeRuleVersion === COMPUTE_RULE_VERSION) {
      return { columnSchemaVersion: 2, computeRuleVersion: COMPUTE_RULE_VERSION };
    }
  }
  fail('BIZOP_RESULT_CONTRACT_UNKNOWN', '结果计算合同不匹配，不能解释为其他版本');
}
const RESULT_SCHEMA = `CREATE TABLE result_rows(row_ordinal INTEGER PRIMARY KEY CHECK(row_ordinal>=1),
  ${RESULT_COLUMNS.map((name) => `${name} TEXT`).join(',')},
  key_bu TEXT COLLATE BINARY NOT NULL,key_account TEXT COLLATE BINARY NOT NULL,key_currency TEXT COLLATE BINARY NOT NULL,
  is_difference INTEGER NOT NULL CHECK(is_difference IN (0,1)),reason_bits INTEGER NOT NULL,
  description_source_role TEXT NOT NULL CHECK(description_source_role IN ('START_OP','END_OP','NONE')),
  UNIQUE(key_bu,key_account,key_currency))`;
const NOTES_SCHEMA = `CREATE TABLE explanation_records(${NOTE_COLUMNS.map((name) => `${name} ${INTEGER_NOTE_FIELDS.has(name) ? 'INTEGER' : 'TEXT'}${name === 'note_ordinal' ? ' PRIMARY KEY CHECK(note_ordinal>=1)' : ''}`).join(',')})`;
const PART_SCHEMA = `CREATE TABLE part_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload_schema_version INTEGER NOT NULL,
  owner_id TEXT NOT NULL,part_kind TEXT NOT NULL,part_number INTEGER NOT NULL,producer_task_id TEXT NOT NULL,
  cell_contract_version TEXT NOT NULL,rule_version TEXT NOT NULL,state TEXT NOT NULL,row_count INTEGER NOT NULL)`;

module.exports = { RESULT_COLUMNS, NOTE_COLUMNS, RESULT_SCHEMA_VERSION, LEGACY_RESULT_SCHEMA_VERSION, COMPUTE_RULE_VERSION,
  resultContractFor, RESULT_SCHEMA, NOTES_SCHEMA, PART_SCHEMA };
