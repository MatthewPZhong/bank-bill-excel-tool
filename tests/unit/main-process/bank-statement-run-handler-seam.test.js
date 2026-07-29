// v3.0.8 需求3 + 需求6（🔴 资金红线）：bank-statement:run handler「接缝」源码护栏。
//
// 为什么是源码 grep 而非 require 驱动：
//   main.js 顶层 `require('electron')` + 海量 register 副作用 + 模块私有状态（bankStatementSession 是
//   模块级 let，外部不可设），无法在 node:test 里 require 并驱动到「已导入」分支跑 handler 体。
//   而 v3.0.8 把三处关键改动都放进了这个**无法被单测 require 的 handler 体**：
//     ① 需求3 进度转发器（内联）—— 正是「createBankStatementRunProgressForwarder is not defined」事故现场；
//     ② 需求6 修复1 bank-deposit 门控谓词（资金红线，须与编排器 r5s4 分桶条件逐字同源）；
//     ③ 需求6 修复2 gateway 按 Channel 过滤读（资金红线，删全量读 + 深拷）。
//   release-check 全绿却漏了 ① 的 not-defined（单测/集成只跑 runReconciliation 核心、从不触发 handler 体；
//   smoke 无数据走不到 `if(!bankStatementSession)` 之后的已导入分支）。本测试用源码断言把这三处钉死，
//   是逐文件 review 看不见的「接缝 + 升级路径」盲区的自动化补强（参见 memory feedback_multiagent_seam_gap）。
//
// 形态沿用仓库既有范式 renderer-status-box-text.test.js：读源文件文本 + 断言关键子串，不引 DOM / 不模拟 Electron。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', '..', '..', 'src');
// 🔴 main.js 含 NUL 字节（见 memory reference_mainjs_nul_grep）——读后剥除 \u0000，避免 NUL 落在子串中段导致 includes 漏配。
const mainSrc = fs.readFileSync(path.join(SRC_DIR, 'main.js'), 'utf8')
  .replace(/\r\n?/g, '\n')
  .replace(/\u0000/g, '');
const orchSrc = fs
  .readFileSync(path.join(SRC_DIR, 'main-process', 'reconciliation-orchestrator.js'), 'utf8')
  .replace(/\r\n?/g, '\n')
  .replace(/\u0000/g, '');

describe('需求3：bank-statement:run handler 进度转发器内联（not-defined 事故回归）', () => {
  test('handler 改 async 并取 event（进度转发需要 event.sender）', () => {
    assert.ok(
      mainSrc.includes("trackedIpcHandle('bank-statement:run', '银行对账单处理', '开始运行', async (event) =>"),
      'bank-statement:run handler 必须是 async (event) =>（需求3 异步化 + 取 event 供进度转发）'
    );
  });

  test('🔴 回归钉死：进度转发器内联在 handler 体内（不引用任何外部作用域的工厂函数）', () => {
    // 事故根因：dev 把 forwarder 定义在收单模块 register 作用域，handler 跨作用域引用 → 运行时 not defined。
    assert.ok(
      mainSrc.includes("const onProgress = (!event || !event.sender) ? null : (ev) =>"),
      'handler 体内必须内联定义 onProgress（不得引用别的 register 作用域里的 forwarder 工厂）'
    );
    assert.ok(
      mainSrc.includes("event.sender.send('bank-statement:run:progress', { ...ev, phase: 'run' });"),
      '内联 forwarder 必须把事件发到 bank-statement:run:progress 通道并打上 phase:run'
    );
  });

  test('🔴 回归钉死：孤儿工厂名 createBankStatementRunProgressForwarder 在 main.js 已彻底消失', () => {
    assert.ok(
      !mainSrc.includes('createBankStatementRunProgressForwarder'),
      'createBankStatementRunProgressForwarder 不得再出现于 main.js（曾误置于收单 register 作用域、跨作用域不可达，已内联替换）'
    );
  });

  test('handler 把内联 onProgress 注入 runReconciliation（否则轮次进度事件永不触发）', () => {
    assert.ok(mainSrc.includes('const result = await runReconciliation({'), 'handler 必须 await runReconciliation({…})');
    // 注入点：runReconciliation 入参最后一项是 onProgress（行尾 `onProgress` 紧跟 `});`）。
    assert.ok(
      mainSrc.includes('onProgress\n      });'),
      'runReconciliation 调用必须把 handler 的内联 onProgress 作为入参传入（轮次边界进度依赖它）'
    );
  });
});

