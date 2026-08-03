# v3.1.7 Implementation Notes

## Baseline

- 需求基线：`changes/3.1.7/spec.md`。
- 代码基线：`main`，package version `3.1.6`。
- 工作分支：`codex/v3.1.7-payment-r5s2`。

## Decisions

- Payment 与 R5s2-recon 使用同一数组对象作为运行工作副本；“是否被使用”按物理派生行维护，不按 ReconID 或调拨单号做逻辑去重。
- “是否被使用”仅为运行态，数据库 `raw_json` 中只保存初始化空值，避免异常中断或重跑继承旧消费状态。
- 开启 Payment 时强制派生表来源，关闭时保留旧路径 parity。
- 同周多订单号日期取最早值；订单周断档在任何 Payment/R5 写值前阻断。
- 用户已取消最终 ReconciliationId 重复检测与异常说明；现有多对多审计保持不变。
- 新一轮银行对账运行开始即清空上一轮 `processingResult`；预检或引擎失败后不允许导出旧结果。
- 用户在获知 220 条 Payment 与 2 条 R5 人工逐笔复核尚未完成后，明确要求完成正式收尾和发布收尾；据此只授权生成受控技术 Release，不解除正式业务启用和公告的人工资金门禁。

## Assumptions

- 固定样本使用空账户映射；生产环境继续沿用派生 `big_account` 的既有映射结果。
- Payment 的付款账户条件只作用于 Payment；R5s2-recon 不比较 `Drawee CardNo`。
- 并发运行由现有运行入口互斥；每次调用仍使用隔离工作副本，不产生跨运行共享状态。

## Deviations

- 暂无。

## Evidence

