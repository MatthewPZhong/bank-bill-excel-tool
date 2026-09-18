'use strict';

const test = require('node:test');
const os = require('node:os');
const { READONLY_OWNER_REPLACEMENTS, verifyReadonlyOwnerIdentity } = require('../../fixtures/archive-permanent-delete-readonly-owner');

test('只读副本保留创建身份并及时关闭句柄，重启后真实确认令牌可完成删除', async () => {
  await verifyReadonlyOwnerIdentity(os.tmpdir());
});

for (const replacement of READONLY_OWNER_REPLACEMENTS) {
  test(`只读副本 ${replacement} 替换拒绝登记，重启后保留原 creating 责任及替代文件`, async () => {
    await verifyReadonlyOwnerIdentity(os.tmpdir(), { replacement });
  });
}

test('只读副本读流失败关闭创建句柄后，错误收尾不得关闭其他文件复用的 fd', async () => {
  await verifyReadonlyOwnerIdentity(os.tmpdir(), { readFailure: true });
});
