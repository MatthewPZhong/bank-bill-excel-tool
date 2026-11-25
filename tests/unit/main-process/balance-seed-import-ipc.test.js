'use strict';

// v3.2.22 补录余额「导入余额文件」IPC（file:import-balance-seed-file）：取 main.js 中真实注册的回调，
//   用真实读取、解析、匹配与日志脱敏函数跑一份真实 xlsx，只替换选文件对话框、种子查询与活动日志。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const acorn = require('acorn');
const XLSX = require('xlsx');
const balanceSeedImport = require('../../../src/backend/balance-seed-import');
const { splitTemplateName } = require('../../../src/backend/balance-seed-store');
const { FileValidationError } = require('../../../src/backend/file-service');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });

function findMainNode(predicate) {
  let found = null;
  (function visit(node) {
    if (!node || typeof node !== 'object' || found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    Object.values(node).forEach((value) => (Array.isArray(value) ? value.forEach(visit) : visit(value)));
  })(MAIN_AST);
  return found;
}

function mainFunctionSource(name) {
  const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
  return MAIN_SOURCE.slice(node.start, node.end);
}

function loadImportBalanceSeedFileHandler(deps) {
  const call = findMainNode((node) => (
    node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression'
    && node.callee.object.name === 'ipcMain'
    && node.callee.property.name === 'handle'
    && node.arguments[0]
    && node.arguments[0].value === 'file:import-balance-seed-file'
  ));
  const names = Object.keys(deps);
  return Function(...names, `return (${MAIN_SOURCE.slice(call.arguments[1].start, call.arguments[1].end)});`)(
    ...names.map((name) => deps[name])
  );
}

const HEADER = ['账单日期', '银行名', '开户地', '币种', '银行账户号', '期末余额', '余额来源', '余额获取方式'];

test('v3.2.22 导入余额文件 IPC：开户地为 Excel 错误值的行不当作空开户地匹配；日志中的文件名、模板名按账号脱敏，界面仍显示原名', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-import-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const account = '6222020200112233';
  const otherAccount = '6222020200445566';
  const filePath = path.join(dir, `余额-${account}.xlsx`);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    HEADER,
    // 最近一天：开户地为 #N/A（读取库读成空串），本组输出名称不带所在地
    ['2026-11-20', 'DBS', { t: 'e', v: 0x2A }, 'USD', account, 300, '网银', '接口'],
    // 更早一天：可核对
    ['2026-11-19', 'DBS', '', 'USD', account, 200, '网银', '接口'],
    // 另一个账号只有可核对的行：照常取
    ['2026-11-20', 'DBS', '', 'USD', otherAccount, 50, '网银', '接口']
  ]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);

  const logs = [];
  const maskAccountLikeTextForLog = Function(`return (${mainFunctionSource('maskAccountLikeTextForLog')});`)();
  const prompt = (templateName) => ({
    templateName,
    merchantId: account,
    currency: 'USD',
    targetBillDate: '2026-11-21',
    pendingAccounts: [
      { merchantId: account, currency: 'USD', targetBillDate: '2026-11-21' },
      { merchantId: otherAccount, currency: 'USD', targetBillDate: '2026-11-21' }
    ]
  });
  const dialogOptions = [];
  const handlerFor = (lastManualBalancePrompt) => loadImportBalanceSeedFileHandler({
    ...balanceSeedImport,
    lastManualBalancePrompt,
    splitTemplateName,
    showImportOpenDialog: async (_key, options) => {
      dialogOptions.push(options);
      return { canceled: false, filePaths: [filePath] };
    },
    path,
    findPreviousBalanceSeed: () => null,
    ensureStorageRoot: () => dir,
    appendActivityLogEntry: (entry) => logs.push(entry),
    maskAccountLikeTextForLog,
    FileValidationError,
    appendLog: (_root, error) => { throw error; }
  });

  // 本组输出名称不带所在地（开户地为空）
  const result = await handlerFor(prompt('DBS'))();
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.fileName, path.basename(filePath), '界面显示原名');
  assert.deepEqual(dialogOptions[0].filters, [{ name: 'Excel 工作簿', extensions: ['xlsx'] }], '选择文件时只列出 xlsx（W1）');
  const [errorAccount, okAccount] = result.accounts;
  assert.deepEqual([errorAccount.merchantId, errorAccount.source, errorAccount.endBalance], [account, 'manual', null],
    '最近一天的开户地无法核对：不取该行，也不退回更早一天');
  assert.equal(errorAccount.reason, '文件中该账号 2026-11-20 的余额行（第 2 行）开户地读不出（Excel 错误值 #N/A），无法确认该账号的余额，请手工填写');
  assert.deepEqual([okAccount.merchantId, okAccount.source, okAccount.billDate, okAccount.endBalance], [otherAccount, 'file', '2026-11-20', 50]);
  assert.deepEqual([result.matchedCount, result.manualCount], [1, 1]);

  assert.equal(logs.length, 1);
  const logText = logs[0].details.join('\n');
  assert.doesNotMatch(logText, new RegExp(account), '日志不含完整账号');
  assert.match(logText, /文件：余额-（16位账号）\.xlsx/);
  assert.match(logText, /从文件提取：1 个/);

  // 输出名称用账号命名（所在地为账号）：模板名、银行名 / 开户地同样脱敏，界面仍返回原名
  const named = await handlerFor(prompt(`DBS-${account}`))();
  assert.deepEqual([named.status, named.templateName, named.location], ['success', `DBS-${account}`, account]);
  const namedLog = logs[1].details.join('\n');
  assert.doesNotMatch(namedLog, new RegExp(account));
  assert.match(namedLog, /模板名：DBS-（16位账号）/);
  assert.match(namedLog, /银行名 \/ 开户地：DBS \/ （16位账号）/);
});

