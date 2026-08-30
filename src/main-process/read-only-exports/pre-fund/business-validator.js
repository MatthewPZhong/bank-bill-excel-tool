'use strict';

const { readOwnedArtifactEvidence } = require('../common/artifact-evidence');
const { readWorkbookBusinessEvidence } = require('../common/workbook-evidence');
const { validatePreFundReadOnlyExportResult } = require('./policies');

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function validatePreFundGeneratedArtifact({ generationPlan, result }) {
  if (!validatePreFundReadOnlyExportResult(result)) {
    throw validationError('PRE_FUND_EXPORT_MANIFEST_INVALID', 'PreFund artifact manifest 非法');
  }
  const claimed = result.artifacts[0];
  if (claimed.outputArtifactKey !== generationPlan.outputArtifactKey) {
    throw validationError('PRE_FUND_EXPORT_OWNERSHIP_MISMATCH', 'PreFund artifact ownership 不一致');
  }
  const technical = await readOwnedArtifactEvidence(generationPlan);
  if (technical.byteSize !== claimed.byteSize || technical.sha256 !== claimed.sha256) {
    throw validationError('PRE_FUND_EXPORT_ARTIFACT_TAMPERED', 'PreFund artifact 技术证据不一致');
  }
  const business = readWorkbookBusinessEvidence(generationPlan.generationPath);
  if (business.businessDigest !== claimed.businessDigest ||
      business.sheetCount !== claimed.sheetCount ||
      business.dataRowCount !== claimed.dataRowCount) {
    throw validationError('PRE_FUND_EXPORT_BUSINESS_EVIDENCE_MISMATCH', 'PreFund workbook 回读不一致');
  }
  return Object.freeze({
    ...technical,
    ...business,
    outputArtifactKey: claimed.outputArtifactKey
  });
}

module.exports = { validatePreFundGeneratedArtifact };
