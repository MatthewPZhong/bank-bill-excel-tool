// v2.0.0-beta.4：error-causes 映射 smoke
//
// 验证：
//   - 已知 code 都返回非空 cause
//   - 未知 code fallback '未知错误'
//   - 空 / null / undefined 也返回 '未知错误'

const assert = require('node:assert/strict');
const { errorCodeToCause, CAUSE_MAP } = require('../../src/backend/file-service/error-causes');

function runErrorCausesSmokeTests() {
  let count = 0;
  function check(label, cond, msg) {
    count += 1;
    assert(cond, `${label} ${msg || 'assert failed'}`);
  }

  // E1：已知 code 都返回非空 cause
  Object.keys(CAUSE_MAP).forEach((code) => {
    const cause = errorCodeToCause(code);
    check(`E1[${code}]`, typeof cause === 'string' && cause.length > 0, '应返回非空 cause');
  });

  // E2：未知 code fallback '未知错误'
  check('E2.1', errorCodeToCause('non-existent-code-123') === '未知错误', '未知 code fallback');
  check('E2.2', errorCodeToCause('FOO_BAR') === '未知错误', '未知 code fallback 2');

  // E3：空 / null / undefined fallback '未知错误'
  check('E3.1', errorCodeToCause('') === '未知错误', '空字符串');
  check('E3.2', errorCodeToCause(null) === '未知错误', 'null');
  check('E3.3', errorCodeToCause(undefined) === '未知错误', 'undefined');

  // E4：CAUSE_MAP 是 frozen
  check('E4', Object.isFrozen(CAUSE_MAP), 'CAUSE_MAP 必须 frozen 防止运行时修改');

  // E5：3 模块代表性 code 都覆盖
  const mustHave = [
    'inconsistent-recon-id-values',  // 银行对账单 C1
    'one-to-many',                    // 银行对账单 C2
    'multi-gateway-match',            // 银行对账单 C3
    'FILE_READ',                      // 主模块 FileValidationError
    'invalid-column-count',           // schema 校验
    'fatal',                          // Pending severity
    'row'                             // Pending severity
  ];
  mustHave.forEach((code) => {
    const cause = errorCodeToCause(code);
    check(`E5[${code}]`, cause !== '未知错误', `${code} 必须有具体 cause`);
  });

  console.log(`  error-causes: ${count}/${count} PASS`);
}

module.exports = { runErrorCausesSmokeTests };

if (require.main === module) {
  runErrorCausesSmokeTests();
}
