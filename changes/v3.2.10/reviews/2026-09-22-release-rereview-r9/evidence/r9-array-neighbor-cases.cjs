"use strict";
const prefix='function provide(){return {api:{run(){}}};}const old=provide();const clean=provide();';
const suffix='alias.outsideScope=window.desktopApi.outsideScope;';
module.exports=[
 ['push-direct-control','const list=[];list.push(clean);const alias=list[0].api;',false],
 ['push-static-spread','const list=[];list.push(...[clean]);const alias=list[0].api;',false],
 ['splice-static-spread','const list=[old];list.splice(...[0,1,clean]);const alias=list[0].api;',false],
 ['helper-push','const list=[];function append(value){value.push(clean);}append(list);const alias=list[0].api;',false],
 ['default-after-slot-replace','const list=[old];list[0]=clean;function select(value=list[0]){return value.api;}const alias=select();',false],
 ['spread-before-replace-safe','const list=[old];const copy=[...list];list[0]=clean;const alias=copy[0].api;',true],
 ['delete-slot-default','const list=[old];delete list[0];function select([value=clean]){return value.api;}const alias=select(list);',false],
 ['length-zero-default','const list=[old];list.length=0;function select([value=clean]){return value.api;}const alias=select(list);',false],
].map(([name,setup,safe])=>({name,safe,setup:prefix+setup+suffix,api:'clean.api'}));
