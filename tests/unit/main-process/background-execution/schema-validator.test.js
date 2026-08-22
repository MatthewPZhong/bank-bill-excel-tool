'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SchemaCompileError,
  createSchemaValidator,
  jsonValueEqual
} = require('../../../../src/main-process/background-execution/schema-validator');
const policySchema = require('../../../../src/main-process/background-execution/schemas/platform-contract-v1.schema.json');
const protocolSchema = require('../../../../src/main-process/background-execution/schemas/platform-protocol-v1.schema.json');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CONTRACT_DIR = path.join(
  REPO_ROOT,
  'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution'
);
const BUNDLED_DIR = path.join(REPO_ROOT, 'src/main-process/background-execution/schemas');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('运行时 bundled Schema 与最终合同逐字节一致且不依赖 changes 路径', () => {
  const expected = {
    'platform-contract-v1.schema.json': 'e5a584903d8c88b1f6cce00cbe5e308796bed331ca476458833eb9c448f99ae8',
    'platform-protocol-v1.schema.json': 'd3f38eab7f0f5793fccc6d6f042199172c071887e386349d2559435565a99a43'
  };
  for (const [name, digest] of Object.entries(expected)) {
    const contractBytes = fs.readFileSync(path.join(CONTRACT_DIR, name));
    const bundledBytes = fs.readFileSync(path.join(BUNDLED_DIR, name));
    assert.deepEqual(bundledBytes, contractBytes);
    assert.equal(sha256(bundledBytes), digest);
  }
});

test('启动编译递归盘点当前两个 Schema 的完整 keyword 集', () => {
  const policyAudit = createSchemaValidator(policySchema).audit;
  const protocolAudit = createSchemaValidator(protocolSchema).audit;
  assert.deepEqual(policyAudit.keywords, [
    '$defs', '$id', '$ref', '$schema', 'additionalProperties', 'allOf', 'anyOf',
    'const', 'default', 'description', 'enum', 'exclusiveMinimum', 'format', 'if',
    'items', 'maxItems', 'maxLength', 'maximum', 'minItems', 'minLength',
    'minProperties', 'minimum', 'not', 'pattern', 'properties', 'propertyNames',
    'required', 'then', 'title', 'type', 'uniqueItems'
  ]);
  assert.deepEqual(protocolAudit.keywords, [
    '$defs', '$id', '$ref', '$schema', 'additionalProperties', 'allOf', 'anyOf',
    'const', 'description', 'enum', 'if', 'items', 'maxItems', 'maxLength',
    'maxProperties', 'maximum', 'minLength', 'minimum', 'oneOf', 'pattern',
    'properties', 'required', 'then', 'title', 'type', 'uniqueItems'
  ]);
});

test('未知 keyword 与未知 format 在编译期 fail closed', () => {
  const unknownKeyword = structuredClone(protocolSchema);
  unknownKeyword.$defs.safeKey.silentlyIgnoredKeyword = true;
  assert.throws(
    () => createSchemaValidator(unknownKeyword),
    (error) => error instanceof SchemaCompileError &&
      error.code === 'UNSUPPORTED_SCHEMA_KEYWORD' &&
      error.schemaPath === '#/$defs/safeKey/silentlyIgnoredKeyword'
  );

  assert.throws(
    () => createSchemaValidator({ type: 'string', format: 'hostname' }),
    (error) => error.code === 'UNSUPPORTED_SCHEMA_FORMAT'
  );
});

