'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { durableDirectoryTest } = require('./durable-directory-tests');

function terminalRecoveryTests(terminals) {
  for (const terminal of terminals) for (const withHold of [false, true]) for (const cut of ['retry', 'anchor', 'bundle']) {
    durableDirectoryTest(`真实 ${terminal} / Hold=${withHold} / ${cut} 故障恢复与独立进程重启`, (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-terminal-regression-'));
      fs.mkdirSync(path.join(root, 'app'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      for (const phase of ['create', 'recover']) {
        // Windows 的真实文件落盘与恢复观察更慢；限制测试宿主总时长，不改变产品等待合同。
        const timeout = process.platform === 'win32' ? 120000 : 45000;
        const child = spawnSync(process.execPath, [path.resolve(__dirname, '../fixtures/biz-op-v327-terminal-recovery.cjs'),
          root, terminal, cut, String(withHold), phase], { encoding: 'utf8', timeout,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        const expected = phase === 'recover' ? 0 : { retry: 73, anchor: 75, bundle: 76 }[cut];
        const detail = JSON.stringify({ phase, timeout, errorCode: child.error?.code, signal: child.signal }) + '\n' + child.stderr + child.stdout;
        assert.equal(child.error, undefined, detail);
        assert.equal(child.status, expected, detail);
        t.diagnostic(child.stdout.trim());
      }
    });
  }
}
module.exports = { terminalRecoveryTests };
