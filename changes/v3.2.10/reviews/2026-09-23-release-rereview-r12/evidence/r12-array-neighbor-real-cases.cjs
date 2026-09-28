'use strict';
module.exports=require('./r12-array-neighbor-cases.cjs').filter(c=>['receiver-alias-reorder','helper-reorder-after-write','helper-reorder-before-write-safe','captured-before-later-reorder-safe'].includes(c.name));
