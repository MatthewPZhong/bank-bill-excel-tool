'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../../..');
const V319_COMMIT = '3edf0527d6537d29cb19b48bda2a3f91f0ce6e32';

test('release check-vars 固定 peeled v3.1.9 基线且不扩大普通开发扫描', (t) => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['check:vars'], 'node scripts/check-vars.js');
  assert.equal(
    packageJson.scripts['check:vars:release'],
    'node scripts/check-vars.js --since "v3.1.9^{commit}" --include-minor'
  );

  try {
    const peeled = execFileSync('git', ['rev-parse', 'v3.1.9^{commit}'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    assert.equal(peeled, V319_COMMIT);
  } catch (error) {
    if (error.status === 128) {
      t.diagnostic('当前 checkout 未拉取 tag；静态 release baseline 契约仍已验证');
      return;
    }
    throw error;
  }
});

test('check-vars 为跨 PR baseline diff 配置显式大输出缓冲并禁用 shell 拼接', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/check-vars.js'), 'utf8');
  assert.match(source, /const MAX_GIT_OUTPUT_BYTES = 64 \* 1024 \* 1024;/);
  assert.match(source, /execFileSync\('git', \['diff', target, '--', 'src\/'\]/);
  assert.doesNotMatch(source, /execSync\(`git diff/);
});

test('v3.1.11 storage contract、迁移与 Archive 血缘已进入 important-vars 清单', () => {
  const importantVariables = fs.readFileSync(
    path.join(ROOT, 'rules/important-variables.md'),
    'utf8'
  );
  for (const name of [
    'freezeWorkerBatchContext',
    'TaskLifecycle',
    'TaskPolicyRegistry',
    'BusinessFlowResolver',
    'ArchiveRepository',
    'ArchiveService',
    'VCC_STORAGE_CONTRACT_VERSION',
    'registerVccStorageWriteCapability',
    'buildVccStorageCandidate',
    'recoverVccStorageMigration',
    'buildVccImportArchiveHandoffFiles',
    'archive_artifact_holds'
  ]) {
    assert.match(importantVariables, new RegExp('`' + name + '`'));
  }
  assert.match(importantVariables, /当前清单版本 \| v36（app v3\.1\.11/);
});
