'use strict';
const fs = require('node:fs');
const path = require('node:path');

// 私有 fs 仅在本次发布写句柄关闭后，对同一真实 dev/ino 模拟 Windows ctime 回写。
// 其余字段始终来自真实 stat；后续实际修改仍会反映在返回值中。
function createMigrationCloseMetadataFs({ targetRoot, copyFallback = false, afterClose,
  injectCanonicalClose = false } = {}) {
  const offsets = new Map(), closedWrites = [];
  const key = (stat) => `${stat.dev}:${stat.ino}`;
  const advanceCtime = (stat, offset = 1000000000n) => offsets.set(key(stat), (offsets.get(key(stat)) || 0n) + offset);
  const view = (stat) => {
    const offset = offsets.get(key(stat));
    if (!offset) return stat;
    const result = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat);
    if (typeof stat.ctimeNs === 'bigint') {
      result.ctimeNs += offset; result.ctimeMs = result.ctimeNs / 1000000n;
    } else result.ctimeMs += Number(offset) / 1e6;
    return result;
  };
  const fsImpl = { ...fs,
    lstatSync: (...args) => view(fs.lstatSync(...args)),
    fstatSync: (...args) => view(fs.fstatSync(...args)),
    promises: { ...fs.promises,
      lstat: async (...args) => view(await fs.promises.lstat(...args)),
      async link(source, target) {
        if (copyFallback) throw Object.assign(new Error('模拟不支持 hardlink'), { code: 'ENOTSUP' });
        return fs.promises.link(source, target);
      },
      async open(filePath, ...args) {
        const handle = await fs.promises.open(filePath, ...args);
        const stat = handle.stat.bind(handle), chmod = handle.chmod.bind(handle), close = handle.close.bind(handle);
        const root = typeof targetRoot === 'function' ? targetRoot() : targetRoot;
        const isTarget = root && String(filePath).startsWith(root + path.sep);
        const injectCanonical = typeof injectCanonicalClose === 'function' ? injectCanonicalClose() : injectCanonicalClose;
        const isCanonicalWrite = injectCanonical && isTarget && (copyFallback
          ? args[0] === 'wx' && String(filePath).includes(path.join('blobs', 'sha256'))
          : args[0] === 'r+' && String(filePath).includes(path.join('.staging', 'blob-')));
        let readonlyWritten = false;
        let closePromise;
        let actualClosed = false;
        handle.stat = async (...values) => view(await stat(...values));
        handle.chmod = async (mode) => {
          if (isTarget && mode === 0o444) readonlyWritten = true;
          return chmod(mode);
        };
        handle.close = () => {
          if (actualClosed) return Promise.resolve();
          if (!closePromise) closePromise = (async () => {
            const before = readonlyWritten || isCanonicalWrite ? await stat({ bigint: true }) : null;
            await close();
            actualClosed = true;
            if (before) {
              advanceCtime(before);
              const event = { filePath, identity: before, readonlyWritten };
              closedWrites.push(event);
              if (afterClose) afterClose(event);
            }
          })();
          return closePromise;
        };
        return handle;
      }
    }
  };
  return { fsImpl, closedWrites, advanceCtime };
}

module.exports = { createMigrationCloseMetadataFs };
