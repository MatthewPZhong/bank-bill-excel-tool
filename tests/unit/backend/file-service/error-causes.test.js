const test = require('node:test');
const assert = require('node:assert/strict');

const { CAUSE_MAP, errorCodeToCause } = require('../../../../src/backend/file-service/error-causes');

// ========================================================================
// CAUSE_MAP 常量自洽性
// ========================================================================

test.describe('CAUSE_MAP — 常量结构', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(CAUSE_MAP));
  });

  test('所有 value 是非空字符串', () => {
    for (const [code, cause] of Object.entries(CAUSE_MAP)) {
      assert.equal(typeof cause, 'string', `${code} 的 cause 必须是字符串`);
      assert.ok(cause.length > 0, `${code} 的 cause 不能为空`);
    }
  });
});

test.describe('CAUSE_MAP — 银行对账单算法层错误码', () => {
  test('inconsistent-recon-id-values 已定义', () => {
    assert.ok(CAUSE_MAP['inconsistent-recon-id-values']);
    assert.match(CAUSE_MAP['inconsistent-recon-id-values'], /对账ID/);
  });

  test('single-field-multi-recon-id 已定义', () => {
    assert.ok(CAUSE_MAP['single-field-multi-recon-id']);
  });

  test('one-to-many / many-to-one 已定义', () => {
    assert.ok(CAUSE_MAP['one-to-many']);
    assert.ok(CAUSE_MAP['many-to-one']);
  });

  test('multi-gateway-match 已定义', () => {
    assert.ok(CAUSE_MAP['multi-gateway-match']);
  });

  test('overwrite-existing-* 已定义', () => {
    assert.ok(CAUSE_MAP['overwrite-existing-recon-id']);
    assert.ok(CAUSE_MAP['overwrite-existing-value']);
  });
});

test.describe('CAUSE_MAP — 文件 schema 错误码（跨模块共用）', () => {
  test('invalid-column-count / invalid-column-name 已定义', () => {
    assert.ok(CAUSE_MAP['invalid-column-count']);
    assert.ok(CAUSE_MAP['invalid-column-name']);
  });

  test('missing-sheet / file-not-found 已定义', () => {
    assert.ok(CAUSE_MAP['missing-sheet']);
    assert.ok(CAUSE_MAP['file-not-found']);
  });

  test('amount-parse-error / date-parse-error 已定义', () => {
    assert.ok(CAUSE_MAP['amount-parse-error']);
    assert.ok(CAUSE_MAP['date-parse-error']);
  });
});

test.describe('CAUSE_MAP — v3.0.23 R4 严格匹配', () => {
  test('方向、完整条件、多候选三个错误码均有中文原因', () => {
    for (const code of [
      'r4-fund-direction-mismatch',
      'r4-fund-match-mismatch',
      'r4-fund-multi-candidate'
    ]) {
      assert.ok(CAUSE_MAP[code], `${code} 应已定义`);
      assert.notEqual(errorCodeToCause(code), '未知错误');
    }
    assert.match(CAUSE_MAP['r4-fund-direction-mismatch'], /方向/);
    assert.match(CAUSE_MAP['r4-fund-match-mismatch'], /账号/);
    assert.match(CAUSE_MAP['r4-fund-multi-candidate'], /第一条/);
  });
});

test.describe('CAUSE_MAP — v3.0.24 Payment 多大账号', () => {
  test('非法大账号配置错误码有明确中文原因', () => {
    assert.ok(CAUSE_MAP['payment-offline-invalid-big-account-config']);
    assert.match(
      errorCodeToCause('payment-offline-invalid-big-account-config'),
      /大账号配置无效/
    );
  });
});

test.describe('CAUSE_MAP — v3.0.26 R5 Extra Fee 校验', () => {
  test('非法手续费错误码有明确中文原因', () => {
    assert.ok(CAUSE_MAP['r5-invalid-extra-fee']);
    assert.match(errorCodeToCause('r5-invalid-extra-fee'), /Extra Fee/);
    assert.match(errorCodeToCause('r5-invalid-extra-fee'), /调拨订单对账ID回填/);
    assert.match(errorCodeToCause('r5-invalid-extra-fee'), /手续费原值/);
  });
});

test.describe('CAUSE_MAP — v3.0.21 DBS-Charge outbound 方向守卫', () => {
  test('dbs-charge-fund-direction-mismatch 已定义且说明跳过步骤2改写', () => {
    assert.ok(CAUSE_MAP['dbs-charge-fund-direction-mismatch']);
    assert.match(CAUSE_MAP['dbs-charge-fund-direction-mismatch'], /Credit Amount/);
    assert.match(CAUSE_MAP['dbs-charge-fund-direction-mismatch'], /方向/);
    assert.match(CAUSE_MAP['dbs-charge-fund-direction-mismatch'], /步骤2/);
  });

  test('errorCodeToCause 返回完整中文原因', () => {
    assert.equal(
      errorCodeToCause('dbs-charge-fund-direction-mismatch'),
      'DBS-Charge 同对账ID存在白名单网关候选，但银行行 Credit Amount 非0，借贷方向不符，已跳过步骤2资金性质改写，请人工核对方向'
    );
  });
});

test.describe('CAUSE_MAP — 主模块粗粒度', () => {
  test('FILE_READ / FILE_TYPE 已定义', () => {
    assert.ok(CAUSE_MAP['FILE_READ']);
    assert.ok(CAUSE_MAP['FILE_TYPE']);
  });
});

test.describe('CAUSE_MAP — Pending 严重程度兜底', () => {
  test('fatal / row 已定义', () => {
    assert.ok(CAUSE_MAP['fatal']);
    assert.ok(CAUSE_MAP['row']);
  });
});

// ========================================================================
// errorCodeToCause
// ========================================================================

test.describe('errorCodeToCause — 错误码 → 中文描述', () => {
  test('已知 code → 对应中文', () => {
    assert.equal(
      errorCodeToCause('FILE_READ'),
      '文件读取失败，可能损坏或格式不对'
    );
    assert.equal(
      errorCodeToCause('FILE_TYPE'),
      '文件类型不支持'
    );
  });

  test('未知 code → 未知错误（不抛错）', () => {
    assert.equal(errorCodeToCause('NEVER_DEFINED_CODE'), '未知错误');
  });

  test('null / undefined / 空 → 未知错误', () => {
    assert.equal(errorCodeToCause(null), '未知错误');
    assert.equal(errorCodeToCause(undefined), '未知错误');
    assert.equal(errorCodeToCause(''), '未知错误');
  });

  test('Pending 严重程度作 code', () => {
    assert.equal(errorCodeToCause('fatal'), '导入失败，请检查文件');
    assert.equal(errorCodeToCause('row'), '这一行有问题，已被跳过');
  });

  test('算法层 code', () => {
    assert.equal(
      errorCodeToCause('one-to-many'),
      '一对多匹配，可能有重复数据'
    );
  });

  test('返回类型必为字符串', () => {
    assert.equal(typeof errorCodeToCause('anything'), 'string');
    assert.equal(typeof errorCodeToCause(null), 'string');
  });
});