- 两份固定样本通过生产 reader、流式中台 reader、派生 builder、编排器和 writer 完整回放：银行 1,831 行，中台订单 223 行，派生 446 行。
- Payment 匹配 220，其中 R1=218、R2=0、R3=2；实际改写 190。后跑 R5s2-recon 实际改写 2；命中 192、未命中 1,639，满足银行行数守恒。
- 220 条 Payment 配对的派生“付款账号”与银行 `Drawee CardNo` 全部相等；匹配月份覆盖 2025-10 至 2026-07，不是只覆盖 2026-05/06。
- 生产 Writer 输出五个固定 sheet，Payment 三个核对 sheet 各 220 条；公式错误扫描为 0，重新渲染确认关键表头及核对值可见。
- 旧模拟文件 `Payment线下调拨回填匹配_模拟结果_20260611.xlsx` 的 87 条配对中，按原始“付款账户（卡号）”核验仅 48 条与 `Drawee CardNo` 相等、39 条不等，因此不得作为 v3.1.7 基线。
- 自审发现并修复“已有成功结果后，新一轮 Payment 预检失败仍可能导出旧结果”的状态生命周期缺口；静态契约测试钉死清理时点早于场景读取和预检。
- 最终 `npm run release-check` 通过：`4575/4575` 单测、`44/44` 集成脚本、`2051/2051` 集成断言全部通过；lint 与 smoke 同步通过。
- `npm run scan:vars` 已刷新 v3.1.7 统计。`check-vars` 命中 `processingResult`、`app`、`state`：前者为本次受测的旧结果失效修复；后两者分别来自注释 diff 和 ExcelJS `sheet.views.state='frozen'`，不是 Electron app 生命周期或 renderer 全局 state 变更。
- 桌面交付文件由当前生产链路重跑生成，SHA-256 为 `a3ce595288f0533af7dddbb335d6b046330f1add39e9e0bdc6dec0413f9378ea`，五个 sheet 及关键行数断言全部通过。
- UI 预览确认 Payment 开启时来源勾选项自动选中并锁定；工作簿渲染确认付款账号、`Drawee CardNo` 和“是否被使用”可见，公式错误扫描为 0。
- 最终通用盲区与资金盲区复核未发现剩余 P3 及以上 Finding；仍保留下面的人工资金门禁。
- PR #121 最终实现提交为 `73c35a3f2b8ea2b7cc69e94bc1c44ae641c4cbe6`，以 squash merge commit `6fe118b8c4d665e1ce877fb792e6a4bbcda64cdf` 合入 `main`；PR 及合并前 review 无未解决 P3 及以上 Finding。
- `main@6fe118b` 的 Windows Build run `30794912210` 成功，包含 smoke、SQLite teardown、主页面布局、Setup/portable 构建、包体检查和 updater 资产暂存。
- 2026-08-03 从合并基线执行干净 `npm ci` 后，`npm run release-check` 再次通过 lint、smoke、4,575/4,575 单测（`logs/unit-tests/unit-20260803-160156.log`）和 44 个集成脚本 2,051/2,051 断言；集成总耗时 291,015 ms。
- 正式收尾主页面几何在两种尺寸、三档缩放下 6/6 PASS；`scan:vars` 为 282 files / 3,526 top-level names。`check-vars` 的三个 Runtime-state 词法命中已逐项核对，没有新的 app 生命周期或 renderer 全局 state 行为变更。
- 正式收尾固定样本重跑保持 1,831 条银行行、223 条订单、446 条派生行、Payment 220、Payment 改写 190、R5 改写 2、命中 192、未命中 1,639；220 条付款账号全部等于 `Drawee CardNo`。本次临时工作簿 SHA-256 为 `1221705fe3df8fdf37e8db806d18e6bbea2d94777bed0698da8eee7fae54d2fa`；生成时间元数据使工作簿字节摘要不作为确定性 golden，结构和业务断言才是发布基线。
- `npm audit --omit=dev` 为 0 critical、7 high、2 moderate，与 v3.1.6 发布基线一致；本次不在资金发布收尾中升级依赖。
- 发布准备 PR #122 的 Windows run `30796827775` 成功且无 review 或未解决 thread；PR 以 merge commit `1117c8b7d047cf408807b023368c63123a90d81f` 合入 `main`，合并后 main Windows run `30797197015` 成功。
- annotated tag `v3.1.7` 的 tag object 为 `3b001b60c4e00a4c946ba2681f45c1ff6a15c9ff`；远端 tag object 回读一致，peeled commit 与发布时最新 `main` 均为 `1117c8b7d047cf408807b023368c63123a90d81f`。
- 正式 Windows Release run `30797428933` 从 2026-08-03 16:26:55 运行至 17:01:08 +08:00，一次通过 tag/main/version、完整 release-check、布局、构建、包体、updater 资产、不可变发布和公开回读。Release `364087395` 于 17:01:02 发布为 latest、non-draft、non-prerelease。
- 四项公开资产独立下载后的 size / SHA-256 与 GitHub digest 一致：portable `99619052` / `10e48e17cb78c1b56b06d8955f8aa8b7f04cab1d584029cd52b6168672f0144d`；Setup `100115826` / `c6332203082334c0b1daeb8c6ef75f4fec2adff586d1210bacb8e319a20b3b1a`；blockmap `105513` / `e659f29a3d7c097dcc4ae9fac94c438824b8b4555ef46b48e455fcf6ade50a12`；`latest.yml` `369` / `d7100dd6706e3c17e081d727f91a039c99ee208fef9424b38848eceaae8401de`。两个 EXE 文件头均为 `MZ`。
- `latest.yml` 的 version/path/`files[0].size` 为 `3.1.7` / `bank-bill-excel-tool-setup-3.1.7.exe` / `100115826`，SHA-512 `g90PD6fhQyoFA+4/jpsAYa1HmVA4fcFvkEmZ1tQbHMul/IaW2i5O8tHx4BWZ3IvgNQBuZ+/eSuCtt4ZgqhwCcA==` 与 Setup 实际字节一致。
- 正式日期、tag、workflow 和资产摘要由发布证据 PR #123 回写；该 PR 不修改 `src`，`check:vars --since origin/main --include-minor` 安全跳过，且不得改变或解除 Remaining Unknowns 中的业务人工门禁。

## Remaining Unknowns

- `BLOCK（业务启用/公告）`：自动测试不能替代资金人工门禁；正式业务启用和公告前须人工复核固定样本中的 220 条 Payment 配对与 2 条 R5 后续回填。该项不因用户授权生成技术 Release 而变成已完成。
