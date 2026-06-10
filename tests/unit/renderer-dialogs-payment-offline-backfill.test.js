// v3.0.4 块 F · F1/F2：「Payment线下调拨订单回填处理」UI（弹窗勾选行 + 条件展开三输入框 + config 浅合并保存）的源码断言。
//
// renderer-dialogs.js 是 10000+ 行的浏览器 IIFE（依赖 DOM + deps 注入），无 jsdom 单测脚手架，
// 故沿用本仓既有范式（tests/unit/renderer-dialogs-scenario-channel.test.js）：用源码字符串断言锁定关键实现，
// 防止后续重构无意回退。配套行为由 backend 层测试 + main 侧守卫 + 手测把关。
//
// 锁定点：
//   - F1 gating：仅 config.subCategory==='fund-transfer-backfill' 场景显示 payment 控件。
//   - F1 校验：勾选时银行渠道/地区/大账号三项全必填；inline 校验不关弹窗（return 无 reopen）。
//   - F1 显隐：勾选/取消联动展开区显隐（取消保留输入值）。
//   - F2 守卫：加载完成前禁用保存（防竞态写空 config）。
//   - F2 浅合并：update 携带 config 时以 cachedConfig 为基底展开，仅覆盖 paymentOfflineBackfill（不丢 seed 字段）。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIALOGS_PATH = path.join(__dirname, '..', '..', 'src', 'renderer-dialogs.js');
const source = fs.readFileSync(DIALOGS_PATH, 'utf8');

// 把弹窗工厂函数体单独切出来，避免断言误命中文件其他位置的同名片段。
function extractDialogBody() {
  const start = source.indexOf('function createBuiltinFixedChannelManageDialog(scenarioId)');
  assert.ok(start >= 0, '应能定位 createBuiltinFixedChannelManageDialog 工厂');
  // 切到下一个工厂声明前（createCopyScenarioDialog）即可覆盖整个函数体
  const end = source.indexOf('function createCopyScenarioDialog(', start);
  assert.ok(end > start, '应能定位 createBuiltinFixedChannelManageDialog 工厂结束位置');
  return source.slice(start, end);
}

const dialogBody = extractDialogBody();

