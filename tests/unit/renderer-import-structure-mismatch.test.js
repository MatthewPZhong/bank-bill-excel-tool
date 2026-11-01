'use strict';

// v3.2.14：「导入文件」中表头与当前结构不一致（含未识别）的文件，先弹差异明细（状态框只放得下摘要），
//   确认关闭后再给原有的退款 / 网关导入提示，两类弹窗不互相覆盖。
const { test } = require('node:test');
const assert = require('node:assert');
const { createModalDom } = require('../helpers/modal-dom');
const { createModalHost } = require('../../src/renderer/modal-host');
const { createBankStatementController } = require('../../src/renderer/controllers/bank-statement');

const MISMATCH = {
  fileName: '网关<新>.xlsx',
  status: 'unrecognized',
  message: '表头与「网关对账单」当前版本 V2 不一致',
  detailLines: ['最接近：网关对账单（当前版本 V2，31 列；文件 31 列）', '第 28 列（AB）：应为「fileId」，实际为「fieldId」']
};

function setup(t, results) {
  const dom = createModalDom();
  const host = createModalHost(dom);
  const alerts = [];
  const confirms = [];
  const controller = createBankStatementController({
    panel: { querySelector: () => ({ dataset: {}, addEventListener() {}, removeEventListener() {} }) },
    api: {
      sessionStatus: async () => ({ status: 'ok', hasBankStatement: true, hasRefundOrder: false }),
      refundCandidateCount: async () => ({ status: 'ok', candidateCount: 1 }),
      batchImport: async () => ({ status: 'ok', results })
    },
    config: { scenarios: { list: async () => ({ status: 'ok', scenarios: [{ name: '中台退款订单回填', enabled: true }] }) } },
    sharedReconSession: { sessionStatus: async () => ({ status: 'ok', hasFile: false }), subscribe: () => () => {} },
    ui: {
      modalHost: host,
      alert(message, options) { alerts.push({ message, options }); return dom.createDialog(); },
      confirm(options) { confirms.push(options); return dom.createDialog(); }
    }
  });
  t.after(() => { host.getTop()?.dispose(); controller.dispose(); host.dispose(); });
  return { host, alerts, confirms, controller };
}

test('表头不一致的文件先弹差异明细（转义、写日志明细），确认后才给退款导入提示', async (t) => {
  const env = setup(t, [{ status: 'ok', tableKey: 'bank-statement', fileName: '银行.xlsx' }, MISMATCH]);
  await env.controller.enter();
  await env.controller.commands.import();

  assert.strictEqual(env.alerts.length, 1);
  assert.strictEqual(env.confirms.length, 0, '差异弹窗关闭前不弹退款提示');
  const { message, options } = env.alerts[0];
  assert.match(message, /^1 个文件表头与当前结构不一致，未导入：<br>网关&lt;新&gt;\.xlsx：表头与「网关对账单」当前版本 V2 不一致/);
  assert.ok(message.includes('第 28 列（AB）：应为「fileId」，实际为「fieldId」'));
  assert.strictEqual(options.skipLogReport, undefined, '批量导入在主进程没有失败日志，由弹窗上报');
  assert.deepStrictEqual(options.logDetails, [`${MISMATCH.fileName}｜${MISMATCH.message}`, ...MISMATCH.detailLines]);

  env.host.getTop().close({ status: 'submitted', value: true });
  await options.onConfirm();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(env.confirms.length, 1, '确认后继续原有的退款导入提示');
  assert.match(env.confirms[0].message, /中台退款订单回填/);
});

test('没有差异明细的失败（读取失败、命中多张表）不弹差异窗口，照常提示', async (t) => {
  const env = setup(t, [
    { status: 'ok', tableKey: 'bank-statement', fileName: '银行.xlsx' },
    { status: 'ambiguous', fileName: 'a.xlsx', message: '表头同时命中多张表，无法唯一判定' },
    { status: 'unrecognized', fileName: 'b.xlsx', message: '未识别', detailLines: [] }
  ]);
  await env.controller.enter();
  await env.controller.commands.import();
  assert.strictEqual(env.alerts.length, 0);
  assert.strictEqual(env.confirms.length, 1);
});
