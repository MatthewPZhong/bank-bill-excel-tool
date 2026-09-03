'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const {
  validateTaskOwnedStagingPath
} = require('../../statement-worker/staging-ownership');

function artifactError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function sha256RegularFile(filePath, options = {}) {
  const stat = await fs.promises.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < (options.allowEmpty ? 0 : 1) ||
      Number(stat.nlink) !== 1) {
    throw artifactError('READ_ONLY_EXPORT_FILE_INVALID', '只读导出文件必须是独占普通文件');
  }
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return Object.freeze({ byteSize: Number(stat.size), sha256: hash.digest('hex') });
}

async function readOwnedArtifactEvidence(generationPlan) {
  const owned = validateTaskOwnedStagingPath({
    stagingRoot: generationPlan.stagingRoot,
    candidatePath: generationPlan.generationPath,
    finalState: 'file'
  });
  const file = await sha256RegularFile(owned.candidate);
  return Object.freeze({
    generationPath: owned.candidate,
    byteSize: file.byteSize,
    sha256: file.sha256
  });
}

module.exports = { artifactError, readOwnedArtifactEvidence, sha256RegularFile };