describe('F1：Payment 勾选行 + 条件展开三输入框', () => {
  test('HTML 含勾选行「Payment线下调拨订单回填处理」与三组输入框（银行渠道/地区/大账号）', () => {
    assert.ok(dialogBody.includes('Payment线下调拨订单回填处理'), '应有勾选行文案');
    assert.ok(dialogBody.includes('data-field="payment-offline-enabled"'), '应有勾选框');
    assert.ok(dialogBody.includes('data-field="payment-bank-channel"'), '应有银行渠道输入框');
    assert.ok(dialogBody.includes('data-field="payment-region"'), '应有地区输入框');
    assert.ok(dialogBody.includes('data-field="payment-big-account"'), '应有大账号输入框');
  });

  test('输入框不预填生产值，仅 placeholder 示例（如 BGL / 如 CN / 如 202782001）', () => {
    assert.ok(dialogBody.includes('placeholder="如 BGL"'), '银行渠道 placeholder 示例');
    assert.ok(dialogBody.includes('placeholder="如 CN"'), '地区 placeholder 示例');
    assert.ok(dialogBody.includes('placeholder="如 202782001"'), '大账号 placeholder 示例');
  });

  test('gating：仅 config.subCategory===fund-transfer-backfill 场景显示 payment 控件', () => {
    assert.ok(
      /isPaymentScenario\s*=\s*cachedConfig\.subCategory\s*===\s*'fund-transfer-backfill'/.test(dialogBody),
      'gating 应判定 cachedConfig.subCategory === fund-transfer-backfill'
    );
    // gating 生效后才显示 paymentRow（默认 hidden）
    assert.ok(
      /if\s*\(isPaymentScenario\s*&&\s*paymentRow\)\s*\{[\s\S]*?paymentRow\.hidden\s*=\s*false/.test(dialogBody),
      '仅 payment 场景才把勾选行 hidden 置 false'
    );
  });

  test('显隐联动：勾选/取消展开区显隐（取消勾选保留输入值，不清空 input.value）', () => {
    assert.ok(dialogBody.includes('function syncPaymentFieldsVisibility()'), '应有显隐联动函数');
    assert.ok(
      /paymentFields\.hidden\s*=\s*!paymentCheck\.checked/.test(dialogBody),
      '展开区 hidden 跟随勾选框 checked'
    );
    // 取消勾选不应清空输入框值（保留草稿）——断言 change 联动里没有把 input.value 置空
    assert.ok(
      !/payment(BankChannel|Region|BigAccount)Input\.value\s*=\s*''/.test(
        dialogBody.slice(dialogBody.indexOf('function syncPaymentFieldsVisibility'),
          dialogBody.indexOf('// 异步加载渠道列表'))
      ),
      '取消勾选不应清空 payment 输入框值'
    );
  });

  test('校验：勾选时三项全必填，inline 校验不关弹窗（return 无 reopen/createAlertDialog）', () => {
    // 关键校验分支：enabled && (!bankChannel || !region || !bigAccount)
    assert.ok(
      /if\s*\(enabled\s*&&\s*\(!bankChannel\s*\|\|\s*!region\s*\|\|\s*!bigAccount\)\)/.test(dialogBody),
      '勾选时三项任一为空应拦截'
    );
    // inline：写 paymentError 文案 + return，不调 createBuiltinFixedChannelManageDialog reopen
    const validationBlock = dialogBody.slice(
      dialogBody.indexOf('if (enabled && (!bankChannel'),
      dialogBody.indexOf('paymentOfflineBackfill = { enabled')
    );
    assert.ok(validationBlock.includes('paymentError.hidden = false'), '校验失败应显示 inline 错误');
    assert.ok(validationBlock.includes('return;'), '校验失败应 return 不继续保存');
    assert.ok(
      !validationBlock.includes('createBuiltinFixedChannelManageDialog'),
      'inline 校验失败不得 reopen 弹窗（避免丢草稿）'
    );
  });
});

describe('F2：config 读-改-写浅合并保存 + 加载守卫', () => {
  test('加载完成前禁用保存（saveButton.disabled = true → 加载后 false）', () => {
    assert.ok(
      /if\s*\(saveButton\)\s*saveButton\.disabled\s*=\s*true/.test(dialogBody),
      '加载 IIFE 前应禁用保存按钮'
    );
    assert.ok(
      /configLoaded\s*=\s*true[\s\S]*?if\s*\(saveButton\)\s*saveButton\.disabled\s*=\s*false/.test(dialogBody),
      '加载完成后置 configLoaded=true 并启用保存'
    );
    assert.ok(
      /if\s*\(!configLoaded\)\s*return/.test(dialogBody),
      '保存 handler 开头应有 configLoaded 守卫（双保险）'
    );
  });

  test('cachedConfig 缓存自 scenarios.get 返回的完整 config（保存浅合并基底）', () => {
    assert.ok(
      /cachedConfig\s*=\s*\(scResult\.scenario\.config\s*&&\s*typeof\s*scResult\.scenario\.config\s*===\s*'object'\)/.test(dialogBody),
      'cachedConfig 应缓存 scenarios.get 返回的 config'
    );
  });

  test('浅合并：update 的 config 以 cachedConfig 为基底展开，仅覆盖 paymentOfflineBackfill（不丢 seed 字段）', () => {
    assert.ok(
      /updateFields\.config\s*=\s*\{\s*\.\.\.\(cachedConfig\s*\|\|\s*\{\}\)\s*,\s*paymentOfflineBackfill\s*\}/.test(dialogBody),
      'config 必须用 { ...cachedConfig, paymentOfflineBackfill } 浅合并，保留 seed 契约字段'
    );
    // paymentOfflineBackfill 四字段 schema 锁定
    assert.ok(
      /paymentOfflineBackfill\s*=\s*\{\s*enabled,\s*bankChannel,\s*region,\s*bigAccount\s*\}/.test(dialogBody),
      'paymentOfflineBackfill 应含 enabled/bankChannel/region/bigAccount 四字段'
    );
  });

  test('非 payment 场景维持原行为：update 不携带 config（仅 priority）', () => {
    assert.ok(
      /const\s+updateFields\s*=\s*\{\s*priority:\s*priorityNum\s*\}/.test(dialogBody),
      'updateFields 基底仅 priority'
    );
    assert.ok(
      /if\s*\(isPaymentScenario\s*&&\s*paymentOfflineBackfill\)\s*\{\s*updateFields\.config/.test(dialogBody),
      'config 仅在 payment 场景且校验通过时才携带'
    );
  });
});
