// v3.0.3 PR-D（W5）：导出目录是否落在 OneDrive 同步路径的检测
//
// 背景（spec acquiring-import-recon-perf §二-W5 / §9.4）：
//   Windows 上若「网银账单生成小助手」工作目录（ensureStorageRoot 结果，位于 Documents 下）
//   被 OneDrive 接管同步，大文件导出/导入会因同步进程实时上传 + Defender 过滤链而显著变慢。
//   启动后单次提示用户在 OneDrive 设置中排除该目录。
//
// 设计要点：
//   - 纯函数、无副作用：仅做平台门控 + 路径字符串判断，便于在任意平台（含 mac）单测路径逻辑。
//   - 平台门控仅 win32 生效：OneDrive 重定向是 Windows 特性；其它平台路径中即便含 onedrive 字样也不提示。
//   - 路径判断大小写不敏感（/onedrive/i）：Windows 路径大小写不敏感，且不同语言/版本目录名大小写不一。
//   - 不做文件系统访问（不读环境变量 / 不 stat）：避免启动期 I/O；纯按路径文本判断已满足提示场景。
//
// platform 参数默认 process.platform，单测可注入 'win32' / 'darwin' 验证两侧分支。

/**
 * 判断给定的工作目录路径是否位于 OneDrive 同步路径下（仅 Windows 平台返回 true）。
 * @param {string} storageRootPath ensureStorageRoot() 的返回值（工作目录绝对路径）
 * @param {string} [platform] 平台标识，默认取 process.platform（单测可注入）
 * @returns {boolean} 仅当 platform === 'win32' 且路径含 OneDrive 字样时返回 true
 */
function isStorageRootOnOneDrive(storageRootPath, platform = process.platform) {
  if (platform !== 'win32') return false;
  if (typeof storageRootPath !== 'string' || storageRootPath.length === 0) return false;
  return /onedrive/i.test(storageRootPath);
}

module.exports = {
  isStorageRootOnOneDrive
};
