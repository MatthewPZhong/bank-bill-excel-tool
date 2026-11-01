'use strict';

// 银行账单处理链接表：识别签名随设置 → 模板文件当前版本；读出的行对应回内置列名（派生、匹配、导出按内置列名读取）。
const assert = require('node:assert/strict');
const test = require('node:test');

const { LINKED_IMPORT_SIGNATURES, ALL_TABLE_SIGNATURES } = require('../../../src/constants/table-signatures');
const {
  LINKED_STRUCTURE_RESOURCES,
  effectiveLinkedSignature,
  linkedStructureMismatchLines,
  projectLinkedRow,
  resolveLinkedSignatures
} = require('../../../src/main-process/linked-structure-signatures');

const signatureOf = (tableKey) => ALL_TABLE_SIGNATURES.find((signature) => signature.tableKey === tableKey)
  || LINKED_IMPORT_SIGNATURES.find((signature) => signature.tableKey === tableKey);
const GATEWAY = signatureOf('gateway-recon');
const TRANSFER = signatureOf('zhongtai-dispatch-order');
const FX = signatureOf('fx-delivery');
const user = (headers) => ({ status: 'user', headers, label: 'V2' });
const valuesOf = (headers) => Object.fromEntries(headers.filter(Boolean).map((header) => [header, `${header}-值`]));

test('4 张链接表各自对应模板资源，只有网关对账单的新增列入库', () => {
  assert.deepEqual(Object.entries(LINKED_STRUCTURE_RESOURCES).map(([key, item]) => [key, item.resourceId, item.keepExtra]), [
    ['gateway-recon', 'gateway-recon', true],
    ['zhongtai-dispatch-order', 'transfer-order', false],
    ['zhongtai-refund-order', 'refund-order', false],
    ['fx-delivery', 'fx-delivery', false]
  ]);
  for (const tableKey of Object.keys(LINKED_STRUCTURE_RESOURCES)) assert.ok(signatureOf(tableKey), tableKey);
});

test('内置版本签名原样；不可用时带原因；用户版本只认当前版本表头', () => {
  assert.equal(effectiveLinkedSignature(GATEWAY, { status: 'builtin' }), GATEWAY);
  assert.equal(effectiveLinkedSignature(GATEWAY, null), GATEWAY);
  const bank = signatureOf('bank-statement');
  assert.equal(effectiveLinkedSignature(bank, user(['a'])), bank, '非链接表签名不受模板版本影响');
  const unavailable = effectiveLinkedSignature(GATEWAY, { status: 'unavailable', message: '版本文件已被修改' });
  assert.equal(unavailable.structureUnavailable, '版本文件已被修改');
  assert.deepEqual(unavailable.expectedHeaders, GATEWAY.expectedHeaders);

  const headers = [...FX.expectedHeaders.slice(0, -1), '新列'];
  const fx = effectiveLinkedSignature(FX, user(headers));
  assert.deepEqual([...fx.expectedHeaders], headers);
  assert.equal(fx.structureExact, true);
  assert.equal(fx.l1MatchHeaders, undefined, '用户版本按整行匹配，不用内置的 L1 锚点段');
  assert.equal(fx.versionLabel, 'V2');
  assert.deepEqual(fx.signatureHeaders, FX.signatureHeaders, 'L2 指纹仍按内置，用于识别出“相近但不一致”');
});

test('解析：只为 4 张链接表读取当前版本，读取异常按内置处理，不阻断其余表', async () => {
  const asked = [];
  const resolved = await resolveLinkedSignatures(ALL_TABLE_SIGNATURES, async (resourceId) => {
    asked.push(resourceId);
    if (resourceId === 'refund-order') throw new Error('store closed');
    if (resourceId === 'transfer-order') return user(TRANSFER.expectedHeaders);
    return { status: 'builtin' };
  });
  assert.deepEqual(asked.sort(), ['fx-delivery', 'gateway-recon', 'refund-order', 'transfer-order']);
  assert.equal(resolved.length, ALL_TABLE_SIGNATURES.length);
  assert.equal(resolved.find((signature) => signature.tableKey === 'zhongtai-refund-order'), signatureOf('zhongtai-refund-order'));
  assert.equal(resolved.find((signature) => signature.tableKey === 'zhongtai-dispatch-order').structureExact, true);
});

