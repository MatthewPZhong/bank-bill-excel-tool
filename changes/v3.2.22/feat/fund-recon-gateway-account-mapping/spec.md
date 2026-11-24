# Spec — 资金对账：网关对账单共用账户映射 + 链接表管理 / 场景管理文案

> status: implemented（未提交；资金红线待脱敏样本人工复核）
> created: 2026-11-24
> 目标版本：v3.2.22（暂定，发版时按 weekly-release 调整）
> 适用分支：`feat/fund-recon-gateway-account-mapping`
> 分支基线：正式标签 `v3.2.21`（`0e996340`）
> 依据：2026-11-24 用户需求（链接表管理 / 账户映射管理 / 场景管理）及同日确认（场景管理【返回】两个模块一起改）
> 格式来源：`changes/v3.2.21/feat/template-date-format/spec.md`

## 1. 背景

「中台调拨订单对账ID回填」（R5 场景2）有两种数据来源，由场景配置「对账数据来源为中台调拨单表」二选一：

- 勾选（默认）：调拨对账单来源（R5s2-recon）。派生调拨对账单时，`big_account` 先按「账户映射管理」由中台调拨单账户号换成清结算系统银行账号（v3.0.12）。
- 取消勾选：网关来源（R5s2）。直接比较网关 `merchantid` 与银行 `MerchantId`，不经过映射。

部分用户用网关对账单里的调拨单回填，网关账户号与清结算银行账号不一致时对不上，而映射管理只覆盖中台调拨单。

用户表述为「网银账单生成模块」；代码中链接表管理、账户映射管理、带「网关对账单修复」入口的场景管理都属于「资金对账数据处理」（`#bankStatementModulePanel`），按该模块实施。

## 2. 需求与决策

| 编号 | 内容 | 来源 |
| --- | --- | --- |
| R1 | 链接表管理底部【退出】→【返回】 | 用户 |
| R2 | 账户映射管理表头「中台调拨单账户号」→「链接表账户号」；同义的用户可见报错一并改 | 用户 |
| R3 | 中台调拨单与网关对账单在「中台调拨订单对账ID回填」上共用同一张映射表、同一套映射逻辑 | 用户 |
| R4 | 网关对账单的 `merchantid` 先按该表映射，再执行匹配与回填 | 用户 |
| R5 | 场景管理底部【完成】→【返回】；弹窗为资金对账与对账单修复两模块共用，两处一起改 | 用户，2026-11-24 确认 |
| R6 | 去掉场景管理右上角「网关对账单修复 [管理]」 | 用户 |
| D1 | 映射语义与调拨派生一致：`key = normalizeCellValue(raw)`，`map.get(key) ?? key`；空表 = 空 Map = 结果与改动前一致；不新增「类别」列（同一张表、同一份键空间） | R3 |
| D2 | 映射只替换 R5s2 网关匹配用的账号；网关行本身、写入的 ReconciliationId、R1/R2(C3)/R3.5/R4/退款各轮对 `merchantid` 的用法不变 | 用户限定在回填功能；最小影响面 |
| D3 | 多对多只读检测器网关侧账号用同一映射，使「异常-人工判断」与 R5s2 网关匹配口径一致（调拨侧本已映射） | 避免映射后命中的多对多漏报 |
| D4 | 生产 run 读映射失败时整轮失败报错，不回退空表（避免静默少回填）；facade 缺失（旧 mock）时按空表 | fail-closed |
| D5 | 映射保存沿用既有 op-lock + 清空 `processingResult`，不新增失效逻辑；G7 worker 路径（生产未接入）同步注入映射并纳入证据签名 | 既有机制；与主路径口径对齐 |
| D6 | 「网关对账单修复」场景改由对账单修复模块的【场景管理】维护（入口已存在） | R6 |

## 3. 规则

### 3.1 共用映射 helper

`engine-utils.js` 新增 `resolveMappedAccount(accountMappingMap, rawAccount)`：归一化 → 非 Map 按空表 → `get ?? 原值`。调拨派生 `buildFundTransferReconRows` 与 R5s2 网关、检测器网关侧共用。

