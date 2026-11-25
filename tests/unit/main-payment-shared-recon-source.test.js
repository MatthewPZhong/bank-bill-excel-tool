// v3.1.7 main 入口静态契约：Payment 与 R5s2-recon 只读同一份调拨派生工作副本。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareRunFundTransferReconDerivation } = require('../../src/main-process/linked-derive-rebuild');

const mainPath = path.join(__dirname, '..', '..', 'src', 'main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const rendererPath = path.join(__dirname, '..', '..', 'src', 'renderer', 'controllers', 'bank-statement.js');
const rendererSource = fs.readFileSync(rendererPath, 'utf8');

function runBlock() {
  const start = source.indexOf("trackedIpcHandle('bank-statement:run'");
  assert.ok(start >= 0, '应能定位 bank-statement:run');
  const end = source.indexOf("trackedIpcHandle('bank-statement:export'", start);
  assert.ok(end > start, '应能定位 bank-statement:run 结束');
  return source.slice(start, end);
}

const block = runBlock();

test('Payment 不再读取 mid-allocation 原始订单或注入 midAllocationContext', () => {
  assert.ok(!block.includes('workingMidRows'));
  assert.ok(!block.includes('midAllocationContext'));
  assert.ok(!block.includes("readLinkedTableRows('mid-allocation')"));
});

test('Payment 开启时强制加载 fundTransferReconContext 工作副本', () => {
  assert.ok(
    /const\s+reconSourceMidEnabled\s*=\s*paymentOfflineEnabled\s*\|\|\s*configuredReconSourceMidEnabled/.test(block)
  );
  assert.ok(
    /fundTransferReconContext:\s*\{\s*reconRows:\s*workingReconRows\s*\}/.test(block)
  );
});

test('Payment 开启时派生失败必须阻断，不能读取陈旧持久表降级', () => {
  // v3.2.22：run 入口的映射读取与重派生抽到 prepareRunFundTransferReconDerivation；Payment 开关必须传入，且在读派生表之前。
  const prepAt = block.indexOf('prepareRunFundTransferReconDerivation(');
  assert.ok(prepAt >= 0);
  assert.ok(/\{\s*reconSourceMidEnabled,\s*dbsChargeScenarioEnabled,\s*r5s2GatewaySourceEnabled,\s*paymentOfflineEnabled\s*\}/.test(block.slice(prepAt)));
  assert.ok(block.indexOf('database.readFundTransferReconRows()', prepAt) > prepAt);
  const logs = [];
  assert.throws(
    () => prepareRunFundTransferReconDerivation({
      database: {
        readLinkedTableRows: () => [],
        replaceFundTransferReconRows: () => { throw new Error('不应写入'); }
      },
      buildFundTransferReconRows: () => { throw new Error('builder boom'); },
      appendActivityLogEntry: (entry) => logs.push(entry)
    }, { reconSourceMidEnabled: true, paymentOfflineEnabled: true }),
    (error) => error.code === 'payment-offline-recon-derive-failed'
  );
  assert.match(logs[0].message, /Payment运行已阻断/);
});

test('Payment 预检阻断的 code 和明细从 main 透传并在运行弹框显示', () => {
  assert.ok(block.includes("code: error && error.code ? String(error.code) : undefined"));
  assert.ok(block.includes('detailLines: error && Array.isArray(error.detailLines) ? error.detailLines : []'));
  assert.ok(rendererSource.includes("detailLines.slice(0, 20).map(escapeHtml).join('<br/>')"));
  assert.match(
    rendererSource,
    /if \(result\?\.status !== 'ok'\) \{[\s\S]*?await refreshBankStatementStatus\(\);[\s\S]*?alert\(`/
  );
});

test('新一轮运行开始即清空旧 processingResult，预检失败后不能导出上一轮结果', () => {
  const sessionGuard = block.indexOf('if (!bankStatementSession)');
  const clearResult = block.indexOf('processingResult = null;', sessionGuard);
  const scenarioRead = block.indexOf('const allScenarios = database.listScenarios();', sessionGuard);
  assert.ok(sessionGuard >= 0);
  assert.ok(clearResult > sessionGuard);
  assert.ok(scenarioRead > clearResult);
});
