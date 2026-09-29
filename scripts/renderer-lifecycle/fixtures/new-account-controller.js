'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ js, load, reset, assert, test }) => {
  const index = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
  const start = index.indexOf('<section id="newAccountModulePanel"');
  const panel = index.slice(start, index.indexOf('</section>', start) + '</section>'.length).replace(' hidden>', '>');
  async function setup() {
    await reset(panel + '<button id="outside">外部</button><div id="modalRoot"></div>');
    await load('src/renderer/controllers/new-account.js');
    await js(`(async () => {
      window.newAccountCalls=[]; window.newAccountFeedback=[]; window.configRemoves=0;
      window.currencyOptions=[{code:'USD',name:'美元'},{code:'EUR',name:'欧元'},{code:'HKD',name:'港元'}];
      window.newAccountConfig={getCurrencyOptions:()=>structuredClone(currencyOptions),subscribe:listener=>{window.configChanged=listener;return()=>configRemoves++;}};
      window.newAccountApi={generate: payload => {newAccountCalls.push(['generate',payload]);return new Promise(resolve=>window.finishGenerate=resolve);},
        exportFile:async()=>{newAccountCalls.push(['export']);return {status:'success',message:'已导出余额：/balance.xlsx'};},
        exportLastError:async()=>{newAccountCalls.push(['error']);return {status:'success',message:'报错文件已导出：/errors.xlsx'};}};
      window.newAccount=__newAccountController.createNewAccountController({api:newAccountApi,panel:document.getElementById('newAccountModulePanel'),config:newAccountConfig,
        ui:{modalHost:__rendererModalHost,status:(element,text,tone,options)=>{newAccountFeedback.push({text,tone,options});element.textContent=text;},reportError:error=>__testErrors.push(error.message)}});
      await newAccount.enter();
      newAccount.preview.applyRows([{bankName:'中国银行',location:'香港',currency:'USD',bankAccount:'000001',openingDate:'2026-01-01'}]);
    })()`);
  }
  const flush = () => js(`new Promise(resolve=>setTimeout(resolve,5))`);
  await test('新账号真实表单保留多行、原账户字符串和多币种选择顺序', async () => {
    await setup();
    await js(`newAccount.preview.applyRows([
      {bankName:'中国银行',location:'香港',currency:'USD',bankAccount:'000001',openingDate:'2026-01-01'},
      {bankName:'汇丰',location:'英国',bankAccount:'000002',openingDate:'2026-02-02',isMultiCurrency:true,currencies:['HKD','EUR']}
    ]); document.getElementById('newAccountGenerateBtn').click();`); await flush();
    assert.deepEqual((await js(`newAccountCalls[0][1]`)), {accounts:[
      {bankName:'中国银行',location:'香港',currency:'USD',currencies:[],isMultiCurrency:false,bankAccount:'000001',openingDate:'2026-01-01'},
      {bankName:'汇丰',location:'英国',currency:'',currencies:['HKD','EUR'],isMultiCurrency:true,bankAccount:'000002',openingDate:'2026-02-02'}
    ]});
    await js(`finishGenerate({status:'success',exportReady:true,message:'已生成 3 行余额'});`); await flush();
    assert.equal(await js(`document.getElementById('newAccountExportBtn').disabled`), false);
    assert.match(await js(`document.querySelectorAll('.new-account-currency-dropdown-btn')[1].textContent`), /HKD 港元、EUR 欧元/);
    await js(`document.querySelectorAll('.new-account-multi-currency-checkbox')[1].click();`);
    assert.equal(await js(`newAccount.getPayload().accounts[1].currency`), 'HKD');
    assert.deepEqual(await js(`newAccount.getPayload().accounts[1].currencies`), []);
    assert.equal(await js(`document.getElementById('newAccountExportBtn').disabled`), true);
  });
  await test('新账号后台生成中修改表单，旧成功不能赋予新表单导出能力', async () => {
    await setup();
    await js(`document.getElementById('newAccountGenerateBtn').click(); document.getElementById('newAccountGenerateBtn').click();`);
    assert.equal((await js(`newAccountCalls`)).length, 1);
    await js(`var input=document.querySelector('.new-account-bank-account-input');input.value='999999';input.dispatchEvent(new Event('input'));finishGenerate({status:'success',exportReady:true,message:'旧输入已生成'});`); await flush();
    assert.equal(await js(`document.getElementById('newAccountExportBtn').disabled`), true);
    assert.equal(await js(`document.getElementById('newAccountGenerateBtn').disabled`), false);
    assert.equal(await js(`newAccount.getPayload().accounts[0].bankAccount`), '999999');
    assert.doesNotMatch(await js(`document.getElementById('newAccountStatusBox').textContent`), /旧输入/);
  });
  await test('新账号离页重进期间后台完成，由本域重同步解除 busy 并保留生成/导出反馈', async () => {
    await setup();
    await js(`(async()=>{newAccount.generate();newAccount.leave();await newAccount.enter();})()`);
    assert.equal(await js(`document.getElementById('newAccountGenerateBtn').disabled`), true);
    await js(`finishGenerate({status:'success',exportReady:true,message:'原任务生成完成'});`); await flush();
    assert.equal(await js(`document.getElementById('newAccountExportBtn').disabled`), false);
    assert.equal(await js(`document.getElementById('newAccountStatusBox').textContent`), '原任务生成完成');
    await js(`newAccount.export();`); await flush();
    await js(`(async()=>{newAccount.leave();await newAccount.enter();})()`);
    assert.equal(await js(`document.getElementById('newAccountStatusBox').textContent`), '已导出余额：/balance.xlsx');
  });
  await test('新账号下拉外部点击/ESC、行增删、busy leave 与 dispose 释放', async () => {
    await setup();
    await js(`document.querySelector('.new-account-currency-dropdown-btn').click();newAccount.handleOutsidePointerDown({target:document.getElementById('outside')});`);
    assert.equal(await js(`document.querySelector('.new-account-currency-dropdown-panel').hidden`), true);
    await js(`document.querySelector('.new-account-currency-dropdown-btn').click();newAccount.handleKeyDown({key:'Escape'});document.querySelector('.new-account-row-action-btn').click();`);
    assert.equal(await js(`document.querySelectorAll('[data-new-account-row]').length`), 2);
    await js(`document.querySelectorAll('.new-account-row-action-btn')[1].click();`);
    assert.equal(await js(`document.querySelectorAll('[data-new-account-row]').length`), 1);
    await js(`window.busyModal=__rendererModalHost.openRoot(()=>{const overlay=document.createElement('div');overlay.innerHTML='<div class="modal-card"></div>';return {overlay,dialog:overlay.firstChild,canClose:()=>false};},{owner:'new-account-generator'}).handle; void 0;`);
    assert.equal(await js(`newAccount.leave().status`), 'blocked');
    await js(`busyModal.dispose();newAccount.dispose();newAccount.dispose();document.querySelector('.new-account-row-action-btn').click();`);
    assert.equal(await js(`document.querySelectorAll('[data-new-account-row]').length`), 1);
    assert.equal(await js(`configRemoves`), 1);
  });
  await test('新账号配置是复制读取，币种失效清除选择并关闭旧导出能力；报错入口保留反馈', async () => {
    await setup();
    await js(`newAccount.generate();finishGenerate({status:'error',exportReady:false,errorReportReady:true,message:'开户信息错误'});`); await flush();
    await js(`document.getElementById('newAccountStatusBox').click();`); await flush();
    assert.equal(await js(`newAccountFeedback.at(-1).options.errorReportReady`), true);
    assert.equal(await js(`newAccountFeedback.at(-1).text`), '报错文件已导出：/errors.xlsx');
    await js(`newAccount.preview.setExportAvailability(true);currencyOptions=[{code:'EUR',name:'欧元'}];configChanged({resource:'configuration'});`);
    assert.equal(await js(`newAccount.getPayload().accounts[0].currency`), '');
    assert.equal(await js(`document.getElementById('newAccountExportBtn').disabled`), true);
    assert.equal(await js(`document.getElementById('newAccountGenerateBtn').disabled`), true);
  });
};
