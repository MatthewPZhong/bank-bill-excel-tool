'use strict';
const prefix='const old={run(){}},clean={run(){}},box={api:old};function replace(){box.api=clean;}function middle(){replace();}function read(){return box.api;}';
const capture='const alias=read();alias.outsideScope=window.desktopApi.outsideScope;window.BankStatementController.createBankStatementController({api:old});return alias===old;';
const fallback='window.BankStatementController.createBankStatementController({api:old});return false;';
const entries=[
 ['finally-nested-helper-required-safe','do{try{if(window.flag)break;}finally{middle();}}while(false);'+capture,[false,false]],
 ['finally-read-skipped-helper-write','do{try{if(window.flag)break;middle();}finally{'+capture+'}}while(false);',[false,true]],
 ['nested-finally-required-write-safe','do{try{}finally{try{if(window.flag)continue;}finally{middle();}}}while(false);'+capture,[false,false]],
 ['inner-finally-continue-skips-outer-write','do{try{}finally{try{}finally{if(window.flag)continue;}middle();}}while(false);'+capture,[false,true]],
 ['outer-helper-finally-read','function outer(){do{try{if(window.flag)break;middle();}finally{'+capture+'}}while(false);}return outer();',[false,true]],
 ['helper-loop-finally-write-safe','function outer(){do{try{if(window.flag)break;}finally{middle();}}while(false);}outer();'+capture,[false,false]],
 ['write-before-jump-read-skipped-safe','do{try{middle();if(window.flag)break;'+capture+'}finally{}}while(false);'+fallback,[false,false]],
 ['read-before-finally-overwrite-unsafe','do{try{if(window.flag)break;'+capture+'}finally{middle();}}while(false);'+fallback,[true,false]],
];
module.exports=entries.map(([name,body,expectedSame],index)=>({name,api:'old',safe:!expectedSame.some(Boolean),expectedSame,expectedBefore:index===7?2:0,expectedCurrent:index===7?2:(expectedSame.some(Boolean)?1:0),source:prefix+'function run(){'+body+'}run();'}));
