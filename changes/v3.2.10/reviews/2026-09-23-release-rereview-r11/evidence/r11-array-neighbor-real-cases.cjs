'use strict';
module.exports=require('./r11-array-neighbor-cases.cjs').filter(c=>['uncertain-copy-fixed-slot','uncertain-copy-slot-reverse','uncertain-copy-independent-safe'].includes(c.name));
