#!/usr/bin/env node
/* eslint-disable no-console */
// 从 git diff 扫描，是否触及 rules/important-variables.md 中的重要变量
// 仅做 diff 行匹配（不扫未改动上下文），输出命中变量 + 层级
//
// 用法：node scripts/check-vars.js [--since <ref>] [--include-minor]
//
// 默认扫：git diff HEAD -- src/   （未提交 + 本地 HEAD 改动）
// --since main → 扫 main...HEAD 的增量（适合 PR 前自查）

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = { since: null, includeMinor: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--since') opt.since = argv[++i];
  else if (a === '--include-minor') opt.includeMinor = true;
  else if (a === '--help' || a === '-h') {
    console.log('usage: node scripts/check-vars.js [--since <ref>] [--include-minor]');
    process.exit(0);
  }
}

const REPO_ROOT = path.resolve(__dirname, '..');
const MD_PATH = path.resolve(REPO_ROOT, 'rules/important-variables.md');

if (!fs.existsSync(MD_PATH)) {
  console.error('[check-vars] 清单不存在：rules/important-variables.md');
  process.exit(1);
}

// ---------- Step 1: 取 diff ----------
let diff;
try {
  const target = opt.since ? `${opt.since}...HEAD` : 'HEAD';
  diff = execSync(`git diff ${target} -- src/`, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (!opt.since) {
    // 默认追加未提交改动
    const unstaged = execSync(`git diff -- src/`, { cwd: REPO_ROOT, encoding: 'utf8' });
    const staged = execSync(`git diff --cached -- src/`, { cwd: REPO_ROOT, encoding: 'utf8' });
    diff = diff + '\n' + unstaged + '\n' + staged;
  }
} catch (e) {
  console.error('[check-vars] git diff 失败：', e.message);
  process.exit(1);
}

const changedLines = [];
let currentFile = null;
const changedFiles = new Set();
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/') || line.startsWith('--- a/')) {
    const f = line.slice(6);
    if (f && f !== '/dev/null') {
      currentFile = f;
      changedFiles.add(f);
    }
    continue;
  }
  if (line.startsWith('diff --git')) continue;
  if (line.startsWith('+') && !line.startsWith('+++')) changedLines.push(line.slice(1));
  else if (line.startsWith('-') && !line.startsWith('---')) changedLines.push(line.slice(1));
}

if (!changedLines.length) {
  console.log('[check-vars] src/ 下无改动（' + (opt.since ? `since ${opt.since}` : 'HEAD + working tree') + '）。跳过。');
  process.exit(0);
}

// ---------- Step 2: 解析 rules/important-variables.md ----------
const md = fs.readFileSync(MD_PATH, 'utf8');

const TIERS = ['Critical', 'Important-skeleton', 'Runtime-state', 'Risk-sensitive', 'Minor'];
const tierRe = /^## \d+\. (Critical|Important-skeleton|Runtime-state|Risk-sensitive|Minor)/gm;
const sections = [];
const marks = [];
let m;
while ((m = tierRe.exec(md))) marks.push({ tier: m[1], start: m.index });
for (let i = 0; i < marks.length; i++) {
  const end = marks[i + 1] ? marks[i + 1].start : md.length;
  sections.push({ tier: marks[i].tier, body: md.slice(marks[i].start, end) });
}

// 仅从"条目入口"位置抽变量名，避免散文里提到的名字变成假阳性。
// 认可的入口：
//   ### `name`             → 三级标题
//   - `name` — ...         → 列表项以反引号名开头
//   - `name` / `name2` ... → 列表项多个变量名用 / 分隔（写 4-way 映射这类簇）
function extractNames(body) {
  const noBlocks = body.replace(/```[\s\S]*?```/g, '');
  const names = new Set();
  const lines = noBlocks.split('\n');
  for (const raw of lines) {
    const line = raw.trimStart();
    let m;
    // 三级标题
    m = line.match(/^###\s+`([A-Za-z_$][\w$]*)`/);
    if (m && m[1].length >= 2) { names.add(m[1]); continue; }
    // 列表项：只认"开头连续的反引号变量名"（可用 / 或 , 分隔）
    // 命中：`foo`, `foo` / `bar` —— 定义: ...
    // 不命中：模板 JSON bundle 的 `bundleVersion` ...（反引号不在开头）
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const prefix = line.slice(2).trimStart();
      if (!prefix.startsWith('`')) continue;
      let idx = 0;
      const re = /`([A-Za-z_$][\w$]*)`/g;
      let mm;
      while ((mm = re.exec(prefix))) {
        const gap = prefix.slice(idx, mm.index);
        if (idx === 0 ? gap !== '' : !/^\s*[\/,]\s*$/.test(gap)) break;
        if (mm[1].length >= 2) names.add(mm[1]);
        idx = mm.index + mm[0].length;
      }
    }
  }
  return names;
}

const tierNames = new Map();
for (const s of sections) tierNames.set(s.tier, extractNames(s.body));

// ---------- Step 3: 命中扫描 ----------
const diffText = changedLines.join('\n');
const hits = new Map();
for (const tier of TIERS) hits.set(tier, new Set());
for (const tier of TIERS) {
  for (const name of tierNames.get(tier) || []) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(diffText)) hits.get(tier).add(name);
  }
}

// ---------- Step 4: 输出 ----------
const mandatory = ['Critical', 'Important-skeleton', 'Runtime-state', 'Risk-sensitive'];
let mandatoryTotal = 0;
for (const t of mandatory) mandatoryTotal += hits.get(t).size;
const minorTotal = hits.get('Minor').size;

console.log('='.repeat(60));
console.log(`[check-vars] 改动文件 ${changedFiles.size} 个：`);
for (const f of [...changedFiles].sort()) console.log('  - ' + f);
console.log('='.repeat(60));
console.log();

if (!mandatoryTotal && !minorTotal) {
  console.log('✅ 未命中任何重要变量，可按正常流程提交。');
  process.exit(0);
}

for (const tier of TIERS) {
  const set = hits.get(tier);
  if (!set.size) continue;
  if (tier === 'Minor' && !opt.includeMinor) continue;
  const icon = tier === 'Minor' ? 'ℹ️ ' : '⚠️ ';
  console.log(`${icon}${tier} — ${set.size} 个命中`);
  for (const n of [...set].sort()) console.log(`   - \`${n}\``);
  console.log();
}

if (!opt.includeMinor && minorTotal) {
  console.log(`ℹ️  Minor 层知会：命中 ${minorTotal} 个（加 --include-minor 查看）`);
  console.log();
}

console.log('---');
console.log('下一步：');
console.log('  1. 对照 rules/important-variables.md 里对应条目的"变更 review 要点"逐项自查');
console.log('  2. PR body 追加「⚠️ 关联功能 review」段落，列出上述命中与自查结论');
console.log('  3. Critical / Risk-sensitive 命中时，必须跑 npm run smoke');

if (mandatoryTotal) process.exitCode = 2; // 命中强制层级时用 exit 2，便于 CI 区分
