'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reviewRoot = process.env.VCC_REVIEW_ROOT || process.cwd();
const XLSX = require('xlsx');
const {createReviewFixture}=require(path.join(reviewRoot, 'tests/helpers/vcc-review-export'));
const {prepareReviewManifest,extractReviewSources}=require(path.join(reviewRoot, 'src/backend/vcc-financial-op/review-export-plan'));
const {writeReviewWorkbook}=require(path.join(reviewRoot, 'src/main-process/vcc-financial-op-review-writer'));
const {validateReviewWorkbook}=require(path.join(reviewRoot, 'src/main-process/vcc-financial-op-review-validator'));
const repository=require(path.join(reviewRoot, 'src/backend/vcc-financial-op-db/repository'));
const cases=[
 {name:'zero-padded-zero',subject:'000000',cell:{t:'n',v:0,z:'000000'}},
 {name:'negative-literal-prefix',subject:'ENT-00123',cell:{t:'n',v:-123,z:'"ENT-"00000;"ENT-"00000'}},
 {name:'cached-formula-format',subject:'ENT-00123',cell:{t:'n',v:123,z:'"ENT-"00000',f:'100+23'}},
 {name:'current-boolean-false',subject:'false',cell:{t:'b',v:false}},
 {name:'date-display-month-raw-fallback',subject:'甲',dateCell:{t:'n',v:46203,z:'"不能解析为日期"'}},
 {name:'historical-formatted-without-source',subject:'000123',cell:{t:'n',v:123,z:'000000'},historical:true}
];
(async()=>{
 for(const c of cases){
  const cleanup=[];
  try{
   const f=await createReviewFixture({after(fn){cleanup.push(fn);}}, {subjects:[c.subject],beforeImport(file){
    const book=XLSX.readFile(file),sheet=book.Sheets['系统 OP'];
    for(let row=2;row<=10;row++){
     if(c.cell)sheet['B'+row]={...c.cell};
     if(c.dateCell)sheet['A'+row]={...c.dateCell};
    }
    XLSX.writeFile(book,file);
   }});
   if(c.historical){
    const id='never-bound-historical-system';
    repository.createImportBatch(f.db,{id,targetMonth:'2026-06',fileCount:1});
    const recordId=repository.createImportRecord(f.db,{batchId:id,targetMonth:'2026-06',sourceType:'system_op',sourceFiles:['historical.xlsx']});
    repository.finishImportRecord(f.db,recordId,{status:'success',rawCount:1,insertedCount:1});
    repository.finishImportBatch(f.db,id,'success');
    f.db.prepare('UPDATE vcc_fin_op_system_snapshots SET import_record_id=?,import_source_id=NULL').run(recordId);
   }
   const before=f.db.prepare('SELECT total_changes() n').get().n;
   const options={...f,appVersion:'3.2.9',manifestPath:path.join(f.dir,'probe.sqlite'),filePath:path.join(f.dir,'probe.xlsx')};
   await prepareReviewManifest(options);await extractReviewSources(options);const written=await writeReviewWorkbook(options);await validateReviewWorkbook(options);
   assert.equal(written.sheetCount,8);assert.equal(written.sourceRowCount,7);
   const book=XLSX.readFile(options.filePath,{cellNF:true});
   const pages=book.SheetNames.map(name=>book.Sheets[name]).filter(sheet=>sheet.E1?.v==='OP发生额');
   assert.equal(pages.length,2);
   for(const sheet of pages){
    if(c.cell){assert.equal(sheet.B2.t,c.cell.t);assert.equal(sheet.B2.v,c.cell.v);assert.equal(sheet.B2.f,undefined);if(c.cell.z&&!c.historical)assert.equal(sheet.B2.z,c.cell.z);}
    if(c.dateCell){assert.equal(sheet.A2.v,c.dateCell.v);assert.equal(sheet.A2.z,c.dateCell.z);}
   }
   assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
   console.log(JSON.stringify({name:c.name,status:'PASS',sheetCount:written.sheetCount,sourceRowCount:written.sourceRowCount,subject:pages[0].B2}));
  }finally{for(const fn of cleanup)await fn();}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
