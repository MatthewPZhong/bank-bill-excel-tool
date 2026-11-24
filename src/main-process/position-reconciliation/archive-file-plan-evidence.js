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

// 按侧库记录的报告键在原存档批次里找异常报告条目。
// 侧库记的是生成报告时的键（存档批次的删除保护与运行冻结都按它核对）；存档条目自己的键由文件计划另行分配，
// 生成键登记在条目的 preGeneratedOutput.producerArtifactKey。先按条目键找（兼容直接以生成键入库的批次），
// 再按生成键找；同一批次里对应多个条目时无法确定是哪一份，返回 null。
function findArchivedPositionReportArtifact(repository, batchId, reportArtifactKey) {
  const key = String(reportArtifactKey || '').trim();
  if (!repository || !key) return null;
  const direct = repository.getArtifactByKey(batchId, key);
  if (direct) return direct;
  const produced = repository.listArtifacts(batchId).filter((item) => (
    item
    && item.direction === 'output'
    && item.metadata
    && item.metadata.preGeneratedOutput
    && item.metadata.preGeneratedOutput.producerArtifactKey === key
  ));
  return produced.length === 1 ? produced[0] : null;
}

module.exports = {
  findArchivedPositionReportArtifact,
  positionInputFilePlanEvidence,
  positionOutputFilePlanEvidence,
  positionFilePlanSettlementFiles
};