test('受控 validator self-test 覆盖 ref/defs、组合、条件、exact object、字符串、数组与数值边界', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'label', 'items', 'score', 'choice', 'metadata', 'timestamp'],
    properties: {
      kind: { enum: ['strict', 'loose'] },
      label: { $ref: '#/$defs/label' },
      items: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      score: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
      choice: { oneOf: [{ const: 'left' }, { const: 'right' }] },
      marker: { type: 'string' },
      metadata: {
        type: 'object', minProperties: 1, maxProperties: 2,
        propertyNames: { pattern: '^[a-z]+$' }, additionalProperties: { type: 'string' }
      },
      timestamp: { type: 'string', format: 'date-time' }
    },
    allOf: [
      { anyOf: [{ properties: { kind: { const: 'strict' } } }, { properties: { kind: { const: 'loose' } } }] },
      {
        if: { properties: { kind: { const: 'strict' } }, required: ['kind'] },
        then: { properties: { marker: { const: 'required' } }, required: ['marker'] },
        else: { not: { required: ['marker'] } }
      }
    ],
    $defs: {
      label: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' }
    }
  };
  const validator = createSchemaValidator(schema);
  const valid = {
    kind: 'strict', label: 'abc', items: [1, 2], score: 0.5, choice: 'left', marker: 'required',
    metadata: { source: 'fixture' }, timestamp: '2026-08-22T00:00:00Z'
  };
  assert.equal(validator.validate(valid).valid, true);

  function mutate(fields) {
    return { ...structuredClone(valid), ...fields };
  }
  const missingConditionalProperty = structuredClone(valid);
  delete missingConditionalProperty.marker;

  const mutations = [
    [mutate({ label: 'a' }), 'minLength'],
    [mutate({ label: 'abcde' }), 'maxLength'],
    [mutate({ label: 'AB' }), 'pattern'],
    [mutate({ label: 3 }), 'type'],
    [mutate({ kind: 'unknown' }), 'enum'],
    [mutate({ items: [] }), 'minItems'],
    [mutate({ items: [1, 2, 3] }), 'maxItems'],
    [mutate({ items: [1, 1] }), 'uniqueItems'],
    [mutate({ items: [0] }), 'minimum'],
    [mutate({ score: 0 }), 'exclusiveMinimum'],
    [mutate({ score: 11 }), 'maximum'],
    [mutate({ choice: 'middle' }), 'oneOf'],
    [mutate({ extra: true }), 'additionalProperties'],
    [missingConditionalProperty, 'required'],
    [mutate({ kind: 'loose' }), 'not'],
    [mutate({ metadata: {} }), 'minProperties'],
    [mutate({ metadata: { one: '1', two: '2', three: '3' } }), 'maxProperties'],
    [mutate({ metadata: { Invalid: 'value' } }), 'pattern'],
    [mutate({ timestamp: 'not-a-date' }), 'format'],
    [mutate({ timestamp: '2026-02-30T00:00:00Z' }), 'format']
  ];
  for (const [value, keyword] of mutations) {
    const result = validator.validate(value);
    assert.equal(result.valid, false, `mutation should fail keyword ${keyword}`);
    assert.ok(result.errors.some((error) => error.keyword === keyword), JSON.stringify(result.errors));
  }
});

test('JSON value equality 统一用于 const/enum/uniqueItems，0 与 -0 相等', () => {
  assert.equal(jsonValueEqual(0, -0), true);
  assert.equal(jsonValueEqual({ left: 1, right: [2] }, { right: [2], left: 1 }), true);
  assert.equal(jsonValueEqual([1, 2], [2, 1]), false);

  assert.equal(createSchemaValidator({ const: -0 }).validate(0).valid, true);
  assert.equal(createSchemaValidator({ enum: [-0] }).validate(0).valid, true);
  const unique = createSchemaValidator({ type: 'array', uniqueItems: true });
  assert.equal(unique.validate([0, -0]).valid, false);
  assert.equal(unique.validate([{ left: 1, right: 2 }, { right: 2, left: 1 }]).valid, false);
});

test('RFC3339 date-time 接受合法 leap second 表达并拒绝普通 :60 与非法日期', () => {
  const validator = createSchemaValidator({ type: 'string', format: 'date-time' });
  assert.equal(validator.validate('2016-12-31T23:59:60Z').valid, true);
  assert.equal(validator.validate('2016-12-31T18:59:60-05:00').valid, true);
  assert.equal(validator.validate('2016-12-31T12:00:60Z').valid, false);
  assert.equal(validator.validate('2016-11-30T23:59:60Z').valid, false);
  assert.equal(validator.validate('2026-02-29T00:00:00Z').valid, false);
});
