'use strict';

// 只转交业务预检已经冻结的证据；不能在删除或恢复时重读来源补造原身份。
function positionInputFilePlanEvidence(file) {
  const expectedSha256 = file.expectedSha256 ?? file.stagedSha256 ?? file.sha256;
  const expectedSizeBytes = file.expectedSizeBytes ?? file.stagedSizeBytes ?? file.sizeBytes;
  const sourceSnapshot = file.sourceSnapshot ?? file.stagedSnapshot;
  return {
    ...(sourceSnapshot ? { sourceSnapshot } : {}),
    ...(expectedSha256 !== undefined || expectedSizeBytes !== undefined
      ? { expectedSha256, expectedSizeBytes }
      : {})
  };
}

function positionOutputFilePlanEvidence(file) {
  return { preGeneratedOutput: { version: 1, kind: 'position-anomaly-report', producerArtifactKey: file.artifactKey,
    sourceSnapshot: file.sourceSnapshot, expectedSha256: file.expectedSha256 ?? file.sha256,
    expectedSizeBytes: file.expectedSizeBytes ?? file.sizeBytes } };
}

function positionFilePlanSettlementFiles(filePlan) {
  return [...filePlan.inputs, ...filePlan.outputs].map((item) => ({
    artifactKey: item.artifactKey,
    ...(item.preGeneratedOutput
      ? { expectedSha256: item.preGeneratedOutput.expectedSha256, expectedSizeBytes: item.preGeneratedOutput.expectedSizeBytes }
      : item.direction === 'input' && item.expectedSha256 !== undefined
        ? { expectedSha256: item.expectedSha256, expectedSizeBytes: item.expectedSizeBytes }
        : {})
  }));
}

module.exports = { positionInputFilePlanEvidence, positionOutputFilePlanEvidence, positionFilePlanSettlementFiles };
