// v2.0.0-beta.4：隐藏 .usage-stats.txt 模块
//
// 路径：<storageRoot>/.usage-stats.txt（dot prefix → macOS 默认隐藏）
// 格式：key=value 简单文本 + [section] 块
// 颗粒度：用户视角"功能"（按 FUNCTION_REGISTRY 限制集合）
// 写盘：关闭时 flush + 每 5 分钟自动 flush（混合）
// 原子写入：tmp → rename
//
// stats 对象结构：
//   {
//     appOpenCount: number,
//     firstOpenedAt: string (ISO 本地时间) | null,
//     lastClosedAt: string | null,
//     sessionStartedAt: string | null,
//     modules: { [moduleKey: string]: { [functionKey: string]: number } }
//   }

const fs = require('node:fs');
const path = require('node:path');
// v2.1.9 SR-log-1 (T32h)：替换 console.warn → appendModuleLog 双写
const { appendModuleLog } = require('./logger');

const STATS_FILENAME = '.usage-stats.txt';
const STATS_TMP_FILENAME = '.usage-stats.txt.tmp';

// 用户视角"功能"清单（不在此清单的 increment 静默忽略，防御性）
const FUNCTION_REGISTRY = Object.freeze({
  '生成网银账单': ['导入模板', '导入文件', '导出明细', '导出余额', '模板管理', '账户映射'],
  '新开账户': ['生成余额账单', '导出余额'],
  '月度 Pending': ['规则管理', '导入文件', '开始运行', '导出差异'],
  '银行对账单处理': ['场景管理', '导入文件', '开始运行', '导出文件'],
  // v2.1.0-beta.1 PR-B：对账单 ReconID 修复模块（v2.1.5 修复 long-standing bug — 旧 key '单据对账ReconID修复' 与 main.js trackedIpcHandle 第二参不匹配，导致计数静默失败；同步与 N1 模块名加空格保持一致）
  '对账单 ReconID 修复': ['导入文件', '开始运行', '导出文件'],
  // v2.1.2 T2：月度银行对账单BU回填校验（PR #43 Codex F1 修复 — main.js trackedIpcHandle 已用此 moduleKey 但 registry 未注册导致计数静默失败）
  '月度银行对账单BU回填校验': ['导入文件', '开始运行', '导出差异'],
  // v2.1.3 T3：业务OP数据核对（PR #45 round 3 P2 修复 — 共 15 个 bizOpRecon:* IPC，5 个核心 action 接入 trackedIpcHandle，10 个 query/dialog/helper 保持 plain ipcMain.handle）
  // 仅核心成功路径计数（导入/运行/导出）；模块状态查询 / 文件选择对话框 / BU 列表等中间态不计
  '业务OP数据核对': ['导入文件', '开始运行', '导出差异'],
  // v2.1.6：收单单据币种校验（与 main.js trackedIpcHandle 第 3 参严格一致；listMonths / sessionStatus / clearMonth 走 plain ipcMain.handle 不计）
  '收单单据币种校验': ['导入流水表', '导入单据表', '开始运行', '导出差异'],
  // v3.1.0：平盘资金性质校验的持久化银行/链接数据、运行、结果回导和确认。
  '平盘对账数据处理': [
    '导入银行对账单', '导入链接原始表', '账户映射管理',
    '删除银行数据', '删除链接原始表',
    '导出银行数据', '导出链接对账表', '导出链接原始表',
    '开始运行', '导出文件', '导入修改结果', '确认结果'
  ],
  // v2.1.16 PR#61 F1：链接表管理（main.js trackedIpcHandle('linked-table:import', '链接表管理', '导入', ...)
  //   此前未注册 → incrementFunction 静默丢弃 → 链接表导入成功不计入 .usage-stats.txt。
  '链接表管理': ['导入'],
  // v3.1.8：VCC 财务OP校验成功动作；查询/preview 不计数，统一删除仅结果删除计“删除结果”。
  'VCC财务OP校验': [
    '导入文件', '开始运行', '初始化期初财务OP', '确认归档',
    '修改结果', '删除数据', '导出数据',
    '导出校验结果表', '导出导入审计', '解归档', '删除结果'
  ],
  '切换页面风格': ['切换']
});

function pad2(n) {
  return String(n).padStart(2, '0');
}

function nowIsoLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function defaultStats() {
  const modules = {};
  Object.entries(FUNCTION_REGISTRY).forEach(([moduleKey, fnKeys]) => {
    modules[moduleKey] = {};
    fnKeys.forEach((fnKey) => {
      modules[moduleKey][fnKey] = 0;
    });
  });
  return {
    appOpenCount: 0,
    firstOpenedAt: null,
    lastClosedAt: null,
    sessionStartedAt: null,
    modules
  };
}