test('v3.2.22 导入余额文件 IPC：核对入口读取已有余额失败（种子文件损坏）时，返回界面的提示不带种子文件路径', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-import-ipc-seed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const account = '6222020200112233';
  const filePath = path.join(dir, 'balance.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ['2026-11-20', account, 'SG', 'USD', account, 1, '', '']]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  const seedFilePath = path.join(dir, 'balance-seeds', `${account}.json`);
  const logs = [];
  const handler = loadImportBalanceSeedFileHandler({
    ...balanceSeedImport,
    lastManualBalancePrompt: {
      templateName: `${account}-SG`,
      merchantId: account,
      currency: 'USD',
      targetBillDate: '2026-11-21',
      seedMismatch: { seedDate: '2026-11-19' },
      pendingAccounts: []
    },
    splitTemplateName,
    showImportOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }),
    path,
    // 与 readBalanceSeedRecords 文件损坏时同一形态：明细含种子文件路径
    findPreviousBalanceSeed: () => {
      throw new FileValidationError('FILE_READ', '本地余额种子文件损坏，请检查或删除后重试', {
        context: { balanceSeedFilePath: seedFilePath },
        detailLines: [`余额种子文件：${seedFilePath}`]
      });
    },
    ensureStorageRoot: () => dir,
    appendActivityLogEntry: (entry) => logs.push(entry),
    maskAccountLikeTextForLog: Function(`return (${mainFunctionSource('maskAccountLikeTextForLog')});`)(),
    FileValidationError,
    appendLog: (_root, error) => { throw error; }
  });
  const result = await handler();
  assert.deepEqual([result.status, result.errorCode, result.message], ['error', 'FILE_READ', '本地余额种子文件损坏，请检查或删除后重试']);
  const shown = [result.message, ...result.detailLines].join('\n');
  assert.doesNotMatch(shown, new RegExp(account));
  assert.doesNotMatch(shown, /balance-seeds/);
  assert.deepEqual(logs, [], '未进入匹配，不记导入日志');
});
