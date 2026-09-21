'use strict';

// 现有 CI 只负责提供事件身份；历史底线始终由 check-architecture 检查。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function selectPolicyBase({ eventName, refType, eventBase, head, expectedHead }) {
  if (!/^[a-f0-9]{40}$/.test(head) || head !== expectedHead) throw new Error('架构检查的 checkout SHA 与实际 HEAD 不一致');
  if (eventName === 'pull_request' || (eventName === 'push' && refType !== 'tag')) {
    if (!/^[a-f0-9]{40}$/.test(eventBase || '') || /^0+$/.test(eventBase)) throw new Error('PR base / push before 缺失或为零 SHA');
    return eventBase;
  }
  if (eventName === 'workflow_dispatch' || (eventName === 'push' && refType === 'tag')) return head;
  throw new Error(`未支持的架构门禁事件：${eventName}`);
}

function main(env = process.env, root = path.resolve(__dirname, '../..')) {
  const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const base = selectPolicyBase({ eventName: env.GITHUB_EVENT_NAME, refType: env.GITHUB_REF_TYPE,
    eventBase: env.ARCHITECTURE_EVENT_BASE, head, expectedHead: env.ARCHITECTURE_EXPECTED_HEAD });
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT 不存在');
  fs.appendFileSync(env.GITHUB_OUTPUT, `base=${base}\n`);
  return base;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
module.exports = { selectPolicyBase, main };
