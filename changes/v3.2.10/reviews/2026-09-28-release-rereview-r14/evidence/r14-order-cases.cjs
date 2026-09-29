'use strict';
const prefix='const old={run(){}},clean={run(){}},intermediate={run(){}};const box={api:old};';
const both='function maybe(){box.api=intermediate;}function last(){box.api=clean;}function layer(){last();}function outer(){layer();}if(window.flag)maybe();outer();const alias=box.api;';
module.exports=[
 ['nested-definite-overwrite-safe',both,'old',[false,false],'allow'],
 ['nested-definite-overwrite-unsafe',both,'clean',[true,true],'deny'],
 ['conditional-write-after-definite','function first(){box.api=clean;}function late(){box.api=old;}function inner(){late();}function outer(){inner();}first();if(window.flag)outer();const alias=box.api;','old',[false,true],'deny'],
 ['factory-conditional-then-overwrite-safe','function make(){const record={api:old};function maybe(){record.api=intermediate;}if(window.flag)maybe();return record;}const returned=make();function overwrite(){returned.api=clean;}overwrite();const alias=returned.api;','old',[false,false],'allow'],
 ['array-fixed-slot-definite-overwrite-safe','const items=[old];function maybe(){items[0]=intermediate;}function write(){items[0]=clean;}function inner(){write();}if(window.flag)maybe();inner();const alias=items[0];','old',[false,false],'allow'],
 ['unordered-repeated-helper-retains-origin','function write(){box.api=old;}write();box.api=clean;write();const alias=box.api;','old',[true,true],'deny'],
 ['declarations-reversed-call-order-safe','function final(){box.api=clean;}function maybe(){box.api=intermediate;}if(window.flag)maybe();function wrapper(){final();}wrapper();const alias=box.api;','old',[false,false],'allow'],
 ['captured-before-nested-overwrite-safe','function capture(){return box.api;}const alias=capture();if(window.flag){box.api=intermediate;}function inner(){box.api=clean;}function outer(){inner();}outer();','clean',[false,false],'allow'],
].map(([name,body,api,expectedSame,expectedStatic])=>({name,safe:!expectedSame.some(Boolean),setup:prefix+body+'alias.outsideScope=window.desktopApi.outsideScope;',api,expectedSame,expectedStatic}));
