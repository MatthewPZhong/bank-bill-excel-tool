'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  REDACTED_TEXT,
  assertFinanceSafeValue,
  fromProtocolError,
  sanitizeFinanceSafeValue,
  toProtocolError,
  validateSafeErrorV1
} = require('../../../../src/main-process/background-execution/error-codec');

test('统一 error codec 只输出冻结 SafeErrorV1 exact shape，不泄露 stack/cause/context', () => {
  const source = new Error('worker failed');
  source.code = 'WORKER_FAILED';
  source.stage = 'compute';
  source.detailLines = ['row 3'];
  source.context = { private: true };
  source.cause = new Error('private cause');

  const encoded = toProtocolError(source);
  assert.deepEqual(encoded, {
    code: 'WORKER_FAILED',
    message: 'worker failed',
    stage: 'compute',
    detailLines: ['row 3']
  });
  assert.equal(Object.isFrozen(encoded), true);
  assert.equal(Object.isFrozen(encoded.detailLines), true);
  assert.equal(Object.prototype.hasOwnProperty.call(encoded, 'stack'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(encoded, 'cause'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(encoded, 'context'), false);

  const decoded = fromProtocolError(encoded);
  assert.equal(decoded.message, 'worker failed');
  assert.equal(decoded.code, 'WORKER_FAILED');
  assert.equal(decoded.stage, 'compute');
  assert.deepEqual(decoded.detailLines, ['row 3']);
});

test('统一 error codec fallback/maxErrorItems/finance-safe-v1 脱敏稳定', () => {
  const source = new Error('failed at /Users/alice/private/input.xlsx for 6222021234567890');
  source.detailLines = ['safe', 'raw /home/alice/private.csv', 'truncated'];
  const encoded = toProtocolError(source, 'BACKGROUND_FALLBACK', { maxErrorItems: 2 });
  assert.equal(encoded.code, 'BACKGROUND_FALLBACK');
  assert.equal(encoded.message, REDACTED_TEXT);
  assert.deepEqual(encoded.detailLines, ['safe', REDACTED_TEXT]);
  assert.doesNotThrow(() => validateSafeErrorV1(encoded, { maxErrorItems: 2 }));
});

test('SafeErrorV1 validator 拒绝额外 stack/cause、非字符串与超量 detailLines', () => {
  const base = { code: 'FAILED', message: 'safe', stage: 'execute', detailLines: [] };
  assert.throws(
    () => validateSafeErrorV1({ ...base, stack: 'private' }),
    (error) => error.code === 'SAFE_ERROR_KEYS_INVALID'
  );
  assert.throws(
    () => validateSafeErrorV1({ ...base, message: 1 }),
    (error) => error.code === 'SAFE_ERROR_STRING_INVALID' && error.path === '/message'
  );
  assert.throws(
    () => validateSafeErrorV1({ ...base, detailLines: ['one'] }, { maxErrorItems: 0 }),
    (error) => error.code === 'SAFE_ERROR_ITEMS_EXCEEDED'
  );

  let getterCalls = 0;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'message', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unsafe';
    }
  });
  assert.throws(
    () => validateSafeErrorV1(accessor),
    (error) => error.code === 'SAFE_ERROR_KEYS_INVALID' && error.path === '/message'
  );
  assert.equal(getterCalls, 0);
});

test('finance-safe-v1 唯一文本 gate 覆盖 key/value、分隔符、中英文标签与两类用户目录', () => {
  for (const text of [
    'rawRow=招商银行,6222021234567890,100.00',
    'orderId: ORD-20260822-001',
    'ReconID=RECON-001',
    'amountDetails: debit=100.00',
    '原始行：招商银行第 3 行',
    '订单号=CN-001',
    '金额明细：借方 100.00',
    'failed at /Users/alice/private/input.xlsx',
    'failed at /home/alice/private/input.xlsx',
    'failed at C:\\Users\\alice\\private\\input.xlsx',
    'failed at C:/Users/alice/private/input.xlsx',
    'path=/Users/alice/private/input.xlsx',
    'source=/home/alice/private/input.xlsx',
    'file:C:\\Users\\alice\\private\\input.xlsx',
    'file:C:/Users/alice/private/input.xlsx',
    'location=[/Users/alice/private/input.xlsx]',
    'location=file:///home/alice/private/input.xlsx',
    'source=file://localhost/Users/alice/private/input.xlsx',
    'source=file://localhost/home/alice/private/input.xlsx',
    'location=[\\Users\\alice\\private\\input.xlsx]',
    'path=\\\\Users\\alice\\private\\input.xlsx'
  ]) {
    assert.throws(
      () => assertFinanceSafeValue({ message: text }),
      (error) => error.code === 'PRIVACY_VALUE_FORBIDDEN' && error.path === '/message',
      text
    );
  }
  for (const key of ['accountNumber', 'rawRow', 'orderId', 'ReconID', 'amountDetails', '用户路径', '订单号']) {
    assert.throws(
      () => assertFinanceSafeValue({ [key]: 'masked' }),
      (error) => error.code === 'PRIVACY_VALUE_FORBIDDEN' && error.path === `/${key}`,
      key
    );
  }
  for (const text of [
    'rawRow parser failed',
    'order processing failed',
    'amount details unavailable',
    'reconciliation completed',
    'open /payload/result',
    'failed at C:\\Program Files\\BankTool\\worker.js',
    'path=/opt/BankTool/worker.js',
    'source=/var/lib/bank-tool/input.json',
    'http://localhost/Users/alice/public-help',
    'https://example.test/Users/alice/help',
    'file://files.example.test/Users/alice/shared-help',
    '/srv/Users/shared/input.xlsx'
  ]) {
    assert.doesNotThrow(() => assertFinanceSafeValue({ message: text }), text);
  }
});

