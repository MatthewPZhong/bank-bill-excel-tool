#!/usr/bin/env node
'use strict';

// 架构检查唯一命令入口。只读源码和 Git；仅显式 --json 写证据。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const FACT_BASELINE = '11086a3cbf632a30adbcfa796e4cd81810c5aef9';
const LIMITATIONS = [
  '静态依赖图不完整证明运行时 IPC、callback 注入、任意别名/反射、共享对象内部写入或数据库业务语义。',
  '动态加载仅覆盖静态可解析目标及准确登记的目标集；未解释位置必须诊断。',
  'Classic global 仅覆盖已登记工厂、支持的全局读取与脚本顺序；普通 DOM 和宿主之外的对象生命期须由行为测试证明。',
  'pending/partial 边界和 activationEvidence 文件存在不代表对应治理已通过行为、GUI 或平台验收。',
  '历史修复只核对 Git 身份、内容 hash、schema 和审查材料存在；最小语法修复的语义保持仍须人工 review。'
];

function inputError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function parseArguments(argv, env = process.env) {
  const options = { root: REPOSITORY_ROOT, against: env.ARCHITECTURE_BASE_REF || 'HEAD' };
  const used = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') { options.help = true; continue; }
    if (!['--root', '--against', '--json'].includes(key)) throw inputError(`未知参数：${key}`);
    if (used.has(key)) throw inputError(`参数重复：${key}`);
    used.add(key);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw inputError(`参数缺少值：${key}`);
    if (key === '--against') {
      if (value.startsWith('-') || /[\r\n\0]/.test(value)) throw inputError('对比提交格式无效');
      options.against = value;
    } else {
      if (!path.isAbsolute(value)) throw inputError(`${key} 必须使用绝对路径`);
      options[key.slice(2)] = path.resolve(value);
    }
  }
  options.explicitRoot = used.has('--root');
  return options;
}

function readConfiguration(root, relativePath) {
  let absolute = root;
  for (const segment of relativePath.split('/')) {
    absolute = path.join(absolute, segment);
    if (fs.lstatSync(absolute).isSymbolicLink()) throw inputError(`配置路径不能包含 symlink：${relativePath}`);
  }
  if (!fs.statSync(absolute).isFile()) throw inputError(`配置必须是普通文件：${relativePath}`);
  try { return JSON.parse(fs.readFileSync(absolute, 'utf8')); }
  catch (error) { throw inputError(`当前配置无法读取：${relativePath}：${error.message}`); }
}

