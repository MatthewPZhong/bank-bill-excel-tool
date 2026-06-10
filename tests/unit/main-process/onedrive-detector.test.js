// v3.0.3 PR-D（W5）：isStorageRootOnOneDrive 纯函数单测
//
// 覆盖维度（spec acquiring-import-recon-perf §9.4 验收 = win32 模拟路径单测）：
//   1) win32 + 路径含 OneDrive → true（含大小写变体 / 中文路径 / 个人版 OneDrive - Personal / 企业版 OneDrive - 公司名）
//   2) win32 + 路径不含 OneDrive → false（普通 Documents 路径）
//   3) 非 win32（darwin / linux）即便路径含 onedrive 字样 → false（平台门控）
//   4) 边界：空串 / 非字符串 / undefined → false（不抛错）
//
// 函数纯逻辑（无副作用、无 I/O），platform 参数注入使本测试在任意平台可跑（含 macOS CI）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { isStorageRootOnOneDrive } = require('../../../src/main-process/onedrive-detector');

test('win32 + OneDrive 路径（标准大小写）→ true', () => {
  assert.equal(
    isStorageRootOnOneDrive('C:\\Users\\zhang\\OneDrive\\Documents\\网银账单生成小助手', 'win32'),
    true
  );
});

test('win32 + OneDrive 路径（全小写）→ true（大小写不敏感）', () => {
  assert.equal(
    isStorageRootOnOneDrive('c:\\users\\zhang\\onedrive\\documents\\网银账单生成小助手', 'win32'),
    true
  );
});

test('win32 + OneDrive 路径（全大写 ONEDRIVE）→ true', () => {
  assert.equal(
    isStorageRootOnOneDrive('C:\\Users\\ZHANG\\ONEDRIVE\\Documents', 'win32'),
    true
  );
});

test('win32 + OneDrive 个人版（OneDrive - Personal）→ true', () => {
  assert.equal(
    isStorageRootOnOneDrive('C:\\Users\\zhang\\OneDrive - Personal\\Documents\\网银账单生成小助手', 'win32'),
    true
  );
});

test('win32 + OneDrive 企业版（OneDrive - 公司名，中文目录）→ true', () => {
  assert.equal(
    isStorageRootOnOneDrive('C:\\Users\\张三\\OneDrive - 某某科技有限公司\\文档\\网银账单生成小助手', 'win32'),
    true
  );
});

test('win32 + 普通 Documents 路径（无 OneDrive）→ false', () => {
  assert.equal(
    isStorageRootOnOneDrive('C:\\Users\\zhang\\Documents\\网银账单生成小助手', 'win32'),
    false
  );
});

test('非 win32（darwin）即便路径含 onedrive 字样 → false（平台门控）', () => {
  assert.equal(
    isStorageRootOnOneDrive('/Users/zhang/OneDrive/Documents/网银账单生成小助手', 'darwin'),
    false
  );
});

test('非 win32（linux）即便路径含 onedrive 字样 → false', () => {
  assert.equal(
    isStorageRootOnOneDrive('/home/zhang/OneDrive/网银账单生成小助手', 'linux'),
    false
  );
});

test('边界：空字符串 → false', () => {
  assert.equal(isStorageRootOnOneDrive('', 'win32'), false);
});

test('边界：非字符串（null / undefined / 数字）→ false（不抛错）', () => {
  assert.equal(isStorageRootOnOneDrive(null, 'win32'), false);
  assert.equal(isStorageRootOnOneDrive(undefined, 'win32'), false);
  assert.equal(isStorageRootOnOneDrive(12345, 'win32'), false);
});

test('默认 platform 取 process.platform：当前平台非 win32 时含 onedrive 路径返回 false', () => {
  // 在 macOS / linux CI 上跑：不传 platform 走 process.platform（非 win32）→ false。
  // 仅当宿主恰为 win32 时该断言才会因平台命中而需调整；此处用条件断言避免环境耦合。
  const result = isStorageRootOnOneDrive('C:\\Users\\zhang\\OneDrive\\Documents');
  if (process.platform === 'win32') {
    assert.equal(result, true);
  } else {
    assert.equal(result, false);
  }
});
