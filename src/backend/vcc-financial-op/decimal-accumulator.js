'use strict';

const { canonicalizeDecimal } = require('../../main-process/financial-decimal');

class DecimalAccumulator {
  constructor(initialValue = '0') {
    this.units = 0n;
    this.scale = 0;
    this.add(initialValue);
  }

  add(value) {
    const canonical = canonicalizeDecimal(value, { label: '待汇总金额' });
    const negative = canonical.startsWith('-');
    const unsigned = negative ? canonical.slice(1) : canonical;
    const [integerPart, fractionPart = ''] = unsigned.split('.');
    const incomingScale = fractionPart.length;
    let incomingUnits = BigInt(`${integerPart}${fractionPart}` || '0');
    if (negative) incomingUnits = -incomingUnits;

    if (incomingScale > this.scale) {
      this.units *= 10n ** BigInt(incomingScale - this.scale);
      this.scale = incomingScale;
    } else if (incomingScale < this.scale) {
      incomingUnits *= 10n ** BigInt(this.scale - incomingScale);
    }
    this.units += incomingUnits;
    return this;
  }

  value() {
    if (this.units === 0n) return '0';
    const negative = this.units < 0n;
    let digits = (negative ? -this.units : this.units).toString();
    if (this.scale > 0) {
      digits = digits.padStart(this.scale + 1, '0');
      digits = `${digits.slice(0, -this.scale)}.${digits.slice(-this.scale)}`;
    }
    return canonicalizeDecimal(`${negative ? '-' : ''}${digits}`, { label: '汇总金额' });
  }
}

function addToAccumulatorMap(map, key, value) {
  let accumulator = map.get(key);
  if (!accumulator) {
    accumulator = new DecimalAccumulator();
    map.set(key, accumulator);
  }
  accumulator.add(value);
  return accumulator;
}

module.exports = {
  DecimalAccumulator,
  addToAccumulatorMap
};
