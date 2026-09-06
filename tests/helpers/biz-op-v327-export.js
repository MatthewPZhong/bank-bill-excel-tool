'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHost } = require('./biz-op-v327-host');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');

async function createExportHost(t, options = {}) {
  const f = await createHost(t, options);
  f.outputRoot = options.outputRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-export-target-'));
  t.after(() => { if (!options.keep) fs.rmSync(f.outputRoot, { recursive: true, force: true }); });
  return f;
}
function request(f, outputKind, objectId, options = {}) {
  const suffix = outputKind.toLowerCase().replace('_', '-');
  const target = options.targetPath || path.join(f.outputRoot, `${suffix}.xlsx`);
  return f.module.runExport({ taskLifecycle: f.lifecycle, runtime: f.runtime, outputKind, objectId,
    filePlan: normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [], outputs: [{ filePath: target,
      role: 'output', sourceOperation: `bizOpReconV327:export:${suffix}` }] }), ...options });
}
module.exports = { createExportHost, request };