test('网关对账单：改名列取新列值、删除列为空、新增列按原名入库；其余表新增列不入库', () => {
  const version = [...GATEWAY.expectedHeaders.filter((header) => header !== 'bookdate').map((header) => (header === 'remark1' ? '备注1' : header)), '新增列'];
  const row = projectLinkedRow(effectiveLinkedSignature(GATEWAY, user(version)), valuesOf(version));
  assert.deepEqual(Object.keys(row), [...GATEWAY.expectedHeaders, '新增列']);
  assert.deepEqual([row.remark1, row.bookdate, row['新增列'], row.amount], ['备注1-值', '', '新增列-值', 'amount-值']);

  const transferVersion = [...TRANSFER.expectedHeaders, '新增列'];
  const transferRow = projectLinkedRow(effectiveLinkedSignature(TRANSFER, user(transferVersion)), valuesOf(transferVersion));
  assert.deepEqual(Object.keys(transferRow), [...TRANSFER.expectedHeaders]);
  assert.equal(projectLinkedRow(GATEWAY, { amount: '1' }).amount, '1', '内置签名不转换');
});

test('外汇交割表：内置结构的中间空列不入对象，调序后按列名对应', () => {
  const version = [...FX.expectedHeaders];
  [version[0], version[1]] = [version[1], version[0]];
  const row = projectLinkedRow(effectiveLinkedSignature(FX, user(version)), valuesOf(version));
  assert.deepEqual(Object.keys(row), FX.expectedHeaders.filter(Boolean));
  assert.equal(row['交易编号'], '交易编号-值');
  assert.equal(Object.hasOwn(row, ''), false);
});

test('差异明细：结构不一致时只与该表比较并标出当前版本；未识别时在全部候选中找最接近的', () => {
  const version = GATEWAY.expectedHeaders.map((header) => (header === 'remark1' ? '备注1' : header));
  const signatures = LINKED_IMPORT_SIGNATURES.map((signature) => effectiveLinkedSignature(signature,
    signature.tableKey === 'gateway-recon' ? user(version) : { status: 'builtin' }));
  const headerCandidates = [{ name: 'Sheet1', rowLabel: '', headers: [...GATEWAY.expectedHeaders] }];
  const mismatch = linkedStructureMismatchLines({ status: 'structure-mismatch', tableKey: 'gateway-recon', headerCandidates }, signatures);
  assert.deepEqual(mismatch.slice(0, 2), ['最接近：网关对账单（当前版本 V2，31 列；文件 31 列）', '第 26 列（Z）：应为「备注1」，实际为「remark1」']);

  const transferLike = TRANSFER.expectedHeaders.map((header) => (header === '调拨单号' ? '单号' : header));
  const unrecognized = linkedStructureMismatchLines({
    status: 'unrecognized', headerCandidates: [{ name: 'Sheet1', rowLabel: '', headers: transferLike }]
  }, signatures);
  assert.match(unrecognized[0], /^最接近：中台调拨订单（26 列；文件 26 列）$/);
  assert.deepEqual(linkedStructureMismatchLines({ status: 'unrecognized' }, signatures), []);
});

// main.js 的两个导入入口是 IPC + 对话框绑定，无法直接调用：源码守卫当前版本不可用时在入库 / 建会话之前中止该表。
test('链接表管理与导入文件两个入口：当前版本不可用时先中止该表，再读行入库', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'latin1');
  const handler = (channel) => {
    const start = source.indexOf(`trackedIpcHandle('${channel}'`);
    assert.ok(start >= 0, channel);
    return source.slice(start, source.indexOf('trackedIpcHandle(', start + 1));
  };
  // [取本表签名, 不可用拦截, 读行 / 入库]：拦截在取签名之后、读取之前，两者之间不读文件。
  for (const [channel, steps] of [
    ['linked-table:import', [['getLinkedSignatureByKey(detectorKey, linkedSignatures)', 'signature.structureUnavailable', 'importLinkedFileToRepo(']]],
    ['bank-statement:batch-import', [
      ["batchSignatures.find((s) => s.tableKey === 'zhongtai-refund-order')", 'refundSignature.structureUnavailable', 'readLinkedRowsAsObjects('],
      ['getLinkedSignatureByKey(tableKey, batchSignatures)', 'linkedSignature.structureUnavailable', 'importLinkedFileToRepo(']
    ]]
  ]) {
    const body = handler(channel);
    assert.match(body, /await resolveImportSignatures\(/, channel);
    for (const [lookup, guard, read] of steps) {
      const at = body.indexOf(lookup);
      const guarded = body.indexOf(guard, at);
      assert.ok(at >= 0 && guarded > at, `${channel}：取签名后缺少 ${guard}`);
      const between = body.slice(at, guarded);
      assert.equal(between.includes('readLinkedRowsAsObjects(') || between.includes('importLinkedFileToRepo('), false, `${channel}：${guard} 之前已读取`);
      assert.ok(body.indexOf(read, guarded) > guarded, `${channel}：${guard} 之后读取 ${read}`);
    }
  }
});