describe('需求6 修复1（🔴 资金红线）：bank-deposit 门控谓词 + 与编排器 r5s4 逐字同源', () => {
  test('handler 定义 refundBackfillEnabled 谓词，三个条件子句齐全', () => {
    assert.ok(
      mainSrc.includes('const refundBackfillEnabled = dispatchScenarios.some('),
      'handler 必须有 refundBackfillEnabled 门控谓词'
    );
    assert.ok(mainSrc.includes("s.category === 'builtin-fixed'"), "门控谓词须含 category==='builtin-fixed' 子句");
    assert.ok(
      mainSrc.includes("s.config.funcCategory === 'platform-order'"),
      "门控谓词须含 funcCategory==='platform-order' 子句"
    );
    assert.ok(
      mainSrc.includes("s.config.subCategory === 'refund-order-backfill'"),
      "门控谓词须含 subCategory==='refund-order-backfill' 子句"
    );
  });

  test('bank-deposit 仅在门控开启时才读全表，否则注入 []（防 65.7 万行 ~1.2GB 无谓尖峰）', () => {
    assert.ok(mainSrc.includes('const workingDepositRows = refundBackfillEnabled'), 'workingDepositRows 必须受 refundBackfillEnabled 门控');
    assert.ok(
      mainSrc.includes("? structuredClone(database.readLinkedTableRows('bank-deposit') || [])"),
      '门控开启分支才 structuredClone 读 bank-deposit 全表'
    );
    assert.ok(/refundBackfillEnabled\s*\n\s*\?[^]*?\n\s*:\s*\[\];/.test(mainSrc), '门控关闭分支必须注入 [] 而非读全表');
  });

  test('🔴 跨文件同源：编排器 r5s4 分桶用相同字面值三元组（任一侧改字面 → 本测试红）', () => {
    // 谓词漂移是资金红线接缝：handler 关掉门控注入 []，而编排器 r5s4 实际启用 → 退款回填静默无产出。
    // 用「字面值」做同源锚（handler 用 s.config.funcCategory / 编排器用局部 fc，但值必须一致）。
    assert.ok(orchSrc.includes("s.category === 'builtin-fixed'"), "编排器 r5s4 分桶须含 'builtin-fixed'");
    assert.ok(orchSrc.includes("fc === 'platform-order'"), "编排器 r5s4 分桶须含 'platform-order'");
    assert.ok(
      orchSrc.includes("sub === 'refund-order-backfill'"),
      "编排器 r5s4 分桶须含 'refund-order-backfill'（与 handler 门控同源）"
    );
  });
});

describe('需求6 修复2（🔴 资金红线）：gateway 账单按 Channel 过滤读（删全量读 + 深拷）', () => {
  test('handler 从 session 行收集 bankChannels', () => {
    assert.ok(
      mainSrc.includes('const bankChannels = bankStatementSession.rows.map('),
      'handler 必须从 bankStatementSession.rows 收集 bankChannels'
    );
  });

  test('handler 一次读取 exactRows/c3Rows 双池并分别注入编排器', () => {
    assert.ok(
      mainSrc.includes('const gatewayRowPools = database.readGatewayBillRowPoolsByChannels(bankChannels);'),
      '网关数据必须经双池 facade 单次读取'
    );
    assert.ok(mainSrc.includes('const workingGwRows = gatewayRowPools.exactRows;'), '其它轮次必须使用 exactRows');
    assert.ok(mainSrc.includes('const workingC3GwRows = gatewayRowPools.c3Rows;'), 'C3 必须使用 c3Rows');
    assert.ok(mainSrc.includes('c3GwRows: workingC3GwRows,'), 'handler 必须显式注入 C3 专用候选池');
    // 注：不断言 readLinkedTableRows('gateway-bill') 全局缺席——该字面仍存在于 handler 上方注释（记录旧实现）。
  });
});

