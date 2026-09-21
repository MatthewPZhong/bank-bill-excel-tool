'use strict';

const fs = require('node:fs');
const path = require('node:path');
if (process.env.REVIEW_OUTPUT_LOG) { fs.writeFileSync(process.env.REVIEW_OUTPUT_LOG, ''); const originalLog = console.log; console.log = (...args) => { fs.appendFileSync(process.env.REVIEW_OUTPUT_LOG, args.join(' ') + '\n'); originalLog(...args); }; }
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const root = process.env.REVIEW_SOURCE_ROOT || '/private/tmp/renderer-boundaries-r4-2qr0rwdp';
const temporary = process.env.RENDERER_LIFECYCLE_TEMP;
if (!temporary) throw new Error('必须通过 test-renderer-lifecycle.js 运行隔离工厂测试');
app.setPath('userData', path.join(temporary, 'userData'));
app.setPath('documents', path.join(temporary, 'Documents'));
fs.mkdirSync(app.getPath('documents'), { recursive: true });
app.disableHardwareAcceleration();
const fixturesDirectory = path.join(root,'scripts/renderer-lifecycle/fixtures');
let passed = 0;
let total = 0;
const failures = [];

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1080, height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  const js = (source) => win.webContents.executeJavaScript(source, true);
  const load = (file) => js(fs.readFileSync(path.join(root, file), 'utf8') + '\n;void 0;');
  const reset = async (html = '<div id="modalRoot"></div>') => {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>')}`);
    await load('src/renderer/modal-host.js');
    await load('src/renderer/modal-bridge.js');
    await load('src/renderer/scenario-command-service.js');
    await load('src/renderer/scenario-change-router.js');
    await load('src/renderer/dialogs/scenarios.js');
    await load('src/renderer/configuration-services.js');
    await load('src/renderer/dialogs/configuration.js');
    await js(`window.__testErrors = []; window.__rendererModalHost = window.__modalHost.createModalHost({
      root: document.getElementById('modalRoot'), document, reportError: error => window.__testErrors.push(String(error?.message || error))
    }); window.__rendererModalBridge = window.__modalBridge.createModalBridge({ host: window.__rendererModalHost }); void 0;`);
  };
  const originalLoad = load;
  const loadFixture = async (file) => {
    await originalLoad(file);
    if (file === 'src/renderer-dialogs.js') await js(`window.__createTestRendererDialogs = (deps) => {
      const router = window.ScenarioChangeRouter.createScenarioChangeRouter();
      const commands = window.ScenarioCommandService.createScenarioCommandService({
        scenariosApi: deps.desktopApi?.scenarios || {}, channelsApi: deps.desktopApi?.channels || {}, publish: event => router.route(event)
      });
      const configurationServices = window.ConfigurationServices.createConfigurationServices({ templatesApi: deps.desktopApi?.templates || {} });
      configurationServices.acceptBootstrap(deps.state || {});
      configurationServices.applyPreviewTemplates(deps.state?.templates || []);
      return window.__rendererDialogs.createRendererDialogs({...deps, scenarioCommands: commands, scenarioSubscriptions: router,
        configurationServices, configurationApi: deps.desktopApi || {}, dialogApis: deps.desktopApi || {}, reportLog: deps.desktopApi?.app?.reportLog });
    }; void 0;`);
  };
  const test = async (label, work) => {
    total += 1;
    try { await work(); passed += 1; console.log(`PASS ${label}`); }
    catch (error) { failures.push({ label, error }); console.error(`FAIL ${label}: ${error.stack || error}`); }
  };
  const requested = process.argv.slice(2);
  const files = [];
  for (const name of files) {
    if (path.basename(name) !== name) throw new Error('fixture 名称不能包含路径');
    const fixture = require(path.join(fixturesDirectory, name));
    await fixture({ js, load: loadFixture, reset, assert, test });
  }

  async function setupReview() {
    await require(path.join(fixturesDirectory,'legacy-dialogs.js'))({js,load:loadFixture,reset,assert,test:async(label,work)=>{if(label.startsWith('公共告警'))await work();}});
  }
  const initialRules=[{targetField:'Credit Amount',conditionField:'Condition',conditionValue:'入金',mappedField:'Amount',rowIndex:0},{targetField:'Debit Amount',conditionField:'Condition',conditionValue:'出金',mappedField:'Amount',rowIndex:1}];
  const initialMeta={signedAmountSourceField:'',signedAmountTargetSeqNos:[],byFieldAmountTargetSeqNos:[]};
  const cases=[
    {label:'original-second-failed',stage:'meta',status:'failed'},
    {label:'second-reject',stage:'meta',status:'reject'},
    {label:'second-cancelled',stage:'meta',status:'cancelled'},
    {label:'first-failed',stage:'rules',status:'failed'},
    {label:'first-reject',stage:'rules',status:'reject'},
    {label:'first-cancelled',stage:'rules',status:'cancelled'},
    {label:'first-committed-then-failed',stage:'rules',status:'failed',committed:true},
    {label:'first-committed-then-reject',stage:'rules',status:'reject',committed:true},
    {label:'second-committed-then-failed',stage:'meta',status:'failed',committed:true},
    {label:'second-committed-then-reject',stage:'meta',status:'reject',committed:true},
    {label:'both-success',stage:null,status:'success'}
  ];
  for(const mode of ['byField','signed'].filter(x=>!process.env.REVIEW_MODE||x===process.env.REVIEW_MODE)) for(const scenario of cases.filter(x=>!process.env.REVIEW_CASE||x.label===process.env.REVIEW_CASE)) await test(mode+'/'+scenario.label,async()=>{
    await setupReview();
    const result=await js(`(async()=>{
      const rules=${JSON.stringify(initialRules)};const meta=${JSON.stringify(initialMeta)};
      const selectedMode=${JSON.stringify(mode)};const fault=${JSON.stringify(scenario)};
      const store={rules:structuredClone(rules),meta:structuredClone(meta)};const calls=[];
      async function write(stage,payload){
        calls.push({stage,payload:structuredClone(payload)});
        const faultHere=stage===fault.stage;
        const commit=()=>{if(stage==='rules')store.rules=structuredClone(payload.amountSplitRules);else{const {templateId,...value}=payload;store.meta=structuredClone(value);}};
        if(!faultHere||fault.committed)commit();
        if(faultHere&&fault.status==='reject')throw new Error(stage+' rejected after '+(fault.committed?'commit':'no commit'));
        return faultHere?{status:fault.status,message:stage+' '+fault.status+' after '+(fault.committed?'commit':'no commit')}:{status:'success'};
      }
      desktopApi.templates.saveBillSplitAmountRules=payload=>write('rules',payload);
      desktopApi.templates.saveBillSplitMeta=payload=>write('meta',payload);
      desktopApi.templates.getBillSplitConfig=async id=>{calls.push({stage:'read',templateId:id});return {status:'success',billSplitAmountRules:structuredClone(store.rules),billSplitMeta:structuredClone(store.meta),billSplitRows:[]};};
      legacy.open(()=>legacy.dialogs.createBillSplitRowsDialog({template:{id:7,name:'独立部分成功测试',headers:['Currency','Condition','Amount']},initialRows:[{seqNo:1,rowStatus:'draft',currencySourceField:'Currency',creditSourceField:'',debitSourceField:''}],initialAmountRules:rules,initialBillSplitMeta:meta}));
      const view=legacy.overlay;const signed=view.querySelector('.bill-split-signed-select');const byField=view.querySelector('.bill-split-by-field-select');const manage=view.querySelector('.bill-split-amount-rules-manage-btn');
      const entry=selectedMode==='signed'?signed:byField;entry.value=selectedMode==='signed'?'Amount':'';entry.dispatchEvent(new Event('change'));
      await legacy.tick();await legacy.tick();
      const error=legacy.top()!==view?legacy.top().textContent.trim():null;if(error)legacy.host.closeTop();
      const count=calls.length;await legacy.tick();await legacy.tick();const automaticCallsStable=count===calls.length;
      const state={ruleCount:store.rules.length,storedMeta:store.meta,manageHidden:manage.hidden,byField:byField.value,signed:signed.value,signedDisabled:signed.disabled,byFieldDisabled:byField.disabled};
      // 检查保存失败后的编辑器确实使用已恢复规则，而非仅检查按钮样式。
      let editorValues=null;if(!manage.hidden){manage.click();editorValues=[...legacy.top().querySelectorAll('.rule-condition-value')].map(node=>node.value);}
      else if(!byField.disabled){byField.value='是';byField.dispatchEvent(new Event('change'));await legacy.tick();if(legacy.top()!==view)editorValues=[...legacy.top().querySelectorAll('.rule-condition-value')].map(node=>node.value);}
      return {callsBeforeEditor:calls.slice(0,count),automaticCallsStable,store,state,error,editorValues,errors:__testErrors};
    })()`);
    console.log('MATRIX '+JSON.stringify({mode,case:scenario.label,state:result.state,calls:result.callsBeforeEditor.map(x=>x.stage),errorShown:!!result.error,editorValues:result.editorValues}));
    assert.equal(result.automaticCallsStable,true);
    const rulesDeleted=scenario.stage!=='rules'||scenario.committed===true;
    const metaCommitted=scenario.stage===null||(scenario.stage==='meta'&&scenario.committed===true);
    const expectedMeta=metaCommitted?{...initialMeta,signedAmountSourceField:mode==='signed'?'Amount':''}:initialMeta;
    assert.equal(result.state.ruleCount,rulesDeleted?0:2);
    assert.deepEqual(result.state.storedMeta,expectedMeta);
    assert.equal(result.state.manageHidden,rulesDeleted);
    assert.equal(result.state.byField,rulesDeleted?'':'是');
    assert.equal(result.state.signed,expectedMeta.signedAmountSourceField);
    assert.equal(result.state.signedDisabled,!rulesDeleted);
    assert.equal(result.state.byFieldDisabled,!!expectedMeta.signedAmountSourceField);
    assert.deepEqual(result.callsBeforeEditor.map(x=>x.stage),scenario.stage===null?['rules','meta']:scenario.stage==='rules'?['rules','read']:['rules','meta','read']);
    if(scenario.stage===null)assert.equal(result.error,null);else assert.match(result.error,new RegExp(scenario.stage));
    if(!expectedMeta.signedAmountSourceField)assert.deepEqual(result.editorValues,rulesDeleted?['','']:['入金','出金']);
    assert.deepEqual(result.errors,[]);
  });
  console.log(`${passed}/${total} PASS`);
  win.destroy();
  app.exit(failures.length ? 1 : 0);
})().catch(error => { console.error(error.stack || error); app.exit(1); });
