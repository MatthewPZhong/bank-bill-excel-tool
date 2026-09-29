'use strict';
module.exports=require('./r10-array-neighbor-cases.cjs').filter(c=>['factory-empty-extended','factory-empty-pushed','factory-initial-replaced','independent-factory-safe'].includes(c.name));
