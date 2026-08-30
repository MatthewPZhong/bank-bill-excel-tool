'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../../..');
const CHANGE_ROOT = path.join(ROOT, 'changes', '3.2.5');
const FROZEN_ROOT = path.join(
  ROOT,
  'changes',
  'background-execution-v3.2.x-contract-baseline',
  'changes',
  '3.2.5'
);

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function replaceExactlyOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, `${label} 的冻结锚点必须精确出现一次`);
  return source.replace(before, after);
}

test('v3.2.5 顶层合同只允许已记录的 E13-B/E13-C/E13-D/E13-E/E13-F 证据型修订', () => {
  const frozenHashes = new Map([
    ['spec.md', '13410e4e5cf64798255cab30dd2487d4da4323eddf59d44cf2a0653e950898f2'],
    ['techdoc.md', '3fb1845979823f2c39a8e26d9d5adc5d7f3e351fda90d2f4086d6c355d17e64f']
  ]);
  const currentHashes = new Map([
    ['spec.md', 'd5b58458c0a2316f742b8ba6c23552004c7b1094a587731714ca469ac343b6a2'],
    ['techdoc.md', '5ee46941f93a2548fbb1b4d8e444deb9ba97417f8651f9062ee1e453c31aa7a2']
  ]);
  const amendments = new Map([
    ['spec.md', (frozen) => {
      const policyAmended = replaceExactlyOnce(
        frozen,
        '| `position:export-run` | `legacy-preserved` | `managed` | `thread-single` | `job` | `existing-dispatch` | `main-settlement` | `false` | 具体 adapterKey 在 inventory 固化 |',
        '| `position:export-run` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 模块专用只读 Worker；不得复用 position import dispatcher |',
        'spec.md Position export policy'
      );
      const nonGoalAmended = replaceExactlyOnce(
        policyAmended,
        '-不把Position改成worker thread；',
        '-不把 Position 现有 import utility-process/child_process dispatcher 改成 worker thread；只读 export 按 3.1 的 native thread-single action 执行；',
        'spec.md Position import non-goal'
      );
      const importAdapterAmended = replaceExactlyOnce(
        nonGoalAmended,
        '-把Position改为thread；',
        '-把 Position 现有 import utility-process/child_process dispatcher 改为 thread；',
        'spec.md Position import adapter prohibition'
      );
      const pendingAdapterAmended = replaceExactlyOnce(
        importAdapterAmended,
        '| `pending:import` | `managed` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `true` | 现有 big-table engine；不额外 spawn |',
        '| `pending:import` | `managed` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | 现有 big-table engine；不额外 spawn；人工资金/恢复门禁前保持 legacy |',
        'spec.md Pending adapter production gate'
      );
      const bizOpAdapterAmended = replaceExactlyOnce(
        pendingAdapterAmended,
        '| `biz-op:import-flow` | `managed` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `true` | 现有 ordered writer |',
        '| `biz-op:import-flow` | `managed` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | 现有 ordered writer；人工资金/恢复门禁前保持 legacy |',
        'spec.md BizOP adapter production gate'
      );
      const adapterIdentityAmended = replaceExactlyOnce(
        bizOpAdapterAmended,
        '-调用既有receipt/inspector并映射Lifecycle。',
        '-调用既有receipt/inspector并映射Lifecycle。\n' +
          '- 对 `file-batch` action，以已校验的 Protocol envelope exact-7 `context` 作为唯一 Main-owned\n' +
          '  任务身份；既有 dispatcher 所需的 `input.batchContext` 必须由 adapter 绑定为同一身份，caller\n' +
          '  若同时提供则必须逐字段一致，不一致时在启动既有 dispatcher 前 fail closed。',
        'spec.md mature adapter batch identity authority'
      );
      const classificationAmended = replaceExactlyOnce(
        adapterIdentityAmended,
        '-两个action应使用不同actionKey，避免运行时猜测策略。',
        '-两个action应使用不同actionKey，避免运行时猜测策略。\n\n' +
          'Current-tree 分类结论：\n\n' +
          '- 现有 `acquiringBillCurrency:export` 只读取 `diff_file_path` 并复制既有稳定文件，唯一绑定\n' +
          '  `acquiring:copy-existing-diff`；\n' +
          '- `acquiring:export-diff-workbook` 对应 `acquiring-bill-currency-writer.writeDiffWorkbook()` 的\n' +
          '  read-only regenerate capability。当前树没有单独 IPC/button，因此该 action 保持无 legacy TaskPolicy\n' +
          '  绑定、`production.enabled=false`，不得为了凑 coverage 复用 copy handler 或新增隐式用户入口；\n' +
          '- 后续若新增 regenerate 用户入口，必须在独立 change 中显式绑定该 action，并重新完成 run freshness、\n' +
          '  Publisher、Windows 与人工资金/恢复复核。',
        'spec.md Acquiring current-tree classification'
      );
      const importTopologyAmended = replaceExactlyOnce(
        classificationAmended,
        '| `acquiring:import` | `legacy-preserved` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | adapterKey 固化现有 import pool |',
        '| `acquiring:import` | `legacy-preserved` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | adapterKey 固化现有 import root + Parser Pool；childrenMax=4 |',
        'spec.md Acquiring import topology'
      );
      const runNewTopologyAmended = replaceExactlyOnce(
        importTopologyAmended,
        '| `acquiring:run-new-eligible` | `legacy-preserved` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | 仅符合既有 multiworker gate 的全新 run；adapterKey 固定 |',
        '| `acquiring:run-new-eligible` | `legacy-preserved` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | 仅符合既有 multiworker gate 的全新 run；current workerCount 上限=8 |',
        'spec.md Acquiring multiworker topology'
      );
      const runSingleTopologyAmended = replaceExactlyOnce(
        runNewTopologyAmended,
        '| `acquiring:run-single-or-resume` | `legacy-preserved` | `managed` | `thread-single` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | small / resume / forced-single；不得在运行中切换 |',
        '| `acquiring:run-single-or-resume` | `legacy-preserved` | `managed` | `thread-single` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | small / resume / forced-single；只有 root Worker、`compound=null`，不得在运行中切换 |',
        'spec.md Acquiring single/resume topology'
      );
      const positionTopologyAmended = replaceExactlyOnce(
        runSingleTopologyAmended,
        '| `position:import` | `legacy-preserved` | `managed` | `utility-process` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | 保留 prepare/grant/apply/recovery |',
        '| `position:import` | `legacy-preserved` | `managed` | `utility-process` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | 保留 prepare/grant/apply/recovery；root phase + 最多 1 个 schema child |',
        'spec.md Position import topology'
      );
      const resourceAuthorityAmended = replaceExactlyOnce(
        positionTopologyAmended,
        '`adapterKey`、`entryKey`、`inspectorKey` 等必须在机器可读 Registry fixture 中给出，不能写“native 或 existing-dispatch”“模块现有映射”“job/service”等非 canonical 值。',
        '`adapterKey`、`entryKey`、`inspectorKey` 等必须在机器可读 Registry fixture 中给出，不能写“native 或 existing-dispatch”“模块现有映射”“job/service”等非 canonical 值。\n\n' +
          'Acquiring current-tree topology 以真实 dispatcher 为权威：import 的 root Worker 由 phase 计费，最多\n' +
          '4 个 Parser child 由 CompoundLease 计费；`run-new-eligible` 的 root pool Worker 由 phase 计费，\n' +
          '合法 nested child 上限必须覆盖设置与 Main CPU/内存闸允许的 8；`run-single-or-resume` 不创建\n' +
          'nested child，不得用一个虚构 child 重复计费。冻结历史 fixture 保持不变，E13-G 必须按 current\n' +
          'authority 重建最终 Registry/策略快照。\n\n' +
          'Position current-tree topology 同样以真实 dispatcher 为权威：bank prepare、bank/account confirmed\n' +
          'apply 均只在任一时刻运行 1 个 root utility process；source prepare-and-apply 的 root 在等待 Main\n' +
          'durable grant 时，authorizer 最多并发 1 个 schema-migration utility process。因此\n' +
          '`position:import` 的 `childrenMax=1`，各 intent 的 `effectiveChildCount` 只能为 `0/1`，不得沿用\n' +
          '冻结历史 fixture 的 4。Protocol exact-5 operation context 与既有 File Task exact-7 batch owner\n' +
          '共享的五个 identity 字段必须一致，mutation operation token 必须等于 `taskRunId`。',
        'spec.md Acquiring resource authority'
      );
      return replaceExactlyOnce(
        resourceAuthorityAmended,
        '- 对 `file-batch` action，以已校验的 Protocol envelope exact-7 `context` 作为唯一 Main-owned\n' +
          '  任务身份；既有 dispatcher 所需的 `input.batchContext` 必须由 adapter 绑定为同一身份，caller\n' +
          '  若同时提供则必须逐字段一致，不一致时在启动既有 dispatcher 前 fail closed。',
        '- 对 `file-batch` action，以已校验的 Protocol envelope exact-7 `context` 作为唯一 Main-owned\n' +
          '  任务身份；既有 dispatcher 所需的 `input.batchContext` 必须由 adapter 绑定为同一身份，caller\n' +
          '  若同时提供则必须逐字段一致，不一致时在启动既有 dispatcher 前 fail closed。\n' +
          '- 对 Acquiring run 的 exact-5 `operation` action，既有 worker 仍需要 File Task exact-7\n' +
          '  `input.batchContext` 保存 chunk/recovery owner；adapter 必须逐字段核对两者共有的\n' +
          '  `taskRunId/taskKey/moduleId/parentRunId/operationKey`，并拒绝任何身份分叉。`batchId/batchNumber`\n' +
          '  继续来自 Main-owned File Task，不得由 adapter 推测或生成。\n' +
          '- Acquiring resume 的 caller 只允许提交正整数 `resumeRunId`；adapter 必须从 Main-owned\n' +
          '  `userDataDir/mainDatabasePath/mainDb` 重新执行 `prepareRunResume()` 与 freshness 复核，拒绝嵌套\n' +
          '  `resumePlan/dbPath` authority。持久 exact-7 owner 与当前 File Task、持久 output intent 与当前\n' +
          '  FilePlan 必须完全一致；持久 `chunkSize` 优先于当前设置，避免 chunk offset 漂移。\n' +
          '- Position bank prepare 只接受绝对输入路径；confirmed apply 只接受 Main-owned prepared selector\n' +
          '  与 exact-7 batch owner。selector 必须解析为完整 preflight manifest，bank/account kind、当前\n' +
          '  checkpoint 与 operation token 必须在启动 schema/apply 前 fail closed。\n' +
          '- Position source durable grant 必须匹配 preflight manifest、schema fingerprint、base checkpoint\n' +
          '  与 exact-7 owner；adapter 只向既有 dispatcher 返回这组 allowlist 字段，不能透传 provider 的\n' +
          '  额外数据。取消在等待 grant 或 schema protected 阶段发生时必须保留为 job-level 请求，并在下一\n' +
          '  安全点停止；`accepted=false` 本身不得伪装成 cancelled。\n' +
          '- E13-F 合并时默认 IPC、FilePlan staging、pending/receipt 与人工确认编排仍走 legacy TaskPolicy。\n' +
          '  capability 注册不等于生产切路；未完成 Windows、真实样本、资金/恢复人工复核与 route authority\n' +
          '  注入前，Effective Production Strategy 必须保持 `legacy/PENDING_HUMAN_REVIEW`。',
        'spec.md Acquiring exact owner and resume authority'
      );
    }],
    ['techdoc.md', (frozen) => {
      const executorAmended = replaceExactlyOnce(
        frozen,
        '每个模块目录有自己的query、writer、business-validator和worker entry；公共目录不包含业务SQL或Workbook规则。',
        '每个模块目录有自己的query、writer、business-validator和worker entry；公共目录不包含业务SQL或Workbook规则。\n\n' +
          '`position:export-run` 属于本节的模块专用 native read-only executor。仓库中没有可复用的 Position export dispatcher；第 5 节 Position utility-process adapter 仅适用于 `position:import`（E13-F），不得把 import dispatcher、虚构的 compound topology 或外层套 Worker 代替真实 export 拓扑。',
        'techdoc.md Position executor'
      );
      const sourceAuthorityAmended = replaceExactlyOnce(
        executorAmended,
        '- runId/datasetId/revision；',
        '- runId/datasetId/revision；\n' +
          '-参与 Workbook 语义的模板或受管归档文件 SHA-256/byteSize authority；Main 与 Worker 均须复核，不能只冻结路径；',
        'techdoc.md template/archive evidence'
      );
      const adapterIdentityAmended = replaceExactlyOnce(
        sourceAuthorityAmended,
        '- root engine Worker + N parser children；\n-保留fileIndex reducer/单Writer/大事务；',
        '- root engine Worker + N parser children；\n' +
          '-保留fileIndex reducer/单Writer/大事务；\n' +
          '- Protocol envelope exact-7 `context` 是任务身份 authority；adapter 将同一 context 绑定给既有\n' +
          '  engine 的 `input.batchContext`，拒绝 caller-supplied 身份分叉；',
        'techdoc.md big-table batch identity authority'
      );
      const classificationAmended = replaceExactlyOnce(
        adapterIdentityAmended,
        '→ Publisher\n```\n\n## 5. Existing dispatcher adapter interface',
        '→ Publisher\n```\n\n' +
          'Current-tree authority：`acquiringBillCurrency:export` 的 source 是已发布 `diff_file_path`，只走\n' +
          'copy executor；它不能在文件缺失时静默转为 regenerate。Regenerate executor 作为独立、\n' +
          'production-disabled capability 注册，输入必须显式携带 stable completed run DB authority；当前没有\n' +
          '独立 IPC/button，故不与任何 legacy TaskPolicy 绑定。`partial`、`in-progress`、`data-complete`、\n' +
          'progress 缺失/破坏或 source 漂移全部 fail closed。\n\n' +
          '## 5. Existing dispatcher adapter interface',
        'techdoc.md Acquiring current-tree authority'
      );
      const acquiringAdapterAmended = replaceExactlyOnce(
        classificationAmended,
        '### Acquiring\n\n' +
          '- import pool、runCheck pool、eligible multiworker、single/resume不变；\n' +
          '- adapter读取现有workerCount/chunk/temp预算；',
        '### Acquiring\n\n' +
          '- import pool、runCheck pool、eligible multiworker、single/resume不变；\n' +
          '- import root + Parser children 复用既有 big-table handle，childrenMax=4；\n' +
          '- adapter读取现有workerCount/chunk/temp预算；`run-new-eligible` 只在既有 D31 gate 通过时\n' +
          '  申领 nested children，current childrenMax=8（与设置 1～8 及 Main CPU/内存 clamp 一致）；\n' +
          '- `run-single-or-resume` 只有长驻 pool root Worker，`resources.compound=null`，resume 永不转为 multiworker；\n' +
          '- run policy 的 envelope 是 exact-5 operation context；传给旧 pool 的 exact-7 batchContext\n' +
          '  必须由 Main File Task 提供，且共有五个 identity 字段逐项一致，adapter 不生成 batchId/batchNumber；\n' +
          '- resume input 只携带 `resumeRunId` selector；adapter 以 Main-owned DB 路径/句柄重新准备当前\n' +
          '  resume plan，并在 dispatch 前复核 persisted exact-7 owner、output intent 与 freshness；caller\n' +
          '  提供的 `resumePlan/dbPath` 一律拒绝，chunkSize 继续采用持久 progress 值优先规则；\n' +
          '- 普通 job close 不 shutdown 长驻 pool，只有强制 transport terminate 或 App 既有 before-quit owner\n' +
          '  才关闭；side-DB main mirror 继续由 `runCheckViaSideDb`/`resumeRunCheck` 完成；',
        'techdoc.md Acquiring adapter topology and authority'
      );
      return replaceExactlyOnce(
        acquiringAdapterAmended,
        '### Position\n\n' +
          '- mode=`utility-process`；\n' +
          '- adapter映射现有prepare/apply/grant/critical/commit/cancel；\n' +
          '- utilityProcess不可用时的child_process fallback仍由原dispatcher决定；\n' +
          '- protected committing不映射cancelled；\n' +
          '- journal/ledger是`existing-critical-protocol`证据。',
        '### Position\n\n' +
          '- mode=`utility-process`；\n' +
          '- adapter 映射现有 prepare/apply/grant/critical/commit/cancel，不在外层再 spawn process；\n' +
          '- utilityProcess不可用时的child_process fallback仍由原dispatcher决定；\n' +
          '- bank prepare 与 bank/account confirmed apply 任一时刻只有 root process；source root 等待 durable\n' +
          '  grant 时，Main authorizer 最多并发一个 schema-migration process，因此\n' +
          '  `childrenMax=1`、intent 级 `effectiveChildCount=0/1`；\n' +
          '- Protocol exact-5 operation context 与 File Task exact-7 batch context 的共有五字段逐项一致；\n' +
          '  mutation operation token 必须精确等于 `taskRunId`，caller 不能覆盖 userData/side DB/checkpoint；\n' +
          '- confirmed selector 由 Main 解析并在 mutation 前验证完整 preflight manifest 与 bank/account kind；\n' +
          '  source grant 只允许 operation token、manifest hash、schema fingerprint、base checkpoint、batch owner\n' +
          '  六项字段，provider 的额外字段不跨 grant boundary；\n' +
          '- raw dispatcher 的 `cancel()` true 只表示消息已投递；adapter 等待真实 CANCEL_ACK 或可识别的\n' +
          '  `position-import-cancelled` terminal。protected committing 的 `accepted=false` 不映射 cancelled，\n' +
          '  但 job-level cancel 在 schema 完成后的下一安全点仍阻止 apply；等待 authorizer 时已接受取消则\n' +
          '  禁止继续发 grant；\n' +
          '- checkpoint/manifest/result 投影采用 compact allowlist；非法、互相冲突或缺失的提交证据 fail closed，\n' +
          '  不得降级为 preflight success；\n' +
          '- journal/ledger 是 `existing-critical-protocol` 证据。E13-F 不替换默认 IPC/FilePlan/pending 编排，\n' +
          '  实际 route authority、Windows 与资金/恢复人工门禁完成前 production snapshot 保持 legacy。',
        'techdoc.md Position adapter topology and authority'
      );
    }]
  ]);

  for (const [fileName, frozenHash] of frozenHashes) {
    const topLevel = fs.readFileSync(path.join(CHANGE_ROOT, fileName), 'utf8');
    const frozen = fs.readFileSync(path.join(FROZEN_ROOT, fileName));
    assert.equal(sha256(frozen), frozenHash, `${fileName} 冻结来源 SHA-256 漂移`);
    assert.equal(
      topLevel,
      amendments.get(fileName)(frozen.toString('utf8')),
      `${fileName} 存在未记录的合同漂移`
    );
    assert.equal(
      sha256(Buffer.from(topLevel)),
      currentHashes.get(fileName),
      `${fileName} 当前 authority SHA-256 漂移`
    );
  }
});

