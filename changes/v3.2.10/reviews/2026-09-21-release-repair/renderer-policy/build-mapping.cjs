'use strict';
const fs=require('fs'); const path=require('path');
const root=process.cwd(); const {scan}=require(path.join(root,'scripts/architecture/scan')); const {createRendererContracts}=require(path.join(root,'scripts/architecture/renderer-contracts'));
const config=JSON.parse(fs.readFileSync('architecture/boundaries.json')); const s=scan(root,config); const r=createRendererContracts(s);
const preload=r.resolve(r.globals.get('desktopApi').value,r.globals.get('desktopApi').analysis);
const methods=(group,prefix='')=>Object.entries(preload.properties[group].properties).flatMap(([key,v])=>v.kind==='object'?Object.keys(v.properties).map(k=>`${prefix}${key}.${k}`):`${prefix}${key}`);
const host=['openRoot','push','replace','closeTop','closeOwner','dispose','getHandle','getTop'];
const bridge=['registerModal','openModal','pushModal','replaceModal','closeModal','returnToModal',...host.map(x=>'host.'+x)];
const domainUi=['status','alert','escapeHtml','reportError',...host.map(x=>'modalHost.'+x),...bridge.map(x=>'modalBridge.'+x)];
const bankUi=['status','alert','confirm','gatewayScenarioPicker','reportError','openScenarios','openLinkedTables',...['openRoot','push','replace','closeOwner','closeTop','getTop','getHandle'].map(x=>'modalHost.'+x)];
const controllerTests=['tests/unit/renderer/r4-controllers.test.js','tests/unit/renderer/r4-domain-controllers.test.js','scripts/test-renderer-lifecycle.js'];
const servicesMethods=['getTemplates','getCurrencyOptions','getAccountMappingCount','acceptBootstrap','acceptAccountMappingCount','refreshTemplates','subscribe','applyPreviewTemplates','dispose'];
const specs={
 'bank-statement': ['BankStatementController','createBankStatementController',['api','panel','config','sharedReconSession','ui'],{api:methods('bankStatement'),config:['scenarios.list','linkedTable.rowCount','linkedTable.import'],sharedReconSession:['import','run','clearSession','export','sessionStatus','subscribe','dispose'],ui:bankUi},['tests/unit/renderer/scenario-change-routing.test.js','tests/unit/renderer/scenario-controller-feedback.test.js','scripts/test-renderer-lifecycle.js']],
 'recon-id-fix':['ReconIdFixController','createReconIdFixController',['api','panel','config','sharedReconSession','ui'],{api:['setReconIdFixBillCategory'],config:['initialBillCategory','scenarios.list'],sharedReconSession:['import','run','clearSession','export','sessionStatus','subscribe','dispose'],ui:bankUi},['tests/unit/renderer/scenario-change-routing.test.js','tests/unit/renderer/scenario-controller-feedback.test.js','scripts/test-renderer-lifecycle.js']],
 'pre-fund':['__preFundController','createPreFundController',['api','panel','ui'],{api:methods('preFundReconciliation'),ui:[...domainUi,'createPreFundTempManagerDialog']}],
 'bank-bu':['__bankBuController','createBankBuController',['api','panel','ui'],{api:methods('bankBuRecon'),ui:[...domainUi,'createBankBuReconMonthPickerDialog','createBankBuReconFileImportPromptDialog','createBankBuReconReconcileDialog','createBankBuReconExportDialog']}],
 'duplicate-inbound':['__duplicateInboundController','createDuplicateInboundController',['api','panel','ui'],{api:methods('duplicateInboundMatch'),ui:domainUi}],
 'acquiring':['__acquiringController','createAcquiringController',['api','panel','ui'],{api:methods('acquiringBillCurrency'),ui:[...domainUi,'createAcquiringBillCurrencyMonthPickerDialog','confirmNative']}],
 'vcc-op-calc':['__vccOpCalcController','createVccOpCalcController',['api','panel','ui'],{api:methods('vccOpCalc'),ui:[...domainUi,'createVccOpCalcConfirmDialog','createVccOpCalcComputeDialog','createVccOpCalcShowBalanceDialog']},['tests/unit/renderer/vcc-op-calc-source-binding.test.js','tests/unit/renderer/r4-domain-controllers.test.js','scripts/test-renderer-lifecycle.js']],
 'biz-op-legacy':['__bizOpLegacyController','createBizOpLegacyController',['api','panel','ui'],{api:methods('bizOpRecon'),ui:[...domainUi,'createAlertDialog','createBizOpReconDatePickerDialog','createBizOpReconSecondImportPromptDialog','createBizOpReconReconcileDialog','createBizOpReconExportDialog','getBizOpReconDefaultDate']}],
 'statement':['StatementController','createStatementController',['api','panel','config','ui','initialInfo'],{api:[...methods('files','files.'),...methods('monthlyBalance','monthlyBalance.'),'templates.importTemplate',...methods('accountMappings','accountMappings.'),'errors.exportLast'],config:['getTemplates','getCurrencyOptions','getAccountMappingCount','subscribe','refreshTemplates'],ui:[...host.map(x=>'modalHost.'+x),...bridge.map(x=>'modalBridge.'+x),'status','reportError','alertNative','createAlertDialog','createTemplateManagerDialog','createBigAccountSelectionDialog','createRememberOrderMismatchDialog','createExportScopeDialog','createMonthlyBalanceExportDialog','createManualBalanceSeedDialog','createAccountMappingDialog','createAccountMappingMigrationDialog']},['tests/unit/renderer/configuration-services.test.js','scripts/test-renderer-lifecycle.js']],
 'new-account':['__newAccountController','createNewAccountController',['api','panel','config','ui'],{api:['generate','exportFile','exportLastError'],config:['getCurrencyOptions','subscribe'],ui:domainUi},['tests/unit/renderer/configuration-services.test.js','scripts/test-renderer-lifecycle.js']],
 'pending':['__rendererPending','createPendingController',['api','panel','ui'],{api:methods('pending'),ui:[...host.map(x=>'modalHost.'+x),...bridge.map(x=>'modalBridge.'+x),'createAlertDialog','createConfirmDialog','reportError']}],
 'position':['__positionReconciliation','createPositionReconciliationUI',['api','panel','openModal','closeModal','createAlertDialog','createConfirmDialog','modalHost','modalBridge'],{api:methods('positionReconciliation'),modalHost:host,modalBridge:bridge},['scripts/test-renderer-lifecycle.js']],
 'vcc-financial-op':['__vccFinancialOpController','createVccFinancialOpController',['api','panel','modalHost','differenceApi','reviewProjection','previewEnabled'],{api:methods('vccFinancialOp'),modalHost:host,differenceApi:['assertCanonicalDifference','isEffectiveDifferenceZero'],reviewProjection:['CURRENCIES','HEADERS','SUMMARIES','formatAmount','projectReview']},['scripts/test-renderer-lifecycle.js']],
 'biz-op-v327':['createBizOpV327Controller','createBizOpV327Controller',['api','panel','legacyPanel','legacyController','modalHost'],{api:methods('bizOpReconV327'),modalHost:host,legacyController:['enter','leave','dispose','importFiles','run','export','selectBu','invalidate','applyPreviewState','getSnapshot']},['tests/unit/main-process/biz-op-v329-renderer.test.js','scripts/test-renderer-lifecycle.js']],
 'dialog-scenarios':['ScenarioDialogs','createScenarioDialogs',['scenarioCommands','subscriptions','appConstants','modalBridge','ui'],{scenarioCommands:['scenarios.list','scenarios.get',...['create','update','deleteOne','toggleEnabled','setApplicableChannels','batchDelete','transfer','applyImport','getFundTypeEnum','getGatewayReconHeaders','getApplicableChannels','exportBundle','importBundle'].map(x=>'scenarios.'+x),'channels.list','channels.create','channels.update','channels.deleteOne','closed','dispose'],subscriptions:['subscribeScenarios','subscribeChannels'],modalBridge:bridge,ui:['createOverlay','createAlertDialog','createConfirmDialog','escapeHtml','pushAlert']},['tests/unit/renderer/scenario-change-routing.test.js','tests/unit/renderer/scenario-write-boundary.test.js','scripts/test-renderer-lifecycle.js']],
 'dialog-configuration':['ConfigurationDialogs','createConfigurationDialogs',['services','api','modalBridge','ui','constants'],{services:servicesMethods,api:[...['templates','accountMappings','bigAccount','balanceAdjustment','monthlyBalance','files'].flatMap(g=>methods(g,g+'.')),'app.getInfo'],modalBridge:bridge,ui:['createOverlay','escapeHtml','createAlertDialog','createConfirmDialog','pushAlert','setStatus','applyStatementResult','applyManualBalancePromptStatus','createFeedbackScope']},['tests/unit/renderer/configuration-services.test.js','scripts/test-renderer-lifecycle.js']],
 'dialog-app-settings':['__appSettingsDialogs','createAppSettingsDialogs',['api','modalBridge','modules','ui'],{api:[...methods('archiveCenter','archiveCenter.'),...methods('appUpdate','appUpdate.')],modalBridge:bridge,ui:['escapeHtml','createConfirmDialog','getDarkModeController','mountAppearanceSettings','applyAppUpdateActionResult','applyAppUpdateStatus','getAppUpdateStatus','refreshOpenAppUpdateDialog','restartAndInstallAppUpdate']},['scripts/test-renderer-lifecycle.js']],
 'dialog-toolbox':['__toolboxDialogs','createToolboxDialogs',['api','modalBridge','ui'],{api:methods('toolbox'),modalBridge:bridge,ui:['createAlertDialog','escapeHtml']},['tests/unit/renderer/toolbox-modal.test.js','scripts/test-renderer-lifecycle.js']]
};
const results=[];
for(const original of config.boundaries.filter(b=>b.id.startsWith('renderer-'))){
 const b=structuredClone(original); b.state='active'; const key=b.id.slice(9);
 if(specs[key]){
 const [global,name,parameters,fields,evidence]=specs[key]; const file=b.entrypoints[0];
 b.factory={path:file,name,parameters}; b.allowedApiFields=Object.fromEntries(Object.entries(fields).map(([key,values])=>[key,[...new Set(values)].sort()]));
 b.globals=[{path:file,exportsGlobal:[global],consumesGlobals:[]}];
 b.requiredConsumers=[{from:key.startsWith('dialog-')&&!['dialog-app-settings'].includes(key)?'src/renderer-dialogs.js':'src/renderer.js',to:file,kind:'classic-global',importedNames:[global]}];
 b.activationEvidence=evidence||controllerTests;
 b.allowedLocal=[file];
 if(key==='pending'){
  b.entrypoints.push('src/renderer/controllers/pending.js');b.allowedLocal.push('src/renderer/controllers/pending.js');
  b.globals.push({path:'src/renderer/controllers/pending.js',exportsGlobal:['__pendingController'],consumesGlobals:['__rendererPending']});
  b.requiredConsumers=[{from:'src/renderer/controllers/pending.js',to:file,kind:'classic-global',importedNames:['__rendererPending']},{from:'src/renderer.js',to:'src/renderer/controllers/pending.js',kind:'classic-global',importedNames:['__pendingController']}];
 }
 if(key==='dialog-scenarios'){b.allowedLocal.push('src/shared/payment-big-accounts.js');b.globals[0].consumesGlobals=['__paymentBigAccounts'];}
 if(key==='vcc-financial-op')b.allowedLocal.push('src/shared/vcc-financial-op-difference.js','src/shared/vcc-review-projection.js');
 }
 if(key==='modal-owner'){
 b.requiredConsumers=[{from:'src/renderer.js',to:'src/renderer/modal-host.js',kind:'classic-global',importedNames:['__modalHost']}];
 b.activationEvidence=['tests/unit/renderer/modal-host.test.js','tests/unit/renderer/toolbox-modal.test.js','scripts/test-renderer-lifecycle.js'];
 }
 if(key==='services'){
 const services=[['module-router.js','ModuleRouter'],['scenario-command-service.js','ScenarioCommandService'],['scenario-change-router.js','ScenarioChangeRouter'],['shared-recon-session.js','SharedReconSession'],['configuration-services.js','ConfigurationServices'],['modal-bridge.js','__modalBridge']];
 b.entrypoints=services.map(([file])=>'src/renderer/'+file);b.allowedLocal=[...b.entrypoints];
 b.globals=services.map(([file,name])=>({path:'src/renderer/'+file,exportsGlobal:[name],consumesGlobals:[]}));
 b.requiredConsumers=services.map(([file,name])=>({from:'src/renderer.js',to:'src/renderer/'+file,kind:'classic-global',importedNames:[name]}));
 b.globals.push({path:'src/shared/payment-big-accounts.js',exportsGlobal:['__paymentBigAccounts'],consumesGlobals:[]},{path:'src/shared/vcc-financial-op-difference.js',exportsGlobal:['__vccFinancialOpDifference'],consumesGlobals:[]},{path:'src/shared/vcc-review-projection.js',exportsGlobal:['__vccReviewProjection'],consumesGlobals:['__vccFinancialOpDifference']});
 b.activationEvidence=['tests/unit/renderer/module-router.test.js','tests/unit/renderer/scenario-command-service.test.js','tests/unit/renderer/scenario-change-routing.test.js','tests/unit/renderer/configuration-services.test.js','scripts/test-renderer-lifecycle.js'];
 }
 results.push(b);
}
fs.writeFileSync(path.join(__dirname,'renderer-boundaries.json'),JSON.stringify(results,null,2)+'\n');
console.log(results.map(b=>[b.id,b.factory?.name,Object.keys(b.allowedApiFields).join('/')]).map(x=>x.join(' ')).join('\n'));
