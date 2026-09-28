'use strict';
module.exports=require('./r10-array-original-neighbor-cases.cjs').filter(c=>['push-direct-control','push-static-spread','splice-static-spread','spread-before-replace-safe'].includes(c.name));
