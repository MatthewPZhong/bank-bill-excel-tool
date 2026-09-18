'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const { SOURCE_TYPES } = require('./definitions');

const TYPES = Object.values(SOURCE_TYPES);
const SHA = /^[a-f0-9]{64}$/;
function handoffError(message) {
  const error = new Error(`VCC 导入交接身份不符：${message}`);
  error.code = 'vcc-import-handoff-mismatch';
  return error;
}
function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw handoffError(name);
  return value;
}
function integer(value, minimum, name) {
  if (!Number.isSafeInteger(value) || value < minimum) throw handoffError(name);
  return value;
}
function canonicalMembers(value) {
  if (!Array.isArray(value) || !value.length) throw handoffError('成员清单为空');
  const seenTypes = new Set(), seenSheets = new Set();
  const members = value.map((member) => {
    if (!member || !TYPES.includes(member.sourceType) || seenTypes.has(member.sourceType)) throw handoffError('来源类型无效或重复');
    seenTypes.add(member.sourceType);
    integer(member.sourceOrdinal, 1, '来源序号');
    if (!Array.isArray(member.sheets) || !member.sheets.length) throw handoffError('来源没有 Sheet');
    const sheets = member.sheets.map((sheet) => {
      nonempty(sheet.sheetName, 'Sheet 名无效');
      integer(sheet.sheetIndex, 0, 'Sheet 序号');
      integer(sheet.headerRow, 1, '表头行号');
      integer(sheet.rawContractVersion, 1, '原始结构版本');
      if (sheet.headerRow > 1048576 || seenSheets.has(sheet.sheetIndex)) throw handoffError('Sheet 重复或表头越界');
      seenSheets.add(sheet.sheetIndex);
      const result = { sheetName: sheet.sheetName, sheetIndex: sheet.sheetIndex,
        headerRow: sheet.headerRow, rawContractVersion: sheet.rawContractVersion };
      if (member.sourceType === SOURCE_TYPES.CHANNEL) result.subject = nonempty(sheet.subject, '通道主体缺失');
      else if (sheet.subject !== undefined) throw handoffError('非通道成员不接受补充主体');
      return Object.freeze(result);
    }).sort((a, b) => a.sheetIndex - b.sheetIndex);
    return Object.freeze({ sourceType: member.sourceType, sourceOrdinal: member.sourceOrdinal, sheets: Object.freeze(sheets) });
  }).sort((a, b) => TYPES.indexOf(a.sourceType) - TYPES.indexOf(b.sourceType) || a.sourceOrdinal - b.sourceOrdinal);
  return Object.freeze(members);
}
function membersDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalMembers(value))).digest('hex');
}
function buildMemberFiles(files) {
  const ordinals = new Map();
  return files.map((file) => {
    const groups = new Map();
    for (const sheet of file.sheets || []) {
      if (!groups.has(sheet.sourceType)) groups.set(sheet.sourceType, []);
      groups.get(sheet.sourceType).push(sheet);
    }
    const members = [...groups].map(([sourceType, sheets]) => {
      const sourceOrdinal = (ordinals.get(sourceType) || 0) + 1;
      ordinals.set(sourceType, sourceOrdinal);
      return { sourceType, sourceOrdinal, sheets };
    });
    return { ...file, members: canonicalMembers(members) };
  });
}
function handoffMetadata(file, taskRunId) {
  const members = canonicalMembers(file.members);
  if (!SHA.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) throw handoffError('原件指纹无效');
  return Object.freeze({ vccImportHandoffVersion: 2, vccTaskRunId: nonempty(taskRunId, '任务 ID'),
    vccImportBatchId: taskRunId, vccPhysicalFileId: nonempty(file.physicalFileId, '物理文件 ID'),
    vccSourceSha256: file.sha256, vccSourceSizeBytes: file.sizeBytes,
    vccSourceMembers: members, vccMembersDigest: membersDigest(members) });
}
// Used by recovery, import and read-only source reconstruction. Never repairs metadata.
function readHandoffMetadata(metadata) {
  if (!metadata || metadata.vccImportHandoffVersion !== 2) throw handoffError('不是 v2 成员清单');
  const normalized = handoffMetadata({ physicalFileId: metadata.vccPhysicalFileId,
    sha256: metadata.vccSourceSha256, sizeBytes: metadata.vccSourceSizeBytes,
    members: metadata.vccSourceMembers }, metadata.vccTaskRunId);
  if (metadata.vccImportBatchId !== normalized.vccImportBatchId || metadata.vccMembersDigest !== normalized.vccMembersDigest) {
    throw handoffError('任务或成员摘要变化');
  }
  return normalized;
}
function freezeHandoffV2(value, taskRunId) {
  if (!value || value.version !== 2 || value.taskRunId !== taskRunId || !Array.isArray(value.files) || !value.files.length) {
    throw handoffError('工作簿交接版本或任务不符');
  }
  const paths = new Map(), ids = new Set(), artifacts = new Set(), ordinals = new Map();
  const files = value.files.map((file) => {
    const metadata = handoffMetadata(file, taskRunId);
    const filePath = path.resolve(nonempty(file.filePath, '原件路径'));
    integer(file.archiveArtifactId, 1, 'artifact ID');
    if (ids.has(file.physicalFileId) || artifacts.has(file.archiveArtifactId)) throw handoffError('物理文件重复');
    // Preflight deduplicates selected input paths. After archival, distinct files
    // with equal bytes legitimately resolve to one content-addressed Blob path.
    const previous = paths.get(filePath);
    if (previous && (previous.sha256 !== file.sha256 || previous.sizeBytes !== file.sizeBytes)) throw handoffError('共享原件内容身份不一致');
    paths.set(filePath, { sha256: file.sha256, sizeBytes: file.sizeBytes });
    ids.add(file.physicalFileId); artifacts.add(file.archiveArtifactId);
    for (const member of metadata.vccSourceMembers) {
      const next = (ordinals.get(member.sourceType) || 0) + 1;
      if (member.sourceOrdinal !== next) throw handoffError('来源文件顺序变化');
      ordinals.set(member.sourceType, next);
    }
    return Object.freeze({ physicalFileId: file.physicalFileId, filePath,
      fileName: nonempty(file.fileName, '原文件名'), archiveArtifactId: file.archiveArtifactId,
      sha256: file.sha256, sizeBytes: file.sizeBytes, members: metadata.vccSourceMembers });
  });
  return Object.freeze({ version: 2, taskRunId, files: Object.freeze(files) });
}
function assertArtifactMember(artifact, source, batch) {
  const metadata = readHandoffMetadata(artifact.metadata);
  const member = metadata.vccSourceMembers.find((entry) => entry.sourceType === source.source_type
    && entry.sourceOrdinal === Number(source.source_ordinal));
  if (!member || metadata.vccImportBatchId !== source.batch_id || batch?.taskRunId !== source.batch_id
      || batch?.moduleId !== 'vcc-financial-op' || artifact.direction !== 'input' || artifact.role !== 'input'
      || artifact.sourceOperation !== 'vccFinancialOp:import:apply'
      || artifact.originalName !== source.source_file_name
      || metadata.vccSourceSha256 !== source.source_sha256 || metadata.vccSourceSizeBytes !== Number(source.source_size_bytes)
      || artifact.blob?.sha256 !== source.source_sha256 || Number(artifact.blob?.sizeBytes) !== Number(source.source_size_bytes)) {
    throw handoffError('持久原件与来源成员不一致');
  }
  return member;
}

module.exports = { handoffError, canonicalMembers, membersDigest, buildMemberFiles,
  handoffMetadata, readHandoffMetadata, freezeHandoffV2, assertArtifactMember };
