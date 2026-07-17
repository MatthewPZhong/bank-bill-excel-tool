'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer-dialogs.js'), 'utf8');
const start = source.indexOf('function createBuiltinFixedChannelManageDialog(scenarioId)');
const end = source.indexOf('function createCopyScenarioDialog(', start);
assert.ok(start >= 0 && end > start, '应能定位自带场景管理弹窗');
const dialogBody = source.slice(start, end);

describe('退款流水号模糊匹配场景配置', () => {
  test('仅退款场景显示左下角勾选框，老配置默认不勾选', () => {
    assert.ok(dialogBody.includes('银行打款流水号模糊匹配'));
    assert.ok(dialogBody.includes('data-field="bank-payment-serial-fuzzy-enabled"'));
    assert.match(
      dialogBody,
      /isRefundScenario\s*=\s*cachedConfig\.subCategory\s*===\s*'refund-order-backfill'/
    );
    assert.match(
      dialogBody,
      /refundFuzzyCheck\.checked\s*=\s*cachedConfig\.bankPaymentSerialFuzzyMatchEnabled\s*===\s*true/
    );
  });

  test('保存时基于完整 config 浅合并，仅覆盖退款开关', () => {
    assert.match(
      dialogBody,
      /bankPaymentSerialFuzzyMatchEnabled\s*=\s*refundFuzzyCheck\.checked\s*===\s*true/
    );
    assert.match(
      dialogBody,
      /if\s*\(isRefundScenario\s*&&\s*bankPaymentSerialFuzzyMatchEnabled\s*!==\s*null\)[\s\S]*?updateFields\.config\s*=\s*\{\s*\.\.\.\(cachedConfig\s*\|\|\s*\{\}\)\s*\}/
    );
    assert.ok(
      dialogBody.includes('updateFields.config.bankPaymentSerialFuzzyMatchEnabled = bankPaymentSerialFuzzyMatchEnabled')
    );
  });

  test('非退款场景不写该配置，Payment 既有浅合并分支保留', () => {
    assert.ok(dialogBody.includes('if (isPaymentScenario && (reconSourceMid !== null || paymentOfflineBackfill))'));
    assert.ok(dialogBody.includes('if (isRefundScenario && bankPaymentSerialFuzzyMatchEnabled !== null)'));
  });
});
