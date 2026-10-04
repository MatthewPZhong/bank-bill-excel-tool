'use strict';

// yauzl.close() 只提出关闭请求；close 事件才确认底层 reader 的文件描述符已关闭。
function closeZip(zip) {
  if (zip.reader.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { zip.removeListener('close', done); zip.removeListener('error', failed); };
    const done = () => { clean(); resolve(); };
    const failed = (error) => { clean(); reject(error); };
    zip.once('close', done);
    zip.once('error', failed);
    try { zip.close(); } catch (error) { failed(error); }
  });
}

module.exports = { closeZip };
