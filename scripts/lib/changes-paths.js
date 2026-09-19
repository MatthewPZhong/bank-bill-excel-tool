'use strict';

const path = require('node:path');
const { moves } = require('../../changes/organization-map.json');

// 历史证据中的路径和摘要保持原样，仅在读取当前工作区时转换顶层目录。
// 合同包内部也有 changes 目录，不能递归替换其中的版本路径。
function resolveChangesPath(repositoryRoot, ...segments) {
  const relativePath = path.join(...segments).split(path.sep).join('/');
  const parts = relativePath.split('/');
  const originalRoot = parts.slice(0, 2).join('/');
  const destination = Object.hasOwn(moves, originalRoot) ? moves[originalRoot] : null;
  const relocated = destination
    ? destination + relativePath.slice(originalRoot.length)
    : relativePath;
  return path.join(repositoryRoot, relocated);
}

module.exports = { resolveChangesPath };
