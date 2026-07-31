'use strict';

const crypto = require('node:crypto');

const {
  stableJson
} = require('../../main-process/position-reconciliation/common');
const {
  validateSourceRow
} = require('../../main-process/position-reconciliation/readers');

class StableArrayHashAccumulator {
  constructor() {
    this.hash = crypto.createHash('sha256');
    this.hash.update('[');
    this.count = 0;
    this.sealed = false;
  }

  append(value) {
    if (this.sealed) throw new Error('stable array hash 已封存');
    if (this.count > 0) this.hash.update(',');
    this.hash.update(stableJson(value));
    this.count += 1;
  }

  digest() {
    if (!this.sealed) {
      this.hash.update(']');
      this.value = this.hash.digest('hex');
      this.sealed = true;
    }
    return this.value;
  }
}

module.exports = {
  StableArrayHashAccumulator,
  validateSourceRow
};
