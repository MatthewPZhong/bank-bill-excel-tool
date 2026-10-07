'use strict';
// 打印 trace.jsonl 中与升级预检相关的关键事件。用法：node summarize.js <trace.jsonl>
const fs = require('node:fs');

const file = process.argv[2];
if (!file) { console.error('用法：node summarize.js <trace.jsonl>'); process.exit(2); }
const KEEP = new Set(['hook-loaded', 'activation-run', 'activation-run-result', 'activation-run-error', 'governor-created',
  'PRECHECK-SNAPSHOT', 'PRECHECK-GRANTED', 'PRECHECK-REJECTED', 'carrier-created', 'carrier-exit', 'showErrorBox',
  'window-created', 'HARNESS-TIMEOUT-KILL']);
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
  const { t, ev, ...rest } = JSON.parse(line);
  if (!KEEP.has(ev)) continue;
  if (ev === 'PRECHECK-SNAPSHOT') {
    console.log(t, ev, JSON.stringify({ freeMemMiB: rest.freeMemMiB, liveCarriers: rest.liveCarriers.length,
      liveActivities: rest.liveActivities.length, blockers: rest.inventory && rest.inventory.blockers.length,
      inventoryComplete: rest.inventory && rest.inventory.inventoryComplete,
      activeLeases: rest.governor.activeLeases.length, queued: rest.governor.queued }));
    continue;
  }
  const { stack: _stack, ...compact } = rest;
  console.log(t, ev, JSON.stringify(compact).slice(0, 400));
}
