'use strict';
const provide='function provide(){return {api:{run(){}}};}';
module.exports=[
 {name:'array-replaced-element',safe:false,setup:provide+'const envelope=provide();function select([{api}]){return api;}const list=[envelope];const clean=provide();list[0]=clean;const alias=select(list);alias.outsideScope=window.desktopApi.outsideScope;',api:'clean.api'},
 {name:'array-captured-before',safe:true,setup:provide+'const envelope=provide();function select([{api}]){return api;}const list=[envelope];const clean=provide();const alias=select(list);list[0]=clean;alias.outsideScope=window.desktopApi.outsideScope;',api:'clean.api'},
 {name:'array-direct-fixed-slot',safe:false,setup:provide+'const envelope=provide();const list=[envelope];const clean=provide();list[0]=clean;const alias=list[0].api;alias.outsideScope=window.desktopApi.outsideScope;',api:'clean.api'},
 {name:'object-fixed-slot-control',safe:false,setup:provide+'const envelope=provide();function select({0:{api}}){return api;}const list={0:envelope};const clean=provide();list[0]=clean;const alias=select(list);alias.outsideScope=window.desktopApi.outsideScope;',api:'clean.api'},
 {name:'array-without-replacement-control',safe:false,setup:provide+'const clean=provide();function select([{api}]){return api;}const list=[clean];const alias=select(list);alias.outsideScope=window.desktopApi.outsideScope;',api:'clean.api'}
];