test('SafeError detailLines 复用 descriptor-safe dense array gate，Proxy/accessor/洞/额外 key 均 fail closed', () => {
  const base = { code: 'FAILED', message: 'safe', stage: 'execute', detailLines: [] };
  let traps = 0;
  const proxiedLines = new Proxy([], {
    get() { traps += 1; return undefined; },
    getPrototypeOf() { traps += 1; return Array.prototype; },
    ownKeys() { traps += 1; return ['length']; }
  });
  assert.throws(
    () => validateSafeErrorV1({ ...base, detailLines: proxiedLines }),
    (error) => error.code === 'SAFE_ERROR_DETAIL_LINES_INVALID' && error.path === '/detailLines'
  );
  assert.equal(traps, 0);

  let getterCalls = 0;
  const accessorLines = ['safe'];
  Object.defineProperty(accessorLines, '0', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'private';
    }
  });
  assert.throws(
    () => validateSafeErrorV1({ ...base, detailLines: accessorLines }),
    (error) => error.code === 'SAFE_ERROR_DETAIL_LINES_INVALID' && error.path === '/detailLines/0'
  );
  assert.equal(getterCalls, 0);

  const sparse = new Array(1);
  assert.throws(
    () => validateSafeErrorV1({ ...base, detailLines: sparse }),
    (error) => error.code === 'SAFE_ERROR_DETAIL_LINES_INVALID' && error.path === '/detailLines/0'
  );
  const extra = ['safe'];
  extra.note = 'hidden channel';
  assert.throws(
    () => validateSafeErrorV1({ ...base, detailLines: extra }),
    (error) => error.code === 'SAFE_ERROR_DETAIL_LINES_INVALID' && error.path === '/detailLines'
  );
  assert.doesNotThrow(() => validateSafeErrorV1({ ...base, detailLines: ['safe', 'still safe'] }));

  const encoded = toProtocolError({ code: 'FAILED', message: 'safe', stage: 'execute', detailLines: proxiedLines });
  assert.deepEqual(encoded.detailLines, []);
  assert.equal(traps, 0);
});

test('本地 error codec 与 diagnostic sanitizer 共享 finance-safe 文本判定', () => {
  const source = new Error('订单号: ORD-PRIVATE path=file://localhost/Users/alice/input.xlsx');
  source.detailLines = [
    'ReconID=R-001',
    'source=file://localhost/home/alice/input.xlsx',
    'ordinary retry message'
  ];
  const encoded = toProtocolError(source);
  assert.equal(encoded.message, REDACTED_TEXT);
  assert.deepEqual(encoded.detailLines, [REDACTED_TEXT, REDACTED_TEXT, 'ordinary retry message']);

  assert.deepEqual(sanitizeFinanceSafeValue({
    type: 'probe',
    jobId: 'ReconID: R-001',
    source: 'file://localhost/Users/alice/input.xlsx',
    rawRow: 'private row',
    message: 'ordinary retry message'
  }), {
    type: 'probe',
    jobId: REDACTED_TEXT,
    source: REDACTED_TEXT,
    rawRow: REDACTED_TEXT,
    message: 'ordinary retry message'
  });

  const ordinary = new Error('path=/opt/BankTool/worker.js; source=/var/lib/bank-tool/input.json');
  assert.equal(toProtocolError(ordinary).message, ordinary.message);
  assert.deepEqual(sanitizeFinanceSafeValue({ message: ordinary.message }), { message: ordinary.message });
  assert.doesNotThrow(() => assertFinanceSafeValue({
    http: 'http://localhost/Users/alice/public-help',
    remoteFile: 'file://files.example.test/home/alice/shared-help'
  }));
});
