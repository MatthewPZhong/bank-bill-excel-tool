'use strict';

// v3.2.22 B45（spec D3，Codex 第七、十轮）：读余额模板失败按模板不可读报出只在账单生成（传 reportTemplateReadFailure）时生效；
//   新开账户、月度余额等其他调用方保留原生错误与原有的系统异常处理
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FileValidationError } = require('../../../../src/backend/file-service/common');
const { writeBalanceWorkbook } = require('../../../../src/backend/file-service');

test('writeBalanceWorkbook：读余额模板失败默认保留原生错误；传 reportTemplateReadFailure 时按模板不可读报出', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-template-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args = {
    templateFilePath: path.join(root, 'missing.xlsx'),
    records: [],
    templateFields: [],
    outputFilePath: path.join(root, 'out.xlsx')
  };
  assert.throws(() => writeBalanceWorkbook(args),
    (error) => !(error instanceof FileValidationError) && error.code === 'ENOENT');
  assert.throws(() => writeBalanceWorkbook({ ...args, reportTemplateReadFailure: true }),
    (error) => error instanceof FileValidationError && error.code === 'FILE_READ'
      && error.message === '余额账单模板不可读，请重新确认' && error.context.systemErrorCode === 'ENOENT');
  assert.equal(fs.existsSync(args.outputFilePath), false, '不写出目标文件');
});