// INI-lite 解析：
//   - 空行 / 不含 '=' 行（除 [section]）：跳过
//   - [section]：开新 section
//   - key=value：top 层（无 section）放 stats 顶层；section 内放 modules[section]
//   - "小计" / "总操作次数" 是输出时计算项，parse 时忽略
function parse(text) {
  const stats = defaultStats();
  if (!text || typeof text !== 'string') return stats;

  let currentSection = null;
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      // 保留 registry 内的 section；未注册 section 仍允许解析但不影响输出（向前兼容）
      if (!stats.modules[currentSection]) stats.modules[currentSection] = {};
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();

    if (currentSection === null) {
      // top 层
      if (key === 'appOpenCount') {
        const n = parseInt(value, 10);
        stats.appOpenCount = Number.isFinite(n) && n >= 0 ? n : 0;
      } else if (key === 'firstOpenedAt') {
        stats.firstOpenedAt = value || null;
      } else if (key === 'lastClosedAt') {
        stats.lastClosedAt = value || null;
      } else if (key === 'sessionStartedAt') {
        stats.sessionStartedAt = value || null;
      } else if (key === '总操作次数') {
        // 计算项，忽略
      }
    } else {
      // section 内
      if (key === '小计') continue; // 计算项
      const n = parseInt(value, 10);
      stats.modules[currentSection][key] = Number.isFinite(n) && n >= 0 ? n : 0;
    }
  }
  return stats;
}

function calcModuleSubtotal(moduleStats) {
  return Object.values(moduleStats || {}).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
}

function calcGrandTotal(stats) {
  return Object.values(stats.modules || {}).reduce((sum, m) => sum + calcModuleSubtotal(m), 0);
}

function serialize(stats) {
  const lines = [];
  lines.push(`appOpenCount=${stats.appOpenCount || 0}`);
  lines.push(`firstOpenedAt=${stats.firstOpenedAt || ''}`);
  lines.push(`lastClosedAt=${stats.lastClosedAt || ''}`);
  lines.push(`sessionStartedAt=${stats.sessionStartedAt || ''}`);
  lines.push('');

  // 按 FUNCTION_REGISTRY 顺序输出（确保 txt 模块顺序稳定）
  Object.entries(FUNCTION_REGISTRY).forEach(([moduleKey, fnKeys]) => {
    lines.push(`[${moduleKey}]`);
    const moduleStats = (stats.modules && stats.modules[moduleKey]) || {};
    fnKeys.forEach((fnKey) => {
      lines.push(`${fnKey}=${moduleStats[fnKey] || 0}`);
    });
    lines.push(`小计=${calcModuleSubtotal(moduleStats)}`);
    lines.push('');
  });

  lines.push(`总操作次数=${calcGrandTotal(stats)}`);
  return lines.join('\n') + '\n';
}

function loadStats(storageRoot) {
  const filePath = path.join(storageRoot, STATS_FILENAME);
  if (!fs.existsSync(filePath)) return defaultStats();
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return parse(text);
  } catch (err) {
    // 文件损坏 → 返回默认（不影响主流程）
    // v2.1.9 SR-log-1：替换 console.warn → 日志上报
    appendModuleLog({
      level: 'warning',
      source: 'main',
      domain: 'usage-stats',
      message: '[usage-stats] load failed, using default',
      details: [err && err.message ? err.message : String(err)],
      stack: err && err.stack ? err.stack : undefined
    });
    return defaultStats();
  }
}

// 原子写入：tmp → rename
// PR #34 Codex round 1 P2：失败时 throw（让调用方保留 dirty 状态，下次 tick 重试）
//   原实现 swallow 错误后仍清 dirty，导致磁盘满/权限错时 session 计数静默丢失
function saveStats(storageRoot, stats) {
  if (!fs.existsSync(storageRoot)) {
    fs.mkdirSync(storageRoot, { recursive: true });
  }
  const filePath = path.join(storageRoot, STATS_FILENAME);
  const tmpPath = path.join(storageRoot, STATS_TMP_FILENAME);
  const text = serialize(stats);
  try {
    fs.writeFileSync(tmpPath, text, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // 尽力清理 tmp 后向上抛——调用方决定是否 retry
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* ignore cleanup */ }
    throw err;
  }
}

// 计数：未注册 module/function 静默忽略（防御性，避免 IPC 拼写漂移污染）
function incrementFunction(stats, moduleKey, functionKey) {
  const allowed = FUNCTION_REGISTRY[moduleKey];
  if (!allowed || !allowed.includes(functionKey)) {
    // v2.1.9 SR-log-1：替换 console.warn → 日志上报
    appendModuleLog({
      level: 'warning',
      source: 'main',
      domain: 'usage-stats',
      message: '[usage-stats] unregistered function',
      details: [`moduleKey=${moduleKey}`, `functionKey=${functionKey}`]
    });
    return stats;
  }
  if (!stats.modules[moduleKey]) stats.modules[moduleKey] = {};
  const cur = stats.modules[moduleKey][functionKey] || 0;
  stats.modules[moduleKey][functionKey] = cur + 1;
  return stats;
}

function recordSessionStart(stats) {
  const now = nowIsoLocal();
  stats.appOpenCount = (stats.appOpenCount || 0) + 1;
  stats.sessionStartedAt = now;
  if (!stats.firstOpenedAt) stats.firstOpenedAt = now;
  return stats;
}

function recordSessionEnd(stats) {
  stats.lastClosedAt = nowIsoLocal();
  return stats;
}

module.exports = {
  STATS_FILENAME,
  STATS_TMP_FILENAME,
  FUNCTION_REGISTRY,
  defaultStats,
  parse,
  serialize,
  loadStats,
  saveStats,
  incrementFunction,
  recordSessionStart,
  recordSessionEnd,
  calcModuleSubtotal,
  calcGrandTotal,
  // 仅供测试用
  _nowIsoLocal: nowIsoLocal
};
