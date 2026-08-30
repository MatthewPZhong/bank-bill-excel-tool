'use strict';

const { readOwnedArtifactEvidence } = require('../common/artifact-evidence');
const { readWorkbookBusinessEvidence } = require('../common/workbook-evidence');
const { validatePositionReadOnlyExportResult } = require('./policies');

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function validatePositionGeneratedArtifact({ generationPlan, result }) {
  if (!validatePositionReadOnlyExportResult(result)) {
    throw validationError('POSITION_EXPORT_MANIFEST_INVALID', 'Position artifact manifest 非法');
  }
  const claimed = result.artifacts[0];
  if (claimed.outputArtifactKey !== generationPlan.outputArtifactKey) {
    throw validationError('POSITION_EXPORT_OWNERSHIP_MISMATCH', 'Position artifact ownership 不一致');
  }
  const technical = await readOwnedArtifactEvidence(generationPlan);
  if (technical.byteSize !== claimed.byteSize || technical.sha256 !== claimed.sha256) {
    throw validationError('POSITION_EXPORT_ARTIFACT_TAMPERED', 'Position artifact 技术证据不一致');
  }
  const business = readWorkbookBusinessEvidence(generationPlan.generationPath);
  if (business.businessDigest !== claimed.businessDigest ||
      business.sheetCount !== claimed.sheetCount ||
      business.dataRowCount !== claimed.dataRowCount) {
    throw validationError('POSITION_EXPORT_BUSINESS_EVIDENCE_MISMATCH', 'Position workbook 回读不一致');
  }
  return Object.freeze({
    ...technical,
    ...business,
    outputArtifactKey: claimed.outputArtifactKey
  });
}

module.exports = { validatePositionGeneratedArtifact };
