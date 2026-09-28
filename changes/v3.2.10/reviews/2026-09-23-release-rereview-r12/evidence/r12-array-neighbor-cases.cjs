'use strict';
const prefix='function provide(){return {api:{run(){}}};}const old=provide();const clean=provide();function make(value){const args=[];args.push(value);return args;}';
module.exports=[
 ['receiver-alias-reorder','const list=[...make(old)];const holder=list;holder[1]=clean;holder.reverse();const alias=list[0].api;',false],
 ['helper-reorder-after-write','const list=[...make(old)];function reorder(target){target.reverse();}list[1]=clean;reorder(list);const alias=list[0].api;',false],
 ['helper-write-and-reorder','const list=[...make(old)];function refill(target,value){target[1]=value;target.reverse();}refill(list,clean);const alias=list[0].api;',false],
 ['helper-reorder-before-write-safe','const list=[...make(old)];function reorder(target){target.reverse();}reorder(list);list[1]=clean;const alias=list[0].api;',true],
 ['overwritten-before-reorder-safe','const list=[...make(old)];list[1]=clean;list[1]=old;list.reverse();const alias=list[0].api;',true],
 ['last-write-before-reorder','const list=[...make(old)];list[1]=old;list[1]=clean;list.reverse();const alias=list[0].api;',false],
 ['helper-write-after-reorder-safe','const list=[...make(old)];function write(target,value){target[1]=value;}list.reverse();write(list,clean);const alias=list[0].api;',true],
 ['captured-before-later-reorder-safe','const list=[...make(old)];const alias=list[0].api;list[1]=clean;list.reverse();',true],
].map(([name,setup,safe])=>({name,safe,setup:prefix+setup+'alias.outsideScope=window.desktopApi.outsideScope;',api:'clean.api'}));
