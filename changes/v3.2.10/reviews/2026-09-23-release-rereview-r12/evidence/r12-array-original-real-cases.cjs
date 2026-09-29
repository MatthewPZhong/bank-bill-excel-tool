'use strict';
module.exports=require('./r12-array-original-cases.cjs').filter(c=>['uncertain-copy-fixed-slot','uncertain-copy-slot-reverse','uncertain-copy-independent-safe'].includes(c.name));
