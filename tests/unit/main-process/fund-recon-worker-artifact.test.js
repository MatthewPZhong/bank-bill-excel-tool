'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createFundReconArtifactGenerator,
  normalizeStagingPlan
} = require('../../../src/main-process/fund-recon-worker/artifact-generator');

function plan(root, kinds) {
  return {
    version: 1,
    stagingRoot: root,
    manifestPath: path.join(root, 'manifest.json'),
    manifestArtifactKey: 'fund-recon-manifest',
    outputs: kinds.map((kind) => ({ kind, stagingPath: path.join(root, `${kind}.xlsx`) }))
  };
}

function processingResult(overrides = {}) {
  return {
    modifiedRows: [],
    unmatchedRows: [],
    modifications: [],
    errorReport: [],
    platformCleanupRows: [],
    refundBackfillRows: [],
    refundUnmatchedRows: [],
    paymentOfflineMatchedPairs: [],
    manyToManyReviewRows: [],
    evidenceSignature: 'a'.repeat(64),
    ...overrides
  };
}

test('FilePlan拒绝目录逃逸、业务输出别名和manifest别名', () => {
  const root = path.join(os.tmpdir(), 'fund-recon-plan');
  assert.throws(() => normalizeStagingPlan({
    ...plan(root, ['main']),
    outputs: [{ kind: 'main', stagingPath: path.join(root, '..', 'escape.xlsx') }]
  }), (error) => error.code === 'FUND_RECON_STAGING_ESCAPE');
  assert.throws(() => normalizeStagingPlan({
    ...plan(root, ['main', 'error-report']),
    outputs: [
      { kind: 'main', stagingPath: path.join(root, 'same.xlsx') },
      { kind: 'error-report', stagingPath: path.join(root, 'same.xlsx') }
    ]
  }), (error) => error.code === 'FUND_RECON_FILE_PLAN_INVALID');
  assert.throws(() => normalizeStagingPlan({
    ...plan(root, ['main']),
    manifestPath: path.join(root, 'main.xlsx')
  }), (error) => error.code === 'FUND_RECON_FILE_PLAN_INVALID');
});

test('任一Writer失败时清理全部planned staging文件且不留下manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-recon-artifact-'));
  const stagingPlan = plan(root, ['error-report', 'main']);
  const generator = createFundReconArtifactGenerator({
    async writeErrorReportOutputToPath({ outputPath }) {
      fs.writeFileSync(outputPath, 'error-report');
    },
    async writeBankStatementMainOutput({ mainFilePath }) {
      fs.writeFileSync(mainFilePath, 'partial-main');
      throw new Error('writer failed');
    }
  });
  try {
    await assert.rejects(generator.generate({
      processingResult: processingResult({ errorReport: [{ code: 'W1' }], unmatchedRows: [{}] }),
      bankSession: { headers: [], filePath: '/tmp/source.xlsx' },
      evidenceSnapshot: null,
      stagingPlan
    }), /writer failed/);
    for (const target of [...stagingPlan.outputs.map((item) => item.stagingPath), stagingPlan.manifestPath]) {
      assert.equal(fs.existsSync(target), false, `失败后不得残留 ${path.basename(target)}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('成功只返回单manifest artifact，manifest绑定每个staged输出hash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-recon-artifact-'));
  const stagingPlan = plan(root, ['main']);
  const generator = createFundReconArtifactGenerator({
    async writeBankStatementMainOutput({ mainFilePath }) {
      fs.writeFileSync(mainFilePath, 'main-output');
    }
  });
  try {
    const artifact = await generator.generate({
      processingResult: processingResult({ unmatchedRows: [{}] }),
      bankSession: { headers: [], filePath: '/tmp/source.xlsx' },
      evidenceSnapshot: null,
      stagingPlan
    });
    assert.equal(artifact.artifactKey, 'fund-recon-manifest');
    assert.equal(artifact.stagingPath, stagingPlan.manifestPath);
    const manifest = JSON.parse(fs.readFileSync(stagingPlan.manifestPath, 'utf8'));
    assert.equal(manifest.outputs.length, 1);
    assert.match(manifest.outputs[0].sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('退款marker在写盘前注入跨期提醒，并只把ready settlement写入manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-recon-artifact-'));
  const stagingPlan = plan(root, ['refund-backfill']);
  let writtenRows = null;
  const generator = createFundReconArtifactGenerator({
    listChannels: () => [],
    readBankDepositHitMarkers(_db, bizIds) {
      assert.deepEqual(bizIds, ['BIZ-1']);
      return new Map([['BIZ-1', { last_hit_run: 'old-run', last_hit_at: '2026-08-01T00:00:00Z' }]]);
    },
    async writeRefundBackfillOutput(rows, _unmatchedRows, outputPath) {
      writtenRows = rows;
      fs.writeFileSync(outputPath, 'refund-output');
    }
  });
  try {
    await generator.generate({
      processingResult: processingResult({
        refundBackfillRows: [{
          _bridgeDepositBizId: ' BIZ-1 ',
          匹配命中详情: '原命中详情'
        }],
        refundHitDepositBizIds: ['BIZ-1', ' BIZ-1 '],
        runId: 123
      }),
      bankSession: { headers: [], filePath: '/tmp/source.xlsx' },
      evidenceSnapshot: { db: {} },
      stagingPlan
    });
    assert.match(writtenRows[0].匹配命中详情, /^原命中详情\n⚠️/);
    const manifest = JSON.parse(fs.readFileSync(stagingPlan.manifestPath, 'utf8'));
    assert.deepEqual(manifest.settlement.refundHitMarkers, {
      status: 'ready',
      runId: '123',
      bizIds: ['BIZ-1'],
      reasonCode: null
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('退款marker读取失败不阻断产物且manifest禁止推进marker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-recon-artifact-'));
  const stagingPlan = plan(root, ['refund-backfill']);
  const generator = createFundReconArtifactGenerator({
    listChannels: () => [],
    readBankDepositHitMarkers() { throw new Error('marker unavailable'); },
    async writeRefundBackfillOutput(_rows, _unmatchedRows, outputPath) {
      fs.writeFileSync(outputPath, 'refund-output');
    }
  });
  try {
    await generator.generate({
      processingResult: processingResult({
        refundBackfillRows: [{ _bridgeDepositBizId: 'BIZ-1' }],
        refundHitDepositBizIds: ['BIZ-1'],
        runId: 123
      }),
      bankSession: { headers: [], filePath: '/tmp/source.xlsx' },
      evidenceSnapshot: { db: {} },
      stagingPlan
    });
    const manifest = JSON.parse(fs.readFileSync(stagingPlan.manifestPath, 'utf8'));
    assert.deepEqual(manifest.settlement.refundHitMarkers, {
      status: 'skipped',
      runId: null,
      bizIds: [],
      reasonCode: 'marker-read-failed'
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