### 3.2 R5s2 网关匹配

`runRound5FundTransferBackfill(gwRows, bankRows, { accountMappingMap })`：`resolveMappedAccount(map, gw.merchantid) === normalizeCellValue(bank.MerchantId)`，两侧非空；币种、金额（含 Extra Fee）、方向、日期两阶段、严格 1:1、多候选 tie-break 与 warning 不变。

### 3.3 注入

- `runReconciliation({ fundTransferAccountMappingMap })` 缺省空 Map，只传给 R5s2 网关分支与多对多检测器。
- `bank-statement:run`：`database.getFundTransferAccountMappingMap()`。
- worker：`evidence-provider` 读 `getMappingMap(snapshot.db)`，映射 entries 进入证据签名，`service.js` 透传。

## 4. 非目标

- 不改 R4 资金性质校验、R1、C3、DBS-Charge、Payment、退款回填对账号的取值。
- 不改平盘模块的独立账户映射、前置资金对账链接表管理的【退出】。
- 不改映射表结构、IPC 契约、保存语义。
- CHANGELOG、版本历史、升级说明留待发版。

## 5. 对账专项自查（reconciliation-blindspot-pass）

| 级别 | 场景 | 事实与证据 | 处置 |
| --- | --- | --- | --- |
| Important | 网关 `merchantid` 恰好是映射键，银行 `MerchantId` 却等于原值 | 改动后 R5s2 网关比的是映射值，原本同号命中的行不再命中（不会错配到别的行，只是不回填）；同样配置下调拨来源本就是这一口径 | 有意设计（D1），USER_GUIDE 写明映射后按清结算银行账号比对 |
| Important | 映射保存后沿用旧运行结果导出 | 保存 handler 持 op-lock 并清 `processingResult`（`main.js` `fund-transfer-account-mapping:save`），导出需重跑 | 已覆盖（既有机制） |
| Minor | 空表 / 旧调用未传 map | 空 Map，全 passthrough | 单测覆盖 |
| Minor | 检测器与 R5s2 口径 | 同一 helper、同一 map | 单测覆盖 |

资金红线：改变了 R5s2 网关来源的账号匹配口径（只在用户维护了映射且网关账户号命中时生效），回填 ID 与 1:1 去向需用脱敏样本人工复核。

## 6. 验收

| 项 | 验证 |
| --- | --- |
| helper 命中 / 未命中 / 空键 / 非 Map | `tests/unit/main-process/scenario-engines/engine-utils.test.js` |
| R5s2 网关映射命中、两方向、未映射原口径、错映射不命中、1:1 | `tests/unit/main-process/scenario-engines/r5-fund-transfer-backfill.test.js` |
| 检测器网关侧映射成组 | `tests/unit/main-process/scenario-engines/many-to-many-detector.test.js` |
| 编排器透传（网关来源生效、调拨来源不变） | `tests/unit/main-process/reconciliation-orchestrator-fund-transfer-recon.test.js` |
| worker 证据签名随映射变化 | `tests/unit/main-process/fund-recon-worker-evidence.test.js` |
| 文案与入口移除 | renderer 源码断言单测 |
| 端到端：真实 DB 存映射 → `runReconciliation` 网关来源回填 | `scripts/integration/fund-transfer-recon-account-mapping.js` |
| 界面 | `npm run preview` 截图 |

### 6.1 验证记录（2026-11-24，worktree 未提交内容）

| 命令 | 结果 |
| --- | --- |
| `npm run lint` | PASS |
| `npm run check:architecture` | PASS（668/668 文件） |
| `npm run test:unit` | 9075/9079 PASS，4 skipped，0 fail |
| `npm run test:integration` | 90 个脚本全部 PASS；`fund-transfer-recon-account-mapping.js` 19 → 33 例，已回写 `rules/integration-test-policy.md`「七」 |
| `npm run smoke` | PASS |
| 界面预览 | 链接表管理、账户映射管理、场景管理截图已核对（未更新已跟踪的 `docs/previews`） |

未执行：完整 `npm run release-check`（PR-ready 时执行）、真机 GUI 手动点测、脱敏样本人工复核。
