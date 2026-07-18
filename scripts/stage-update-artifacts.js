'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readYamlScalar(content, key) {
  const match = String(content).match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) throw new Error(`latest.yml 缺少 ${key}`);
  const value = match[1].trim();
  if ((value.startsWith("'") && value.endsWith("'"))
    || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

function sha512Base64(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
}

function stageUpdateArtifacts(outputDirectory) {
  const outputDir = path.resolve(outputDirectory || 'dist');
  const metadataPath = path.join(outputDir, 'latest.yml');
  const metadata = fs.readFileSync(metadataPath, 'utf8');
  const releaseVersion = readYamlScalar(metadata, 'version');
  const releaseSetupName = readYamlScalar(metadata, 'path');
  const expectedSha512 = readYamlScalar(metadata, 'sha512');

  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(releaseVersion)) {
    throw new Error(`latest.yml version 非法：${releaseVersion}`);
  }
  if (path.basename(releaseSetupName) !== releaseSetupName
    || !/^[A-Za-z0-9._-]+\.exe$/.test(releaseSetupName)) {
    throw new Error(`latest.yml path 非法：${releaseSetupName}`);
  }

  const sourceSetupNames = fs.readdirSync(outputDir)
    .filter((name) => name.endsWith('-setup.exe') && name !== releaseSetupName);
  if (sourceSetupNames.length !== 1) {
    throw new Error(`应有且仅有一个原始 setup，实际 ${sourceSetupNames.length} 个`);
  }

  const sourceSetupPath = path.join(outputDir, sourceSetupNames[0]);
  const sourceBlockmapPath = `${sourceSetupPath}.blockmap`;
  if (!fs.existsSync(sourceBlockmapPath)) {
    throw new Error(`缺少 setup blockmap：${path.basename(sourceBlockmapPath)}`);
  }
  if (sha512Base64(sourceSetupPath) !== expectedSha512) {
    throw new Error('latest.yml SHA512 与原始 setup 不一致');
  }

  const releaseSetupPath = path.join(outputDir, releaseSetupName);
  const releaseBlockmapPath = `${releaseSetupPath}.blockmap`;
  const releasePortableName = `bank-bill-excel-tool-portable-${releaseVersion}.exe`;
  const sourcePortableNames = fs.readdirSync(outputDir)
    .filter((name) => name.endsWith('-portable.exe') && name !== releasePortableName);
  if (sourcePortableNames.length !== 1) {
    throw new Error(`应有且仅有一个原始 portable，实际 ${sourcePortableNames.length} 个`);
  }
  const sourcePortablePath = path.join(outputDir, sourcePortableNames[0]);
  const releasePortablePath = path.join(outputDir, releasePortableName);

  fs.copyFileSync(sourceSetupPath, releaseSetupPath);
  fs.copyFileSync(sourceBlockmapPath, releaseBlockmapPath);
  fs.copyFileSync(sourcePortablePath, releasePortablePath);

  return {
    metadataPath,
    sourceSetupPath,
    sourceBlockmapPath,
    releaseSetupPath,
    releaseBlockmapPath,
    releaseSetupName,
    sourcePortablePath,
    releasePortablePath,
    releasePortableName
  };
}

if (require.main === module) {
  const result = stageUpdateArtifacts(process.argv[2] || 'dist');
  process.stdout.write(`[stage-update-artifacts] ${JSON.stringify(result)}\n`);
}

module.exports = {
  readYamlScalar,
  sha512Base64,
  stageUpdateArtifacts
};
