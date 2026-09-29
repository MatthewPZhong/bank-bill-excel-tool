'use strict';
const prefix='function provide(){return {api:{run(){}}};}const old=provide();const clean=provide();';
const suffix='const alias=list[0].api;alias.outsideScope=window.desktopApi.outsideScope;';
module.exports=[
 ['factory-empty-extended','function make(value){const args=[];args[0]=value;return args;}const list=[];list.push(...make(clean));',false],
 ['factory-initial-replaced','function make(value){const args=[old];args[0]=value;return args;}const list=[];list.push(...make(clean));',false],
 ['factory-empty-pushed','function make(value){const args=[];args.push(value);return args;}const list=[];list.push(...make(clean));',false],
 ['helper-source-extension','const args=[];function extend(target,value){target[0]=value;}extend(args,clean);const list=[];list.push(...args);',false],
 ['independent-factory-safe','function make(value){const args=[];args[0]=value;return args;}const first=make(old);const second=make(clean);const list=[];list.push(...first);',true],
 ['factory-before-replacement-safe','function make(){return [old];}const args=make();const list=[];list.push(...args);args[0]=clean;',true],
 ['self-spread-source-mutator','const args=[clean];args.push(...args);const list=[];list.push(...args);',false],
].map(([name,setup,safe])=>({name,safe,setup:prefix+setup+suffix,api:'clean.api'}));
