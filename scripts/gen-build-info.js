// v2.1.6 Module A T3 — 构建时生成 src/build-info.js（含 git short SHA）
// 用于 main.js 启动期 log 头注入 `build {commit}` 标识
//
// 使用：
//   - npm run prebuild:meta 单独触发
//   - 各 dist:win* 脚本前置串入此命令
// 不入 git（.gitignore 排除 src/build-info.js）
// dev 期或无 git 环境 → commit 写入 'dev'

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

let commit = 'dev';
try {
  commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim() || 'dev';
} catch (_) {
  // 无 git 或不在仓库中 → 保持 'dev'
}

const outputPath = path.join(__dirname, '..', 'src', 'build-info.js');
const content = `// 构建时自动生成，勿手改；由 scripts/gen-build-info.js 写入
module.exports = ${JSON.stringify({ commit }, null, 2)};
`;

fs.writeFileSync(outputPath, content, 'utf8');
console.log('[gen-build-info] wrote', outputPath, JSON.stringify({ commit }));
