'use strict';
// 生产内存策略下的升级预检探针：模拟 Windows x64 / Electron 身份、16 GB 总内存、5 GB 可用，
// 按 upgrade-main.js 的原参数（reject + timeoutMs:0）申请，比较空闲、存在一个未退出载体、载体退出后三种现场。
// 用法：node precheck-policy-probe.js（在仓库任意位置均可）
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const GiB = 1024 ** 3; const MiB = 1024 ** 2;
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.defineProperty(process, 'arch', { value: 'x64' });
Object.defineProperty(process, 'versions', { value: { ...process.versions, electron: '36.0.0' } });
os.freemem = () => 5 * GiB;

const SRC = path.resolve(__dirname, '../../../../../../src/main-process');
const { createPlatformResourceEnvelope } = require(path.join(SRC, 'background-execution/resource-budget'));
const { createResourceGovernor, closeResourceGovernor } = require(path.join(SRC, 'background-execution/resource-governor'));
const { createProductionMemoryPolicy } = require(path.join(SRC, 'execution-descriptors/memory-profiles'));
const activity = require(path.join(SRC, 'memory-activity'));
const { EXPORT_IO_RESOURCES } = require(path.join(SRC, 'biz-op-v327/export-publication'));

const env = createPlatformResourceEnvelope({ availableParallelism: 12, totalMemoryBytes: 16 * GiB, freeMemoryBytes: 5 * GiB });
const governor = createResourceGovernor({ budgets: env.hardBudgets,
  memoryAdmission: createProductionMemoryPolicy({ compatibilityMemoryBytes: env.compatibilityBudgets.memoryBytes, getGovernor: () => governor }) });
activity.registerMemoryGovernor(governor);
activity.sealMemoryActivityInventory();

async function precheck(label) {
  try {
    const lease = await governor.acquirePhaseLease({ ownerKey: 'biz-op-v327:precheck:probe', actionKey: 'biz-op-v327:upgrade-preflight',
      operationKey: 'biz-op-v327:precheck:probe', resources: EXPORT_IO_RESOURCES, lowMemoryBehavior: 'reject', timeoutMs: 0 });
    console.log(`${label} → GRANTED ${lease.resources.memoryBytes / MiB} MiB`);
    lease.release('probe complete');
  } catch (error) {
    const s = governor.snapshot();
    console.log(`${label} → REJECTED ${error.code}；原文案会显示：当前可用 ${s.available.memoryBytes / MiB} MiB（预算上限 ${s.budgets.memoryBytes / MiB} MiB）`);
  }
}

(async () => {
  await precheck('P1 冷启动空闲');
  const carrier = new EventEmitter();
  activity.observeMemoryCarrier(() => carrier);
  await precheck('P2 存在一个尚未 exit 的受观察载体');
  carrier.emit('exit', 0);
  await precheck('P3 该载体 exit 之后');
  closeResourceGovernor(governor, 'probe complete');
})();