test('v3.2.5 实施序列保持 E13-A 到 R3.2.5 的严格顺序', () => {
  const sequence = read('changes/3.2.5/implementation-sequence.md').toString('utf8');
  const labels = ['E13-A', 'E13-B', 'E13-C', 'E13-D', 'E13-E', 'E13-F', 'E13-G', 'R3.2.5'];
  let cursor = -1;
  for (const label of labels) {
    const next = sequence.indexOf(`| ${label} |`, cursor + 1);
    assert.ok(next > cursor, `${label} 必须且只能在前序节点之后出现`);
    cursor = next;
  }
  assert.match(sequence, /不新增独立功能 PR/);
  assert.match(sequence, /不运行 `release-check`、`check-vars` 或 `scan:vars`/);
});

test('v3.2.5 preflight 不得用历史绿灯代偿当前 binding authority 漂移', () => {
  const evidence = JSON.parse(
    read('changes/3.2.5/preflight-baseline-validation.json').toString('utf8')
  );
  assert.equal(evidence.publishedValidationReport.status, 'PASS');
  assert.equal(evidence.publishedValidationReport.classification, 'historical-only');
  assert.equal(evidence.packageChecksum.status, 'FAIL');
  assert.equal(evidence.packageChecksum.passedFileCount, 61);
  assert.equal(evidence.packageChecksum.failedFileCount, 8);
  assert.equal(evidence.currentTreeValidation.status, 'FAIL');
  assert.deepEqual(evidence.currentTreeValidation.failedChecks, [
    'canonical-action-legacy-task-binding'
  ]);
  assert.equal(evidence.currentTreeValidation.classification, 'E13-G-preflight-finding');
  assert.equal(evidence.resolutionOwner, 'E13-G');
  assert.equal(evidence.productionEnabled, false);
  assert.equal(evidence.humanReviewStatus, 'PENDING_HUMAN_REVIEW');
});
