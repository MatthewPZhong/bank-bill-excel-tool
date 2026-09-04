'use strict';

// Main 侧 client 仅构造 bounded DTO/FilePlan 与 staging technical evidence。
// E10-B copy input 不含 final target；正式目标只交给 Main settlement/既有 Publisher。
module.exports = Object.freeze({
  ...require('./generation-validator'),
  ...require('./artifact-copy')
});
