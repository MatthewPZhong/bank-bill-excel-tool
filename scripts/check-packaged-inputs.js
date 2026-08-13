#!/usr/bin/env node
'use strict';

// Windows 打包前的源码输入洁净度门禁。
// electron-builder 的 build.files 是 app.asar 输入白名单；其中任何 tracked dirty
// 或 Git 未跟踪文件都可能让产物脱离 HEAD。构建元信息必须在本门禁通过后生成。

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
// 该文件由 prepare:dist 在门禁通过后覆写；即使上一次本地构建留下旧 ignored
// 副本，也不会成为本次产物源码。其它 ignored packaged input 一律按 untracked 阻断。
const GENERATED_AFTER_GATE = new Set(['src/build-info.js']);

function normalizeRelativePath(value) {
  return String(value || '')
    .split(path.sep).join('/')
    .replace(/^\.\//, '');
}

function readBuildFilePatterns(repoRoot) {
  const manifestPath = path.join(repoRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const patterns = manifest && manifest.build && manifest.build.files;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('package.json build.files 必须是非空字符串数组');
  }
  if (patterns.some((pattern) => typeof pattern !== 'string' || !pattern.trim())) {
    throw new Error('package.json build.files 出现不支持的非字符串或空规则');
  }
  return patterns.map((pattern) => pattern.trim());
}

function compileBuildFilePattern(pattern) {
  const normalized = normalizeRelativePath(pattern);
  if (/[\[\]{}()]/.test(normalized)) {
    throw new Error(`build.files 暂不支持该 glob 语法：${pattern}`);
  }
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      index += 1;
      if (normalized[index + 1] === '/') {
        index += 1;
        source += '(?:[^/]+/)*';
      } else {
        source += '.*';
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return new RegExp(source + '$');
}

function createBuildFileMatcher(patterns) {
  const includePatterns = patterns
    .filter((pattern) => !pattern.startsWith('!'))
    .map(compileBuildFilePattern);
  const excludePatterns = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => compileBuildFilePattern(pattern.slice(1)));
  if (includePatterns.length === 0) {
    throw new Error('package.json build.files 缺少正向包含规则');
  }
  return (relativePath) => {
    const normalized = normalizeRelativePath(relativePath);
    const included = includePatterns.some((pattern) => pattern.test(normalized));
    if (!included) return false;
    return !excludePatterns.some((pattern) => pattern.test(normalized));
  };
}

function findBuildFileRoots(patterns) {
  const roots = new Set();
  for (const pattern of patterns.filter((entry) => !entry.startsWith('!'))) {
    const segments = normalizeRelativePath(pattern).split('/');
    const firstGlobIndex = segments.findIndex((segment) => /[*?\[\]{}()]/.test(segment));
    const rootSegments = firstGlobIndex < 0 ? segments : segments.slice(0, firstGlobIndex);
    roots.add(rootSegments.length > 0 ? rootSegments.join('/') : '.');
  }
  return [...roots].sort();
}

function gitNullList(repoRoot, args) {
  const output = execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return output.split('\0').filter(Boolean).map(normalizeRelativePath);
}

function inspectPackagedInputs(repoRoot = REPO_ROOT) {
  const patterns = readBuildFilePatterns(repoRoot);
  const matchesBuildFiles = createBuildFileMatcher(patterns);
  const roots = findBuildFileRoots(patterns);
  const dirtyTracked = gitNullList(
    repoRoot,
    ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--', ...roots]
  ).filter(matchesBuildFiles);
  const ordinaryUntracked = gitNullList(
    repoRoot,
    ['ls-files', '--others', '--exclude-standard', '-z', '--', ...roots]
  );
  const ignoredUntracked = gitNullList(
    repoRoot,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...roots]
  );
  const untracked = [...ordinaryUntracked, ...ignoredUntracked]
    .filter(matchesBuildFiles)
    .filter((relativePath) => !GENERATED_AFTER_GATE.has(relativePath));
  return {
    patterns,
    roots,
    dirtyTracked: [...new Set(dirtyTracked)].sort(),
    untracked: [...new Set(untracked)].sort()
  };
}

function assertPackagedInputsClean(repoRoot = REPO_ROOT) {
  const report = inspectPackagedInputs(repoRoot);
  if (report.dirtyTracked.length === 0 && report.untracked.length === 0) {
    return report;
  }
  const error = new Error('electron-builder 打包输入不是 HEAD 的干净快照');
  error.code = 'PACKAGED_INPUTS_DIRTY';
  error.report = report;
  throw error;
}

function main() {
  try {
    const report = assertPackagedInputsClean();
    console.log('[check-packaged-inputs] PASS：build.files 覆盖范围与 HEAD 一致');
    console.log(`  包含规则：${report.patterns.length} 条`);
  } catch (error) {
    console.error('[check-packaged-inputs] FAIL：' + error.message);
    if (error.report) {
      for (const file of error.report.dirtyTracked) {
        console.error('  - tracked dirty：' + file);
      }
      for (const file of error.report.untracked) {
        console.error('  - untracked included：' + file);
      }
    }
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  assertPackagedInputsClean,
  compileBuildFilePattern,
  createBuildFileMatcher,
  findBuildFileRoots,
  inspectPackagedInputs,
  readBuildFilePatterns
};