function check(options, env = process.env) {
  const { scan } = require('./architecture/scan');
  const { evaluateRules } = require('./architecture/rules');
  const { validateBoundaries, validateAllowlist, validateBootstrapComplete } = require('./architecture/schema');
  const { checkPolicyHistory } = require('./architecture/policy-history');
  const root = fs.realpathSync(options.root);
  const config = readConfiguration(root, 'architecture/boundaries.json');
  const allowlist = readConfiguration(root, 'architecture/legacy-allowlist.json');
  validateBoundaries(config);
  validateBootstrapComplete(config);
  validateAllowlist(allowlist);
  let hasProjectBaseline = false;
  try {
    execFileSync('git', ['cat-file', '-e', `${FACT_BASELINE}^{commit}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    hasProjectBaseline = true;
  } catch { /* 临时真实 Git fixture 有自己的根提交；后续仍核验其完整历史。 */ }
  if ((!options.explicitRoot || root === fs.realpathSync(REPOSITORY_ROOT) || hasProjectBaseline) && config.factBaseline !== FACT_BASELINE) {
    throw inputError('普通检查不能替换固定 v3.2.9 事实基线；--root 不解除项目仓库的固定基线约束');
  }
  if (env.ARCHITECTURE_EXPECTED_HEAD) {
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (head !== env.ARCHITECTURE_EXPECTED_HEAD) throw inputError('CI checkout SHA 与实际 HEAD 不一致');
  }
  const history = checkPolicyHistory({ root, config, allowlist, against: options.against });
  const scanned = scan(root, config);
  const result = evaluateRules(scanned, config, allowlist, { root });
  const violations = [...(history.violations || []), ...(result.violations || [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  const report = {
    schemaVersion: 1,
    factBaseline: config.factBaseline,
    policyComparedWith: history.policyComparedWith,
    policyHistory: history.policyHistory,
    coverage: {
      ...(scanned.coverage || {}),
      pendingBoundaries: result.pendingBoundaries || [],
      partialBoundaries: result.partialBoundaries || []
    },
    violations,
    matchedExceptions: result.matchedExceptions || [],
    staleExceptions: result.staleExceptions || [],
    activeBoundaries: result.activeBoundaries || [],
    limitations: LIMITATIONS
  };
  const parseFailure = (scanned.parseErrors || []).length > 0;
  return { report, exitCode: parseFailure ? 2 : violations.length ? 1 : 0 };
}

function formatSummary(report, exitCode) {
  if (report.inputError) return `架构检查输入错误：${report.inputError}`;
  const c = report.coverage;
  const count = (value) => Array.isArray(value) ? value.length : value ?? 0;
  const lines = [
    `架构检查：${exitCode === 0 ? '通过' : '失败'}；解析 ${c.parsedFiles ?? '?'}/${c.scannedFiles ?? '?'} 文件；字面量本地边 ${c.literalEdges ?? '?'}；worker 边 ${c.workerEdges ?? 0}；global 边 ${c.globalEdges ?? 0}。`,
    `覆盖：未解析 ${count(c.unresolved)}；动态位置 ${count(c.dynamicSites)}；active ${report.activeBoundaries.length}；pending ${count(c.pendingBoundaries)}；partial ${count(c.partialBoundaries)}。`,
    `历史：对比 ${report.policyComparedWith}；检查 ${report.policyHistory?.commitsExamined ?? '?'} 个提交；修复绑定 ${report.policyHistory?.historyRepairsApplied?.length ?? 0}。`
  ];
  for (const repair of report.policyHistory?.historyRepairsApplied || []) {
    lines.push(`历史重建：${repair.path} blob=${repair.originalBlob} sha256=${repair.repairedSha256}；审查依据：${repair.reviewEvidence}；来源提交：${repair.sourceCommits.join('、')}`);
  }
  for (const diagnostic of report.policyHistory?.diagnostics || []) {
    lines.push(`历史诊断：${diagnostic.commit}/${diagnostic.path}：${diagnostic.message}`);
  }
  for (const item of report.violations) {
    const location = [item.from || item.path, item.line, item.column].filter(value => value !== undefined && value !== '').join(':');
    lines.push(`[${item.rule}] ${location} ${item.message || item.reason || ''}${item.to ? ` → ${item.to}` : ''}`);
    if (item.dependencyPath?.length) lines.push(`  依赖路径：${item.dependencyPath.join(' → ')}`);
  }
  for (const item of report.staleExceptions) lines.push(`过期例外：${typeof item === 'string' ? item : item.id}；请在对应迁移变更中移除。`);
  if (c.pendingBoundaries?.length) lines.push(`待激活：${c.pendingBoundaries.map(x => typeof x === 'string' ? x : x.id).join('、')}`);
  if (c.partialBoundaries?.length) lines.push(`部分入口存在：${c.partialBoundaries.map(x => typeof x === 'string' ? x : x.id).join('、')}`);
  lines.push('静态覆盖边界：扫描通过不代表 IPC、回调、共享状态、业务恢复或 GUI 验收完成；详见 architecture/README.md。');
  return lines.join('\n');
}

function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  let outcome;
  try {
    options = parseArguments(argv, env);
    if (options.help) {
      console.log('用法：node scripts/check-architecture.js [--against <commit>] [--json <绝对报告路径>] [--root <绝对 fixture 路径>]');
      return 0;
    }
    outcome = check(options, env);
  } catch (error) {
    outcome = { exitCode: 2, report: { schemaVersion: 1, inputError: error.message } };
  }
  if (options?.json) {
    try {
      const parent = path.dirname(options.json);
      if (!fs.statSync(parent).isDirectory()) throw new Error('报告目录不存在');
      fs.writeFileSync(options.json, `${JSON.stringify(outcome.report, null, 2)}\n`, { encoding: 'utf8' });
    } catch (error) {
      console.error(`架构检查报告写入失败：${error.message}`);
      return 2;
    }
  }
  console.log(formatSummary(outcome.report, outcome.exitCode));
  return outcome.exitCode;
}

if (require.main === module) process.exitCode = main();
module.exports = { check, main, parseArguments, formatSummary, FACT_BASELINE, LIMITATIONS };