describe('v3.1.1（🔴 资金红线）：disabled owner 日期策略与运行/导出快照接线', () => {
  test('run 必须先读取含 disabled 的完整场景，再解析唯一日期策略 owner', () => {
    assert.ok(
      mainSrc.includes('const detailedAllScenarios = allScenarios.map((s) => {'),
      'run 必须构造含 disabled 的完整场景详情集合'
    );
    assert.ok(
      mainSrc.includes('const fundTransferPolicyResolution = resolveFundTransferDatePolicy(detailedAllScenarios);'),
      'run 必须从完整场景集合解析日期策略，不能只读取 enabled 场景'
    );
    assert.ok(
      mainSrc.includes('const detailedEnabled = detailedAllScenarios.filter('),
      '日期策略解析的数据集与实际执行的 enabled 场景集必须明确分离'
    );
  });

  test('resolved policy、配置告警和 owner id 必须注入编排与 R5 数据准备门控', () => {
    assert.ok(
      mainSrc.includes('(s) => String(s.id) === String(fundTransferDatePolicy.ownerScenarioId)'),
      'R5 数据准备必须绑定 resolver 返回的 canonical owner id'
    );
    assert.ok(mainSrc.includes('fundTransferDatePolicy,'), 'resolved policy 必须注入 runReconciliation');
    assert.ok(
      mainSrc.includes('initialWarnings: fundTransferPolicyResolution.warnings,'),
      'resolver 非致命告警必须注入最终错误报告链路'
    );
  });

  test('R5 关闭但 R3.5 开启时，多对多审计仍复用 R3.5 已加载的调拨副本', () => {
    assert.ok(
      mainSrc.includes('const workingFundTransferAuditReconRows = dbsChargeScenarioEnabled'),
      '审计输入必须优先绑定 R3.5 已使用的调拨副本'
    );
    assert.ok(
      mainSrc.includes('fundTransferAuditContext: { reconRows: workingFundTransferAuditReconRows },'),
      '主流程必须把独立只读审计 context 注入编排器'
    );
  });

  test('运行与导出均把 raw+effective policy signature 纳入防陈旧快照', () => {
    assert.ok(
      mainSrc.includes("`fund-transfer-date-policy|${String(fundTransferDatePolicySignature || '')}`"),
      '场景快照必须包含日期策略 signature'
    );
    const resolverCalls = mainSrc.match(/resolveFundTransferDatePolicy\(detailedAllScenarios\)/g) || [];
    assert.equal(resolverCalls.length, 2, 'run 与 export 必须各自重新解析一次日期策略');
    const signatureCalls = mainSrc.match(/fundTransferPolicyResolution\.policy\.signature/g) || [];
    assert.ok(signatureCalls.length >= 1, 'export 必须以重新解析的 signature 比较旧结果');
  });

  test('编排器只使用主流程传入的 policy，不再从 enabled R5 config 推导 M2M 日期', () => {
    assert.ok(
      orchSrc.includes('fundTransferDatePolicy: resolvedFundTransferDatePolicy'),
      'R3.5/R5 写入引擎必须接收同一 resolved policy'
    );
    assert.ok(
      orchSrc.includes('dateMatchEnabled: resolvedFundTransferDatePolicy.enabled'),
      'M2M 日期启停必须来自同一 resolved policy'
    );
    assert.ok(
      !orchSrc.includes('const fundTransferDateToleranceDays = r5s2Bucket.length'),
      '不得恢复为依赖 enabled R5 场景的旧容差推导'
    );
  });
});

describe('v3.1.1：平盘侧库初始化审计日志接线', () => {
  test('成功日志只记录初始化 mode，拒绝日志只记录结构化 code/reason', () => {
    assert.ok(
      mainSrc.includes("domain: 'position-reconciliation-side-db-init'"),
      '平盘侧库初始化必须进入独立日志域'
    );
    assert.ok(
      mainSrc.includes("details: [`mode=${String(initializationResult.mode || 'unknown')}`]"),
      '成功初始化必须记录 new / empty-legacy-upgrade / existing mode'
    );
    assert.ok(
      mainSrc.includes("`code=${String(error && error.code ? error.code : 'unknown')}`"),
      '拒绝路径必须记录结构化错误 code'
    );
    assert.ok(
      mainSrc.includes("`reason=${String(error && error.reason ? error.reason : '未提供结构化校验原因')}`"),
      '拒绝路径必须记录非敏感结构化校验原因'
    );
  });
});
