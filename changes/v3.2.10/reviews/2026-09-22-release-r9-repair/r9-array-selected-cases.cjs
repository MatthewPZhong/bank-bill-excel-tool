'use strict';
module.exports=require('./r9-array-neighbor-cases.cjs').filter(c=>['push-direct-control','push-static-spread','splice-static-spread','spread-before-replace-safe'].includes(c.name));
