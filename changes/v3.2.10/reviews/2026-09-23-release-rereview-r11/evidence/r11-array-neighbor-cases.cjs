'use strict';
const prefix='function provide(){return {api:{run(){}}};}const old=provide();const clean=provide();function make(value){const args=[];args.push(value);return args;}';
module.exports=[
 ['uncertain-copy-fixed-slot','const list=[...make(old)];list[1]=clean;const alias=list[1].api;',false],
 ['uncertain-copy-slot-reverse','const list=[...make(old)];list[1]=clean;list.reverse();const alias=list[0].api;',false],
 ['uncertain-copy-independent-safe','const list=[...make(old)];const other=[...make(clean)];list[1]=old;list.reverse();const alias=list[0].api;',true],
 ['unknown-prefix-visible-object','window.values=[];const list=[...window.values,clean];const alias=list[0].api;',false],
 ['conditional-second-array','window.choose=false;const first=[...make(old)],second=[...make(clean)];const list=window.choose?first:second;const alias=list[0].api;',false],
 ['conditional-independent-safe','window.choose=false;const first=[...make(old)],second=[...make(old)];const list=window.choose?first:second;const alias=list[0].api;',true],
 ['copy-before-source-replacement','function fixed(value){const args=[];args[0]=value;return args;}const args=fixed(clean);const list=[...args];args[0]=old;const alias=list[0].api;',false],
 ['copy-before-source-mutator-safe','const args=make(old);const list=[...args];args.push(clean);const alias=list[0].api;',true],
].map(([name,setup,safe])=>({name,safe,setup:prefix+setup+'alias.outsideScope=window.desktopApi.outsideScope;',api:'clean.api'}));
