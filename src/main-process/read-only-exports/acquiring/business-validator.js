'use strict';

const { readOwnedArtifactEvidence } = require('../common/artifact-evidence');
const { readWorkbookBusinessEvidence } = require('../common/workbook-evidence');
const {
  ACQUIRING_EXPORT_ACTIONS,
  validateAcquiringExportResult
} = require('./policies');

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function validateAcquiringGeneratedArtifact({
  generationPlan,
  result,
  stableRunEvidence,
  dbPathOrManagedSource
}) {
  if (!validateAcquiringExportResult(result)) {
    throw validationError('ACQUIRING_EXPORT_MANIFEST_INVALID', 'Acquiring artifact manifest 非法');
  }
  const claimed = result.artifacts[0];
  if (claimed.outputArtifactKey !== generationPlan.outputArtifactKey) {
    throw validationError(
      'ACQUIRING_EXPORT_OWNERSHIP_MISMATCH',
      'Acquiring artifact ownership 不一致'
    );
  }
  if (!stableRunEvidence || result.sourceDigest !== stableRunEvidence.sourceDigest) {
    throw validationError(
      'ACQUIRING_EXPORT_SOURCE_IDENTITY_MISMATCH',
      'Acquiring artifact source identity 不一致'
    );
  }

  const technical = await readOwnedArtifactEvidence(generationPlan);
  if (technical.byteSize !== claimed.byteSize || technical.sha256 !== claimed.sha256) {
    throw validationError(
      'ACQUIRING_EXPORT_ARTIFACT_TAMPERED',
      'Acquiring artifact 技术证据不一致'
    );
  }

  if (result.actionKey === ACQUIRING_EXPORT_ACTIONS.COPY) {
    if (!dbPathOrManagedSource || dbPathOrManagedSource.kind !== 'managed-file' ||
        technical.byteSize !== dbPathOrManagedSource.byteSize ||
        technical.sha256 !== dbPathOrManagedSource.contentSha256 ||
        claimed.businessDigest !== technical.sha256 || claimed.sheetCount !== 0 ||
        claimed.dataRowCount !== 0) {
      throw validationError(
        'ACQUIRING_COPY_BUSINESS_EVIDENCE_MISMATCH',
        'Acquiring copy artifact 与冻结 source 不一致'
      );
    }
    return Object.freeze({
      ...technical,
      businessDigest: technical.sha256,
      sheetCount: 0,
      dataRowCount: 0,
      outputArtifactKey: claimed.outputArtifactKey
    });
  }

  const business = readWorkbookBusinessEvidence(generationPlan.generationPath);
  if (business.businessDigest !== claimed.businessDigest ||
      business.sheetCount !== claimed.sheetCount ||
      business.dataRowCount !== claimed.dataRowCount) {
    throw validationError(
      'ACQUIRING_REGENERATE_BUSINESS_EVIDENCE_MISMATCH',
      'Acquiring regenerate workbook 回读不一致'
    );
  }
  return Object.freeze({
    ...technical,
    ...business,
    outputArtifactKey: claimed.outputArtifactKey
  });
}

module.exports = { validateAcquiringGeneratedArtifact };
