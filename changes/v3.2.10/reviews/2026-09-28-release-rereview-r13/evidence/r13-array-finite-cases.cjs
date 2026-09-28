"use strict";
// 六个 setup 原样来自 release-rereview-r12.test.js；仅用已归档 probe 的命名格式包装。
const prefix='function provide(){return {api:{run(){}}};}const old=provide(),clean=provide();function make(value){const args=[];args.push(value);return args;}';
module.exports=[
 ['object-parameter-write-then-reorder','const list=[...make(old)];function reorder(box){box.target.reverse();}list[1]=clean;reorder({target:list});const alias=list[0].api;',false],
 ['object-parameter-reorder-then-write','const list=[...make(old)];function reorder(box){box.target.reverse();}reorder({target:list});list[1]=clean;const alias=list[0].api;',true],
 ['destructured-parameter-write-then-reorder','const list=[...make(old)];function reorder({target}){target.reverse();}list[1]=clean;reorder({target:list});const alias=list[0].api;',false],
 ['destructured-parameter-reorder-then-write','const list=[...make(old)];function reorder({target}){target.reverse();}reorder({target:list});list[1]=clean;const alias=list[0].api;',true],
 ['single-nested-helper-write-then-reorder','const list=[...make(old)];function inner(target){target.reverse();}function reorder(value){inner(value);}list[1]=clean;reorder(list);const alias=list[0].api;',false],
 ['single-nested-helper-reorder-then-write','const list=[...make(old)];function inner(target){target.reverse();}function reorder(value){inner(value);}reorder(list);list[1]=clean;const alias=list[0].api;',true],
].map(([name,setup,safe])=>({name,safe,setup:prefix+setup+'alias.outsideScope=window.desktopApi.outsideScope;',api:'clean.api'}));
