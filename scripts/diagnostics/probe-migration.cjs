'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

if (process.env.ARCHIVE_MIGRATION_FIELD_DIAGNOSTIC === '1') {
  const Module = require('node:module');
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = function instrument(module, filename) {
    if (!filename.endsWith(path.join('archive-center', 'storage-root-manager.js'))) return original(module, filename);
    const sourceBytes = fs.readFileSync(filename);
    const source = sourceBytes.toString('utf8').replace(/\r\n/g, '\n');
    console.error('MIGRATION_SOURCE_IDENTITY ' + JSON.stringify({ filename,
      sha256: require('node:crypto').createHash('sha256').update(sourceBytes).digest('hex'), normalizedCrlf: true }));
    const marker = "    throw new ArchiveStorageRootError('ARCHIVE_STORAGE_DELETE_FILE_CHANGED',\n      '迁移发布路径不再属于本次创建的原文件，保留文件及恢复记录');";
    if (!source.includes(marker)) throw new Error('assertPublishedIdentity diagnostic marker missing');
    const log = "    console.error('MIGRATION_IDENTITY_DIFF ' + JSON.stringify({ expected, actual, ignored, differing: Object.keys(expected || {}).filter((k) => !ignored.includes(k) && expected[k] !== actual?.[k]), stack: new Error().stack }));\n";
    return module._compile(source.replace(marker, log + marker), filename);
  };
} else {
  const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'mode', 'nlink'];
  const view = (stat) => Object.fromEntries(fields.map((key) => [key, String(stat[key])]));
  const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  async function runPrimitive(root, mode, fallback) {
    const directory = path.join(root, `${mode.toString(8)}-${fallback ? 'wx' : 'link'}`);
    fs.mkdirSync(directory);
    const source = path.join(directory, 'input'), staged = path.join(directory, 'stage'), target = path.join(directory, 'target');
    fs.writeFileSync(source, 'diagnostic fixture only');
    await pipeline(fs.createReadStream(source), fs.createWriteStream(staged, { flags: 'wx', mode: 0o600 }));
    let handle, targetHandle;
    const snapshot = async (phase) => {
      const record = { kind: 'primitive', mode: mode.toString(8), fallback, phase };
      for (const [key, filePath] of [['stagedPath', staged], ['targetPath', target]]) {
        try { record[key] = view(fs.lstatSync(filePath, { bigint: true })); } catch (error) { record[key] = { code: error.code }; }
      }
      for (const [key, fd] of [['stagedFd', handle], ['targetFd', targetHandle]]) {
        if (fd) record[key] = view(await fd.stat({ bigint: true }));
      }
      emit(record);
    };
    try {
      await snapshot('copied-closed');
      handle = await fs.promises.open(staged, 'r+');
      await snapshot('opened');
      await handle.chmod(mode); await handle.sync();
      await snapshot('chmod-sync');
      if (fallback) {
        targetHandle = await fs.promises.open(target, 'wx', 0o600);
        await targetHandle.writeFile(handle.createReadStream({ autoClose: false, start: 0 }));
        await targetHandle.sync(); await targetHandle.chmod(mode); await targetHandle.sync();
      } else await fs.promises.link(staged, target);
      await snapshot('published');
      fs.unlinkSync(staged); await snapshot('staging-unlinked');
      if (targetHandle) { await targetHandle.close(); targetHandle = null; }
      await handle.close(); handle = null;
      await snapshot('all-fds-closed');
    } catch (error) { emit({ kind: 'primitive-error', mode, fallback, code: error.code, stack: error.stack }); }
    finally { if (targetHandle) await targetHandle.close(); if (handle) await handle.close(); }
  }
  (async () => {
    const repository = path.resolve(process.argv[2] || process.cwd());
    emit({ kind: 'environment', platform: process.platform, arch: process.arch, versions: process.versions, release: os.release() });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-migration-field-probe-'));
    try { for (const mode of [0o600, 0o444]) for (const fallback of [false, true]) await runPrimitive(root, mode, fallback); }
    finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
    const result = spawnSync(process.execPath, ['--require', __filename, '--test', '--test-name-pattern', '^正常迁移',
      path.join(repository, 'tests/unit/main-process/archive-storage-root-migration.test.js')],
    { cwd: repository, env: { ...process.env, ARCHIVE_MIGRATION_FIELD_DIAGNOSTIC: '1' }, encoding: 'utf8', timeout: 120000 });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    emit({ kind: 'migration-test-result', status: result.status, signal: result.signal, error: result.error?.message || null });
    process.exitCode = result.status === 0 ? 0 : 1;
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
