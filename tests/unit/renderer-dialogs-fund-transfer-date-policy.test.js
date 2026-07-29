'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer-dialogs.js'),
  'utf8'
);
const styles = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'styles-gemini-extra.css'),
  'utf8'
);

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `应能定位 ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `应能定位 ${endMarker}`);
  return source.slice(start, end);
}

const managerBody = extract(
  'function createScenariosManagerDialog(',
  'function reopenScenariosManager()'
);
const dialogBody = extract(
  'function createBuiltinFixedChannelManageDialog(scenarioId)',
  'function createCopyScenarioDialog('
);

describe('v3.1.1 canonical owner UI 身份与旧冲突处置', () => {
  test('UI canonical 谓词同时检查 category/isBuiltin/funcCategory/subCategory', () => {
    const helper = extract(
      'function hasFundTransferReservedSignatureUi(scenario)',
      'async function loadScenariosOrAlert()'
    );
    assert.ok(helper.includes("scenario.category === 'builtin-fixed'"));
    assert.ok(helper.includes("config.funcCategory === 'platform-order'"));
    assert.ok(helper.includes("config.subCategory === 'fund-transfer-backfill'"));
    assert.ok(/scenario\.isBuiltin\s*===\s*true/.test(helper));
  });

  test('旧非内置保留签名显示“非系统冲突场景”与“删除冲突”，不进入管理页', () => {
    assert.ok(managerBody.includes('非系统冲突场景'));
    assert.ok(managerBody.includes('删除冲突'));
    assert.ok(
      /isFundTransferReservedConflict[\s\S]*?data-row-action="delete"/.test(managerBody)
    );
  });

  test('列表渲染前会为全部 builtin-fixed 行补齐 config，冲突判定不依赖简表缺失字段', () => {
    assert.ok(
      /scenarios[\s\S]*?\.filter\(\(s\)\s*=>\s*s\.category\s*===\s*'builtin-fixed'\)[\s\S]*?desktopApi\.scenarios\.get\(s\.id\)[\s\S]*?s\.config\s*=\s*detail\.scenario\.config/.test(managerBody),
      'scenarios:list 仅返简表；renderRow 前必须通过 scenarios.get 补齐 config，才能识别旧保留签名冲突'
    );
  });
});

describe('v3.1.1 调拨回填功能管理', () => {
  test('canonical owner 使用新标题、隐藏适用渠道控件，并显示日期控件', () => {
    assert.ok(dialogBody.includes('调拨回填功能管理'));
    assert.ok(dialogBody.includes('data-role="applicable-channel-group"'));
    assert.ok(
      /if\s*\(applicableChannelGroup\)\s*applicableChannelGroup\.hidden\s*=\s*true/.test(dialogBody)
    );
    assert.ok(dialogBody.includes('调拨单匹配日期'));
    assert.ok(dialogBody.includes('data-field="date-match-enabled"'));
    assert.ok(dialogBody.includes('data-field="date-tolerance-days"'));
    assert.ok(dialogBody.includes('min="1" max="999"'));
  });

  test('调拨单匹配日期与优先级共用一行，日期在左、优先级在右', () => {
    const rowBody = extract(
      'data-role="date-priority-row"',
      '<!-- /builtin-fixed-date-priority-row -->'
    );
    const dateIndex = rowBody.indexOf('data-role="date-policy-row"');
    const priorityIndex = rowBody.indexOf('builtin-fixed-priority-group');
    assert.ok(dateIndex >= 0, '共享行内应包含调拨单匹配日期');
    assert.ok(priorityIndex > dateIndex, '优先级必须位于调拨单匹配日期右侧');
    assert.ok(
      /data-role="date-policy-row"\s+hidden/.test(rowBody),
      '非 canonical 场景仍默认隐藏日期组'
    );
    assert.ok(
      dialogBody.indexOf('data-role="date-policy-error"')
        > dialogBody.indexOf('<!-- /builtin-fixed-date-priority-row -->'),
      '日期错误提示应位于共享行下方，不能把正常布局挤成两行'
    );
    assert.ok(
      /\.builtin-fixed-date-policy-group\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;/.test(styles),
      '日期策略组必须使用横向 flex 布局'
    );
    assert.ok(
      /\.builtin-fixed-date-policy-group\s*\{\s*transform:\s*translateX\(4px\);/.test(styles),
      '日期勾选项必须右移 4px，与下方首个勾选项左起点对齐'
    );
    assert.ok(
      /\.builtin-fixed-date-policy-group\[hidden\]\s*\{\s*display:\s*none;/.test(styles),
      '非 canonical 场景必须能可靠隐藏日期策略组'
    );
  });

  test('日期开关默认 true；关闭仅禁用输入框、不清空原值', () => {
    assert.ok(
      /dateMatchEnabledCheck\.checked\s*=\s*cachedConfig\.dateMatchEnabled\s*!==\s*false/.test(dialogBody)
    );
    assert.ok(
      dialogBody.includes('const configuredDays = cachedConfig.dateToleranceDays'),
      '加载配置时应保留原始类型，由严格整数校验决定是否回退默认值'
    );
    assert.ok(
      /Number\.isInteger\(configuredDays\)[\s\S]*?configuredDays\s*>=\s*1[\s\S]*?configuredDays\s*<=\s*999/.test(dialogBody)
    );
    const syncBlock = extract(
      'function syncDatePolicyInputState()',
      '// F1：勾选/取消勾选'
    );
    assert.ok(
      /dateToleranceDaysInput\.disabled\s*=\s*!dateMatchEnabledCheck\.checked/.test(syncBlock)
    );
    assert.ok(!/dateToleranceDaysInput\.value\s*=/.test(syncBlock), '关闭开关不得清空 N');
  });

  test('保存前校验 1–999 整数，完整 config 浅合并写回日期/中台来源/Payment 子配置', () => {
    assert.ok(
      /!Number\.isInteger\(dateToleranceDays\)\s*\|\|\s*dateToleranceDays\s*<\s*1\s*\|\|\s*dateToleranceDays\s*>\s*999/.test(dialogBody)
    );
    assert.ok(
      /updateFields\.config\s*=\s*\{\s*\.\.\.\(cachedConfig\s*\|\|\s*\{\}\)\s*\}/.test(dialogBody)
    );
    assert.ok(dialogBody.includes('updateFields.config.dateMatchEnabled = dateMatchEnabled'));
    assert.ok(dialogBody.includes('updateFields.config.dateToleranceDays = dateToleranceDays'));
    assert.ok(dialogBody.includes('updateFields.config.reconSourceMid = reconSourceMid'));
    assert.ok(dialogBody.includes('updateFields.config.paymentOfflineBackfill = paymentOfflineBackfill'));
  });

  test('canonical owner 保存不调用渠道写入；非 owner 才 setApplicableChannels', () => {
    assert.ok(
      /if\s*\(!isCanonicalFundTransferOwner\)\s*\{[\s\S]*?desktopApi\.scenarios\.setApplicableChannels\(scenarioId,\s*ids\)/.test(dialogBody)
    );
  });
});
