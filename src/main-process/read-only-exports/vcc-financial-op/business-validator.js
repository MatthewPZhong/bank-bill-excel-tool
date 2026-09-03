'use strict';

const { readOwnedArtifactEvidence } = require('../common/artifact-evidence');
const { readWorkbookBusinessEvidence } = require('../common/workbook-evidence');
const { validateVccFinancialOpReadOnlyExportResult } = require('./policies');

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function validateVccFinancialOpGeneratedArtifact({ generationPlan, result }) {
  if (!validateVccFinancialOpReadOnlyExportResult(result)) {
    throw validationError('VCC_FINANCIAL_OP_EXPORT_MANIFEST_INVALID', 'VCC Financial OP artifact manifest 非法');
  }
  const claimed = result.artifacts[0];
  if (claimed.outputArtifactKey !== generationPlan.outputArtifactKey) {
    throw validationError('VCC_FINANCIAL_OP_EXPORT_OWNERSHIP_MISMATCH', 'VCC Financial OP artifact ownership 不一致');
  }
  const technical = await readOwnedArtifactEvidence(generationPlan);
  if (technical.byteSize !== claimed.byteSize || technical.sha256 !== claimed.sha256) {
    throw validationError('VCC_FINANCIAL_OP_EXPORT_ARTIFACT_TAMPERED', 'VCC Financial OP artifact 技术证据不一致');
  }
  const business = readWorkbookBusinessEvidence(generationPlan.generationPath);
  if (business.businessDigest !== claimed.businessDigest ||
      business.sheetCount !== claimed.sheetCount ||
      business.dataRowCount !== claimed.dataRowCount) {
    throw validationError('VCC_FINANCIAL_OP_EXPORT_BUSINESS_EVIDENCE_MISMATCH', 'VCC Financial OP workbook 回读不一致');
  }
  return Object.freeze({
    ...technical,
    ...business,
    outputArtifactKey: claimed.outputArtifactKey
  });
}

module.exports = { validateVccFinancialOpGeneratedArtifact };
