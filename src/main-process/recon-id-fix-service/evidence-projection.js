'use strict';

const {
  canonicalSha256
} = require('../background-execution/canonical-json-v1');

const RECON_FIX_EVIDENCE_MAX_BYTES = 268435456;
const UNSAFE_INTEGER_KIND = 'recon-fix:unsafe-integer:v1';

// Legacy ReconFix accepts finite JavaScript numbers beyond MAX_SAFE_INTEGER.
// Keep those business values untouched and tag only the hash projection so the
// strict canonicalizer can distinguish a numeric value from the same text.
function reconFixEvidenceProjection(value) {
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return {
      kind: UNSAFE_INTEGER_KIND,
      decimal: String(value)
    };
  }
  if (Array.isArray(value)) return value.map(reconFixEvidenceProjection);
  if (value && typeof value === 'object') {
    const projected = {};
    for (const key of Object.keys(value)) {
      projected[key] = reconFixEvidenceProjection(value[key]);
    }
    return projected;
  }
  return value;
}

function reconFixEvidenceSha256(value, options = {}) {
  return canonicalSha256(reconFixEvidenceProjection(value), {
    maxBytes: options.maxBytes === undefined
      ? RECON_FIX_EVIDENCE_MAX_BYTES
      : options.maxBytes
  });
}

module.exports = {
  RECON_FIX_EVIDENCE_MAX_BYTES,
  reconFixEvidenceProjection,
  reconFixEvidenceSha256
};
