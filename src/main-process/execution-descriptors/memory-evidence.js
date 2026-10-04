'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '../../..');
const EXCLUDED = new Set(['src/build-info.js', 'src/main-process/execution-descriptors/memory-qualification.json']);
function sourceIdentity(root = ROOT) {
  const files = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && !EXCLUDED.has(name)) files.push(name);
      else if (entry.isSymbolicLink()) throw new Error('容量证据源码不能使用符号链接');
    }
  }
  visit('src');
  files.push('package-lock.json');
  const digest = createHash('sha256');
  // 打包器可移除 scripts/devDependencies/build；运行契约和锁文件必须保持一致。
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  digest.update(JSON.stringify({ version: packageInfo.version, dependencies: Object.entries(packageInfo.dependencies || {}).sort() }) + '\n');
  const chunk = Buffer.alloc(64 * 1024);
  for (const file of files.sort()) {
    const filename = path.join(root, file);
    digest.update(JSON.stringify([file, fs.statSync(filename).size]) + '\n');
    const fd = fs.openSync(filename, 'r');
    try {
      let read;
      while ((read = fs.readSync(fd, chunk)) > 0) digest.update(chunk.subarray(0, read));
    } finally { fs.closeSync(fd); }
  }
  return { sourceTreeSha256: digest.digest('hex'),
    dependencyLockSha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex'),
    appVersion: packageInfo.version,
    platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
    electronVersion: process.versions.electron || null };
}

// 人工确认只授予清单列出的配置；实际准入仍检查资源、实时内存和活动覆盖。
function manuallyQualifiedProfile(manifest, config, identity) {
  const approval = manifest.approval;
  if (manifest.status !== 'qualified' || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      identity?.platform !== manifest.platform || identity.arch !== manifest.arch || !identity.electronVersion ||
      approval?.kind !== 'manual-acceptance' || approval.result !== 'PASS' ||
      typeof approval.reference !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(approval.reference) ||
      typeof approval.releaseVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(approval.releaseVersion) ||
      typeof approval.confirmedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(approval.confirmedAt) ||
      !Array.isArray(manifest.profiles)) return null;
  const entries = manifest.profiles.filter((item) => item?.profileId === config.profileId);
  if (entries.length !== 1 || entries[0].policyDigest !== config.policyDigest) return null;
  return approval.reference;
}

function qualifiedProfile(manifest, config, identity) {
  if (manifest?.schemaVersion === 2) return manuallyQualifiedProfile(manifest, config, identity);
  if (manifest?.schemaVersion !== 1 || manifest.status !== 'qualified' || manifest.inventoryComplete !== true ||
      identity.platform !== 'win32' || !identity.electronVersion ||
      !['sourceTreeSha256', 'dependencyLockSha256', 'appVersion', 'platform', 'arch', 'nodeVersion', 'electronVersion']
        .every((key) => manifest[key] === identity[key]) || !/^[a-f0-9]{64}$/.test(manifest.artifactSha256 || '') ||
      !Array.isArray(manifest.profiles)) return null;
  const entry = manifest.profiles.find((item) => item.profileId === config.profileId && item.policyDigest === config.policyDigest);
  if (!entry || entry.result !== 'PASS' || typeof entry.evidenceId !== 'string' || !entry.evidenceId ||
      entry.syntheticOnly !== false || !Array.isArray(entry.runs)) return null;
  const required = config.profileId.includes('-low-') ? [512, 768] : ['normal'];
  // phase 目前不按格式细分；因此所有可进入该 phase 的格式都必须有证据。
  // 只测 XLSX 不能连带放行公共 CSV/XLS 读取。
  const formats = ['split-prepare', 'rows-generation'].includes(config.phaseKey) ? ['xlsx', 'csv', 'xls'] : ['phase-complete'];
  for (const availableMiB of required) {
    const runs = entry.runs.filter((run) => run.availableMiB === availableMiB && run.result === 'PASS' &&
      run.realPressure === true && run.sourceTreeSha256 === identity.sourceTreeSha256 &&
      run.artifactSha256 === manifest.artifactSha256 && /^[a-f0-9]{64}$/.test(run.reportSha256 || ''));
    if (formats.some((format) => new Set(runs.filter((run) => run.coveredFormats?.includes(format))
      .map((run) => run.reportSha256)).size < 3)) return null;
  }
  return entry.evidenceId;
}
module.exports = { sourceIdentity, qualifiedProfile };
