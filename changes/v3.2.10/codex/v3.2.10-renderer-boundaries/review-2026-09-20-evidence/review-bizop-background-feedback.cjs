const REVIEW_SOURCE_ROOT = process.env.REVIEW_SOURCE_ROOT || '/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries';
const fs=require('node:fs');const Module=require('node:module');
const filename=REVIEW_SOURCE_ROOT + '/tests/unit/main-process/biz-op-v329-renderer.test.js';
const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(require('node:path').dirname(filename));
loaded._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports.virtualEnvironment=virtualEnvironment;',filename);
(async()=>{
 const h=loaded.exports.virtualEnvironment();
 try{
  await h.controller.enter();const pending=h.deferred();h.reply.importFiles=()=>pending.promise;
  await h.click('导入文件');const before={text:h.text(),busy:h.controller.busy,imports:h.count('importFiles')};
  const leave=h.controller.leave();pending.resolve({status:'error',message:'测试导入失败，文件没有保存'});await h.flush();
  await h.controller.enter();console.log(JSON.stringify({before,leave,after:{text:h.text(),busy:h.controller.busy,imports:h.count('importFiles'),disabled:h.find('导入文件').disabled}},null,2));
 }finally{h.close();}
})();
