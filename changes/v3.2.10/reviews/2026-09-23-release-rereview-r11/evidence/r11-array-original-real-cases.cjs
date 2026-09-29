'use strict';
module.exports=require('./r11-array-original-cases.cjs').filter(c=>['factory-empty-extended','factory-empty-pushed','factory-initial-replaced','independent-factory-safe'].includes(c.name));
